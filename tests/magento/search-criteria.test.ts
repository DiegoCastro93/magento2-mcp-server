import { describe, expect, it } from 'vitest';
import type { OrderSearchParams, ProductSearchParams } from '../../src/magento/client.js';
import {
    assertPaging,
    buildSearchCriteria,
    customerEmailQuery,
    endOfDay,
    likeContains,
    orderIncrementIdQuery,
    orderSearchQuery,
    productSearchQuery,
    sourceItemQuery,
    startOfDay
} from '../../src/magento/search-criteria.js';

// Expected strings are written out literally and only ever joined, so a test
// cannot share a bug with the builder it checks.
const q = (...pairs: string[]): string => pairs.join('&');

const PAGE_1_OF_20 = q('searchCriteria[pageSize]=20', 'searchCriteria[currentPage]=1');

const PRODUCT_SORT_PAIRS = q(
    'searchCriteria[sortOrders][0][field]=created_at',
    'searchCriteria[sortOrders][0][direction]=DESC',
    'searchCriteria[sortOrders][1][field]=sku',
    'searchCriteria[sortOrders][1][direction]=ASC'
);

const ORDER_SORT_PAIRS = q(
    'searchCriteria[sortOrders][0][field]=created_at',
    'searchCriteria[sortOrders][0][direction]=DESC',
    'searchCriteria[sortOrders][1][field]=increment_id',
    'searchCriteria[sortOrders][1][direction]=DESC'
);

/** One filter as a tool would pass it, and its literal query fragment. `{g}` is its group index. */
interface FilterCase {
    readonly key: string;
    readonly value: string | number;
    readonly fragment: string;
}

const PRODUCT_FILTERS: readonly FilterCase[] = [
    {
        key: 'name',
        value: 'bag',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=name',
            'searchCriteria[filter_groups][{g}][filters][0][value]=%25bag%25',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=like'
        )
    },
    {
        key: 'sku',
        value: 'MB',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=sku',
            'searchCriteria[filter_groups][{g}][filters][0][value]=%25MB%25',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=like'
        )
    },
    {
        key: 'categoryId',
        value: 4,
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=category_id',
            'searchCriteria[filter_groups][{g}][filters][0][value]=4',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=eq'
        )
    },
    {
        key: 'priceMin',
        value: 10,
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=price',
            'searchCriteria[filter_groups][{g}][filters][0][value]=10',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=gteq'
        )
    },
    {
        key: 'priceMax',
        value: 50,
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=price',
            'searchCriteria[filter_groups][{g}][filters][0][value]=50',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=lteq'
        )
    }
];

const ORDER_FILTERS: readonly FilterCase[] = [
    {
        key: 'status',
        value: 'processing',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=status',
            'searchCriteria[filter_groups][{g}][filters][0][value]=processing',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=eq'
        )
    },
    {
        key: 'email',
        value: 'roni_cost@example.com',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=customer_email',
            'searchCriteria[filter_groups][{g}][filters][0][value]=roni_cost%40example.com',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=eq'
        )
    },
    {
        key: 'createdFrom',
        value: '2026-03-01',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=created_at',
            'searchCriteria[filter_groups][{g}][filters][0][value]=2026-03-01%2000%3A00%3A00',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=from'
        )
    },
    {
        key: 'createdTo',
        value: '2026-03-31',
        fragment: q(
            'searchCriteria[filter_groups][{g}][filters][0][field]=created_at',
            'searchCriteria[filter_groups][{g}][filters][0][value]=2026-03-31%2023%3A59%3A59',
            'searchCriteria[filter_groups][{g}][filters][0][condition_type]=to'
        )
    }
];

/**
 * Every subset of `filters`, with the params a tool would pass and the
 * fragments the query must contain, numbered in the mapper's fixed order.
 * Params are assembled in reverse, so a passing case also shows that the
 * group order does not follow the caller's key order.
 */
function everyCombination(filters: readonly FilterCase[]) {
    return Array.from({ length: 2 ** filters.length }, (_, mask) => {
        const chosen = filters.filter((_, i) => (mask & (1 << i)) !== 0);
        return {
            label: chosen.map((filter) => filter.key).join(' + ') || 'no filters',
            params: Object.fromEntries(chosen.map((filter) => [filter.key, filter.value]).reverse()),
            fragments: chosen.map((filter, g) => filter.fragment.replaceAll('{g}', String(g)))
        };
    });
}

describe('buildSearchCriteria', () => {
    it('sends only paging when there are no filters and no sort', () => {
        expect(buildSearchCriteria({ filterGroups: [], page: 3, pageSize: 7 })).toBe(
            'searchCriteria[pageSize]=7&searchCriteria[currentPage]=3'
        );
    });

    it('omits sort orders when none are given, or when the list is empty', () => {
        const filterGroups = [[{ field: 'sku', value: 'x', conditionType: 'eq' }]] as const;
        const expected = q(
            'searchCriteria[filter_groups][0][filters][0][field]=sku',
            'searchCriteria[filter_groups][0][filters][0][value]=x',
            'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
            PAGE_1_OF_20
        );

        expect(buildSearchCriteria({ filterGroups, page: 1, pageSize: 20 })).toBe(expected);
        expect(buildSearchCriteria({ filterGroups, sortOrders: [], page: 1, pageSize: 20 })).toBe(expected);
    });

    it('numbers the filters inside one group, which Magento ORs together', () => {
        const query = buildSearchCriteria({
            filterGroups: [
                [
                    { field: 'status', value: 'pending', conditionType: 'eq' },
                    { field: 'status', value: 'holded', conditionType: 'eq' }
                ]
            ],
            page: 1,
            pageSize: 20
        });

        expect(query).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=status',
                'searchCriteria[filter_groups][0][filters][0][value]=pending',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                'searchCriteria[filter_groups][0][filters][1][field]=status',
                'searchCriteria[filter_groups][0][filters][1][value]=holded',
                'searchCriteria[filter_groups][0][filters][1][condition_type]=eq',
                PAGE_1_OF_20
            )
        );
    });

    it('percent-encodes values, so + & # space and non-ASCII reach PHP intact', () => {
        const query = buildSearchCriteria({
            filterGroups: [[{ field: 'name', value: 'a+b&c#d eñ', conditionType: 'eq' }]],
            page: 1,
            pageSize: 20
        });

        expect(query).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=name',
                'searchCriteria[filter_groups][0][filters][0][value]=a%2Bb%26c%23d%20e%C3%B1',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                PAGE_1_OF_20
            )
        );
        // URLSearchParams decodes the way PHP does, turning a bare + into a space.
        expect(new URLSearchParams(query).get('searchCriteria[filter_groups][0][filters][0][value]')).toBe(
            'a+b&c#d eñ'
        );
    });

    it.each([
        [0, 20],
        [-1, 20],
        [1.5, 20],
        [Number.NaN, 20],
        [Number.POSITIVE_INFINITY, 20],
        [1, 0],
        [1, -5],
        [1, 2.5]
    ])('refuses page %s with pageSize %s instead of letting Magento clamp it', (page, pageSize) => {
        expect(() => assertPaging(page, pageSize)).toThrow(RangeError);
        expect(() => buildSearchCriteria({ filterGroups: [], page, pageSize })).toThrow(RangeError);
    });
});

describe('likeContains', () => {
    it('wraps a plain value in wildcards', () => {
        expect(likeContains('bag')).toBe('%bag%');
    });

    it.each([
        ['50%', String.raw`%50\%%`],
        ['24-WG085_Group', String.raw`%24-WG085\_Group%`],
        [String.raw`a\b`, String.raw`%a\\b%`],
        // The backslash is escaped first, or it would swallow the escape added for %.
        [String.raw`\%`, String.raw`%\\\%%`]
    ])('escapes %s so it matches literally', (value, expected) => {
        expect(likeContains(value)).toBe(expected);
    });
});

describe('startOfDay / endOfDay', () => {
    it('widens a date to its first and last second', () => {
        expect(startOfDay('2026-03-04')).toBe('2026-03-04 00:00:00');
        expect(endOfDay('2026-03-04')).toBe('2026-03-04 23:59:59');
    });

    it('accepts a leap day', () => {
        expect(endOfDay('2028-02-29')).toBe('2028-02-29 23:59:59');
    });

    it.each([
        '2026-02-29',
        '2026-02-30',
        '2026-13-01',
        '2026-3-4',
        '20260304',
        '2026-03-04T00:00:00Z',
        '2026-03-04 00:00:00',
        ' 2026-03-04',
        ''
    ])('refuses %j rather than letting MySQL coerce it', (date) => {
        expect(() => startOfDay(date)).toThrow(RangeError);
        expect(() => endOfDay(date)).toThrow(RangeError);
    });
});

describe('productSearchQuery', () => {
    it('sends the stable sort and paging with no filters', () => {
        expect(productSearchQuery({ page: 1, pageSize: 20 })).toBe(q(PRODUCT_SORT_PAIRS, PAGE_1_OF_20));
    });

    it('sends every filter as its own AND-ed group, in a fixed order', () => {
        const query = productSearchQuery({
            priceMax: 50,
            priceMin: 10,
            categoryId: 4,
            sku: 'MB',
            name: 'bag',
            page: 2,
            pageSize: 20
        });

        expect(query).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=name',
                'searchCriteria[filter_groups][0][filters][0][value]=%25bag%25',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=like',
                'searchCriteria[filter_groups][1][filters][0][field]=sku',
                'searchCriteria[filter_groups][1][filters][0][value]=%25MB%25',
                'searchCriteria[filter_groups][1][filters][0][condition_type]=like',
                'searchCriteria[filter_groups][2][filters][0][field]=category_id',
                'searchCriteria[filter_groups][2][filters][0][value]=4',
                'searchCriteria[filter_groups][2][filters][0][condition_type]=eq',
                'searchCriteria[filter_groups][3][filters][0][field]=price',
                'searchCriteria[filter_groups][3][filters][0][value]=10',
                'searchCriteria[filter_groups][3][filters][0][condition_type]=gteq',
                'searchCriteria[filter_groups][4][filters][0][field]=price',
                'searchCriteria[filter_groups][4][filters][0][value]=50',
                'searchCriteria[filter_groups][4][filters][0][condition_type]=lteq',
                'searchCriteria[sortOrders][0][field]=created_at',
                'searchCriteria[sortOrders][0][direction]=DESC',
                'searchCriteria[sortOrders][1][field]=sku',
                'searchCriteria[sortOrders][1][direction]=ASC',
                'searchCriteria[pageSize]=20',
                'searchCriteria[currentPage]=2'
            )
        );
    });

    it.each(everyCombination(PRODUCT_FILTERS))('$label', ({ params, fragments }) => {
        const query = productSearchQuery({ ...params, page: 1, pageSize: 20 } as ProductSearchParams);

        expect(query).toBe(q(...fragments, PRODUCT_SORT_PAIRS, PAGE_1_OF_20));
    });

    it('still filters on a price bound of 0', () => {
        expect(productSearchQuery({ priceMin: 0, priceMax: 0, page: 1, pageSize: 20 })).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=price',
                'searchCriteria[filter_groups][0][filters][0][value]=0',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=gteq',
                'searchCriteria[filter_groups][1][filters][0][field]=price',
                'searchCriteria[filter_groups][1][filters][0][value]=0',
                'searchCriteria[filter_groups][1][filters][0][condition_type]=lteq',
                PRODUCT_SORT_PAIRS,
                PAGE_1_OF_20
            )
        );
    });

    it('treats an explicit undefined, as zod leaves it, as an absent filter', () => {
        expect(productSearchQuery({ name: undefined, priceMin: undefined, page: 1, pageSize: 20 })).toBe(
            q(PRODUCT_SORT_PAIRS, PAGE_1_OF_20)
        );
    });

    it('escapes like wildcards before encoding them', () => {
        expect(productSearchQuery({ sku: '_', page: 1, pageSize: 20 })).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=sku',
                'searchCriteria[filter_groups][0][filters][0][value]=%25%5C_%25',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=like',
                PRODUCT_SORT_PAIRS,
                PAGE_1_OF_20
            )
        );
    });
});

describe('orderSearchQuery', () => {
    it('sends the stable sort and paging with no filters', () => {
        expect(orderSearchQuery({ page: 1, pageSize: 20 })).toBe(q(ORDER_SORT_PAIRS, PAGE_1_OF_20));
    });

    it('sends every filter as its own AND-ed group, in a fixed order, widening dates to whole days', () => {
        const query = orderSearchQuery({
            createdTo: '2026-03-31',
            createdFrom: '2026-03-01',
            email: 'roni_cost@example.com',
            status: 'processing',
            page: 3,
            pageSize: 5
        });

        expect(query).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=status',
                'searchCriteria[filter_groups][0][filters][0][value]=processing',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                'searchCriteria[filter_groups][1][filters][0][field]=customer_email',
                'searchCriteria[filter_groups][1][filters][0][value]=roni_cost%40example.com',
                'searchCriteria[filter_groups][1][filters][0][condition_type]=eq',
                'searchCriteria[filter_groups][2][filters][0][field]=created_at',
                'searchCriteria[filter_groups][2][filters][0][value]=2026-03-01%2000%3A00%3A00',
                'searchCriteria[filter_groups][2][filters][0][condition_type]=from',
                'searchCriteria[filter_groups][3][filters][0][field]=created_at',
                'searchCriteria[filter_groups][3][filters][0][value]=2026-03-31%2023%3A59%3A59',
                'searchCriteria[filter_groups][3][filters][0][condition_type]=to',
                'searchCriteria[sortOrders][0][field]=created_at',
                'searchCriteria[sortOrders][0][direction]=DESC',
                'searchCriteria[sortOrders][1][field]=increment_id',
                'searchCriteria[sortOrders][1][direction]=DESC',
                'searchCriteria[pageSize]=5',
                'searchCriteria[currentPage]=3'
            )
        );
    });

    it.each(everyCombination(ORDER_FILTERS))('$label', ({ params, fragments }) => {
        const query = orderSearchQuery({ ...params, page: 1, pageSize: 20 } as OrderSearchParams);

        expect(query).toBe(q(...fragments, ORDER_SORT_PAIRS, PAGE_1_OF_20));
    });

    it('refuses a malformed date instead of sending it', () => {
        expect(() => orderSearchQuery({ createdFrom: '2026-02-30', page: 1, pageSize: 20 })).toThrow(RangeError);
        expect(() => orderSearchQuery({ createdTo: '31/03/2026', page: 1, pageSize: 20 })).toThrow(RangeError);
    });

    it('refuses invalid paging', () => {
        expect(() => orderSearchQuery({ page: 0, pageSize: 20 })).toThrow(RangeError);
    });
});

describe('single-row lookups', () => {
    it('finds an order by increment ID', () => {
        expect(orderIncrementIdQuery('000000001')).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=increment_id',
                'searchCriteria[filter_groups][0][filters][0][value]=000000001',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                'searchCriteria[pageSize]=1',
                'searchCriteria[currentPage]=1'
            )
        );
    });

    it('finds a customer by email, keeping a + as a +', () => {
        expect(customerEmailQuery('roni+test@example.com')).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=email',
                'searchCriteria[filter_groups][0][filters][0][value]=roni%2Btest%40example.com',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                'searchCriteria[pageSize]=1',
                'searchCriteria[currentPage]=1'
            )
        );
    });

    it('finds one source item by SKU and source, ANDing the two', () => {
        expect(sourceItemQuery('24-MB01', 'default')).toBe(
            q(
                'searchCriteria[filter_groups][0][filters][0][field]=sku',
                'searchCriteria[filter_groups][0][filters][0][value]=24-MB01',
                'searchCriteria[filter_groups][0][filters][0][condition_type]=eq',
                'searchCriteria[filter_groups][1][filters][0][field]=source_code',
                'searchCriteria[filter_groups][1][filters][0][value]=default',
                'searchCriteria[filter_groups][1][filters][0][condition_type]=eq',
                'searchCriteria[pageSize]=1',
                'searchCriteria[currentPage]=1'
            )
        );
    });
});
