import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MagentoRequestError, type OrderSearchParams, type ProductSearchParams } from '../../src/magento/client.js';
import { FixtureMagentoClient } from '../../src/magento/fixture-client.js';

const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));
const NOW = new Date('2026-03-11T08:00:00Z');

let client: FixtureMagentoClient;

// Writes mutate memory, so every test starts from the committed fixtures.
beforeEach(async () => {
    client = await FixtureMagentoClient.load(FIXTURES, { now: () => NOW });
});

async function productSkus(params: Partial<ProductSearchParams>): Promise<string[]> {
    const result = await client.searchProducts({ page: 1, pageSize: 50, ...params });
    return result.items.map((p) => p.sku);
}

async function orderIds(params: Partial<OrderSearchParams>): Promise<string[]> {
    const result = await client.searchOrders({ page: 1, pageSize: 50, ...params });
    return result.items.map((o) => o.increment_id);
}

async function refusal(promise: Promise<unknown>): Promise<MagentoRequestError> {
    const error = await promise.then(
        () => undefined,
        (e: unknown) => e
    );
    expect(error).toBeInstanceOf(MagentoRequestError);
    return error as MagentoRequestError;
}

describe('FixtureMagentoClient.load', () => {
    let dir: string;

    /** A private copy of the committed fixtures, for a test to break. */
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'magento-fixtures-'));
        await cp(FIXTURES, dir, { recursive: true });
    });

    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('loads the committed fixtures', async () => {
        await expect(FixtureMagentoClient.load(dir)).resolves.toBeInstanceOf(FixtureMagentoClient);
    });

    it('names the resolved directory when it does not exist', async () => {
        const missing = join(dir, 'nope');
        await expect(FixtureMagentoClient.load(missing)).rejects.toThrow(`Fixture directory ${missing} does not exist`);
    });

    it('names a missing inventory file', async () => {
        await rm(join(dir, 'inventory', 'salable.json'));
        await expect(FixtureMagentoClient.load(dir)).rejects.toThrow(join(dir, 'inventory', 'salable.json'));
    });

    it('names the file holding invalid JSON', async () => {
        const file = join(dir, 'orders', '000000003.json');
        await writeFile(file, '{ "increment_id": ');
        await expect(FixtureMagentoClient.load(dir)).rejects.toThrow(`Fixture file ${file} is not valid JSON`);
    });

    it('names the file missing its key field', async () => {
        const file = join(dir, 'products', '24-MG03.json');
        const { sku: _sku, ...withoutSku } = JSON.parse(await readFile(file, 'utf8')) as { sku: string };
        await writeFile(file, JSON.stringify(withoutSku));
        await expect(FixtureMagentoClient.load(dir)).rejects.toThrow(`${file} is missing "sku"`);
    });

    it('rejects a key that differs from another only in case, naming both files', async () => {
        const original = join(dir, 'products', '24-MB01.json');
        const copy = join(dir, 'products', 'zz-copy.json');
        const product = JSON.parse(await readFile(original, 'utf8')) as { sku: string };
        await writeFile(copy, JSON.stringify({ ...product, sku: '24-mb01' }));

        await expect(FixtureMagentoClient.load(dir)).rejects.toThrow(
            `Duplicate sku "24-mb01" in ${original} and ${copy}.`
        );
    });

    it('rejects a salable quantity above the in-stock on-hand, which would need a positive reservation', async () => {
        const file = join(dir, 'inventory', 'salable.json');
        const rows = JSON.parse(await readFile(file, 'utf8')) as { sku: string; salable_quantity?: number }[];
        await writeFile(
            file,
            JSON.stringify(rows.map((r) => (r.sku === '24-MG03' ? { ...r, salable_quantity: 16 } : r)))
        );
        await expect(FixtureMagentoClient.load(dir)).rejects.toThrow('24-MG03 has salable_quantity 16');
    });

    it('never writes to disk: a reload after a write sees the committed values', async () => {
        const writer = await FixtureMagentoClient.load(dir);
        await writer.updateSourceItem({ sku: '24-MB01', sourceCode: 'default', quantity: 5, status: 'in_stock' });

        const reloaded = await FixtureMagentoClient.load(dir);
        expect((await reloaded.getSourceItem('24-MB01', 'default'))?.quantity).toBe(100);
        expect(await reloaded.getSalableQuantity('24-MB01', 1)).toBe(97);
    });
});

describe('searchProducts', () => {
    it('returns everything, newest first and sku ascending on a tie, with no filters', async () => {
        expect(await productSkus({})).toEqual([
            '24-MG03',
            '24-UG06',
            // Same created_at: the sku tiebreak decides.
            '24-MB01',
            '24-MB04',
            '24-WG085_Group',
            'WS12-M-Orange'
        ]);
    });

    it('matches a name substring case-insensitively', async () => {
        expect(await productSkus({ name: 'DUFFLE' })).toEqual(['24-MB01']);
    });

    it('matches a SKU substring case-insensitively', async () => {
        expect(await productSkus({ sku: '24-mb0' })).toEqual(['24-MB01', '24-MB04']);
    });

    it('treats _ and % as literal characters, as the escaped like does', async () => {
        expect(await productSkus({ sku: '_' })).toEqual(['24-WG085_Group']);
        expect(await productSkus({ sku: '%' })).toEqual([]);
    });

    it('filters by direct category assignment', async () => {
        expect(await productSkus({ categoryId: 4 })).toEqual(['24-MB01', '24-MB04']);
        expect(await productSkus({ categoryId: 5 })).toEqual(['24-UG06', '24-WG085_Group']);
    });

    it('filters by an inclusive price range', async () => {
        expect(await productSkus({ priceMin: 32, priceMax: 34 })).toEqual(['24-MB01', '24-MB04']);
    });

    it('excludes a product without a price from any price filter, even priceMin 0', async () => {
        const skus = await productSkus({ priceMin: 0 });
        expect(skus).toHaveLength(5);
        expect(skus).not.toContain('24-WG085_Group');
    });

    it('ANDs filters together', async () => {
        expect(await productSkus({ categoryId: 3, priceMax: 10 })).toEqual(['24-UG06']);
    });

    it('slices pages and reports the true total', async () => {
        const second = await client.searchProducts({ page: 2, pageSize: 4 });
        expect(second.items.map((p) => p.sku)).toEqual(['24-WG085_Group', 'WS12-M-Orange']);
        expect(second.total_count).toBe(6);
    });

    it('answers a page past the end with no items and the true total', async () => {
        const past = await client.searchProducts({ page: 99, pageSize: 4 });
        expect(past.items).toEqual([]);
        expect(past.total_count).toBe(6);
    });

    it('answers no match with an empty page, not undefined', async () => {
        expect(await client.searchProducts({ name: 'no such thing', page: 1, pageSize: 20 })).toEqual({
            items: [],
            total_count: 0
        });
    });

    it('leaves the legacy stock item out of search results, as Magento does', async () => {
        const { items } = await client.searchProducts({ sku: '24-MB01', page: 1, pageSize: 1 });
        expect(items[0]?.extension_attributes?.stock_item).toBeUndefined();
        expect(items[0]?.extension_attributes?.category_links).toBeDefined();
        expect((await client.getProduct('24-MB01'))?.extension_attributes?.stock_item).toBeDefined();
    });

    it('refuses invalid paging', async () => {
        await expect(client.searchProducts({ page: 0, pageSize: 20 })).rejects.toThrow(RangeError);
    });
});

describe('searchOrders', () => {
    it('returns newest first, increment_id descending on a tie', async () => {
        expect(await orderIds({})).toEqual(['000000005', '000000004', '000000003', '000000002', '000000001']);
    });

    it('filters by exact status', async () => {
        expect(await orderIds({ status: 'processing' })).toEqual(['000000003']);
    });

    it('filters by customer email case-insensitively, guest orders included', async () => {
        expect(await orderIds({ email: 'Roni_Cost@Example.com' })).toEqual(['000000005', '000000002', '000000001']);
        expect(await orderIds({ email: 'sam.rivera@example.net' })).toEqual(['000000004']);
    });

    it('includes the whole createdTo day and nothing after it, in UTC', async () => {
        // 000000003 is 2026-03-04 23:30:00; 000000004 is 2026-03-05 00:00:00.
        expect(await orderIds({ createdTo: '2026-03-04' })).toEqual(['000000003', '000000002', '000000001']);
    });

    it('starts createdFrom at the first second of the day', async () => {
        expect(await orderIds({ createdFrom: '2026-03-05' })).toEqual(['000000005', '000000004']);
        expect(await orderIds({ createdFrom: '2026-03-04', createdTo: '2026-03-04' })).toEqual(['000000003']);
    });

    it('refuses a malformed date exactly as the http mapper does', async () => {
        await expect(client.searchOrders({ createdFrom: '2026-02-30', page: 1, pageSize: 20 })).rejects.toThrow(
            RangeError
        );
    });

    it('slices pages and reports the true total', async () => {
        const second = await client.searchOrders({ page: 2, pageSize: 2 });
        expect(second.items.map((o) => o.increment_id)).toEqual(['000000003', '000000002']);
        expect(second.total_count).toBe(5);
    });
});

describe('lookups', () => {
    it('answers undefined for every entity that does not exist', async () => {
        expect(await client.getProduct('NO-SUCH-SKU')).toBeUndefined();
        expect(await client.getSourceItem('NO-SUCH-SKU', 'default')).toBeUndefined();
        expect(await client.getSalableQuantity('NO-SUCH-SKU', 1)).toBeUndefined();
        expect(await client.findOrderByIncrementId('000000999')).toBeUndefined();
        expect(await client.getCustomerById(999_999)).toBeUndefined();
        expect(await client.findCustomerByEmail('nobody@example.com')).toBeUndefined();
    });

    it('compares keys case-insensitively', async () => {
        expect((await client.getProduct('24-mb01'))?.sku).toBe('24-MB01');
        expect((await client.findCustomerByEmail('JORDAN.ELLIS@EXAMPLE.COM'))?.id).toBe(2);
    });

    it('finds an order by increment ID with its full payload', async () => {
        const order = await client.findOrderByIncrementId('000000005');
        expect(order?.entity_id).toBe(5);
        expect(order?.status_histories).toHaveLength(1);
    });

    it('reads the source item at the requested source only', async () => {
        expect((await client.getSourceItem('24-MB01', 'default'))?.quantity).toBe(100);
        expect((await client.getSourceItem('24-MB01', 'warehouse_eu'))?.quantity).toBe(40);
        expect(await client.getSourceItem('24-UG06', 'warehouse_eu')).toBeUndefined();
    });

    it('answers undefined for a product with no source item, such as grouped', async () => {
        expect(await client.getSourceItem('24-WG085_Group', 'default')).toBeUndefined();
    });
});

describe('MSI stock reads', () => {
    it('reads salable quantity below on-hand where open orders reserve stock', async () => {
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(97);
        expect(await client.isProductSalable('24-MB01', 1)).toBe(true);
    });

    it('refuses salable quantity for a composite type with Magento\'s 400', async () => {
        const error = await refusal(client.getSalableQuantity('24-WG085_Group', 1));
        expect(error.status).toBe(400);
        expect(error.body?.message).toBe("Can't check requested quantity for products without Source Items support.");
    });

    it('answers is-salable for a composite with the stored value', async () => {
        expect(await client.isProductSalable('24-WG085_Group', 1)).toBe(true);
    });

    it('answers false, not undefined, for is-salable on an unknown SKU', async () => {
        expect(await client.isProductSalable('NO-SUCH-SKU', 1)).toBe(false);
    });

    it('reads 0 and false where a stock has no row for the SKU', async () => {
        expect(await client.getSalableQuantity('24-MB01', 2)).toBe(0);
        expect(await client.isProductSalable('24-MB01', 2)).toBe(false);
    });
});

describe('updateSourceItem', () => {
    const setMb01 = (quantity: number, status: 'in_stock' | 'out_of_stock' = 'in_stock') =>
        client.updateSourceItem({ sku: '24-MB01', sourceCode: 'default', quantity, status });

    it('carries the reservations through each write: 100 → 0 → 50 gives 97 → 0 → 47', async () => {
        await setMb01(0, 'out_of_stock');
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(0);
        expect(await client.isProductSalable('24-MB01', 1)).toBe(false);

        await setMb01(50);
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(47);
        expect(await client.isProductSalable('24-MB01', 1)).toBe(true);
    });

    it('never reports a negative salable quantity when on-hand falls below the reservations', async () => {
        await setMb01(2);
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(0);
        expect(await client.isProductSalable('24-MB01', 1)).toBe(false);
    });

    it('counts an out-of-stock source as nothing on hand', async () => {
        await setMb01(100, 'out_of_stock');
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(0);
        expect((await client.getSourceItem('24-MB01', 'default'))?.status).toBe(0);
    });

    it('syncs the legacy stock item from the default source', async () => {
        await setMb01(60);
        expect((await client.getProduct('24-MB01'))?.extension_attributes?.stock_item).toMatchObject({
            qty: 60,
            is_in_stock: true
        });
    });

    it('marks the legacy stock item out of stock at quantity 0 even when the source says in stock', async () => {
        await setMb01(0, 'in_stock');
        expect((await client.getSourceItem('24-MB01', 'default'))?.status).toBe(1);
        expect((await client.getProduct('24-MB01'))?.extension_attributes?.stock_item).toMatchObject({
            qty: 0,
            is_in_stock: false
        });
    });

    it('leaves the legacy stock item and salable quantity alone for another source', async () => {
        await client.updateSourceItem({ sku: '24-MB01', sourceCode: 'warehouse_eu', quantity: 1, status: 'in_stock' });

        expect((await client.getSourceItem('24-MB01', 'warehouse_eu'))?.quantity).toBe(1);
        expect((await client.getProduct('24-MB01'))?.extension_attributes?.stock_item?.qty).toBe(100);
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(97);
    });

    it('upserts a row that did not exist', async () => {
        await client.updateSourceItem({ sku: '24-MG03', sourceCode: 'warehouse_eu', quantity: 8, status: 'in_stock' });
        expect(await client.getSourceItem('24-MG03', 'warehouse_eu')).toEqual({
            sku: '24-MG03',
            source_code: 'warehouse_eu',
            quantity: 8,
            status: 1
        });
    });

    it('updates the stored row when the SKU differs only in case, keeping its casing', async () => {
        await client.updateSourceItem({ sku: '24-mb01', sourceCode: 'DEFAULT', quantity: 70, status: 'in_stock' });
        expect(await client.getSourceItem('24-MB01', 'default')).toEqual({
            sku: '24-MB01',
            source_code: 'default',
            quantity: 70,
            status: 1
        });
        expect(await client.getSalableQuantity('24-MB01', 1)).toBe(67);
    });

    it('creates no salable row where there was none', async () => {
        await client.updateSourceItem({ sku: '24-WG085_Group', sourceCode: 'default', quantity: 5, status: 'in_stock' });
        await expect(client.getSalableQuantity('24-WG085_Group', 1)).rejects.toBeInstanceOf(MagentoRequestError);
        expect(await client.isProductSalable('24-WG085_Group', 1)).toBe(true);
    });
});

describe('addOrderComment', () => {
    const comment = { comment: 'Checked with the warehouse.', notifyCustomer: false, visibleOnFront: false };

    it('prepends the entry, newest first, stamped by the injected clock', async () => {
        await client.addOrderComment(5, { ...comment, notifyCustomer: true, visibleOnFront: true });

        const histories = (await client.findOrderByIncrementId('000000005'))?.status_histories ?? [];
        expect(histories).toHaveLength(2);
        expect(histories[0]).toEqual({
            comment: 'Checked with the warehouse.',
            created_at: '2026-03-11 08:00:00',
            entity_id: 4,
            is_customer_notified: 1,
            is_visible_on_front: 1,
            parent_id: 5,
            status: 'holded'
        });
        expect(histories[1]?.comment).toContain('hold the shipment');
    });

    it('records the current status and leaves the order alone when no status is given', async () => {
        await client.addOrderComment(3, comment);

        const order = await client.findOrderByIncrementId('000000003');
        expect(order?.status).toBe('processing');
        expect(order?.status_histories?.[0]).toMatchObject({ status: 'processing', is_customer_notified: 0 });
    });

    it('applies a status of the current state to the order, as 2.4.9 does', async () => {
        await client.addOrderComment(3, { ...comment, status: 'fraud' });

        const order = await client.findOrderByIncrementId('000000003');
        expect(order?.status).toBe('fraud');
        expect(order?.state).toBe('processing');
        expect(order?.status_histories?.[0]?.status).toBe('fraud');
    });

    it('refuses a status outside the current state with Magento\'s 400 and its parameter', async () => {
        const error = await refusal(client.addOrderComment(3, { ...comment, status: 'complete' }));

        expect(error.status).toBe(400);
        expect(error.body).toEqual({
            message: 'Unable to add comment: The status "%1" is not part of the order status history.',
            parameters: ['complete']
        });
        expect((await client.findOrderByIncrementId('000000003'))?.status_histories).toEqual([]);
    });

    it('compares the status case-sensitively, as array_key_exists does', async () => {
        const error = await refusal(client.addOrderComment(3, { ...comment, status: 'Fraud' }));
        expect(error.status).toBe(400);
    });

    it('refuses an unknown order with Magento\'s 404', async () => {
        const error = await refusal(client.addOrderComment(999, comment));
        expect(error.status).toBe(404);
    });
});

describe('isolation', () => {
    it('hands out copies: mutating a result does not reach the store', async () => {
        const product = await client.getProduct('24-MB01');
        (product as { name: string }).name = 'Tampered';
        const page = await client.searchOrders({ page: 1, pageSize: 1 });
        (page.items[0] as { status: string }).status = 'tampered';

        expect((await client.getProduct('24-MB01'))?.name).toBe('Joust Duffle Bag');
        expect((await client.searchOrders({ page: 1, pageSize: 1 })).items[0]?.status).toBe('holded');
    });
});
