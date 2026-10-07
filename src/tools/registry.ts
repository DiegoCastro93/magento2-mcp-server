/**
 * The tools the server registers. Read tools always; the write tools, gated by
 * `MAGENTO_MCP_WRITE_TOOLS`, arrive with increment 7.
 */
import type { ToolDefinition, ToolDeps } from './definition.js';
import { defineGetProduct } from './read/get-product.js';

export function readTools(deps: ToolDeps): readonly ToolDefinition[] {
    return [defineGetProduct(deps)];
}
