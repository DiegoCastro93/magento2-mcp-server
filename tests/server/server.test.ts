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

function serve(magento: MagentoClient = fixtures): { connected: Promise<Client>; log: () => string } {
    const { logger, output } = memoryLogger();
    const deps = { client: magento, logger, sourceCode: 'default', stockId: 1, serverInfo: SERVER_INFO };
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
    it('lists get_product, with all four hints and a closed output schema', async () => {
        const { tools } = await (await serve().connected).listTools();

        expect(tools.map((t) => t.name)).toEqual(['get_product']);
        const [tool] = tools;
        expect(tool?.annotations).toMatchObject(READ_ANNOTATIONS);
        expect(tool?.outputSchema).toMatchObject({
            type: 'object',
            additionalProperties: false,
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

    it('leaves input that violates the schema to the SDK, outside the envelope', async () => {
        // Pinned as known behaviour: the SDK refuses before the handler runs,
        // with a readable message but without structuredContent.error.
        const result = await (await serve().connected).callTool({ name: 'get_product', arguments: { sku: '' } });

        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
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
