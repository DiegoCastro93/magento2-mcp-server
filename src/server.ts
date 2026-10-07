/**
 * Builds the MCP server from tool definitions.
 *
 * `createServer` does no I/O: `serveStdio` may call it more than once per
 * process — a discovery probe is built and discarded before the instance that
 * serves the connection — so everything slow or fallible, such as loading
 * fixtures, happens once before it.
 */
import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import * as z from 'zod';
import { toToolError } from './errors/map-upstream.js';
import { toToolResult } from './errors/to-result.js';
import { logToolError, type Logger } from './shared/logger.js';
import type { ToolDefinition, ToolDeps } from './tools/definition.js';
import { readTools } from './tools/registry.js';

export interface ServerInfo {
    readonly name: string;
    readonly version: string;
}

export interface ServerDeps extends ToolDeps {
    readonly serverInfo: ServerInfo;
}

export function createServer(deps: ServerDeps): McpServer {
    const server = new McpServer(deps.serverInfo, { capabilities: { tools: {} } });
    for (const tool of readTools(deps)) addTool(server, tool, deps.logger);
    return server;
}

/** Registers `tool` behind the wrapper that every answer and every failure passes through. */
export function addTool(server: McpServer, tool: ToolDefinition, logger: Logger): void {
    server.registerTool(
        tool.name,
        {
            description: tool.description,
            inputSchema: tool.inputSchema,
            outputSchema: tool.outputSchema,
            annotations: tool.annotations
        },
        (input) => run(tool, input, logger)
    );
}

/**
 * Runs the handler, and makes sure the agent receives either an answer that
 * matches the tool's `outputSchema` or the error envelope — never anything else.
 *
 * The output is checked here, not left to the SDK: on a mismatch the SDK
 * answers with its own error text, outside the envelope and unlogged, naming
 * the offending keys — such as one a projection should never have let through.
 */
async function run(
    tool: ToolDefinition,
    input: z.infer<ToolDefinition['inputSchema']>,
    logger: Logger
): Promise<CallToolResult> {
    const started = performance.now();
    try {
        const { structuredContent, text } = await tool.handler(input);
        const checked = tool.outputSchema.safeParse(structuredContent);
        if (!checked.success) {
            throw new Error(`${tool.name} answered outside its outputSchema:\n${z.prettifyError(checked.error)}`);
        }
        logger.debug(`${tool.name} answered in ${Math.round(performance.now() - started)} ms`);
        return { content: [{ type: 'text', text }], structuredContent: checked.data };
    } catch (error) {
        // The handler maps what it knows how to; anything else that escapes it
        // is mapped here with the tool's own retry semantics, and no token proven.
        const toolError = toToolError(error, { tokenAccepted: false, ...tool.retry });
        logToolError(logger, tool.name, toolError);
        return toToolResult(toolError);
    }
}
