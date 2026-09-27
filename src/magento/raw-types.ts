/**
 * Partial types for the raw Magento 2.4.9 REST payloads, with Magento's own
 * field names. Only fields that some layer reads are declared; the payloads
 * carry far more. Shapes follow captures from a stock 2.4.9 install.
 *
 * An optional scalar may be absent *or* `null`: Magento's serialiser drops a
 * null value when the getter's docblock declares it nullable, and sends
 * `null` when it does not — a history entry without text arrives as
 * `"comment": null`, because `getComment()` is declared `@return string`.
 *
 * Secrets that REST does return — a customer's `confirmation`, an order's
 * `protect_code`, the `trace` of an error body — are deliberately left
 * undeclared, so nothing can read one without a visible cast.
 *
 * Everything is `readonly`: the fixture adapter replaces objects rather than
 * mutating them.
 */

export interface RawSearchResult<T> {
    readonly items: readonly T[];
    /** The size of the full match, not of this page. */
    readonly total_count: number;
}

/**
 * Any JSON: a string, a comma-joined list of option ids for a multiselect, or
 * an array (`category_ids`). Third-party modules register any shape, so
 * readers must narrow.
 */
export interface RawCustomAttribute {
    readonly attribute_code: string;
    readonly value: unknown;
}

export interface RawCategoryLink {
    /** A string, although it names a numeric category id. */
    readonly category_id: string;
    readonly position?: number | null;
}

/**
 * The legacy CatalogInventory stock item. Present on a single-product GET only
 * when the token holds `Magento_CatalogInventory::cataloginventory`; absent,
 * without any error, otherwise. Never present on search results.
 */
export interface RawStockItem {
    readonly qty: number;
    readonly is_in_stock: boolean;
    readonly use_config_manage_stock: boolean;
    /**
     * The effective value: when `use_config_manage_stock` is true, Magento's
     * getter already returns the store configuration.
     */
    readonly manage_stock: boolean;
}

export interface RawProduct {
    readonly sku: string;
    readonly name: string;
    readonly type_id: string;
    /** 1 enabled, 2 disabled. */
    readonly status: number;
    /** Absent on a type priced by its children, such as grouped. */
    readonly price?: number | null;
    readonly weight?: number | null;
    readonly created_at: string;
    readonly updated_at: string;
    readonly extension_attributes?: {
        readonly category_links?: readonly RawCategoryLink[];
        readonly stock_item?: RawStockItem;
    };
    readonly custom_attributes?: readonly RawCustomAttribute[];
}

/** An MSI source item: one SKU's on-hand stock at one source. */
export interface RawSourceItem {
    readonly sku: string;
    readonly source_code: string;
    readonly quantity: number;
    /** 1 in stock, 0 out of stock. */
    readonly status: number;
}

export interface RawOrderItem {
    readonly item_id: number;
    readonly sku: string;
    readonly name: string;
    readonly product_type: string;
    readonly qty_ordered: number;
    readonly price: number;
    readonly row_total: number;
    /**
     * Set on the child row of a composite line, such as the simple product
     * under a configurable. The parent row carries the line's price and the
     * child's SKU.
     */
    readonly parent_item_id?: number | null;
}

/** A billing or shipping address as stored on an order. */
export interface RawOrderAddress {
    readonly firstname: string;
    readonly lastname: string;
    readonly company?: string | null;
    readonly street: readonly string[];
    readonly city: string;
    /** A plain name here, unlike a customer address. */
    readonly region?: string | null;
    readonly region_code?: string | null;
    readonly postcode?: string | null;
    readonly country_id: string;
    readonly telephone?: string | null;
}

export interface RawOrderStatusHistory {
    readonly comment?: string | null;
    /** Absent when the entry was recorded without one. */
    readonly status?: string | null;
    readonly created_at: string;
    /** 1 notified, 0 not, 2 not applicable. */
    readonly is_customer_notified?: number | null;
    /** 1 or 0. */
    readonly is_visible_on_front: number;
    /** What the entry records: `order`, `invoice`, `creditmemo`, `shipment`. */
    readonly entity_name?: string | null;
}

export interface RawOrder {
    /** Internal id, needed to write to the order. Never exposed to the model. */
    readonly entity_id: number;
    /** The customer-facing order number, such as `000000001`. */
    readonly increment_id: string;
    readonly state: string;
    readonly status: string;
    readonly created_at: string;
    readonly updated_at: string;
    readonly customer_email: string;
    readonly customer_firstname?: string | null;
    readonly customer_lastname?: string | null;
    /** 1 for a guest checkout, 0 otherwise. */
    readonly customer_is_guest?: number | null;
    readonly order_currency_code: string;
    readonly subtotal: number;
    readonly shipping_amount?: number | null;
    readonly tax_amount?: number | null;
    /** Zero or negative. */
    readonly discount_amount?: number | null;
    readonly grand_total: number;
    readonly total_item_count?: number | null;
    readonly items: readonly RawOrderItem[];
    readonly billing_address?: RawOrderAddress;
    readonly payment?: {
        readonly method: string;
    };
    /** Newest first. */
    readonly status_histories?: readonly RawOrderStatusHistory[];
    readonly extension_attributes?: {
        readonly shipping_assignments?: readonly {
            readonly shipping: {
                readonly address?: RawOrderAddress;
                /** Carrier and method code, such as `flatrate_flatrate`. */
                readonly method?: string | null;
            };
        }[];
    };
}

export interface RawCustomerAddress {
    readonly id: number;
    readonly firstname: string;
    readonly lastname: string;
    readonly company?: string | null;
    readonly street: readonly string[];
    readonly city: string;
    /** An object here, unlike an order address. */
    readonly region?: {
        readonly region?: string | null;
        readonly region_code?: string | null;
    };
    readonly postcode?: string | null;
    readonly country_id: string;
    readonly telephone?: string | null;
    /** A boolean here, unlike the customer's own `default_billing`. */
    readonly default_billing?: boolean | null;
    readonly default_shipping?: boolean | null;
}

export interface RawCustomer {
    readonly id: number;
    readonly email: string;
    readonly firstname: string;
    readonly lastname: string;
    readonly group_id: number;
    readonly created_at: string;
    readonly addresses?: readonly RawCustomerAddress[];
    readonly custom_attributes?: readonly RawCustomAttribute[];
}

/**
 * Magento's JSON error body. `message` may hold placeholders — positional
 * (`%1`) or named (`%resources`) — that `parameters` fills.
 */
export interface RawErrorBody {
    readonly message: string;
    readonly parameters?: readonly unknown[] | Readonly<Record<string, unknown>>;
}
