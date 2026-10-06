/**
 * Orders, reduced to their allowlists in `fields.ts`.
 *
 * A composite line — a configurable, a bundle — is stored as a parent row and
 * one or more child rows, each child carrying `parent_item_id`. The parent row
 * holds the line's price and the chosen SKU, so the children are skipped: kept,
 * a configurable would be listed twice.
 */
import type { RawOrder, RawOrderItem, RawOrderStatusHistory } from '../magento/raw-types.js';
import { projectAddress } from './address.js';
import { MAX_ORDER_COMMENTS, TEXT_LIMITS, type OrderComment, type OrderDetail, type OrderSummary } from './fields.js';
import type { Notices } from './truncate.js';
import { htmlField, present, text, utcTimestamp } from './values.js';

type Shipping = NonNullable<NonNullable<RawOrder['extension_attributes']>['shipping_assignments']>[number]['shipping'];

export function projectOrderSummary(raw: RawOrder): OrderSummary {
    return {
        incrementId: raw.increment_id,
        status: raw.status,
        state: raw.state,
        createdAt: utcTimestamp(raw.created_at),
        customerEmail: raw.customer_email,
        customerName: fullName(raw),
        grandTotal: raw.grand_total,
        currency: raw.order_currency_code,
        // Not total_item_count, which counts a bundle's options rather than the line.
        itemCount: lines(raw).length
    };
}

/**
 * @param notices receives a sentence when the comments are capped, and one for
 *   each comment that was cut.
 */
export function projectOrderDetail(raw: RawOrder, notices: Notices): OrderDetail {
    // An order has no top-level shipping address: it lives on its shipping assignment.
    const shipping = raw.extension_attributes?.shipping_assignments?.[0]?.shipping;

    return {
        ...projectOrderSummary(raw),
        shippingMethod: shippingMethod(raw, shipping),
        paymentMethod: paymentMethod(raw),
        billingAddress: raw.billing_address && projectAddress(raw.billing_address, raw.billing_address.region),
        shippingAddress: shipping?.address && projectAddress(shipping.address, shipping.address.region),
        items: lines(raw).map((item) => ({
            sku: item.sku,
            name: item.name,
            qty: item.qty_ordered,
            price: item.price,
            rowTotal: item.row_total
        })),
        totals: {
            subtotal: raw.subtotal,
            shipping: present(raw.shipping_amount),
            tax: present(raw.tax_amount),
            discount: present(raw.discount_amount),
            grandTotal: raw.grand_total
        },
        comments: comments(raw.status_histories ?? [], notices)
    };
}

function lines(raw: RawOrder): RawOrderItem[] {
    return raw.items.filter((item) => item.parent_item_id === undefined || item.parent_item_id === null);
}

function fullName(raw: RawOrder): string | undefined {
    const name = [raw.customer_firstname, raw.customer_lastname].filter((part) => text(part) !== undefined).join(' ');
    return text(name);
}

/** The code from the shipping assignment, the title as the order recorded it. */
function shippingMethod(raw: RawOrder, shipping: Shipping | undefined): OrderDetail['shippingMethod'] {
    const code = text(shipping?.method);
    const title = text(raw.shipping_description);
    return code === undefined && title === undefined ? undefined : { code, title };
}

/**
 * The title comes from the keyed `payment_additional_info`, never from
 * `payment.additional_information[0]`, which holds it only for a method that
 * stores nothing else.
 */
function paymentMethod(raw: RawOrder): OrderDetail['paymentMethod'] {
    if (raw.payment === undefined) return undefined;
    const title = raw.extension_attributes?.payment_additional_info?.find((info) => info.key === 'method_title');
    return { code: raw.payment.method, title: text(title?.value) };
}

/**
 * The newest {@link MAX_ORDER_COMMENTS} entries; Magento prepends each new one.
 * An entry without text is kept: the status it recorded is still information.
 */
function comments(history: readonly RawOrderStatusHistory[], notices: Notices): OrderComment[] {
    if (history.length > MAX_ORDER_COMMENTS) {
        notices.add(`Showing the ${MAX_ORDER_COMMENTS} most recent of ${history.length} comments.`);
    }

    return history.slice(0, MAX_ORDER_COMMENTS).map((entry, index) => ({
        createdAt: utcTimestamp(entry.created_at),
        // The admin renders comments with a few tags allowed (b, br, strong, i, u, a).
        comment: htmlField(entry.comment, TEXT_LIMITS.comment, `comments[${index}].comment`, notices),
        status: text(entry.status),
        customerNotified: customerNotified(entry.is_customer_notified),
        visibleOnFront: entry.is_visible_on_front === 1
    }));
}

/** 1 notified, 0 not; 2 means not applicable, which is left absent rather than read as either. */
function customerNotified(value: number | null | undefined): boolean | undefined {
    if (value === 1) return true;
    if (value === 0) return false;
    return undefined;
}
