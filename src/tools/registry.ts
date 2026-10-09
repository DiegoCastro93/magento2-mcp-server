/**
 * The tools the server registers: the read tools always, and the write tools
 * only when named in `MAGENTO_MCP_WRITE_TOOLS`.
 */
import type { ToolDefinition, ToolDeps } from './definition.js';
import { WRITE_TOOL_NAMES, type WriteToolName } from './names.js';
import { defineGetCustomer } from './read/get-customer.js';
import { defineGetOrder } from './read/get-order.js';
import { defineGetProduct } from './read/get-product.js';
import { defineSearchOrders } from './read/search-orders.js';
import { defineSearchProducts } from './read/search-products.js';
import { defineAddOrderComment } from './write/add-order-comment.js';
import { defineUpdateProductStock } from './write/update-product-stock.js';

/** In the order of `READ_TOOL_NAMES`, which is the order `tools/list` shows them. */
export function readTools(deps: ToolDeps): readonly ToolDefinition[] {
    return [
        defineSearchProducts(deps),
        defineGetProduct(deps),
        defineSearchOrders(deps),
        defineGetOrder(deps),
        defineGetCustomer(deps)
    ];
}

/** Keyed by name, so a name added to `WRITE_TOOL_NAMES` without a definition fails the typecheck. */
const WRITE_TOOLS = {
    update_product_stock: defineUpdateProductStock,
    add_order_comment: defineAddOrderComment
} as const satisfies Record<WriteToolName, (deps: ToolDeps) => ToolDefinition>;

/**
 * The write tools named in `enabled`, and no other. They come in the order of
 * `WRITE_TOOL_NAMES`, whatever the allowlist's order.
 */
export function writeTools(deps: ToolDeps, enabled: readonly WriteToolName[]): readonly ToolDefinition[] {
    return WRITE_TOOL_NAMES.filter((name) => enabled.includes(name)).map((name) => WRITE_TOOLS[name](deps));
}
