import { beforeEach, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import type { ToolError } from '../../src/errors/tool-error.js';
import { MagentoRequestError, MagentoUnavailableError, type MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { UpdateProductStockOutputSchema, type UpdateProductStockOutput } from '../../src/projection/fields.js';
import { defineGetProduct } from '../../src/tools/read/get-product.js';
import { defineUpdateProductStock } from '../../src/tools/write/update-product-stock.js';
import { wire } from '../projection/fixtures.js';
import { failing, loadFixtureClient, memoryLogger, override, refusalOf } from './client-stubs.js';

const TIMEOUT = new MagentoUnavailableError('shop.example.com', 'timeout');

function unauthorized(resource: string): MagentoRequestError {
    return new MagentoRequestError(401, {
        message: "The consumer isn't authorized to access %resources.",
        parameters: { resources: resource }
    });
}

// Writes mutate the fixture store, so every spec starts from the committed fixtures.
let store: FixtureMagentoClient;

beforeEach(async () => {
    store = await loadFixtureClient();
});

function tool(client: MagentoClient = store, sourceCode = 'default') {
    return defineUpdateProductStock({ client, logger: memoryLogger().logger, sourceCode, stockId: 1 });
}

type Input = z.input<ReturnType<typeof tool>['inputSchema']>;

/**
 * Parses `input` as the SDK would, and returns the answer as it would cross
 * stdio, checked against the output schema.
 */
async function answer(
    input: Input,
    client?: MagentoClient,
    sourceCode?: string
): Promise<{ result: UpdateProductStockOutput; text: string }> {
    const definition = tool(client, sourceCode);
    const { structuredContent, text } = await definition.handler(definition.inputSchema.parse(input));
    const result = wire(structuredContent);
    expect(UpdateProductStockOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
}

function refusal(input: Input, client?: MagentoClient, sourceCode?: string): Promise<ToolError> {
    const definition = tool(client, sourceCode);
    return refusalOf(definition.handler(definition.inputSchema.parse(input)));
}

/** `client`, counting the writes that reach it. */
function counting(client: MagentoClient): { client: MagentoClient; writes: () => number } {
    let writes = 0;
    return {
        client: override(client, {
            updateSourceItem: (update) => {
                writes += 1;
                return client.updateSourceItem(update);
            }
        }),
        writes: () => writes
    };
}

describe('update_product_stock', () => {
    it('declares itself destructive and idempotent, all four hints explicit', () => {
        expect(tool().annotations).toStrictEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true
        });
        expect(tool().retry).toStrictEqual({ idempotent: true });
    });

    it('sets the absolute quantity, and reports the previous one', async () => {
        const { result, text } = await answer({ sku: '24-MB01', quantity: 120 });

        expect(result).toStrictEqual({
            sku: '24-MB01',
            sourceCode: 'default',
            previous: { quantity: 100, status: 'in_stock' },
            current: { quantity: 120, status: 'in_stock' }
        });
        expect(text).toBe('Set 24-MB01 to 120 on hand at source "default", in stock (was 100, in stock).');
        expect(await store.getSourceItem('24-MB01', 'default')).toMatchObject({ quantity: 120, status: 1 });
    });

    it('leaves get_product showing the new on-hand, and salable shifted by the same delta', async () => {
        const getProduct = defineGetProduct({
            client: store,
            logger: memoryLogger().logger,
            sourceCode: 'default',
            stockId: 1
        });
        const before = (await getProduct.handler({ sku: '24-MB01' })).structuredContent.stock;

        await answer({ sku: '24-MB01', quantity: 120 });
        const after = (await getProduct.handler({ sku: '24-MB01' })).structuredContent.stock;

        expect(before).toMatchObject({ sourceQuantity: 100, salableQuantity: 97 });
        expect(after).toMatchObject({ sourceQuantity: 120, salableQuantity: 117 });
    });

    it('repeats harmlessly: the same call again reports what the first one set', async () => {
        await answer({ sku: '24-MB01', quantity: 120 });
        const { result } = await answer({ sku: '24-MB01', quantity: 120 });

        expect(result.previous).toStrictEqual(result.current);
    });

    it('defaults the status from the quantity', async () => {
        expect((await answer({ sku: '24-MB01', quantity: 0 })).result.current.status).toBe('out_of_stock');
        expect((await answer({ sku: '24-MB04', quantity: 5 })).result).toMatchObject({
            previous: { quantity: 0, status: 'out_of_stock' },
            current: { quantity: 5, status: 'in_stock' }
        });
    });

    it('lets an explicit status win over the default', async () => {
        const { result, text } = await answer({ sku: '24-MB01', quantity: 0, status: 'in_stock' });
        expect(result.current).toStrictEqual({ quantity: 0, status: 'in_stock' });
        expect(text).toBe('Set 24-MB01 to 0 on hand at source "default", in stock (was 100, in stock).');

        const again = await answer({ sku: '24-MB01', quantity: 50, status: 'out_of_stock' });
        expect(again.result.current).toStrictEqual({ quantity: 50, status: 'out_of_stock' });
    });

    it('writes the stored row when the SKU arrives in another casing, and answers with the canonical SKU', async () => {
        const { result } = await answer({ sku: '24-mb01', quantity: 7 });

        expect(result.sku).toBe('24-MB01');
        expect(await store.getSourceItem('24-MB01', 'default')).toMatchObject({ sku: '24-MB01', quantity: 7 });
    });

    it('writes at the configured source only', async () => {
        const { result } = await answer({ sku: '24-MB01', quantity: 12 }, store, 'warehouse_eu');

        expect(result).toMatchObject({ sourceCode: 'warehouse_eu', previous: { quantity: 40 } });
        expect(await store.getSourceItem('24-MB01', 'default')).toMatchObject({ quantity: 100 });
    });

    it('refuses a negative quantity in its input schema', () => {
        expect(tool().inputSchema.safeParse({ sku: '24-MB01', quantity: -1 }).success).toBe(false);
    });

    describe('refuses before anything is written', () => {
        it('an unknown SKU, as NOT_FOUND', async () => {
            const { client, writes } = counting(store);

            const error = await refusal({ sku: 'NO-SUCH-SKU', quantity: 5 }, client);

            expect(error).toMatchObject({
                code: 'NOT_FOUND',
                message: "No product with SKU 'NO-SUCH-SKU'.",
                suggestion: 'Use search_products to find the correct SKU.',
                retryable: false
            });
            expect(writes()).toBe(0);
            expect(await store.getSourceItem('NO-SUCH-SKU', 'default')).toBeUndefined();
        });

        it('a type without stock of its own, as INVALID_INPUT', async () => {
            const { client, writes } = counting(store);

            const error = await refusal({ sku: '24-WG085_Group', quantity: 5 }, client);

            expect(error).toMatchObject({
                code: 'INVALID_INPUT',
                message: "Product '24-WG085_Group' is a grouped product, which holds no stock of its own.",
                retryable: false
            });
            expect(error.suggestion).toContain('set the stock of each of those instead');
            expect(writes()).toBe(0);
            expect(await store.getSourceItem('24-WG085_Group', 'default')).toBeUndefined();
        });

        it('a product not assigned to the configured source, as NOT_FOUND', async () => {
            const { client, writes } = counting(store);

            const error = await refusal({ sku: '24-MG03', quantity: 8 }, client, 'warehouse_eu');

            expect(error).toMatchObject({
                code: 'NOT_FOUND',
                message: "Product '24-MG03' is not assigned to source 'warehouse_eu'.",
                retryable: false
            });
            expect(error.suggestion).toContain('assign it in the Magento admin');
            expect(error.suggestion).toContain('MAGENTO_SOURCE_CODE');
            expect(writes()).toBe(0);
            expect(await store.getSourceItem('24-MG03', 'warehouse_eu')).toBeUndefined();
        });
    });

    describe('failures', () => {
        it('reads a 401 on the write as the missing write ACL, since the pre-check proved the token', async () => {
            const denied = unauthorized('Magento_InventoryApi::stock_source_item_assign');
            const client = failing(store, 'updateSourceItem', denied);

            const error = await refusal({ sku: '24-MB01', quantity: 5 }, client);

            expect(error).toMatchObject({
                code: 'PERMISSION_DENIED',
                message: 'The integration lacks access to Magento_InventoryApi::stock_source_item_assign.',
                retryable: false
            });
        });

        it('calls a write timeout retryable, since setting an absolute value twice is harmless', async () => {
            const error = await refusal({ sku: '24-MB01', quantity: 5 }, failing(store, 'updateSourceItem', TIMEOUT));

            expect(error).toMatchObject({
                code: 'UPSTREAM_UNAVAILABLE',
                retryable: true,
                suggestion: 'Retry shortly.'
            });
        });

        it('reads 401s on both pre-check calls as AUTH_FAILED, and writes nothing', async () => {
            const { client, writes } = counting(
                override(store, {
                    getProduct: () => Promise.reject(unauthorized('Magento_Catalog::products')),
                    getSourceItem: () => Promise.reject(unauthorized('Magento_InventoryApi::source'))
                })
            );

            const error = await refusal({ sku: '24-MB01', quantity: 5 }, client);

            expect(error).toMatchObject({ code: 'AUTH_FAILED', retryable: false });
            expect(writes()).toBe(0);
        });

        it('reads a 401 on the source item alone as PERMISSION_DENIED, and writes nothing', async () => {
            const { client, writes } = counting(
                failing(store, 'getSourceItem', unauthorized('Magento_InventoryApi::source'))
            );

            const error = await refusal({ sku: '24-MB01', quantity: 5 }, client);

            expect(error).toMatchObject({
                code: 'PERMISSION_DENIED',
                message: 'The integration lacks access to Magento_InventoryApi::source.'
            });
            expect(writes()).toBe(0);
        });
    });
});
