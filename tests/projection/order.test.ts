import { describe, expect, it } from 'vitest';
import type { RawOrder, RawOrderItem, RawOrderStatusHistory } from '../../src/magento/raw-types.js';
import { MAX_ORDER_COMMENTS, OrderDetailSchema, OrderSummarySchema, TEXT_LIMITS } from '../../src/projection/fields.js';
import { projectOrderDetail, projectOrderSummary } from '../../src/projection/order.js';
import { Notices, TRUNCATION_MARKER } from '../../src/projection/truncate.js';
import { loadOrder, wire } from './fixtures.js';

function item(fields: Partial<RawOrderItem> & Pick<RawOrderItem, 'item_id' | 'sku'>): RawOrderItem {
    return { name: fields.sku, product_type: 'simple', qty_ordered: 1, price: 0, row_total: 0, ...fields };
}

function history(count: number): RawOrderStatusHistory[] {
    return Array.from({ length: count }, (_, i) => ({
        comment: `Note ${count - i}`,
        status: 'processing',
        created_at: `2026-03-${String(count - i + 10).padStart(2, '0')} 12:00:00`,
        is_customer_notified: 0,
        is_visible_on_front: 0,
        entity_name: 'order'
    }));
}

describe('projectOrderSummary', () => {
    it('keeps exactly the summary allowlist', async () => {
        const summary = wire(projectOrderSummary(await loadOrder('000000005')));

        expect(summary).toStrictEqual({
            incrementId: '000000005',
            status: 'holded',
            state: 'holded',
            createdAt: '2026-03-10T09:15:00Z',
            customerEmail: 'roni_cost@example.com',
            customerName: 'Veronica Costello',
            grandTotal: 25.16,
            currency: 'USD',
            itemCount: 1
        });
        expect(OrderSummarySchema.safeParse(summary).success).toBe(true);
    });

    it("names a guest order's customer from the order itself", async () => {
        const raw = await loadOrder('000000004');

        expect(raw.customer_is_guest).toBe(1);
        expect(projectOrderSummary(raw).customerName).toBe('Sam Rivera');
    });

    it('leaves customerName absent when the order holds no name', async () => {
        const raw = await loadOrder('000000004');

        const summary = wire(projectOrderSummary({ ...raw, customer_firstname: null, customer_lastname: '' }));

        expect(summary).not.toHaveProperty('customerName');
    });

    it('counts lines, not units', async () => {
        const raw = await loadOrder('000000004');

        expect(raw.items[0]?.qty_ordered).toBe(2);
        expect(projectOrderSummary(raw).itemCount).toBe(1);
    });
});

describe('projectOrderDetail', () => {
    it('keeps exactly the detail allowlist, with no internal ID and no protect_code', async () => {
        const raw = await loadOrder('000000001');
        const protectCode = (raw as unknown as { protect_code: string }).protect_code;
        const detail = wire(projectOrderDetail(raw, new Notices()));
        const json = JSON.stringify(detail);

        expect(Object.keys(detail)).toEqual([
            'incrementId',
            'status',
            'state',
            'createdAt',
            'customerEmail',
            'customerName',
            'grandTotal',
            'currency',
            'itemCount',
            'shippingMethod',
            'paymentMethod',
            'billingAddress',
            'shippingAddress',
            'items',
            'totals',
            'comments'
        ]);
        expect(OrderDetailSchema.safeParse(detail).success).toBe(true);
        expect(protectCode).toMatch(/\w{6,}/);
        expect(json).not.toContain(protectCode);
        expect(json).not.toMatch(/entity_id|protect_code|parent_id|"email"/);
    });

    it('reads the shipping address from the shipping assignment, and the billing address from the order', async () => {
        const detail = projectOrderDetail(await loadOrder('000000004'), new Notices());

        expect(wire(detail.shippingAddress)).toStrictEqual({
            firstname: 'Sam',
            lastname: 'Rivera',
            street: ['415 SE Morrison St'],
            city: 'Portland',
            region: 'Oregon',
            postcode: '97214',
            countryId: 'US',
            telephone: '(503) 555-0199'
        });
        expect(wire(detail.billingAddress)).toStrictEqual(wire(detail.shippingAddress));
    });

    it('gives each method its code and its title', async () => {
        const detail = projectOrderDetail(await loadOrder('000000001'), new Notices());

        expect(detail.shippingMethod).toEqual({ code: 'flatrate_flatrate', title: 'Flat Rate - Fixed' });
        expect(detail.paymentMethod).toEqual({ code: 'checkmo', title: 'Check / Money order' });
    });

    it('takes the payment title by its key, not from additional_information[0], and reads nothing else', async () => {
        const raw = await loadOrder('000000001');
        // additional_information is undeclared in RawOrder: no layer may read it.
        const payment = { method: 'braintree', additional_information: ['tok_5f2a', 'Credit Card'] };
        const gateway: RawOrder = {
            ...raw,
            payment,
            extension_attributes: {
                ...raw.extension_attributes,
                payment_additional_info: [
                    { key: 'payment_method_nonce', value: 'tok_5f2a' },
                    { key: 'method_title', value: 'Credit Card' }
                ]
            }
        };
        const detail = projectOrderDetail(gateway, new Notices());

        expect(detail.paymentMethod).toEqual({ code: 'braintree', title: 'Credit Card' });
        expect(JSON.stringify(detail)).not.toContain('tok_5f2a');
    });

    it('lists a configurable once, from its parent row', async () => {
        const raw = await loadOrder('000000001');
        const detail = projectOrderDetail(
            {
                ...raw,
                items: [
                    item({
                        item_id: 10,
                        sku: 'WS12-M-Orange',
                        name: 'Radiant Tee',
                        product_type: 'configurable',
                        price: 22,
                        row_total: 22
                    }),
                    item({ item_id: 11, sku: 'WS12-M-Orange', name: 'Radiant Tee-M-Orange', parent_item_id: 10 })
                ],
                total_item_count: 1
            },
            new Notices()
        );

        expect(detail.items).toEqual([{ sku: 'WS12-M-Orange', name: 'Radiant Tee', qty: 1, price: 22, rowTotal: 22 }]);
        expect(detail.itemCount).toBe(1);
    });

    it('counts a bundle as one line where total_item_count counts its options', async () => {
        const raw = await loadOrder('000000001');
        const bundle: RawOrder = {
            ...raw,
            items: [
                item({
                    item_id: 20,
                    sku: '24-WG080',
                    name: 'Sprite Yoga Companion Kit',
                    product_type: 'bundle',
                    price: 61,
                    row_total: 61
                }),
                item({ item_id: 21, sku: '24-WG084', parent_item_id: 20 }),
                item({ item_id: 22, sku: '24-WG086', parent_item_id: 20 }),
                item({ item_id: 23, sku: '24-WG088', parent_item_id: 20 })
            ],
            total_item_count: 3
        };

        expect(projectOrderSummary(bundle).itemCount).toBe(1);
        expect(projectOrderDetail(bundle, new Notices()).items).toHaveLength(1);
    });

    it('gives the totals with Magento’s own discount sign', async () => {
        const detail = projectOrderDetail(await loadOrder('000000004'), new Notices());

        expect(detail.totals).toEqual({ subtotal: 68, shipping: 10, tax: 0, discount: -6.8, grandTotal: 71.2 });
    });

    it('gives the status history as comments', async () => {
        const notices = new Notices();
        const detail = projectOrderDetail(await loadOrder('000000005'), notices);

        expect(wire(detail.comments)).toStrictEqual([
            {
                createdAt: '2026-03-10T16:40:00Z',
                comment: 'Customer asked us to hold the shipment until they confirm the delivery address.',
                status: 'holded',
                customerNotified: false,
                visibleOnFront: false
            }
        ]);
        expect(notices.toNotice()).toBeUndefined();
    });

    it('keeps the most recent comments, in order, and says how many there were', async () => {
        const raw = await loadOrder('000000001');
        const notices = new Notices();
        const detail = projectOrderDetail({ ...raw, status_histories: history(12) }, notices);

        expect(detail.comments).toHaveLength(MAX_ORDER_COMMENTS);
        expect(detail.comments.map((c) => c.comment)).toEqual(Array.from({ length: 10 }, (_, i) => `Note ${12 - i}`));
        expect(notices.toNotice()).toBe('Showing the 10 most recent of 12 comments.');
    });

    it('cuts a long comment, names it in the notice, and reads its markup as text', async () => {
        const [first, second] = history(2) as [RawOrderStatusHistory, RawOrderStatusHistory];
        const notices = new Notices();
        const detail = projectOrderDetail(
            {
                ...(await loadOrder('000000001')),
                status_histories: [
                    { ...first, comment: 'x'.repeat(600) },
                    { ...second, comment: '<b>Fragile</b>, ship by air' }
                ]
            },
            notices
        );

        expect(detail.comments[0]?.comment).toBe('x'.repeat(TEXT_LIMITS.comment) + TRUNCATION_MARKER);
        expect(detail.comments[1]?.comment).toBe('Fragile, ship by air');
        expect(notices.toNotice()).toBe('comments[0].comment was truncated to 500 characters.');
    });

    it('keeps an entry without text, and leaves a not-applicable notification flag absent', async () => {
        const [entry] = history(1) as [RawOrderStatusHistory];
        const detail = wire(
            projectOrderDetail(
                {
                    ...(await loadOrder('000000001')),
                    status_histories: [{ ...entry, comment: null, is_customer_notified: 2, is_visible_on_front: 1 }]
                },
                new Notices()
            )
        );

        expect(detail.comments).toStrictEqual([
            { createdAt: '2026-03-11T12:00:00Z', status: 'processing', visibleOnFront: true }
        ]);
    });

    it('leaves the shipping fields absent for an order with nothing to ship', async () => {
        const raw = await loadOrder('000000001');
        const virtual: RawOrder = {
            ...raw,
            shipping_description: null,
            extension_attributes: { shipping_assignments: [] }
        };
        const detail = wire(projectOrderDetail(virtual, new Notices()));

        expect(detail).not.toHaveProperty('shippingMethod');
        expect(detail).not.toHaveProperty('shippingAddress');
        expect(detail.paymentMethod).toEqual({ code: 'checkmo' });
        expect(OrderDetailSchema.safeParse(detail).success).toBe(true);
    });
});
