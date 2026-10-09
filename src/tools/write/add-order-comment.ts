/**
 * `add_order_comment`: appends a comment to an order's status history.
 *
 * Purely additive: the port takes no status, so the order keeps the one it
 * has (see `OrderCommentInput`). Not idempotent: a second call adds a second
 * comment, and may send a second email. A failure after the request may have
 * reached Magento is therefore not retryable; the agent is told to check the
 * order's comments first. That includes a 400: Magento 2.4.9 saves the order
 * before it sends the email, and a failed email is a 400 with the comment
 * already stored.
 */
import * as z from 'zod';
import { toToolError } from '../../errors/map-upstream.js';
import { ToolError } from '../../errors/tool-error.js';
import { AddOrderCommentOutputSchema, type AddOrderCommentOutput } from '../../projection/fields.js';
import type { RetryContext, ToolDefinition, ToolDeps, ToolHints } from '../definition.js';

const MAX_COMMENT_LENGTH = 2000;

const DESCRIPTION =
    "Append a comment to an order's status history, by its increment ID — the customer-facing number such as " +
    '000000123. The order itself is not changed: the comment records its current status. This cannot be undone ' +
    'through this server, and calling it twice adds two comments. Set notifyCustomer only when the shopper should ' +
    'receive an email — that sends real mail to a real person. Set visibleOnFront to expose the comment in the ' +
    "customer's account area.";

/** Additive, so not destructive; not idempotent, since a repeat appends again. */
const ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true
} as const satisfies ToolHints;

const RETRY = {
    idempotent: false,
    verifyBeforeRetry: "Check the order's comments with get_order before retrying."
} as const satisfies RetryContext;

const AddOrderCommentInputSchema = z.object({
    incrementId: z.string().min(1),
    comment: z.string().min(1).max(MAX_COMMENT_LENGTH),
    notifyCustomer: z.boolean().default(false),
    visibleOnFront: z.boolean().default(false)
});

export function defineAddOrderComment(
    deps: ToolDeps
): ToolDefinition<typeof AddOrderCommentInputSchema, typeof AddOrderCommentOutputSchema> {
    const { client } = deps;

    return {
        name: 'add_order_comment',
        description: DESCRIPTION,
        inputSchema: AddOrderCommentInputSchema,
        outputSchema: AddOrderCommentOutputSchema,
        annotations: ANNOTATIONS,
        retry: RETRY,

        async handler({ incrementId, comment, notifyCustomer, visibleOnFront }) {
            // Nothing is written yet, so a failure here is as safe to repeat as
            // a read. Left to the server's backstop, it would be mapped with the
            // tool's own retry context and wrongly say the comment may be stored.
            const order = await client.findOrderByIncrementId(incrementId).catch((error: unknown) => {
                throw toToolError(error, { tokenAccepted: false, idempotent: true });
            });
            if (order === undefined) {
                throw new ToolError('NOT_FOUND', `No order with increment ID '${incrementId}'.`, {
                    suggestion:
                        'Use search_orders to find the order. The increment ID is the customer-facing order ' +
                        'number, such as 000000123, not the internal entity ID.'
                });
            }

            await client
                .addOrderComment(order.entity_id, { comment, notifyCustomer, visibleOnFront })
                .catch((error: unknown) => {
                    throw toToolError(error, { tokenAccepted: true, ...RETRY });
                });

            const structuredContent: AddOrderCommentOutput = {
                incrementId: order.increment_id,
                status: order.status,
                notifyCustomer,
                visibleOnFront
            };
            return { structuredContent, text: summarize(structuredContent) };
        }
    };
}

/** "Added a comment to order 000000003 (processing); the customer was not notified." */
function summarize({ incrementId, status, notifyCustomer }: AddOrderCommentOutput): string {
    const email = notifyCustomer ? 'an email to the customer was requested' : 'the customer was not notified';
    return `Added a comment to order ${incrementId} (${status}); ${email}.`;
}
