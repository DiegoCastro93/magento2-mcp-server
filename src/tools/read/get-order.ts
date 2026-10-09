/**
 * `get_order`: one order in full, by its increment ID.
 *
 * Magento has no by-increment-id endpoint, so the port answers this with a
 * search for one row; an empty search is the order's absence.
 */
import * as z from 'zod';
import { ToolError } from '../../errors/tool-error.js';
import {
    GetOrderOutputSchema,
    MAX_ORDER_COMMENTS,
    type GetOrderOutput,
    type OrderDetail
} from '../../projection/fields.js';
import { projectOrderDetail } from '../../projection/order.js';
import { Notices } from '../../projection/truncate.js';
import { answerText, READ_ANNOTATIONS, READ_RETRY, type ToolDefinition, type ToolDeps } from '../definition.js';

const DESCRIPTION =
    'Get one sales order in full by its increment ID — the customer-facing number such as 000000123, not the ' +
    'internal entity ID. Returns totals, status, addresses, line items and the ' +
    `${MAX_ORDER_COMMENTS} most recent comments, each reduced to an allowlisted set of fields.`;

const GetOrderInputSchema = z.object({ incrementId: z.string().min(1) });

export function defineGetOrder(
    deps: ToolDeps
): ToolDefinition<typeof GetOrderInputSchema, typeof GetOrderOutputSchema> {
    const { client } = deps;

    return {
        name: 'get_order',
        description: DESCRIPTION,
        inputSchema: GetOrderInputSchema,
        outputSchema: GetOrderOutputSchema,
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,

        async handler({ incrementId }) {
            const raw = await client.findOrderByIncrementId(incrementId);
            if (raw === undefined) {
                throw new ToolError('NOT_FOUND', `No order with increment ID '${incrementId}'.`, {
                    suggestion:
                        'Use search_orders to find the order. The increment ID is the customer-facing order ' +
                        'number, such as 000000123, not the internal entity ID.'
                });
            }

            const notices = new Notices();
            const order = projectOrderDetail(raw, notices);
            const notice = notices.toNotice();

            const structuredContent: GetOrderOutput = { order, notice };
            return { structuredContent, text: answerText(summarize(order), notice) };
        }
    };
}

/** "Order 000000001: complete, 1 line, grand total 63.46 USD." */
function summarize(order: OrderDetail): string {
    const lines = order.items.length === 1 ? '1 line' : `${order.items.length} lines`;
    return `Order ${order.incrementId}: ${order.status}, ${lines}, grand total ${order.grandTotal} ${order.currency}.`;
}
