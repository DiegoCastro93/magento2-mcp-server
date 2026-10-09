/**
 * `search_orders`: a page of order summaries matching the filters.
 *
 * `status` is a plain string, not an enum, because a store may define statuses
 * of its own. What that costs is a silent failure: an invented status such as
 * `shipped` matches nothing, and an empty page reads as "no such orders". So
 * when a status outside the stock list matches nothing, the notice says so.
 *
 * The date range is checked here rather than with a zod `.refine`, for the
 * reason given in `search-products.ts`.
 */
import * as z from 'zod';
import { ToolError } from '../../errors/tool-error.js';
import { isStockOrderStatus, STOCK_ORDER_STATUSES } from '../../magento/order-statuses.js';
import { SearchOrdersOutputSchema, type SearchOrdersOutput } from '../../projection/fields.js';
import { projectOrderSummary } from '../../projection/order.js';
import { matchSummary, PAGING_INPUT, paginate, paginationNotice } from '../../shared/pagination.js';
import { answerText, READ_ANNOTATIONS, READ_RETRY, type ToolDefinition, type ToolDeps } from '../definition.js';

const DESCRIPTION =
    'Search sales orders and return a compact page of matching orders. Filter by status, customer email and ' +
    'creation date range; with no filters this returns the most recent orders. Dates are whole UTC days, both ends ' +
    'inclusive. Each result is reduced to summary fields — call get_order with an increment ID for line items and ' +
    'addresses.';

const SearchOrdersInputSchema = z.object({
    status: z
        .string()
        .min(1)
        .optional()
        .describe(
            'Status code, not its label: holded, not "On Hold". A stock Magento install has ' +
                `${STOCK_ORDER_STATUSES.join(', ')}; a store may define more.`
        ),
    email: z
        .email()
        .optional()
        .describe("The customer's email on the order, exact but case-insensitive. Guest orders are included."),
    createdFrom: z.iso.date().optional().describe('YYYY-MM-DD, a UTC day. Must not be after createdTo.'),
    createdTo: z.iso.date().optional().describe('YYYY-MM-DD, a UTC day, included whole.'),
    ...PAGING_INPUT
});

export function defineSearchOrders(
    deps: ToolDeps
): ToolDefinition<typeof SearchOrdersInputSchema, typeof SearchOrdersOutputSchema> {
    const { client } = deps;

    return {
        name: 'search_orders',
        description: DESCRIPTION,
        inputSchema: SearchOrdersInputSchema,
        outputSchema: SearchOrdersOutputSchema,
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,

        async handler(input) {
            const { status, createdFrom, createdTo, page, pageSize } = input;
            // YYYY-MM-DD strings compare in calendar order.
            if (createdFrom !== undefined && createdTo !== undefined && createdFrom > createdTo) {
                throw new ToolError(
                    'INVALID_INPUT',
                    `createdFrom (${createdFrom}) is after createdTo (${createdTo}).`,
                    { suggestion: 'Swap the two dates, or drop one of them to leave that end of the range open.' }
                );
            }

            const result = await client.searchOrders(input);
            const pagination = paginate({ totalCount: result.total_count, page, pageSize });
            // An empty match has no pagination sentence, so the two never meet.
            const notice = paginationNotice(pagination, 'orders') ?? unknownStatusNotice(status, result.total_count);

            const structuredContent: SearchOrdersOutput = {
                orders: result.items.map((raw) => projectOrderSummary(raw)),
                pagination,
                notice
            };
            return { structuredContent, text: answerText(matchSummary(result.total_count, 'orders'), notice) };
        }
    };
}

/**
 * Worded for both readings, since nothing here can tell them apart: a status
 * the agent invented, and a custom status that no order holds yet.
 */
function unknownStatusNotice(status: string | undefined, totalCount: number): string | undefined {
    if (status === undefined || totalCount > 0 || isStockOrderStatus(status)) return undefined;
    return (
        `No order has status "${status}", which is not one of Magento's stock statuses. Unless this store ` +
        'defines it, use a status code listed for the status filter.'
    );
}
