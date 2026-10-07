/**
 * `get_product`: one product's detail and its stock, from four upstream calls.
 *
 * The calls are issued together and awaited with `Promise.allSettled`, not
 * `Promise.all`. That is load-bearing: `Promise.all` rejects on the first
 * failure, so an MSI endpoint being down would throw away the product that the
 * first call returned, the opposite of the degradation this tool promises.
 * Only the product itself is required; each stock call fails on its own, and
 * the notice says what is missing and why.
 */
import * as z from 'zod';
import { toToolError, type UpstreamContext } from '../../errors/map-upstream.js';
import { ToolError } from '../../errors/tool-error.js';
import { hasOwnStock } from '../../magento/product-types.js';
import {
    GetProductOutputSchema,
    type GetProductOutput,
    type ProductDetail,
    type StockDetail
} from '../../projection/fields.js';
import { projectProductDetail } from '../../projection/product.js';
import { projectStock, type Outcome } from '../../projection/stock.js';
import { Notices } from '../../projection/truncate.js';
import { logToolError } from '../../shared/logger.js';
import { READ_ANNOTATIONS, READ_RETRY, type ToolDefinition, type ToolDeps } from '../definition.js';

const DESCRIPTION =
    'Get detail and current inventory for exactly one product, by SKU. Returns an allowlisted subset of the ' +
    "product's attributes plus its stock at the configured inventory source: on-hand source quantity, salable " +
    'quantity (on-hand minus open order reservations), and whether Magento currently considers it sellable. A ' +
    'stock field that is absent is unknown, not zero; notice says why. Use search_products first if you do not ' +
    'know the exact SKU.';

const GetProductInputSchema = z.object({ sku: z.string().min(1) });

export function defineGetProduct(
    deps: ToolDeps
): ToolDefinition<typeof GetProductInputSchema, typeof GetProductOutputSchema> {
    const { client, logger, sourceCode, stockId } = deps;

    return {
        name: 'get_product',
        description: DESCRIPTION,
        inputSchema: GetProductInputSchema,
        outputSchema: GetProductOutputSchema,
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,

        async handler({ sku }) {
            const settled = await Promise.allSettled([
                client.getProduct(sku),
                client.getSourceItem(sku, sourceCode),
                client.getSalableQuantity(sku, stockId),
                client.isProductSalable(sku, stockId)
            ] as const);
            const [product, sourceItem, salableQuantity, isSalable] = settled;

            // Any answer proves the token, which turns a 401 on another call
            // into a missing ACL resource rather than a dead credential.
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

            // A type without stock of its own draws no source item and a 400 on
            // salable quantity by design; that is no failure worth a log line.
            const ownStock = hasOwnStock(raw.type_id);
            const outcome = <T>(result: PromiseSettledResult<T>, subject: string, expected: boolean): Outcome<T> => {
                if (result.status === 'fulfilled') return { ok: true, value: result.value };
                const error = toToolError(result.reason, context);
                if (!expected) logToolError(logger, `get_product ${subject}`, error, 'warn');
                return { ok: false, error };
            };

            const notices = new Notices();
            const detail = projectProductDetail(raw, notices);
            const stock = projectStock(
                {
                    product: raw,
                    sourceCode,
                    sourceItem: outcome(sourceItem, 'sourceItem', !ownStock),
                    salableQuantity: outcome(salableQuantity, 'salableQuantity', !ownStock),
                    isSalable: outcome(isSalable, 'isSalable', false)
                },
                notices
            );
            const notice = notices.toNotice();

            const structuredContent: GetProductOutput = { product: detail, stock, notice };
            const line = summarize(detail, stock);
            return { structuredContent, text: notice === undefined ? line : `${line} ${notice}` };
        }
    };
}

/** "24-MB01 Joust Duffle Bag: 97 salable, 100 on hand at source "default"." */
function summarize(product: ProductDetail, stock: StockDetail): string {
    const parts: string[] = [];
    if (stock.salableQuantity !== undefined) parts.push(`${stock.salableQuantity} salable`);
    if (stock.sourceQuantity !== undefined) {
        parts.push(`${stock.sourceQuantity} on hand at source "${stock.sourceCode}"`);
    }
    if (parts.length === 0 && stock.isSalable !== undefined) parts.push(stock.isSalable ? 'salable' : 'not salable');
    if (parts.length === 0) parts.push('stock unknown');
    return `${product.sku} ${product.name}: ${parts.join(', ')}.`;
}
