/**
 * Magento's `searchCriteria` query grammar, as one pure module.
 *
 * Two layers: {@link buildSearchCriteria} serialises any criteria, and the
 * per-domain mappers below it decide which filters, sort and paging each
 * search sends. The http adapter only has to append their output to a URL.
 *
 * The boundary rules that both adapters must agree on also live here — date
 * boundaries, `like` escaping, paging guards and the sort specs — so the
 * fixture adapter imports them instead of restating them, and the two modes
 * cannot drift apart.
 */
import type { OrderSearchParams, ProductSearchParams } from './client.js';

/** The condition types this server sends. Magento accepts more. */
export type ConditionType = 'eq' | 'like' | 'gteq' | 'lteq' | 'from' | 'to';

export interface Filter {
    readonly field: string;
    readonly value: string | number;
    readonly conditionType: ConditionType;
}

/** Filters within a group OR together; groups AND together. */
export type FilterGroup = readonly [Filter, ...Filter[]];

export interface SortOrder {
    readonly field: string;
    readonly direction: 'ASC' | 'DESC';
}

export interface SearchCriteria {
    readonly filterGroups: readonly FilterGroup[];
    readonly sortOrders?: readonly SortOrder[] | undefined;
    /**
     * Required, unlike in Magento: REST applies no default page size, so a
     * query without one returns every matching row.
     */
    readonly page: number;
    readonly pageSize: number;
}

/**
 * `created_at` alone is not a total order — sample catalogues share timestamps
 * freely — and an unstable sort makes page 2 skip and repeat rows. Sent by the
 * http mappers and interpreted by the fixture adapter's comparator.
 */
export const PRODUCT_SORT: readonly SortOrder[] = [
    { field: 'created_at', direction: 'DESC' },
    { field: 'sku', direction: 'ASC' }
];

/** See {@link PRODUCT_SORT}. */
export const ORDER_SORT: readonly SortOrder[] = [
    { field: 'created_at', direction: 'DESC' },
    { field: 'increment_id', direction: 'DESC' }
];

/**
 * Serialises criteria in a fixed order: filter groups (field, value,
 * condition_type), then sort orders, then `pageSize`, then `currentPage`.
 *
 * Keys keep literal brackets, which is Magento's documented form. Values go
 * through `encodeURIComponent`, so a `+` in an email goes out as `%2B` instead
 * of reaching PHP as a space.
 *
 * @throws {RangeError} on invalid paging, see {@link assertPaging}.
 */
export function buildSearchCriteria(criteria: SearchCriteria): string {
    assertPaging(criteria.page, criteria.pageSize);

    const pairs: string[] = [];
    const add = (key: string, value: string | number): void => {
        pairs.push(`searchCriteria${key}=${encodeURIComponent(String(value))}`);
    };

    criteria.filterGroups.forEach((group, g) => {
        group.forEach((filter, f) => {
            const prefix = `[filter_groups][${g}][filters][${f}]`;
            add(`${prefix}[field]`, filter.field);
            add(`${prefix}[value]`, filter.value);
            add(`${prefix}[condition_type]`, filter.conditionType);
        });
    });
    criteria.sortOrders?.forEach((sort, s) => {
        add(`[sortOrders][${s}][field]`, sort.field);
        add(`[sortOrders][${s}][direction]`, sort.direction);
    });
    add('[pageSize]', criteria.pageSize);
    add('[currentPage]', criteria.page);

    return pairs.join('&');
}

/**
 * Rejects paging that is not a pair of integers ≥ 1. Magento refuses neither:
 * a `currentPage` below 1 is clamped to 1, answering with a plausible page
 * that is not the one asked for, and a `pageSize` of 0 drops the `LIMIT` and
 * returns every row.
 *
 * @throws {RangeError}
 */
export function assertPaging(page: number, pageSize: number): void {
    if (!Number.isInteger(page) || page < 1) {
        throw new RangeError(`page must be an integer >= 1, got ${page}.`);
    }
    if (!Number.isInteger(pageSize) || pageSize < 1) {
        throw new RangeError(`pageSize must be an integer >= 1, got ${pageSize}.`);
    }
}

/**
 * Wraps a value as a `like` substring pattern, with `\`, `%` and `_` escaped so
 * that a search for `50%` means those literal characters rather than a
 * wildcard. Magento passes `like` values to SQL untouched, and MySQL's default
 * `LIKE` escape character is `\`.
 */
export function likeContains(value: string): string {
    return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/**
 * The first second of a UTC day, as Magento compares `created_at`.
 *
 * @throws {RangeError} unless `date` is a real calendar date as `YYYY-MM-DD`.
 */
export function startOfDay(date: string): string {
    assertIsoDate(date);
    return `${date} 00:00:00`;
}

/**
 * The last second of a UTC day. A bare date would compare as midnight and
 * silently drop that whole day from a `to` filter.
 *
 * @throws {RangeError} unless `date` is a real calendar date as `YYYY-MM-DD`.
 */
export function endOfDay(date: string): string {
    assertIsoDate(date);
    return `${date} 23:59:59`;
}

/** MySQL coerces a malformed date leniently instead of refusing it, so refuse it here. */
function assertIsoDate(date: string): void {
    const parsed = new Date(`${date}T00:00:00Z`);
    const valid =
        /^\d{4}-\d{2}-\d{2}$/.test(date) &&
        !Number.isNaN(parsed.getTime()) &&
        // Catches a day that overflows its month, such as 2026-02-30.
        parsed.toISOString().slice(0, 10) === date;
    if (!valid) {
        throw new RangeError(`Expected a calendar date as YYYY-MM-DD, got "${date}".`);
    }
}

function single(field: string, conditionType: ConditionType, value: string | number): FilterGroup {
    return [{ field, value, conditionType }];
}

/**
 * `GET /V1/products`. One AND-ed group per present filter, always in the order
 * name, sku, category, price min, price max. Presence is `!== undefined`, so a
 * `priceMin` of 0 still filters.
 */
export function productSearchQuery(params: ProductSearchParams): string {
    const groups: FilterGroup[] = [];
    if (params.name !== undefined) groups.push(single('name', 'like', likeContains(params.name)));
    if (params.sku !== undefined) groups.push(single('sku', 'like', likeContains(params.sku)));
    if (params.categoryId !== undefined) groups.push(single('category_id', 'eq', params.categoryId));
    if (params.priceMin !== undefined) groups.push(single('price', 'gteq', params.priceMin));
    if (params.priceMax !== undefined) groups.push(single('price', 'lteq', params.priceMax));

    return buildSearchCriteria({
        filterGroups: groups,
        sortOrders: PRODUCT_SORT,
        page: params.page,
        pageSize: params.pageSize
    });
}

/**
 * `GET /V1/orders`. One AND-ed group per present filter, always in the order
 * status, email, created from, created to. The dates widen to whole UTC days.
 */
export function orderSearchQuery(params: OrderSearchParams): string {
    const groups: FilterGroup[] = [];
    if (params.status !== undefined) groups.push(single('status', 'eq', params.status));
    if (params.email !== undefined) groups.push(single('customer_email', 'eq', params.email));
    if (params.createdFrom !== undefined) groups.push(single('created_at', 'from', startOfDay(params.createdFrom)));
    if (params.createdTo !== undefined) groups.push(single('created_at', 'to', endOfDay(params.createdTo)));

    return buildSearchCriteria({
        filterGroups: groups,
        sortOrders: ORDER_SORT,
        page: params.page,
        pageSize: params.pageSize
    });
}

// The three lookups below ask for a single row. Their keys are unique in a
// single-store install, which is v1's scope: an increment ID is only unique per
// store, and a customer email per website.

/** `GET /V1/orders`: Magento has no by-increment-id endpoint. */
export function orderIncrementIdQuery(incrementId: string): string {
    return buildSearchCriteria({ filterGroups: [single('increment_id', 'eq', incrementId)], page: 1, pageSize: 1 });
}

/** `GET /V1/customers/search`. */
export function customerEmailQuery(email: string): string {
    return buildSearchCriteria({ filterGroups: [single('email', 'eq', email)], page: 1, pageSize: 1 });
}

/** `GET /V1/inventory/source-items`, for one SKU at one source. */
export function sourceItemQuery(sku: string, sourceCode: string): string {
    return buildSearchCriteria({
        filterGroups: [single('sku', 'eq', sku), single('source_code', 'eq', sourceCode)],
        page: 1,
        pageSize: 1
    });
}
