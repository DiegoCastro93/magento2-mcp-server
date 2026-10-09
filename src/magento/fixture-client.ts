/**
 * The fixture adapter: serves canned Magento payloads from a directory, and
 * filters, sorts and paginates them the way Magento 2.4.9 does, so a clone
 * with no Magento is a real demo rather than a stub.
 *
 * The boundary rules it shares with the http adapter — date boundaries, sort
 * specs, paging guards — are imported from `search-criteria.ts`, not restated.
 * Writes change memory only: a restart returns to the committed files.
 *
 * Layout, keyed by each payload's own fields rather than by filename:
 *
 *     products/*.json              one RawProduct each, keyed by `sku`
 *     orders/*.json                one RawOrder each, keyed by `increment_id` and `entity_id`
 *     customers/*.json             one RawCustomer each, keyed by `id` and `email`
 *     inventory/source-items.json  RawSourceItem[]
 *     inventory/salable.json       SalableRow[], one per SKU and stock
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
    MagentoRequestError,
    SOURCE_ITEM_STATUS,
    type MagentoClient,
    type OrderCommentInput,
    type OrderSearchParams,
    type ProductSearchParams,
    type SourceItemUpdate
} from './client.js';
import { hasOwnStock } from './product-types.js';
import type {
    RawCustomer,
    RawOrder,
    RawOrderStatusHistory,
    RawProduct,
    RawSearchResult,
    RawSourceItem
} from './raw-types.js';
import {
    ORDER_SORT,
    PRODUCT_SORT,
    assertPaging,
    endOfDay,
    startOfDay,
    type SortOrder
} from './search-criteria.js';

/**
 * What the two MSI stock endpoints answer for one SKU on one stock.
 * `salable_quantity` is absent for a type without source items.
 */
export interface SalableRow {
    readonly sku: string;
    readonly stock_id: number;
    readonly salable_quantity?: number;
    readonly is_salable: boolean;
}

export interface FixtureClientOptions {
    /** Clock for comment timestamps. */
    readonly now?: () => Date;
}

/**
 * The fixtures model a single-source install, which is v1's scope: the source
 * coded `default` is the only one feeding the default stock, id 1. Magento
 * syncs the legacy stock item from this source alone.
 */
const DEFAULT_SOURCE_CODE = 'default';
const DEFAULT_STOCK_ID = 1;

// Magento's own messages for the refusals the fixture reproduces.
const UNKNOWN_ORDER = "The entity that was requested doesn't exist. Verify the entity and try again.";
const NO_SOURCE_ITEMS = "Can't check requested quantity for products without Source Items support.";

export class FixtureMagentoClient implements MagentoClient {
    private readonly products: Map<string, RawProduct>;
    private readonly orders: Map<number, RawOrder>;
    private readonly customers: Map<number, RawCustomer>;
    private sourceItems: readonly RawSourceItem[];
    private readonly salable: Map<string, SalableRow>;
    /** Reservations on the default stock, ≤ 0: literal salable minus in-stock on-hand. */
    private readonly reservations: ReadonlyMap<string, number>;
    private readonly now: () => Date;
    private nextHistoryId: number;

    private constructor(data: FixtureData, now: () => Date) {
        this.products = new Map(data.products.map((p) => [ci(p.sku), p]));
        this.orders = new Map(data.orders.map((o) => [o.entity_id, o]));
        this.customers = new Map(data.customers.map((c) => [c.id, c]));
        this.sourceItems = data.sourceItems;
        this.salable = new Map(data.salable.map((row) => [salableKey(row.sku, row.stock_id), row]));
        this.reservations = data.reservations;
        this.now = now;
        this.nextHistoryId =
            Math.max(0, ...data.orders.flatMap((o) => o.status_histories ?? []).map(historyId)) + 1;
    }

    /**
     * Reads and checks every fixture up front, so a wrong directory fails at
     * startup with a readable message rather than on the first tool call.
     *
     * @throws {Error} naming the resolved path, and the file where one is at fault.
     */
    static async load(dir: string, options: FixtureClientOptions = {}): Promise<FixtureMagentoClient> {
        const data = await loadFixtureData(resolve(dir));
        return new FixtureMagentoClient(data, options.now ?? (() => new Date()));
    }

    async searchProducts(params: ProductSearchParams): Promise<RawSearchResult<RawProduct>> {
        const { name, sku, categoryId, priceMin, priceMax } = params;
        const matches = [...this.products.values()].filter(
            (p) =>
                (name === undefined || ci(p.name).includes(ci(name))) &&
                (sku === undefined || ci(p.sku).includes(ci(sku))) &&
                (categoryId === undefined ||
                    (p.extension_attributes?.category_links ?? []).some(
                        (link) => link.category_id === String(categoryId)
                    )) &&
                // A missing price never matches, as NULL fails any SQL comparison.
                (priceMin === undefined || (p.price != null && p.price >= priceMin)) &&
                (priceMax === undefined || (p.price != null && p.price <= priceMax))
        );
        return page(sortBy(matches, PRODUCT_SORT), params, withoutStockItem);
    }

    async getProduct(sku: string): Promise<RawProduct | undefined> {
        return copy(this.products.get(ci(sku)));
    }

    async getSourceItem(sku: string, sourceCode: string): Promise<RawSourceItem | undefined> {
        return copy(this.findSourceItem(sku, sourceCode));
    }

    async getSalableQuantity(sku: string, stockId: number): Promise<number | undefined> {
        const product = this.products.get(ci(sku));
        if (product === undefined) return undefined;
        if (!hasOwnStock(product.type_id)) {
            throw new MagentoRequestError(400, { message: NO_SOURCE_ITEMS });
        }
        // No stock data at all reads as 0 (`GetProductSalableQty`).
        return this.salable.get(salableKey(sku, stockId))?.salable_quantity ?? 0;
    }

    async isProductSalable(sku: string, stockId: number): Promise<boolean> {
        if (!this.products.has(ci(sku))) return false;
        return this.salable.get(salableKey(sku, stockId))?.is_salable ?? false;
    }

    async searchOrders(params: OrderSearchParams): Promise<RawSearchResult<RawOrder>> {
        const { status, email } = params;
        // Converted before filtering, so a malformed date throws exactly as the http mapper does.
        const from = params.createdFrom === undefined ? undefined : startOfDay(params.createdFrom);
        const to = params.createdTo === undefined ? undefined : endOfDay(params.createdTo);

        const matches = [...this.orders.values()].filter(
            (o) =>
                (status === undefined || ci(o.status) === ci(status)) &&
                (email === undefined || ci(o.customer_email) === ci(email)) &&
                (from === undefined || o.created_at >= from) &&
                (to === undefined || o.created_at <= to)
        );
        return page(sortBy(matches, ORDER_SORT), params);
    }

    async findOrderByIncrementId(incrementId: string): Promise<RawOrder | undefined> {
        return copy([...this.orders.values()].find((o) => ci(o.increment_id) === ci(incrementId)));
    }

    async getCustomerById(customerId: number): Promise<RawCustomer | undefined> {
        return copy(this.customers.get(customerId));
    }

    async findCustomerByEmail(email: string): Promise<RawCustomer | undefined> {
        return copy([...this.customers.values()].find((c) => ci(c.email) === ci(email)));
    }

    /**
     * Upserts the source item. On the default source it also does what 2.4.9's
     * save plugins do: syncs the legacy stock item, and recomputes the default
     * stock's salable row from the new on-hand and the reservations.
     */
    async updateSourceItem(update: SourceItemUpdate): Promise<void> {
        const status = SOURCE_ITEM_STATUS[update.status];
        const existing = this.findSourceItem(update.sku, update.sourceCode);
        this.sourceItems =
            existing === undefined
                ? [
                      ...this.sourceItems,
                      { sku: update.sku, source_code: update.sourceCode, quantity: update.quantity, status }
                  ]
                : this.sourceItems.map((item) =>
                      // The stored key keeps its casing, as an ON DUPLICATE KEY update does.
                      item === existing ? { ...item, quantity: update.quantity, status } : item
                  );

        if (ci(update.sourceCode) !== DEFAULT_SOURCE_CODE) return;
        this.syncLegacyStockItem(update.sku, update.quantity, status);
        this.recomputeSalable(update.sku, status === SOURCE_ITEM_STATUS.in_stock ? update.quantity : 0);
    }

    /** Replicates `OrderService::addComment` called without a status. */
    async addOrderComment(orderId: number, input: OrderCommentInput): Promise<void> {
        const order = this.orders.get(orderId);
        if (order === undefined) {
            throw new MagentoRequestError(404, { message: UNKNOWN_ORDER });
        }

        const createdAt = toMagentoTimestamp(this.now());

        const entry = {
            comment: input.comment,
            created_at: createdAt,
            entity_id: this.nextHistoryId++,
            is_customer_notified: input.notifyCustomer ? 1 : 0,
            is_visible_on_front: input.visibleOnFront ? 1 : 0,
            parent_id: order.entity_id,
            status: order.status
        };

        this.orders.set(orderId, {
            ...order,
            updated_at: createdAt,
            status_histories: [entry, ...(order.status_histories ?? [])]
        });
    }

    private findSourceItem(sku: string, sourceCode: string): RawSourceItem | undefined {
        return this.sourceItems.find(
            (item) => ci(item.sku) === ci(sku) && ci(item.source_code) === ci(sourceCode)
        );
    }

    /**
     * `SetDataToLegacyCatalogInventory`: qty and in-stock flag follow the source,
     * except that managed stock at or below the minimum (0 here) is forced out
     * of stock. A product without a legacy stock item is left alone.
     */
    private syncLegacyStockItem(sku: string, quantity: number, status: number): void {
        const product = this.products.get(ci(sku));
        const stockItem = product?.extension_attributes?.stock_item;
        if (product === undefined || stockItem === undefined) return;

        const inStock = status === SOURCE_ITEM_STATUS.in_stock && !(stockItem.manage_stock && quantity <= 0);
        this.products.set(ci(sku), {
            ...product,
            extension_attributes: {
                ...product.extension_attributes,
                stock_item: { ...stockItem, qty: quantity, is_in_stock: inStock }
            }
        });
    }

    /**
     * After a default-source save, 2.4.9 sets the default stock's status to
     * `on-hand + reservations − minQty > 0` (`UpdateDefaultStock`), and salable
     * quantity reads 0 while that status is false. With minQty 0 that is
     * `max(0, on-hand + reservations)`. Assumes managed stock and no backorders,
     * which is how every fixture product is set up. No row is created where
     * none exists.
     */
    private recomputeSalable(sku: string, onHandInStock: number): void {
        const key = salableKey(sku, DEFAULT_STOCK_ID);
        const row = this.salable.get(key);
        if (row?.salable_quantity === undefined) return;

        const available = onHandInStock + (this.reservations.get(ci(sku)) ?? 0);
        this.salable.set(key, { ...row, salable_quantity: Math.max(0, available), is_salable: available > 0 });
    }
}

// ------------------------------------------------------------------ helpers

/** Keyed lookups and `eq`/`like` compare case-insensitively, like MySQL's `_ci` collations. */
function ci(value: string): string {
    return value.toLowerCase();
}

function salableKey(sku: string, stockId: number): string {
    return `${stockId}:${ci(sku)}`;
}

/** Every result is a fresh copy, the way each HTTP response is fresh JSON. */
function copy<T>(value: T | undefined): T | undefined {
    return value === undefined ? undefined : structuredClone(value);
}

/** Search results never carry the legacy stock item; only the single-product GET does. */
function withoutStockItem(product: RawProduct): RawProduct {
    if (product.extension_attributes?.stock_item === undefined) return product;
    const { stock_item: _dropped, ...extension } = product.extension_attributes;
    return { ...product, extension_attributes: extension };
}

function page<T>(
    sorted: readonly T[],
    { page: current, pageSize }: { readonly page: number; readonly pageSize: number },
    shape: (item: T) => T = (item) => item
): RawSearchResult<T> {
    assertPaging(current, pageSize);
    const start = (current - 1) * pageSize;
    return {
        items: sorted.slice(start, start + pageSize).map((item) => structuredClone(shape(item))),
        total_count: sorted.length
    };
}

/** Interprets the same sort specs the http mappers send. */
function sortBy<T extends object>(items: T[], spec: readonly SortOrder[]): T[] {
    return items.sort((a, b) => {
        for (const { field, direction } of spec) {
            const order = compareValues(fieldOf(a, field), fieldOf(b, field));
            if (order !== 0) return direction === 'ASC' ? order : -order;
        }
        return 0;
    });
}

function fieldOf(item: object, field: string): unknown {
    return (item as Record<string, unknown>)[field];
}

function compareValues(a: unknown, b: unknown): number {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    const left = ci(String(a));
    const right = ci(String(b));
    return left < right ? -1 : left > right ? 1 : 0;
}

function historyId(entry: RawOrderStatusHistory): number {
    const id = (entry as { entity_id?: unknown }).entity_id;
    return typeof id === 'number' ? id : 0;
}

/** Magento's timestamp format: UTC, `YYYY-MM-DD HH:MM:SS`. */
function toMagentoTimestamp(date: Date): string {
    return date.toISOString().slice(0, 19).replace('T', ' ');
}

// ------------------------------------------------------------------ loading

interface FixtureData {
    readonly products: readonly RawProduct[];
    readonly orders: readonly RawOrder[];
    readonly customers: readonly RawCustomer[];
    readonly sourceItems: readonly RawSourceItem[];
    readonly salable: readonly SalableRow[];
    readonly reservations: ReadonlyMap<string, number>;
}

interface LoadedFile {
    readonly file: string;
    readonly data: unknown;
}

async function loadFixtureData(root: string): Promise<FixtureData> {
    try {
        await readdir(root);
    } catch {
        throw new Error(`Fixture directory ${root} does not exist or cannot be read.`);
    }

    // Promise.all, not allSettled: a missing fixture is a startup failure, not
    // something to degrade around.
    const [productFiles, orderFiles, customerFiles, sourceItemsFile, salableFile] = await Promise.all([
        readJsonDir(join(root, 'products')),
        readJsonDir(join(root, 'orders')),
        readJsonDir(join(root, 'customers')),
        readJsonFile(join(root, 'inventory', 'source-items.json')),
        readJsonFile(join(root, 'inventory', 'salable.json'))
    ]);

    const products = productFiles.map(({ file, data }) => {
        requireFields(file, data, { sku: 'string', type_id: 'string' });
        return data as RawProduct;
    });
    rejectDuplicates(productFiles, products, 'sku', (p) => ci(p.sku));

    const orders = orderFiles.map(({ file, data }) => {
        requireFields(file, data, { entity_id: 'number', increment_id: 'string', state: 'string' });
        return data as RawOrder;
    });
    rejectDuplicates(orderFiles, orders, 'increment_id', (o) => ci(o.increment_id));
    rejectDuplicates(orderFiles, orders, 'entity_id', (o) => String(o.entity_id));

    const customers = customerFiles.map(({ file, data }) => {
        requireFields(file, data, { id: 'number', email: 'string' });
        return data as RawCustomer;
    });
    rejectDuplicates(customerFiles, customers, 'id', (c) => String(c.id));
    rejectDuplicates(customerFiles, customers, 'email', (c) => ci(c.email));

    const sourceItems = rowsOf(sourceItemsFile, {
        sku: 'string',
        source_code: 'string',
        quantity: 'number',
        status: 'number'
    }) as RawSourceItem[];
    rejectDuplicateRows(sourceItemsFile.file, sourceItems, (i) => `${ci(i.sku)} at source ${ci(i.source_code)}`);

    const salable = rowsOf(salableFile, {
        sku: 'string',
        stock_id: 'number',
        is_salable: 'boolean'
    }) as SalableRow[];
    rejectDuplicateRows(salableFile.file, salable, (r) => `${ci(r.sku)} on stock ${r.stock_id}`);

    const reservations = deriveReservations(salableFile.file, salable, sourceItems);
    return { products, orders, customers, sourceItems, salable, reservations };
}

/**
 * Reservations are not stored; they are what separates a literal salable
 * quantity from the in-stock on-hand at the default source. A salable
 * quantity above on-hand would need a positive reservation, which cannot
 * exist, so the fixture is rejected.
 */
function deriveReservations(
    file: string,
    salable: readonly SalableRow[],
    sourceItems: readonly RawSourceItem[]
): Map<string, number> {
    const reservations = new Map<string, number>();
    for (const row of salable) {
        if (row.stock_id !== DEFAULT_STOCK_ID || row.salable_quantity === undefined) continue;
        const source = sourceItems.find(
            (item) => ci(item.sku) === ci(row.sku) && ci(item.source_code) === DEFAULT_SOURCE_CODE
        );
        const onHand = source?.status === SOURCE_ITEM_STATUS.in_stock ? source.quantity : 0;
        const reserved = row.salable_quantity - onHand;
        if (reserved > 0) {
            throw new Error(
                `${file}: ${row.sku} has salable_quantity ${row.salable_quantity}, above its in-stock ` +
                    `quantity ${onHand} at source "${DEFAULT_SOURCE_CODE}".`
            );
        }
        reservations.set(ci(row.sku), reserved);
    }
    return reservations;
}

async function readJsonDir(dir: string): Promise<LoadedFile[]> {
    let names: string[];
    try {
        names = await readdir(dir);
    } catch {
        throw new Error(`Fixture directory ${dir} does not exist or cannot be read.`);
    }
    // Sorted, so the same broken tree always reports the same error.
    const files = names
        .filter((name) => name.endsWith('.json'))
        .sort()
        .map((name) => join(dir, name));
    return Promise.all(files.map(readJsonFile));
}

async function readJsonFile(file: string): Promise<LoadedFile> {
    let text: string;
    try {
        text = await readFile(file, 'utf8');
    } catch {
        throw new Error(`Fixture file ${file} does not exist or cannot be read.`);
    }
    try {
        return { file, data: JSON.parse(text) as unknown };
    } catch (error) {
        throw new Error(`Fixture file ${file} is not valid JSON: ${(error as Error).message}`);
    }
}

type FieldType = 'string' | 'number' | 'boolean';

function requireFields(where: string, data: unknown, fields: Readonly<Record<string, FieldType>>): void {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) {
        throw new Error(`${where} must hold a JSON object.`);
    }
    for (const [field, type] of Object.entries(fields)) {
        if (typeof (data as Record<string, unknown>)[field] !== type) {
            throw new Error(`${where} is missing "${field}" (expected a ${type}).`);
        }
    }
}

function rowsOf({ file, data }: LoadedFile, fields: Readonly<Record<string, FieldType>>): unknown[] {
    if (!Array.isArray(data)) throw new Error(`Fixture file ${file} must hold a JSON array.`);
    data.forEach((row, index) => requireFields(`${file} row ${index}`, row, fields));
    return data;
}

function rejectDuplicates<T>(
    files: readonly LoadedFile[],
    entities: readonly T[],
    field: string,
    key: (entity: T) => string
): void {
    const seen = new Map<string, string>();
    entities.forEach((entity, index) => {
        const file = files[index]?.file ?? '(unknown file)';
        const earlier = seen.get(key(entity));
        if (earlier !== undefined) {
            throw new Error(`Duplicate ${field} "${key(entity)}" in ${earlier} and ${file}.`);
        }
        seen.set(key(entity), file);
    });
}

function rejectDuplicateRows<T>(file: string, rows: readonly T[], key: (row: T) => string): void {
    const seen = new Set<string>();
    for (const row of rows) {
        if (seen.has(key(row))) throw new Error(`${file}: duplicate row for ${key(row)}.`);
        seen.add(key(row));
    }
}
