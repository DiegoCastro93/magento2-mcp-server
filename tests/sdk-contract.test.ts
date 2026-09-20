/**
 * Pins the parts of the MCP SDK surface this project is built on.
 *
 * Everything asserted here is an assumption the design depends on: the shape of
 * `registerTool`, that all four annotation hints survive the round trip to
 * `tools/list`, that `structuredContent` is validated against `outputSchema`,
 * and that a handler throwing produces a readable tool error rather than a
 * protocol error the model never sees.
 *
 * If an SDK upgrade changes any of that, this file fails first and says so,
 * instead of the breakage surfacing as puzzling behaviour inside a tool.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import * as z from 'zod';

const SERVER_INFO = { name: 'sdk-contract', version: '0.0.0' };
const CLIENT_INFO = { name: 'test-harness', version: '0.0.0' };

/** Mirrors how the real read tools will be registered. */
function buildServer(): McpServer {
    const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });

    server.registerTool(
        'read_like_tool',
        {
            description: 'A read-only tool shaped like the catalog tools.',
            inputSchema: z.object({ sku: z.string().min(1) }),
            outputSchema: z.object({
                sku: z.string(),
                name: z.string(),
                notice: z.string().optional()
            }),
            annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: true
            }
        },
        async ({ sku }) => {
            if (sku === 'MISSING') {
                throw new Error(`No product with SKU "${sku}".`);
            }
            const payload = { sku, name: 'Joust Duffle Bag', notice: 'shortDescription was truncated.' };
            return {
                content: [{ type: 'text' as const, text: `Found ${sku}.` }],
                structuredContent: payload
            };
        }
    );

    // Mirrors update_product_stock: an overwrite, hence destructive, but
    // idempotent because it sets an absolute value.
    server.registerTool(
        'write_like_tool',
        {
            description: 'A write tool shaped like update_product_stock.',
            inputSchema: z.object({ sku: z.string().min(1), quantity: z.number().min(0) }),
            annotations: {
                readOnlyHint: false,
                destructiveHint: true,
                idempotentHint: true,
                openWorldHint: true
            }
        },
        async ({ sku, quantity }) => ({
            content: [{ type: 'text' as const, text: `Set ${sku} to ${quantity}.` }]
        })
    );

    return server;
}

async function connect(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = buildServer();
    const client = new Client(CLIENT_INFO);
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    return client;
}

describe('MCP SDK contract', () => {
    it('exposes registered tools with their input schemas', async () => {
        const client = await connect();
        const { tools } = await client.listTools();

        expect(tools.map((t) => t.name).sort()).toEqual(['read_like_tool', 'write_like_tool']);

        const read = tools.find((t) => t.name === 'read_like_tool');
        expect(read?.description).toContain('read-only');
        expect(read?.inputSchema).toBeDefined();

        await client.close();
    });

    it('round-trips all four annotation hints to the client', async () => {
        const client = await connect();
        const { tools } = await client.listTools();

        // The spec's defaults are conservative — an omitted destructiveHint means
        // true — so the read tool must state all four explicitly.
        expect(tools.find((t) => t.name === 'read_like_tool')?.annotations).toMatchObject({
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true
        });

        // The contrast that matters: an overwrite is destructive but idempotent.
        expect(tools.find((t) => t.name === 'write_like_tool')?.annotations).toMatchObject({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true
        });

        await client.close();
    });

    it('returns structuredContent alongside a short text summary', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'read_like_tool',
            arguments: { sku: '24-MB01' }
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
            sku: '24-MB01',
            name: 'Joust Duffle Bag',
            notice: 'shortDescription was truncated.'
        });

        await client.close();
    });

    it('turns a thrown handler error into a tool error the model can read', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'read_like_tool',
            arguments: { sku: 'MISSING' }
        });

        // Resolves as an ordinary result, not a rejected promise: this is what
        // lets the error design put recovery hints in front of the model.
        expect(result.isError).toBe(true);

        // The thrown message reaches the model verbatim in a text block.
        const text = result.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join('\n');
        expect(text).toContain('No product with SKU "MISSING"');

        await client.close();
    });

    it('rejects arguments that violate the input schema before the handler runs', async () => {
        const client = await connect();
        const result = await client.callTool({
            name: 'read_like_tool',
            arguments: { sku: '' }
        });

        expect(result.isError).toBe(true);

        await client.close();
    });
});
