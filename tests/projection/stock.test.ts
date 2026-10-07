import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/errors/tool-error.js';
import type { RawProduct, RawSourceItem } from '../../src/magento/raw-types.js';
import { StockDetailSchema } from '../../src/projection/fields.js';
import { projectStock, type Outcome, type StockInputs } from '../../src/projection/stock.js';
import { Notices } from '../../src/projection/truncate.js';
import { loadProduct, wire } from './fixtures.js';

const ok = <T>(value: T): Outcome<T> => ({ ok: true, value });
const failed = (error: ToolError): Outcome<never> => ({ ok: false, error });

const TIMEOUT = new ToolError('UPSTREAM_UNAVAILABLE', 'Magento at shop.example.com did not answer in time.');
const REFUSED = new ToolError('PERMISSION_DENIED', 'The integration lacks access to Magento_InventoryApi::source');

const NO_SOURCE_ITEMS = "Can't check requested quantity for products without Source Items support.";

const SOURCE_ITEM: RawSourceItem = { sku: '24-MB01', source_code: 'default', quantity: 100, status: 1 };

function withoutStockItem(raw: RawProduct): RawProduct {
    const { stock_item: _dropped, ...extension } = raw.extension_attributes ?? {};
    return { ...raw, extension_attributes: extension };
}

/** Every call answered, as for 24-MB01 on the default source. */
async function answered(overrides: Partial<StockInputs> = {}): Promise<StockInputs> {
    return {
        product: await loadProduct('24-MB01'),
        sourceCode: 'default',
        sourceItem: ok(SOURCE_ITEM),
        salableQuantity: ok(97),
        isSalable: ok(true),
        ...overrides
    };
}

function project(inputs: StockInputs): { stock: ReturnType<typeof projectStock>; notice: string | undefined } {
    const notices = new Notices();
    const stock = wire(projectStock(inputs, notices));
    expect(StockDetailSchema.safeParse(stock).success).toBe(true);
    return { stock, notice: notices.toNotice() };
}

describe('projectStock', () => {
    it('reads every field, with nothing to explain, when every call answered', async () => {
        const { stock, notice } = project(await answered());

        expect(stock).toStrictEqual({
            sourceCode: 'default',
            sourceQuantity: 100,
            sourceStatus: 'in_stock',
            salableQuantity: 97,
            isSalable: true,
            manageStock: true
        });
        expect(notice).toBeUndefined();
    });

    it('reads source status 0 as out of stock', async () => {
        const { stock } = project(await answered({ sourceItem: ok({ ...SOURCE_ITEM, quantity: 0, status: 0 }) }));

        expect(stock.sourceStatus).toBe('out_of_stock');
    });

    it('takes manageStock as Magento resolved it, whichever setting it inherits', async () => {
        const raw = await loadProduct('24-MB01');
        const stockItem = raw.extension_attributes?.stock_item;
        if (stockItem === undefined) throw new Error('fixture lacks stock_item');
        const unmanaged = {
            ...raw,
            extension_attributes: {
                ...raw.extension_attributes,
                stock_item: { ...stockItem, use_config_manage_stock: true, manage_stock: false }
            }
        };

        expect(project(await answered({ product: unmanaged })).stock.manageStock).toBe(false);
    });

    describe('a type without stock of its own', () => {
        it('keeps only isSalable, and says why, without reporting the expected refusals', async () => {
            const { stock, notice } = project(
                await answered({
                    product: await loadProduct('24-WG085_Group'),
                    sourceItem: ok(undefined),
                    salableQuantity: failed(new ToolError('INVALID_INPUT', NO_SOURCE_ITEMS))
                })
            );

            expect(stock).toStrictEqual({ sourceCode: 'default', isSalable: true });
            expect(notice).toBe(
                'A grouped product has no stock of its own: quantities are tracked on its children, so only ' +
                    'isSalable applies.'
            );
        });

        it('still reports isSalable failing', async () => {
            const { stock, notice } = project(
                await answered({ product: await loadProduct('24-WG085_Group'), isSalable: failed(TIMEOUT) })
            );

            expect(stock).toStrictEqual({ sourceCode: 'default' });
            expect(notice).toContain('isSalable is unavailable (UPSTREAM_UNAVAILABLE): Magento at shop.example.com');
        });
    });

    it('says the product is not assigned to the source when there is no source item', async () => {
        const { stock, notice } = project(await answered({ sourceCode: 'warehouse_us', sourceItem: ok(undefined) }));

        expect(stock).not.toHaveProperty('sourceQuantity');
        expect(stock).not.toHaveProperty('sourceStatus');
        expect(notice).toBe(
            'The product is not assigned to source "warehouse_us", so sourceQuantity and sourceStatus are absent.'
        );
    });

    describe('when the source item could not be read', () => {
        it('falls back to the legacy quantity on the default source, which it mirrors', async () => {
            const { stock, notice } = project(await answered({ sourceItem: failed(TIMEOUT) }));

            expect(stock.sourceQuantity).toBe(100);
            expect(stock).not.toHaveProperty('sourceStatus');
            expect(notice).toBe(
                'The source item could not be read (UPSTREAM_UNAVAILABLE): Magento at shop.example.com did not ' +
                    'answer in time. sourceQuantity comes from the legacy stock item instead, and sourceStatus is ' +
                    'unknown.'
            );
        });

        it('does not fall back on any other source, which the legacy item does not mirror', async () => {
            const { stock, notice } = project(
                await answered({ sourceCode: 'warehouse_eu', sourceItem: failed(TIMEOUT) })
            );

            expect(stock).not.toHaveProperty('sourceQuantity');
            expect(notice).toBe(
                'sourceQuantity and sourceStatus are unavailable (UPSTREAM_UNAVAILABLE): Magento at ' +
                    'shop.example.com did not answer in time.'
            );
        });

        it('does not fall back without a stock item', async () => {
            const product = withoutStockItem(await loadProduct('24-MB01'));
            const { stock } = project(await answered({ product, sourceItem: failed(TIMEOUT) }));

            expect(stock).not.toHaveProperty('sourceQuantity');
        });
    });

    it('reports salableQuantity and isSalable failing, each on its own', async () => {
        const salable = project(await answered({ salableQuantity: failed(TIMEOUT) }));
        const flag = project(await answered({ isSalable: failed(REFUSED) }));

        expect(salable.stock).not.toHaveProperty('salableQuantity');
        expect(salable.stock.isSalable).toBe(true);
        expect(salable.notice).toContain('salableQuantity is unavailable (UPSTREAM_UNAVAILABLE)');

        expect(flag.stock).not.toHaveProperty('isSalable');
        expect(flag.stock.salableQuantity).toBe(97);
        expect(flag.notice).toBe(
            'isSalable is unavailable (PERMISSION_DENIED): The integration lacks access to ' +
                'Magento_InventoryApi::source.'
        );
    });

    it('says when salable quantity answered with nothing', async () => {
        const { stock, notice } = project(await answered({ salableQuantity: ok(undefined) }));

        expect(stock).not.toHaveProperty('salableQuantity');
        expect(notice).toBe('salableQuantity is unavailable: Magento reported none for this SKU.');
    });

    it('groups the fields lost to the same failure into one sentence', async () => {
        const { notice } = project(
            await answered({
                sourceCode: 'warehouse_eu',
                sourceItem: failed(TIMEOUT),
                salableQuantity: failed(TIMEOUT),
                isSalable: failed(REFUSED)
            })
        );

        expect(notice).toBe(
            'sourceQuantity, sourceStatus, and salableQuantity are unavailable (UPSTREAM_UNAVAILABLE): Magento at ' +
                'shop.example.com did not answer in time. isSalable is unavailable (PERMISSION_DENIED): The ' +
                'integration lacks access to Magento_InventoryApi::source.'
        );
    });

    it('says manageStock is unknown when Magento omitted the stock item', async () => {
        const product = withoutStockItem(await loadProduct('24-MB01'));
        const { stock, notice } = project(await answered({ product }));

        expect(stock).not.toHaveProperty('manageStock');
        expect(stock.sourceQuantity).toBe(100);
        expect(notice).toBe(
            "manageStock is unknown: Magento omitted the product's stock item, as it does when the integration " +
                'lacks the Magento_CatalogInventory::cataloginventory resource.'
        );
    });
});
