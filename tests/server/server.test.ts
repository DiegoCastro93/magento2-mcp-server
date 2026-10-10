/**
 * The server as an MCP client sees it, over an in-memory transport: what
 * `tools/list` advertises, and that every answer is either valid
 * `structuredContent` or the error envelope.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { MagentoClient } from '../../src/magento/client.js';
import type { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { addTool, createServer } from '../../src/server.js';
import { READ_ANNOTATIONS, READ_RETRY, type ToolDefinition } from '../../src/tools/definition.js';
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES, type WriteToolName } from '../../src/tools/names.js';
import { loadFixtureClient, memoryLogger, override } from '../tools/client-stubs.js';

const SERVER_INFO = { name: 'magento2-mcp-server', version: '0.0.0-test' };

let fixtures: FixtureMagentoClient;
let client: Client | undefined;

beforeAll(async () => {
    fixtures = await loadFixtureClient();
});

afterEach(async () => {
    await client?.close();
    client = undefined;
});

async function connect(server: McpServer): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: 'server-spec', version: '0.0.0' });
    await client.connect(clientTransport);
    return client;
}

function serve(
    magento: MagentoClient = fixtures,
    writeTools: readonly WriteToolName[] = []
): { connected: Promise<Client>; log: () => string } {
    const { logger, output } = memoryLogger();
    const deps = { client: magento, logger, sourceCode: 'default', stockId: 1, serverInfo: SERVER_INFO, writeTools };
    const server = createServer(deps);
    return { connected: connect(server), log: output };
}

function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
    return result.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n');
}

describe('createServer', () => {
    it('lists only the five read tools with no write tool enabled, all hints set, output schemas closed', async () => {
        const { tools } = await (await serve().connected).listTools();

        expect(tools.map((t) => t.name)).toEqual([...READ_TOOL_NAMES]);
        for (const tool of tools) {
            expect(tool.annotations, tool.name).toMatchObject(READ_ANNOTATIONS);
            expect(tool.outputSchema, tool.name).toMatchObject({ type: 'object', additionalProperties: false });
        }
        expect(tools.find((t) => t.name === 'get_product')?.outputSchema).toMatchObject({
            properties: { stock: { additionalProperties: false } }
        });
    });

    it('answers with structuredContent and a one-line summary', async () => {
        const result = await (await serve().connected).callTool({ name: 'get_product', arguments: { sku: '24-MB01' } });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
            product: { sku: '24-MB01' },
            stock: { salableQuantity: 97, sourceQuantity: 100 }
        });
        expect(textOf(result)).toBe('24-MB01 Joust Duffle Bag: 97 salable, 100 on hand at source "default".');
    });

    it("returns a handler's ToolError as the envelope, and logs it", async () => {
        const { connected, log } = serve();

        const result = await (await connected).callTool({ name: 'get_product', arguments: { sku: 'NO-SUCH-SKU' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toStrictEqual({
            error: {
                code: 'NOT_FOUND',
                message: "No product with SKU 'NO-SUCH-SKU'.",
                retryable: false,
                suggestion: 'Use search_products to find the correct SKU.'
            }
        });
        expect(log()).toContain("INFO get_product: NOT_FOUND: No product with SKU 'NO-SUCH-SKU'.");
    });

    it('turns a defect into INTERNAL_ERROR, with the detail in the log only', async () => {
        const broken = override(fixtures, {
            getProduct: () => Promise.reject(new TypeError("Cannot read properties of undefined (reading 'sku')"))
        });
        const { connected, log } = serve(broken);

        const result = await (await connected).callTool({ name: 'get_product', arguments: { sku: '24-MB01' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR', retryable: false } });
        expect(JSON.stringify(result)).not.toContain('Cannot read properties');
        expect(log()).toContain('ERROR get_product: INTERNAL_ERROR');
        expect(log()).toContain("TypeError: Cannot read properties of undefined (reading 'sku')");
        expect(log()).toMatch(/\n {4}\s*at /);
    });

    it('returns a broken cross-field rule as the INVALID_INPUT envelope, and logs it', async () => {
        // The handler checks it, since a zod refine would fail outside the envelope.
        const { connected, log } = serve();

        const result = await (await connected).callTool({
            name: 'search_products',
            arguments: { priceMin: 5, priceMax: 0 }
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toStrictEqual({
            error: {
                code: 'INVALID_INPUT',
                message: 'priceMin (5) is greater than priceMax (0).',
                retryable: false,
                suggestion: 'Swap the two values, or drop one of them to leave that end of the range open.'
            }
        });
        expect(log()).toContain('INFO search_products: INVALID_INPUT: priceMin (5) is greater than priceMax (0).');
    });

    it('advertises a cross-field rule in the field description, since the JSON Schema cannot carry it', async () => {
        const { tools } = await (await serve().connected).listTools();

        const search = tools.find((t) => t.name === 'search_products');
        expect(search?.inputSchema).toMatchObject({
            properties: { priceMin: { description: expect.stringContaining('Must not be greater than priceMax.') } }
        });
    });

    it('leaves input that violates the schema to the SDK, outside the envelope', async () => {
        // Pinned as known behaviour: the SDK refuses before the handler runs,
        // with a readable message but without structuredContent.error.
        const result = await (await serve().connected).callTool({ name: 'get_product', arguments: { sku: '' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
    });
});

describe('the write gate', () => {
    // 5 read tools always; each enabled write tool adds one: 5, 6 or 7.
    async function listed(writeTools: readonly WriteToolName[]): Promise<string[]> {
        const { tools } = await (await serve(fixtures, writeTools).connected).listTools();
        return tools.map((t) => t.name);
    }

    it.each(WRITE_TOOL_NAMES)('registers %s alone when it is the only one named: 6 tools', async (name) => {
        expect(await listed([name])).toEqual([...READ_TOOL_NAMES, name]);
    });

    it('registers both in canonical order, whatever the allowlist order: 7 tools', async () => {
        const names = await listed(['add_order_comment', 'update_product_stock']);

        expect(names).toHaveLength(7);
        expect(names).toEqual([...READ_TOOL_NAMES, 'update_product_stock', 'add_order_comment']);
    });

    // Both writes are destructive: a comment saves the whole order, which can
    // move a lagging order's state. Only the absolute stock set repeats harmlessly.
    it('marks both writes destructive and only the stock overwrite idempotent, all four hints explicit', async () => {
        const { tools } = await (await serve(fixtures, [...WRITE_TOOL_NAMES]).connected).listTools();
        const hints = (name: string) => tools.find((t) => t.name === name)?.annotations;

        expect(hints('update_product_stock')).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true
        });
        expect(hints('add_order_comment')).toEqual({
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true
        });
        for (const name of WRITE_TOOL_NAMES) {
            expect(tools.find((t) => t.name === name)?.outputSchema, name).toMatchObject({
                type: 'object',
                additionalProperties: false
            });
        }
    });

    it('refuses a withheld write tool as an unknown tool, and writes nothing', async () => {
        // The gate is registration, not a hidden tools/list entry: the SDK
        // answers a call to it with a protocol error, before any handler.
        const store = await loadFixtureClient();
        const connected = await serve(store, ['add_order_comment']).connected;

        await expect(
            connected.callTool({ name: 'update_product_stock', arguments: { sku: '24-MB01', quantity: 0 } })
        ).rejects.toThrow('Tool update_product_stock not found');
        expect(await store.getSourceItem('24-MB01', 'default')).toMatchObject({ quantity: 100 });
    });

    it('runs an enabled write tool through the wrapper', async () => {
        const store = await loadFixtureClient();
        const connected = await serve(store, ['update_product_stock']).connected;

        const result = await connected.callTool({
            name: 'update_product_stock',
            arguments: { sku: '24-MB01', quantity: 120 }
        });

        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toEqual({
            sku: '24-MB01',
            sourceCode: 'default',
            previous: { quantity: 100, status: 'in_stock' },
            current: { quantity: 120, status: 'in_stock' }
        });
        expect(textOf(result)).toBe('Set 24-MB01 to 120 on hand at source "default", in stock (was 100, in stock).');
    });

    it("maps a defect escaping a write handler with that tool's own retry context", async () => {
        // A synchronous throw escapes the handler's own mapping and reaches
        // the wrapper, which must not call a maybe-applied comment retryable.
        const store = await loadFixtureClient();
        const broken = override(store, {
            addOrderComment: () => {
                throw new TypeError('adapter defect');
            }
        });
        const { connected, log } = serve(broken, ['add_order_comment']);

        const result = await (await connected).callTool({
            name: 'add_order_comment',
            arguments: { incrementId: '000000003', comment: 'Packed.' }
        });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({
            error: {
                code: 'INTERNAL_ERROR',
                retryable: false,
                suggestion:
                    'Magento may have applied the request before the failure. ' +
                    "Check the order's comments with get_order before retrying."
            }
        });
        expect(JSON.stringify(result)).not.toContain('adapter defect');
        expect(log()).toContain('ERROR add_order_comment: INTERNAL_ERROR');
    });
});

describe('addTool', () => {
    /** A tool whose answer breaks its own outputSchema, as a projection defect would. */
    const leaky: ToolDefinition = {
        name: 'get_product',
        description: 'A tool whose projection lets a field through.',
        inputSchema: z.object({ sku: z.string() }),
        outputSchema: z.strictObject({ sku: z.string() }),
        annotations: READ_ANNOTATIONS,
        retry: READ_RETRY,
        handler: ({ sku }) =>
            Promise.resolve({ structuredContent: { sku, protect_code: 'a1b2c3-secret' }, text: `${String(sku)}.` })
    };

    function serveLeaky(): { connected: Promise<Client>; log: () => string } {
        const { logger, output } = memoryLogger();
        const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
        addTool(server, leaky, logger);
        return { connected: connect(server), log: output };
    }

    it('refuses an answer outside the outputSchema as INTERNAL_ERROR, without echoing it', async () => {
        const { connected, log } = serveLeaky();

        const result = await (await connected).callTool({ name: 'get_product', arguments: { sku: '24-MB01' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
        expect(JSON.stringify(result)).not.toContain('a1b2c3-secret');
        expect(JSON.stringify(result)).not.toContain('protect_code');
        expect(log()).toContain('get_product answered outside its outputSchema');
        expect(log()).toContain('protect_code');
    });
});
