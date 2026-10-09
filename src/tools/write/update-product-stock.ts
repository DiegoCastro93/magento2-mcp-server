/**
 * `update_product_stock`: sets one SKU's on-hand quantity at the configured
 * source, as an absolute value.
 *
 * `POST /V1/inventory/source-items` upserts and checks neither that the product
 * exists nor that its type holds stock, so the handler checks all three first:
 * an unknown SKU, a type without stock of its own, and a product not assigned
 * to the source are refused before anything is written. Those checks are also
 * what proves the token, so a 401 on the write itself is the integration
 * lacking the write ACL.
 */
import * as z from 'zod';
import { toToolError, type UpstreamContext } from '../../errors/map-upstream.js';
import { ToolError } from '../../errors/tool-error.js';
import { SOURCE_ITEM_STATUS, type SourceItemStatus } from '../../magento/client.js';
import { hasOwnStock } from '../../magento/product-types.js';
import { UpdateProductStockOutputSchema, type UpdateProductStockOutput } from '../../projection/fields.js';
import type { ToolDefinition, ToolDeps, ToolHints } from '../definition.js';

const DESCRIPTION =
    'Set the on-hand quantity for one SKU at the configured inventory source. This overwrites the current ' +
    'quantity with an absolute value — it is not a delta. The answer reports the previous quantity; nothing else ' +
    'keeps it. Only simple, virtual and downloadable products hold stock of their own, and only at a source they ' +
    'are already assigned to; anything else is refused. Salable quantity may differ from the value you set, ' +
    'because Magento subtracts open order reservations: call get_product to see it.';

/**
 * Destructive: it overwrites a value rather than adding one. Idempotent: it
 * sets an absolute quantity, so repeating the same call changes nothing.
 */
const ANNOTATIONS = {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true
} as const satisfies ToolHints;

const UpdateProductStockInputSchema = z.object({
    sku: z.string().min(1),
    quantity: z.number().min(0).describe('The new on-hand quantity at the source: an absolute value, not a delta.'),
    status: z
        .enum(['in_stock', 'out_of_stock'])
        .optional()
        .describe('Defaults from quantity: in_stock above 0, out_of_stock at 0.')
});

export function defineUpdateProductStock(
    deps: ToolDeps
): ToolDefinition<typeof UpdateProductStockInputSchema, typeof UpdateProductStockOutputSchema> {
    const { client, sourceCode } = deps;

    return {
        name: 'update_product_stock',
        description: DESCRIPTION,
        inputSchema: UpdateProductStockInputSchema,
        outputSchema: UpdateProductStockOutputSchema,
        annotations: ANNOTATIONS,
        retry: { idempotent: true },

        async handler({ sku, quantity, status }) {
            const settled = await Promise.allSettled([
                client.getProduct(sku),
                client.getSourceItem(sku, sourceCode)
            ] as const);
            const [product, sourceItem] = settled;
            const context: UpstreamContext = {
                tokenAccepted: settled.some((result) => result.status === 'fulfilled'),
                idempotent: true
            };

            if (product.status === 'rejected') throw toToolError(product.reason, context);
            const raw = product.value;
            if (raw === undefined) {
                throw new ToolError('NOT_FOUND', `No product with SKU '${sku}'.`, {
                    suggestion: 'Use search_products to find the correct SKU.'
                });
            }
            // Magento would store the row, and it would change nothing that sells.
            if (!hasOwnStock(raw.type_id)) {
                throw new ToolError(
                    'INVALID_INPUT',
                    `Product '${raw.sku}' is a ${raw.type_id} product, which holds no stock of its own.`,
                    {
                        suggestion:
                            'Its stock lives on the products it is made of; set the stock of each of those instead.'
                    }
                );
            }

            if (sourceItem.status === 'rejected') throw toToolError(sourceItem.reason, context);
            const previous = sourceItem.value;
            // Magento would upsert the row, assigning the product to the source.
            if (previous === undefined) {
                throw new ToolError('NOT_FOUND', `Product '${raw.sku}' is not assigned to source '${sourceCode}'.`, {
                    suggestion:
                        'This server sets stock only at a source the product is already assigned to. A human ' +
                        'operator must assign it in the Magento admin, or check MAGENTO_SOURCE_CODE if no product ' +
                        'is assigned to that source.'
                });
            }

            const current = { quantity, status: status ?? (quantity > 0 ? 'in_stock' : 'out_of_stock') } as const;
            await client
                .updateSourceItem({ sku: raw.sku, sourceCode: previous.source_code, ...current })
                .catch((error: unknown) => {
                    throw toToolError(error, { tokenAccepted: true, idempotent: true });
                });

            const structuredContent: UpdateProductStockOutput = {
                sku: raw.sku,
                sourceCode: previous.source_code,
                previous: {
                    quantity: previous.quantity,
                    status: previous.status === SOURCE_ITEM_STATUS.in_stock ? 'in_stock' : 'out_of_stock'
                },
                current
            };
            return { structuredContent, text: summarize(structuredContent) };
        }
    };
}

/** "Set 24-MB01 to 120 on hand at source "default", in stock (was 100, in stock)." */
function summarize({ sku, sourceCode, previous, current }: UpdateProductStockOutput): string {
    return (
        `Set ${sku} to ${current.quantity} on hand at source "${sourceCode}", ${words(current.status)} ` +
        `(was ${previous.quantity}, ${words(previous.status)}).`
    );
}

function words(status: SourceItemStatus): string {
    return status === 'in_stock' ? 'in stock' : 'out of stock';
}
