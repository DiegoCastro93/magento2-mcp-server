/**
 * The canonical tool names, in one place.
 *
 * `config.ts` validates the write allowlist against {@link WRITE_TOOL_NAMES},
 * so a misspelled entry fails at startup instead of silently leaving a tool
 * unregistered — a failure that would look exactly like the permission gate
 * working correctly.
 */

export const READ_TOOL_NAMES = [
    'search_products',
    'get_product',
    'search_orders',
    'get_order',
    'get_customer'
] as const;

export const WRITE_TOOL_NAMES = ['update_product_stock', 'add_order_comment'] as const;

export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export type WriteToolName = (typeof WRITE_TOOL_NAMES)[number];
export type ToolName = ReadToolName | WriteToolName;

export function isWriteToolName(value: string): value is WriteToolName {
    return (WRITE_TOOL_NAMES as readonly string[]).includes(value);
}
