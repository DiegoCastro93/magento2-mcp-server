import { beforeAll, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import type { MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { SearchProductsOutputSchema, type SearchProductsOutput } from '../../src/projection/fields.js';
import { defineSearchProducts } from '../../src/tools/read/search-products.js';
import { loadProduct, wire } from '../projection/fixtures.js';
import { loadFixtureClient, memoryLogger, override, refusalOf } from './client-stubs.js';

/**
 * The ceiling for a full page's whole answer: 50 summaries of the largest
 * fixture, the pagination envelope and its notice, measured at 5,334 bytes when
 * it was set, plus about 10% headroom. The summaries alone have their own
 * ceiling in the projection spec.
 */
const ANSWER_BYTE_CEILING = 5_900;

type Input = z.input<ReturnType<typeof defineSearchProducts>['inputSchema']>;

let fixtures: FixtureMagentoClient;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

function tool(client: MagentoClient = fixtures) {
    return defineSearchProducts({ client, logger: memoryLogger().logger, sourceCode: 'default', stockId: 1 });
}

/** Parses `input` as the SDK does, defaults included, and returns the answer as it would cross stdio. */
async function answer(input: Input, client?: MagentoClient): Promise<{ result: SearchProductsOutput; text: string }> {
    const definition = tool(client);
    const { structuredContent, text } = await definition.handler(definition.inputSchema.parse(input));
    const result = wire(structuredContent);
    expect(SearchProductsOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
}

function skus(result: SearchProductsOutput): string[] {
    return result.products.map((product) => product.sku);
}

describe('search_products', () => {
    it('with no filters, lists the newest products first, ties broken by SKU', async () => {
        const { result, text } = await answer({});

        expect(skus(result)).toEqual(['24-MG03', '24-UG06', '24-MB01', '24-MB04', '24-WG085_Group', 'WS12-M-Orange']);
        expect(result.pagination).toStrictEqual({
            page: 1,
            pageSize: 20,
            totalCount: 6,
            totalPages: 1,
            hasMore: false
        });
        expect(result).not.toHaveProperty('notice');
        expect(text).toBe('6 products match.');
    });

    it('reduces every result to the summary allowlist', async () => {
        const { result } = await answer({ sku: '24-MB01' });

        expect(result.products).toStrictEqual([
            { sku: '24-MB01', name: 'Joust Duffle Bag', price: 34, status: 'enabled', type: 'simple' }
        ]);
    });

    it('matches a name or SKU substring, whatever its case', async () => {
        expect(skus((await answer({ name: 'duffle BAG' })).result)).toEqual(['24-MB01']);
        expect(skus((await answer({ sku: 'mb0' })).result)).toEqual(['24-MB01', '24-MB04']);
    });

    it('filters by category', async () => {
        expect(skus((await answer({ categoryId: 7 })).result)).toEqual(['24-MG03', '24-MB04']);
    });

    it('applies an inclusive price range, which a product without a price never matches', async () => {
        expect(skus((await answer({ priceMin: 32, priceMax: 54 })).result)).toEqual(['24-MG03', '24-MB01', '24-MB04']);
        expect(skus((await answer({ priceMin: 0 })).result)).not.toContain('24-WG085_Group');
        expect(skus((await answer({ priceMin: 34, priceMax: 34 })).result)).toEqual(['24-MB01']);
    });

    it('ANDs the filters together', async () => {
        const { result, text } = await answer({ sku: '24-', categoryId: 7, priceMax: 40 });

        expect(skus(result)).toEqual(['24-MB04']);
        expect(text).toBe('1 product matches.');
    });

    it('refuses a price range that runs backwards, even when its upper end is 0', async () => {
        const error = await refusalOf(tool().handler(tool().inputSchema.parse({ priceMin: 5, priceMax: 0 })));

        expect(error.code).toBe('INVALID_INPUT');
        expect(error.message).toBe('priceMin (5) is greater than priceMax (0).');
        expect(error.suggestion).toBe('Swap the two values, or drop one of them to leave that end of the range open.');
        expect(error.retryable).toBe(false);
    });

    it('states the price rule in the field description, since the schema cannot carry it', () => {
        expect(tool().inputSchema.shape.priceMin.description).toContain('Must not be greater than priceMax.');
    });

    describe('pagination', () => {
        it('says when a page is not the whole answer, in the notice and in the text', async () => {
            const { result, text } = await answer({ pageSize: 2 });

            expect(skus(result)).toEqual(['24-MG03', '24-UG06']);
            expect(result.pagination).toMatchObject({ totalCount: 6, totalPages: 3, hasMore: true });
            expect(result.notice).toBe('Showing 2 of 6 products (page 1 of 3). Narrow the filters or request page 2.');
            expect(text).toBe(`6 products match. ${result.notice}`);
        });

        it('serves the next page', async () => {
            expect(skus((await answer({ page: 2, pageSize: 2 })).result)).toEqual(['24-MB01', '24-MB04']);
        });

        it('says when a page is past the end', async () => {
            const { result } = await answer({ page: 9, pageSize: 2 });

            expect(result.products).toEqual([]);
            expect(result.notice).toBe('Page 9 is past the end: 6 products match, in 3 pages.');
        });
    });

    it('answers no match with an empty page and nothing to explain', async () => {
        const { result, text } = await answer({ name: 'no such product' });

        expect(result.products).toEqual([]);
        expect(result.pagination.totalCount).toBe(0);
        expect(result).not.toHaveProperty('notice');
        expect(text).toBe('No products match.');
    });

    it("keeps a full page's whole answer under the byte ceiling", async () => {
        const raw = await loadProduct('WS12-M-Orange');
        const items = Array.from({ length: 50 }, (_, i) => ({ ...raw, sku: `${raw.sku}-${i}` }));
        const client = override(fixtures, {
            searchProducts: () => Promise.resolve({ items, total_count: 3412 })
        });

        const { result } = await answer({ pageSize: 50 }, client);

        expect(result.products).toHaveLength(50);
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(ANSWER_BYTE_CEILING);
    });
});
