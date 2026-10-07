import { beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors/tool-error.js';
import { MagentoRequestError, MagentoUnavailableError, type MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import type { RawProduct } from '../../src/magento/raw-types.js';
import { GetProductOutputSchema, type GetProductOutput } from '../../src/projection/fields.js';
import type { ToolDeps } from '../../src/tools/definition.js';
import { defineGetProduct } from '../../src/tools/read/get-product.js';
import { wire } from '../projection/fixtures.js';
import { failing, loadFixtureClient, memoryLogger, override } from './client-stubs.js';

/**
 * The ceiling for the largest fixture's whole answer, product and stock
 * together: measured at 1,898 bytes when it was set, plus about 10% headroom.
 * The product detail alone has its own ceiling in the projection spec.
 */
const ANSWER_BYTE_CEILING = 2_100;

const TIMEOUT = new MagentoUnavailableError('shop.example.com', 'timeout');

function unauthorized(resource: string): MagentoRequestError {
    return new MagentoRequestError(401, {
        message: "The consumer isn't authorized to access %resources.",
        parameters: { resources: resource }
    });
}

let fixtures: FixtureMagentoClient;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

function tool(client: MagentoClient = fixtures, overrides: Partial<ToolDeps> = {}) {
    const { logger, output } = memoryLogger();
    const definition = defineGetProduct({ client, logger, sourceCode: 'default', stockId: 1, ...overrides });
    return { definition, log: output };
}

/** Calls the handler and returns the answer as it would cross stdio, checked against the output schema. */
async function answer(
    sku: string,
    client?: MagentoClient,
    overrides?: Partial<ToolDeps>
): Promise<{ result: GetProductOutput; text: string; log: string }> {
    const { definition, log } = tool(client, overrides);
    const { structuredContent, text } = await definition.handler({ sku });
    const result = wire(structuredContent);
    expect(GetProductOutputSchema.safeParse(result).success).toBe(true);
    return { result, text, log: log() };
}

/** The ToolError the handler throws for `sku`. */
async function refusal(sku: string, client: MagentoClient): Promise<ToolError> {
    const error: unknown = await tool(client).definition.handler({ sku }).then(
        () => undefined,
        (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
}

describe('get_product', () => {
    it('declares itself read-only, idempotent and open-world, all four hints explicit', () => {
        expect(tool().definition.annotations).toStrictEqual({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        });
    });

    it('answers with the product and its complete stock, and nothing to explain', async () => {
        const { result, text } = await answer('24-MB01');

        expect(result.product.sku).toBe('24-MB01');
        expect(result.product.name).toBe('Joust Duffle Bag');
        expect(result.stock).toStrictEqual({
            sourceCode: 'default',
            sourceQuantity: 100,
            sourceStatus: 'in_stock',
            salableQuantity: 97,
            isSalable: true,
            manageStock: true
        });
        expect(result).not.toHaveProperty('notice');
        expect(text).toBe('24-MB01 Joust Duffle Bag: 97 salable, 100 on hand at source "default".');
    });

    it('reports a product that is out of stock as such, not as missing data', async () => {
        const { result } = await answer('24-MB04');

        expect(result.stock).toStrictEqual({
            sourceCode: 'default',
            sourceQuantity: 0,
            sourceStatus: 'out_of_stock',
            salableQuantity: 0,
            isSalable: false,
            manageStock: true
        });
    });

    it('explains a grouped product, without logging the refusals its type draws by design', async () => {
        const { result, text, log } = await answer('24-WG085_Group');

        expect(result.stock).toStrictEqual({ sourceCode: 'default', isSalable: true });
        expect(result.notice).toContain('A grouped product has no stock of its own');
        expect(text).toBe(`24-WG085_Group Set of Sprite Yoga Straps: salable. ${result.notice}`);
        expect(log).toBe('');
    });

    it('reads the configured source', async () => {
        const { result } = await answer('24-MB01', fixtures, { sourceCode: 'warehouse_eu' });

        expect(result.stock.sourceCode).toBe('warehouse_eu');
        expect(result.stock.sourceQuantity).toBe(40);
    });

    it('says when the product is not assigned to the configured source', async () => {
        const { result } = await answer('24-UG06', fixtures, { sourceCode: 'warehouse_eu' });

        expect(result.stock).not.toHaveProperty('sourceQuantity');
        expect(result.notice).toBe(
            'The product is not assigned to source "warehouse_eu", so sourceQuantity and sourceStatus are absent.'
        );
    });

    it('carries a truncation notice from the product detail into the same notice', async () => {
        const { result, text } = await answer('WS12-M-Orange');

        expect(result.notice).toContain('description was truncated to 1000 characters.');
        expect(text.endsWith(result.notice ?? '')).toBe(true);
    });

    it("keeps the largest fixture's whole answer under the byte ceiling", async () => {
        const { result } = await answer('WS12-M-Orange');

        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(ANSWER_BYTE_CEILING);
    });

    describe('when the product does not exist', () => {
        it('refuses with NOT_FOUND and points at search_products', async () => {
            const error = await refusal('NO-SUCH-SKU', fixtures);

            expect(error.code).toBe('NOT_FOUND');
            expect(error.message).toBe("No product with SKU 'NO-SUCH-SKU'.");
            expect(error.suggestion).toBe('Use search_products to find the correct SKU.');
            expect(error.retryable).toBe(false);
        });
    });

    // This is what proves allSettled: with Promise.all, any one of these
    // failures would have thrown away the product and the other answers.
    describe('when one stock call fails, the others still answer', () => {
        const cases = [
            { method: 'getSalableQuantity', missing: ['salableQuantity'], named: 'salableQuantity is unavailable' },
            { method: 'isProductSalable', missing: ['isSalable'], named: 'isSalable is unavailable' }
        ] as const;

        it.each(cases)('$method failing loses only its own field', async ({ method, missing, named }) => {
            const { result, log } = await answer('24-MB01', failing(fixtures, method, TIMEOUT));

            expect(result.product.name).toBe('Joust Duffle Bag');
            for (const field of missing) expect(result.stock).not.toHaveProperty(field);
            expect(Object.keys(result.stock)).toHaveLength(6 - missing.length);
            expect(result.notice).toBe(
                `${named} (UPSTREAM_UNAVAILABLE): Magento at shop.example.com did not answer in time.`
            );
            expect(log).toContain('WARN get_product');
            expect(log).toContain('UPSTREAM_UNAVAILABLE');
        });

        it('getSourceItem failing on the default source falls back to the legacy quantity', async () => {
            const { result, log } = await answer('24-MB01', failing(fixtures, 'getSourceItem', TIMEOUT));

            expect(result.stock).toStrictEqual({
                sourceCode: 'default',
                sourceQuantity: 100,
                salableQuantity: 97,
                isSalable: true,
                manageStock: true
            });
            expect(result.notice).toContain('sourceQuantity comes from the legacy stock item instead');
            expect(log).toContain('WARN get_product sourceItem: UPSTREAM_UNAVAILABLE');
        });

        it('getSourceItem failing on another source loses both source fields', async () => {
            const { result } = await answer('24-MB01', failing(fixtures, 'getSourceItem', TIMEOUT), {
                sourceCode: 'warehouse_eu'
            });

            expect(result.stock).not.toHaveProperty('sourceQuantity');
            expect(result.stock).not.toHaveProperty('sourceStatus');
            expect(result.stock.salableQuantity).toBe(97);
        });

        it('all three failing still returns the product, with one sentence for the shared cause', async () => {
            let client: MagentoClient = fixtures;
            for (const method of ['getSourceItem', 'getSalableQuantity', 'isProductSalable'] as const) {
                client = failing(client, method, TIMEOUT);
            }

            const { result } = await answer('24-MB01', client, { sourceCode: 'warehouse_eu' });

            expect(result.product.sku).toBe('24-MB01');
            expect(result.stock).toStrictEqual({ sourceCode: 'warehouse_eu', manageStock: true });
            expect(result.notice).toBe(
                'sourceQuantity, sourceStatus, salableQuantity, and isSalable are unavailable ' +
                    '(UPSTREAM_UNAVAILABLE): Magento at shop.example.com did not answer in time.'
            );
        });
    });

    it('says manageStock is unknown when Magento omits the stock item', async () => {
        const product = (await fixtures.getProduct('24-MB01')) as RawProduct;
        const { stock_item: _dropped, ...extension } = product.extension_attributes ?? {};
        const client = override(fixtures, {
            getProduct: () => Promise.resolve({ ...product, extension_attributes: extension })
        });

        const { result } = await answer('24-MB01', client);

        expect(result.stock).not.toHaveProperty('manageStock');
        expect(result.notice).toContain('Magento_CatalogInventory::cataloginventory');
    });

    describe('when the product call itself fails', () => {
        it('reads a 401 as a missing resource once another call proved the token', async () => {
            const client = failing(fixtures, 'getProduct', unauthorized('Magento_Catalog::products'));

            const error = await refusal('24-MB01', client);

            expect(error.code).toBe('PERMISSION_DENIED');
            expect(error.message).toBe('The integration lacks access to Magento_Catalog::products.');
        });

        it('keeps both readings of a 401 open when no call proved the token', async () => {
            let client: MagentoClient = fixtures;
            for (const method of ['getProduct', 'getSourceItem', 'getSalableQuantity', 'isProductSalable'] as const) {
                client = failing(client, method, unauthorized('Magento_Catalog::products'));
            }

            const error = await refusal('24-MB01', client);

            expect(error.code).toBe('AUTH_FAILED');
            expect(error.suggestion).toContain('MAGENTO_ACCESS_TOKEN');
        });

        it('reports a 503 as retryable, since a read cannot be applied twice', async () => {
            const error = await refusal('24-MB01', failing(fixtures, 'getProduct', new MagentoRequestError(503)));

            expect(error.code).toBe('UPSTREAM_UNAVAILABLE');
            expect(error.retryable).toBe(true);
        });
    });
});
