import { beforeAll, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import type { MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { STOCK_ORDER_STATUSES } from '../../src/magento/order-statuses.js';
import { SearchOrdersOutputSchema, type SearchOrdersOutput } from '../../src/projection/fields.js';
import { defineSearchOrders } from '../../src/tools/read/search-orders.js';
import { loadOrder, wire } from '../projection/fixtures.js';
import { loadFixtureClient, memoryLogger, override, refusalOf } from './client-stubs.js';

type Input = z.input<ReturnType<typeof defineSearchOrders>['inputSchema']>;

let fixtures: FixtureMagentoClient;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

function tool(client: MagentoClient = fixtures) {
    return defineSearchOrders({ client, logger: memoryLogger().logger, sourceCode: 'default', stockId: 1 });
}

/** Parses `input` as the SDK does, defaults included, and returns the answer as it would cross stdio. */
async function answer(input: Input, client?: MagentoClient): Promise<{ result: SearchOrdersOutput; text: string }> {
    const definition = tool(client);
    const { structuredContent, text } = await definition.handler(definition.inputSchema.parse(input));
    const result = wire(structuredContent);
    expect(SearchOrdersOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
}

async function ids(input: Input): Promise<string[]> {
    return (await answer(input)).result.orders.map((order) => order.incrementId);
}

describe('search_orders', () => {
    it('with no filters, lists the newest orders first, ties broken by increment ID', async () => {
        const { result, text } = await answer({});

        expect(result.orders.map((order) => order.incrementId)).toEqual([
            '000000005',
            '000000004',
            '000000003',
            '000000002',
            '000000001',
            '000000006'
        ]);
        expect(result).not.toHaveProperty('notice');
        expect(text).toBe('6 orders match.');
    });

    it('reduces every result to the summary allowlist', async () => {
        const { result } = await answer({ status: 'holded' });

        expect(result.orders).toStrictEqual([
            {
                incrementId: '000000005',
                status: 'holded',
                state: 'holded',
                createdAt: '2026-03-10T09:15:00Z',
                customerEmail: 'roni_cost@example.com',
                customerName: 'Veronica Costello',
                grandTotal: 25.16,
                currency: 'USD',
                itemCount: 1
            }
        ]);
    });

    it('filters by status, whatever its case', async () => {
        const { result, text } = await answer({ status: 'Processing' });

        expect(result.orders.map((order) => order.incrementId)).toEqual(['000000003', '000000006']);
        expect(text).toBe('2 orders match.');
    });

    it("filters by the customer's email, whatever its case, guest orders included", async () => {
        expect(await ids({ email: 'RONI_COST@example.com' })).toEqual(['000000005', '000000002', '000000001']);
        expect(await ids({ email: 'sam.rivera@example.net' })).toEqual(['000000004']);
    });

    describe('the date range', () => {
        it('includes the whole UTC day at either end', async () => {
            // 000000003 was placed at 23:30 on the 4th, 000000004 at midnight on the 5th.
            expect(await ids({ createdTo: '2026-03-04' })).toEqual(['000000003', '000000002', '000000001', '000000006']);
            expect(await ids({ createdFrom: '2026-03-05' })).toEqual(['000000005', '000000004']);
            expect(await ids({ createdFrom: '2026-02-10', createdTo: '2026-02-10' })).toEqual([
                '000000002',
                '000000001'
            ]);
        });

        it('refuses a range that runs backwards', async () => {
            const input = tool().inputSchema.parse({ createdFrom: '2026-03-05', createdTo: '2026-03-04' });

            const error = await refusalOf(tool().handler(input));

            expect(error.code).toBe('INVALID_INPUT');
            expect(error.message).toBe('createdFrom (2026-03-05) is after createdTo (2026-03-04).');
            expect(error.retryable).toBe(false);
        });

        it('states the rule in the field description, since the schema cannot carry it', () => {
            expect(tool().inputSchema.shape.createdFrom.description).toContain('Must not be after createdTo.');
        });
    });

    describe('a status that matches nothing', () => {
        it('is called out when it is not a stock status, so an invented one does not read as "no orders"', async () => {
            const { result, text } = await answer({ status: 'shipped' });

            expect(result.orders).toEqual([]);
            expect(result.notice).toBe(
                'No order has status "shipped", which is not one of Magento\'s stock statuses. Unless this store ' +
                    'defines it, use a status code listed for the status filter.'
            );
            expect(text).toBe(`No orders match. ${result.notice}`);
        });

        it('is just an empty page when it is a stock status', async () => {
            const { result, text } = await answer({ status: 'closed' });

            expect(result.orders).toEqual([]);
            expect(result).not.toHaveProperty('notice');
            expect(text).toBe('No orders match.');
        });
    });

    it("accepts a store's own status, and says nothing when it matches", async () => {
        const order = await loadOrder('000000003');
        const client = override(fixtures, {
            searchOrders: () => Promise.resolve({ items: [{ ...order, status: 'awaiting_pickup' }], total_count: 1 })
        });

        const { result } = await answer({ status: 'awaiting_pickup' }, client);

        expect(result.orders.map((o) => o.status)).toEqual(['awaiting_pickup']);
        expect(result).not.toHaveProperty('notice');
    });

    it('lists every stock status in the status description', () => {
        const description = tool().inputSchema.shape.status.description ?? '';

        for (const status of STOCK_ORDER_STATUSES) expect(description).toContain(status);
    });

    it('says when a page is not the whole answer', async () => {
        const { result, text } = await answer({ pageSize: 2 });

        expect(result.pagination).toMatchObject({ page: 1, pageSize: 2, totalCount: 6, totalPages: 3, hasMore: true });
        expect(result.notice).toBe('Showing 2 of 6 orders (page 1 of 3). Narrow the filters or request page 2.');
        expect(text).toBe(`6 orders match. ${result.notice}`);
    });
});
