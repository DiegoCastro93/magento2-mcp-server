import { beforeEach, describe, expect, it } from 'vitest';
import type * as z from 'zod';
import type { ToolError } from '../../src/errors/tool-error.js';
import { MagentoRequestError, MagentoUnavailableError, type MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { AddOrderCommentOutputSchema, type AddOrderCommentOutput } from '../../src/projection/fields.js';
import { defineGetOrder } from '../../src/tools/read/get-order.js';
import { defineAddOrderComment } from '../../src/tools/write/add-order-comment.js';
import { wire } from '../projection/fixtures.js';
import { failing, loadFixtureClient, memoryLogger, override, refusalOf } from './client-stubs.js';

const TIMEOUT = new MagentoUnavailableError('shop.example.com', 'timeout');
const VERIFY =
    'Magento may have applied the request before the failure. ' +
    "Check the order's comments with get_order before retrying.";

// Writes mutate the fixture store, so every spec starts from the committed fixtures.
let store: FixtureMagentoClient;

beforeEach(async () => {
    store = await loadFixtureClient();
});

function tool(client: MagentoClient = store) {
    return defineAddOrderComment({ client, logger: memoryLogger().logger, sourceCode: 'default', stockId: 1 });
}

type Input = z.input<ReturnType<typeof tool>['inputSchema']>;

/**
 * Parses `input` as the SDK would, and returns the answer as it would cross
 * stdio, checked against the output schema.
 */
async function answer(input: Input, client?: MagentoClient): Promise<{ result: AddOrderCommentOutput; text: string }> {
    const definition = tool(client);
    const { structuredContent, text } = await definition.handler(definition.inputSchema.parse(input));
    const result = wire(structuredContent);
    expect(AddOrderCommentOutputSchema.safeParse(result).success).toBe(true);
    return { result, text };
}

function refusal(input: Input, client?: MagentoClient): Promise<ToolError> {
    const definition = tool(client);
    return refusalOf(definition.handler(definition.inputSchema.parse(input)));
}

/** `client`, counting the comments that reach it. */
function counting(client: MagentoClient): { client: MagentoClient; writes: () => number } {
    let writes = 0;
    return {
        client: override(client, {
            addOrderComment: (orderId, input) => {
                writes += 1;
                return client.addOrderComment(orderId, input);
            }
        }),
        writes: () => writes
    };
}

const NOTE = { incrementId: '000000003', comment: 'Packed and waiting for pickup.' };

describe('add_order_comment', () => {
    it('declares itself additive and not idempotent, all four hints explicit', () => {
        expect(tool().annotations).toStrictEqual({
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: true
        });
        expect(tool().retry).toStrictEqual({
            idempotent: false,
            verifyBeforeRetry: "Check the order's comments with get_order before retrying."
        });
    });

    it("appends a comment, and leaves the order's status as it was", async () => {
        const { result, text } = await answer(NOTE);

        expect(result).toStrictEqual({
            incrementId: '000000003',
            status: 'processing',
            notifyCustomer: false,
            visibleOnFront: false
        });
        expect(text).toBe('Added a comment to order 000000003 (processing); the customer was not notified.');

        const order = await store.findOrderByIncrementId('000000003');
        expect(order?.status).toBe('processing');
        expect(order?.status_histories).toHaveLength(1);
    });

    it('shows up first in get_order, as sent: the check the retry advice points at', async () => {
        const { text } = await answer({
            incrementId: '000000005',
            comment: 'Released once the address was confirmed.',
            notifyCustomer: true,
            visibleOnFront: true
        });
        const getOrder = defineGetOrder({
            client: store,
            logger: memoryLogger().logger,
            sourceCode: 'default',
            stockId: 1
        });
        const { comments } = (await getOrder.handler({ incrementId: '000000005' })).structuredContent.order;

        expect(text).toBe('Added a comment to order 000000005 (holded); an email to the customer was requested.');
        expect(comments).toHaveLength(2);
        expect(comments[0]).toMatchObject({
            comment: 'Released once the address was confirmed.',
            status: 'holded',
            customerNotified: true,
            visibleOnFront: true
        });
    });

    it('takes no status: one sent anyway is dropped, and the answer shows the order kept its own', async () => {
        const { result } = await answer({ ...NOTE, status: 'fraud' } as Input);

        expect(result.status).toBe('processing');
        expect((await store.findOrderByIncrementId('000000003'))?.status).toBe('processing');
    });

    it('caps the comment at 2,000 characters in its input schema', () => {
        const schema = tool().inputSchema;
        expect(schema.safeParse({ ...NOTE, comment: 'x'.repeat(2000) }).success).toBe(true);
        expect(schema.safeParse({ ...NOTE, comment: 'x'.repeat(2001) }).success).toBe(false);
    });

    it('refuses an unknown increment ID as NOT_FOUND, and writes nothing', async () => {
        const { client, writes } = counting(store);

        const error = await refusal({ ...NOTE, incrementId: '999999999' }, client);

        expect(error).toMatchObject({ code: 'NOT_FOUND', message: "No order with increment ID '999999999'." });
        expect(error.suggestion).toContain('search_orders');
        expect(writes()).toBe(0);
    });

    describe('failures', () => {
        it('calls a lookup timeout retryable: nothing was written yet', async () => {
            const { client, writes } = counting(failing(store, 'findOrderByIncrementId', TIMEOUT));

            const error = await refusal(NOTE, client);

            expect(error).toMatchObject({
                code: 'UPSTREAM_UNAVAILABLE',
                retryable: true,
                suggestion: 'Retry shortly.'
            });
            expect(writes()).toBe(0);
        });

        it('calls a write timeout not retryable, and points at get_order to check', async () => {
            const error = await refusal(NOTE, failing(store, 'addOrderComment', TIMEOUT));

            expect(error).toMatchObject({ code: 'UPSTREAM_UNAVAILABLE', retryable: false, suggestion: VERIFY });
        });

        it('treats a 500 on the write the same way', async () => {
            const serverError = new MagentoRequestError(500, { message: 'Internal Error. Details are in the log.' });

            const error = await refusal(NOTE, failing(store, 'addOrderComment', serverError));

            expect(error).toMatchObject({ code: 'UPSTREAM_ERROR', retryable: false, suggestion: VERIFY });
        });

        it('points a 400 on the write at get_order too: a failed email is a 400 after the save', async () => {
            const mailFailure = new MagentoRequestError(400, {
                message: 'Unable to send mail. Please try again later.'
            });

            const error = await refusal(NOTE, failing(store, 'addOrderComment', mailFailure));

            expect(error).toMatchObject({
                code: 'INVALID_INPUT',
                message: 'Unable to send mail. Please try again later.',
                retryable: false
            });
            expect(error.suggestion).toBe(`${VERIFY} If it was not applied, correct the input before calling again.`);
        });

        it('reads a 401 on the write as the missing comment ACL, since the lookup proved the token', async () => {
            const unauthorized = new MagentoRequestError(401, {
                message: "The consumer isn't authorized to access %resources.",
                parameters: { resources: 'Magento_Sales::comment' }
            });

            const error = await refusal(NOTE, failing(store, 'addOrderComment', unauthorized));

            expect(error).toMatchObject({
                code: 'PERMISSION_DENIED',
                message: 'The integration lacks access to Magento_Sales::comment.',
                retryable: false
            });
        });
    });
});
