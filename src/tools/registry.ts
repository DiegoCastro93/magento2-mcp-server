/**
 * The tools the server registers. Read tools always; the write tools, gated by
 * `MAGENTO_MCP_WRITE_TOOLS`, arrive with increment 7.
 */
import type { ToolDefinition, ToolDeps } from './definition.js';
import { defineGetCustomer } from './read/get-customer.js';
import { defineGetOrder } from './read/get-order.js';
import { defineGetProduct } from './read/get-product.js';
import { defineSearchOrders } from './read/search-orders.js';
import { defineSearchProducts } from './read/search-products.js';

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
