import { beforeAll, describe, expect, it } from 'vitest';
import type { MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import type { RawOrderStatusHistory } from '../../src/magento/raw-types.js';
import { GetOrderOutputSchema, MAX_ORDER_COMMENTS, type GetOrderOutput } from '../../src/projection/fields.js';
import { defineGetOrder } from '../../src/tools/read/get-order.js';
import { loadOrder, wire } from '../projection/fixtures.js';
import { loadFixtureClient, memoryLogger, override, refusalOf } from './client-stubs.js';

let fixtures: FixtureMagentoClient;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

function tool(client: MagentoClient = fixtures) {
    return defineGetOrder({ client, logger: memoryLogger().logger, sourceCode: 'default', stockId: 1 });
}

/** The answer as it would cross stdio, checked against the output schema. */
async function answer(incrementId: string, client?: MagentoClient): Promise<{ result: GetOrderOutput; text: string }> {
    const { structuredContent, text } = await tool(client).handler({ incrementId });
    const result = wire(structuredContent);
    expect(GetOrderOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
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

describe('get_order', () => {
    it('answers with the order in full, and a one-line summary', async () => {
        const { result, text } = await answer('000000001');

        expect(result.order).toMatchObject({ incrementId: '000000001', status: 'complete', grandTotal: 63.46 });
        expect(result.order.items).toHaveLength(1);
        expect(result.order.billingAddress).toBeDefined();
        expect(result).not.toHaveProperty('notice');
        expect(text).toBe('Order 000000001: complete, 1 line, grand total 63.46 USD.');
    });

    it('never lets the guest-link secret through', async () => {
        const raw = await loadOrder('000000001');
        const protectCode = (raw as unknown as { protect_code: string }).protect_code;
        const { result } = await answer('000000001');

        expect(protectCode).toMatch(/\w{6,}/);
        expect(JSON.stringify(result)).not.toContain('protect_code');
        expect(JSON.stringify(result)).not.toContain(protectCode);
    });

    it('includes the status history', async () => {
        const { result } = await answer('000000005');

        expect(result.order.comments).toHaveLength(1);
        expect(result.order.comments[0]?.status).toBe('holded');
    });

    it('caps the comments and says so, in the notice and in the text', async () => {
        const order = await loadOrder('000000003');
        const client = override(fixtures, {
            findOrderByIncrementId: () => Promise.resolve({ ...order, status_histories: history(12) })
        });

        const { result, text } = await answer('000000003', client);

        expect(result.order.comments).toHaveLength(MAX_ORDER_COMMENTS);
        expect(result.order.comments[0]?.comment).toBe('Note 12');
        expect(result.notice).toBe('Showing the 10 most recent of 12 comments.');
        expect(text).toBe(`Order 000000003: processing, 1 line, grand total 39 USD. ${result.notice}`);
    });

    it('refuses an unknown increment ID with NOT_FOUND, pointing at search_orders', async () => {
        const error = await refusalOf(tool().handler({ incrementId: '000000099' }));

        expect(error.code).toBe('NOT_FOUND');
        expect(error.message).toBe("No order with increment ID '000000099'.");
        expect(error.suggestion).toContain('Use search_orders to find the order.');
        expect(error.suggestion).toContain('not the internal entity ID');
        expect(error.retryable).toBe(false);
    });
});
