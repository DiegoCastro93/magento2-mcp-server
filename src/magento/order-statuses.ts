/**
 * The order statuses a stock Magento 2.4.9 install holds, so `search_orders`
 * can tell an invented status from one that simply has no orders.
 */

/**
 * `module-sales` installs the first nine
 * (`Setup/Patch/Data/InstallOrderStatusesAndInitialSalesConfig.php`), and the
 * bundled `module-paypal` the last three (`Setup/Patch/Data/AddPaypalOrderStatuses.php`).
 * A store may define more of its own in the admin, so this list describes and
 * advises; it never refuses.
 */
export const STOCK_ORDER_STATUSES = [
    'pending',
    'pending_payment',
    'processing',
    'complete',
    'closed',
    'canceled',
    'holded',
    'payment_review',
    'fraud',
    'pending_paypal',
    'paypal_reversed',
    'paypal_canceled_reversal'
] as const;

const STOCK: ReadonlySet<string> = new Set(STOCK_ORDER_STATUSES);

/** Case-insensitive, as Magento's `eq` filter on `status` is under MySQL's collation. */
export function isStockOrderStatus(status: string): boolean {
    return STOCK.has(status.toLowerCase());
}
