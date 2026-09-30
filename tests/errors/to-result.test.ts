import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';
import { toToolResult } from '../../src/errors/to-result.js';
import { ToolError } from '../../src/errors/tool-error.js';

describe('toToolResult', () => {
    it('builds the full envelope', () => {
        const error = new ToolError('RATE_LIMITED', 'Magento is rate-limiting requests.', {
            suggestion: 'Wait 30 seconds before retrying.',
            retryAfterSeconds: 30
        });

        expect(toToolResult(error)).toEqual({
            content: [
                {
                    type: 'text',
                    text: 'RATE_LIMITED: Magento is rate-limiting requests. — Wait 30 seconds before retrying.'
                }
            ],
            structuredContent: {
                error: {
                    code: 'RATE_LIMITED',
                    message: 'Magento is rate-limiting requests.',
                    retryable: true,
                    suggestion: 'Wait 30 seconds before retrying.',
                    retryAfterSeconds: 30
                }
            },
            isError: true
        });
    });

    it('omits absent fields rather than sending them as undefined', () => {
        const result = toToolResult(new ToolError('NOT_FOUND', 'No product with SKU "24-XX99".'));

        expect(result.content).toEqual([{ type: 'text', text: 'NOT_FOUND: No product with SKU "24-XX99".' }]);
        expect(Object.keys((result.structuredContent as { error: object }).error)).toEqual([
            'code',
            'message',
            'retryable'
        ]);
    });

    it('never carries the cause', () => {
        const cause = new Error('Authorization: Bearer abc123secrettoken');
        const result = toToolResult(new ToolError('INTERNAL_ERROR', 'The MCP server failed.', { cause }));

        expect(JSON.stringify(result)).not.toContain('abc123secrettoken');
    });

    // The error payload does not match the tool's outputSchema. Both ends of
    // the SDK skip output validation when isError is set; this pins that, with
    // the client holding the schema from tools/list, as a real host does.
    it('reaches a client intact through a tool that declares an outputSchema', async () => {
        const server = new McpServer({ name: 'to-result', version: '0.0.0' }, { capabilities: { tools: {} } });
        server.registerTool(
            'get_like_tool',
            {
                description: 'Fails the way a tool does.',
                inputSchema: z.object({ sku: z.string().min(1) }),
                outputSchema: z.object({ sku: z.string(), name: z.string() })
            },
            async ({ sku }) =>
                toToolResult(
                    new ToolError('NOT_FOUND', `No product with SKU "${sku}".`, {
                        suggestion: 'Use search_products to find the correct SKU.'
                    })
                )
        );

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        const client = new Client({ name: 'test-harness', version: '0.0.0' });
        await server.connect(serverTransport);
        await client.connect(clientTransport);
        await client.listTools();

        const result = await client.callTool({ name: 'get_like_tool', arguments: { sku: '24-XX99' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toEqual({
            error: {
                code: 'NOT_FOUND',
                message: 'No product with SKU "24-XX99".',
                retryable: false,
                suggestion: 'Use search_products to find the correct SKU.'
            }
        });

        await client.close();
    });
});
