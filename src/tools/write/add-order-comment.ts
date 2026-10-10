/**
 * `add_order_comment`: appends a comment to an order's status history.
 *
 * The agent cannot choose the order's status: the port takes none (see
 * `OrderCommentInput`). The call is still not purely additive, so it is marked
 * destructive: Magento saves the whole order with the comment, and that save
 * re-derives the state from the order's invoices, shipments and credit memos
 * (`Handler\State::check`), moving an order whose state lags behind them. The
 * answer reports the state before and after.
 *
 * Not idempotent: a second call adds a second comment, and may send a second
 * email. A failure after the request may have reached Magento is therefore not
 * retryable; the agent is told to check the order's comments first. That
 * includes a 400: Magento 2.4.9 saves the order before it sends the email, and
 * a failed email is a 400 with the comment already stored.
 */
import * as z from 'zod';
import { toToolError } from '../../errors/map-upstream.js';
import { ToolError } from '../../errors/tool-error.js';
import { AddOrderCommentOutputSchema, type AddOrderCommentOutput } from '../../projection/fields.js';
import { logToolError } from '../../shared/logger.js';
import { answerText, type RetryContext, type ToolDefinition, type ToolDeps, type ToolHints } from '../definition.js';

const MAX_COMMENT_LENGTH = 2000;

const DESCRIPTION =
    "Append a comment to an order's status history, by its increment ID — the customer-facing number such as " +
    "000000123. The comment records the order's current status; this tool never sets one. Magento saves the whole " +
    "order with the comment, and saving re-derives the order's state from its invoices, shipments and credit memos: " +
    'an order whose state lags behind them moves, for example from processing to complete. The answer reports the ' +
    'state before and after. This cannot be undone through this server, and calling it twice adds two comments. ' +
    'Set notifyCustomer only when the shopper should receive an email — that sends real mail to a real person. Set ' +
    "visibleOnFront to expose the comment in the customer's account area.";

/**
 * Destructive, since saving the comment can move a lagging order's state on;
 * not idempotent, since a repeat appends again.
 */
const ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
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
    const { client, logger } = deps;

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

            // The comment is stored, so nothing from here on may turn the answer
            // into a failure. The order is read again only to report what the
            // save did to it.
            const previous: OrderState = { state: order.state, status: order.status };
            let current: OrderState | undefined;
            try {
                const saved = await client.findOrderByIncrementId(order.increment_id);
                if (saved !== undefined) current = { state: saved.state, status: saved.status };
            } catch (error) {
                const readError = toToolError(error, { tokenAccepted: true, idempotent: true });
                logToolError(logger, 'add_order_comment re-read', readError, 'warn');
            }

            const structuredContent: AddOrderCommentOutput = {
                incrementId: order.increment_id,
                previous,
                ...(current === undefined ? {} : { current }),
                notifyCustomer,
                visibleOnFront,
                ...noticeOf(previous, current)
            };
            return { structuredContent, text: answerText(summarize(structuredContent), structuredContent.notice) };
        }
    };
}

interface OrderState {
    readonly state: string;
    readonly status: string;
}

function noticeOf(previous: OrderState, current: OrderState | undefined): { notice?: string } {
    if (current === undefined) {
        return {
            notice: 'The comment was stored, but the order could not be read again: check its status with get_order.'
        };
    }
    if (current.state === previous.state && current.status === previous.status) return {};
    return {
        notice:
            "Saving the comment made Magento re-derive the order's state from its invoices, shipments and credit " +
            `memos: it moved from ${describe(previous)} to ${describe(current)}.`
    };
}

/** "processing", or "processing (status fraud)" where the two differ. */
function describe({ state, status }: OrderState): string {
    return state === status ? state : `${state} (status ${status})`;
}

/** "Added a comment to order 000000003 (processing); the customer was not notified." */
function summarize({ incrementId, previous, notifyCustomer }: AddOrderCommentOutput): string {
    const email = notifyCustomer ? 'an email to the customer was requested' : 'the customer was not notified';
    return `Added a comment to order ${incrementId} (${previous.status}); ${email}.`;
}
