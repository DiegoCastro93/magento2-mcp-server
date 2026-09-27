/**
 * The Magento port: what the tools need from a Magento instance, stated in
 * domain terms, so a tool cannot tell whether the answer came from REST or
 * from fixtures.
 *
 * Optional parameter fields are typed `?: T | undefined` rather than `?: T`.
 * Under `exactOptionalPropertyTypes` that is what lets a zod-parsed tool input,
 * whose absent keys may be present as `undefined`, pass straight through.
 */
import type {
    RawCustomer,
    RawErrorBody,
    RawOrder,
    RawProduct,
    RawSearchResult,
    RawSourceItem
} from './raw-types.js';

/**
 * The contract every adapter keeps:
 *
 * - `undefined` means the entity does not exist.
 * - A throw means the adapter could not answer, or Magento refused, in which
 *   case it is a {@link MagentoRequestError}.
 * - A search never returns `undefined`: no match is an empty page. A page past
 *   the end is empty too, and still carries the true `total_count`.
 * - Every result belongs to the caller and shares no state with the adapter,
 *   the way each HTTP response is fresh JSON.
 *
 * Reads return raw Magento payloads; projection happens above the port.
 */
export interface MagentoClient {
    /** Ordered `created_at DESC, sku ASC`. Items never carry `stock_item`. */
    searchProducts(params: ProductSearchParams): Promise<RawSearchResult<RawProduct>>;

    getProduct(sku: string): Promise<RawProduct | undefined>;

    /** `undefined` when the SKU has no row at that source, whether or not the product exists. */
    getSourceItem(sku: string, sourceCode: string): Promise<RawSourceItem | undefined>;

    /**
     * On-hand minus reservations minus the out-of-stock threshold, never below 0.
     *
     * @throws {MagentoRequestError} 400 for a type without source items, such as grouped.
     */
    getSalableQuantity(sku: string, stockId: number): Promise<number | undefined>;

    /** `false` for an unknown SKU too: Magento answers that with a plain `false`, not a 404. */
    isProductSalable(sku: string, stockId: number): Promise<boolean>;

    /** Ordered `created_at DESC, increment_id DESC`. */
    searchOrders(params: OrderSearchParams): Promise<RawSearchResult<RawOrder>>;

    findOrderByIncrementId(incrementId: string): Promise<RawOrder | undefined>;

    getCustomerById(customerId: number): Promise<RawCustomer | undefined>;

    findCustomerByEmail(email: string): Promise<RawCustomer | undefined>;

    /**
     * Upserts, as the REST endpoint does: an unknown SKU is not refused, so a
     * caller that must not create rows checks the product first.
     */
    updateSourceItem(update: SourceItemUpdate): Promise<void>;

    /**
     * Appends to the order's status history, newest first.
     *
     * @param orderId the internal `entity_id`, not the increment ID.
     * @throws {MagentoRequestError} 404 for an unknown order; 400 for a status
     *   outside the order's current state.
     */
    addOrderComment(orderId: number, input: OrderCommentInput): Promise<void>;
}

/**
 * Magento answered, and the answer was a refusal. Both adapters throw it for
 * the same refusals, so the error mapper has one input instead of one per mode.
 */
export class MagentoRequestError extends Error {
    readonly status: number;
    /** Absent when the body was not Magento's JSON, such as a proxy's HTML error page. */
    readonly body: RawErrorBody | undefined;

    constructor(status: number, body?: RawErrorBody) {
        super(`Magento refused the request with HTTP ${status}${body === undefined ? '' : `: ${body.message}`}`);
        this.name = 'MagentoRequestError';
        this.status = status;
        this.body = body;
    }
}

/** Paging for every search. Both fields are required: see `assertPaging`. */
export interface Paging {
    /** 1-based. */
    readonly page: number;
    readonly pageSize: number;
}

/** Filters for `searchProducts`. Every filter is optional; present ones AND together. */
export interface ProductSearchParams extends Paging {
    /** Case-insensitive substring of the product name. */
    readonly name?: string | undefined;
    /** Case-insensitive substring of the SKU. */
    readonly sku?: string | undefined;
    /** Direct assignment to this category (`category_links`); descendants are not included. */
    readonly categoryId?: number | undefined;
    /** Inclusive. A product with no price, such as a grouped product, never matches. */
    readonly priceMin?: number | undefined;
    /** Inclusive. A product with no price, such as a grouped product, never matches. */
    readonly priceMax?: number | undefined;
}

/** Filters for `searchOrders`. Every filter is optional; present ones AND together. */
export interface OrderSearchParams extends Paging {
    /** Exact status code, such as `processing`. */
    readonly status?: string | undefined;
    /** Exact customer email. */
    readonly email?: string | undefined;
    /** `YYYY-MM-DD`, inclusive, as a UTC day: `created_at` is stored in UTC. */
    readonly createdFrom?: string | undefined;
    /** `YYYY-MM-DD`, inclusive of the whole day, as a UTC day. */
    readonly createdTo?: string | undefined;
}

export type SourceItemStatus = 'in_stock' | 'out_of_stock';

/** The one place the domain status meets Magento's integer `status` on a source item. */
export const SOURCE_ITEM_STATUS = {
    in_stock: 1,
    out_of_stock: 0
} as const satisfies Record<SourceItemStatus, 0 | 1>;

/** An absolute write to one source item. `updateSourceItem` upserts, as the REST endpoint does. */
export interface SourceItemUpdate {
    readonly sku: string;
    readonly sourceCode: string;
    /** Absolute on-hand quantity, not a delta. */
    readonly quantity: number;
    readonly status: SourceItemStatus;
}

export interface OrderCommentInput {
    readonly comment: string;
    /**
     * Status recorded with the comment. Magento 2.4.9 also *applies* it to the
     * order, and refuses with a 400 a status that does not belong to the order's
     * current state (`OrderService::addComment`). Omitted, the current status is
     * recorded and the order is left as it was.
     */
    readonly status?: string | undefined;
    /** Sends the customer an email. */
    readonly notifyCustomer: boolean;
    /** Shows the comment in the customer's account area. */
    readonly visibleOnFront: boolean;
}
