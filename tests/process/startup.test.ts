/**
 * The built server as a client launches it: `node dist/index.js`, from an
 * arbitrary working directory, with a clean environment.
 *
 * This is the only spec that runs `index.ts`: `serveStdio`, the exit code of a
 * refused start, the fixture banner, and the rule that stdout carries nothing
 * but JSON-RPC.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Client, deserializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const ENTRY = join(ROOT, 'dist', 'index.js');
const TOKEN = 'abc123secrettoken';

/** Only what a launched server needs, so nothing from the developer's shell leaks in. */
function environment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return { PATH: process.env['PATH'] ?? '', ...extra };
}

/** The real layout matters: the fixtures default resolves from where the module sits. */
beforeAll(() => {
    const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
    execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: ROOT, stdio: 'pipe' });
}, 60_000);

/**
 * Launches the server and speaks newline-delimited JSON-RPC to it, keeping
 * every line of its stdout. The SDK's own stdio client silently skips a line
 * that is not JSON, so it cannot tell a clean stdout from a polluted one.
 */
class RecordingTransport implements Transport {
    readonly stdoutLines: string[] = [];
    stderr = '';
    onclose?: Transport['onclose'];
    onerror?: Transport['onerror'];
    onmessage?: Transport['onmessage'];
    #child: ChildProcessWithoutNullStreams | undefined;
    #exited: Promise<void> | undefined;
    #pending = '';

    constructor(private readonly env: NodeJS.ProcessEnv) {}

    start(): Promise<void> {
        const child = spawn(process.execPath, [ENTRY], { cwd: tmpdir(), env: this.env, stdio: 'pipe' });
        this.#child = child;
        this.#exited = new Promise((resolve) => child.once('close', () => resolve()));
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.#read(chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (this.stderr += chunk));
        child.once('error', (error) => this.onerror?.(error));
        child.once('close', () => this.onclose?.());
        return Promise.resolve();
    }

    send(message: JSONRPCMessage): Promise<void> {
        this.#child?.stdin.write(`${JSON.stringify(message)}\n`);
        return Promise.resolve();
    }

    async close(): Promise<void> {
        this.#child?.stdin.end();
        await this.#exited;
    }

    #read(chunk: string): void {
        this.#pending += chunk;
        for (let end = this.#pending.indexOf('\n'); end !== -1; end = this.#pending.indexOf('\n')) {
            const line = this.#pending.slice(0, end);
            this.#pending = this.#pending.slice(end + 1);
            this.stdoutLines.push(line);
            try {
                this.onmessage?.(deserializeMessage(line));
            } catch {
                // Kept in stdoutLines, where the spec asserts on it.
            }
        }
    }
}

interface Exit {
    readonly code: number | null;
    readonly stdout: string;
    readonly stderr: string;
}

/** Starts the server with stdin already closed and waits for it to exit. */
function run(env: NodeJS.ProcessEnv): Promise<Exit> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [ENTRY], { cwd: tmpdir(), env, stdio: 'pipe' });
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end();
    });
}

interface Received {
    readonly request: string;
    readonly authorization: string | undefined;
}

interface FakeMagento {
    /** On loopback, where plain http is allowed. */
    readonly baseUrl: string;
    readonly received: Received[];
    close(): Promise<void>;
}

const fakes: FakeMagento[] = [];

afterEach(async () => {
    for (const fake of fakes.splice(0)) await fake.close();
});

/**
 * A stand-in for Magento's REST API on a free loopback port. Routes are keyed
 * `METHOD /path`, without the query; anything else gets an HTML 404, as from
 * a web server.
 */
async function fakeMagento(routes: Readonly<Record<string, unknown>> = {}): Promise<FakeMagento> {
    const received: Received[] = [];
    const server = createHttpServer((request, response) => {
        const key = `${request.method} ${(request.url ?? '').split('?')[0]}`;
        received.push({ request: key, authorization: request.headers.authorization });
        if (Object.hasOwn(routes, key)) {
            response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(routes[key]));
        } else {
            response.writeHead(404, { 'content-type': 'text/html' }).end('<html><body>Not Found</body></html>');
        }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const fake = {
        baseUrl: `http://127.0.0.1:${port}`,
        received,
        close: () => new Promise<void>((resolve) => server.close(() => resolve()))
    };
    fakes.push(fake);
    return fake;
}

/** A loopback port with nothing listening on it. */
async function closedPort(): Promise<number> {
    const server = createHttpServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return port;
}

function httpEnvironment(baseUrl: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    return environment({ MAGENTO_MODE: 'http', MAGENTO_BASE_URL: baseUrl, MAGENTO_ACCESS_TOKEN: TOKEN, ...extra });
}

const CURRENCY = { base_currency_code: 'USD', base_currency_symbol: '$', available_currency_codes: ['USD'] };
const CUSTOMER: unknown = JSON.parse(readFileSync(join(ROOT, 'fixtures', 'customers', '1.json'), 'utf8'));

describe('the built server', () => {
    it('serves the read tools over stdio from any cwd, with nothing but JSON-RPC on stdout', async () => {
        const transport = new RecordingTransport(environment());
        const client = new Client({ name: 'process-spec', version: '0.0.0' });

        await client.connect(transport);
        const { tools } = await client.listTools();
        const result = await client.callTool({ name: 'get_product', arguments: { sku: '24-MB01' } });
        await client.close();

        expect(tools.map((t) => t.name)).toEqual([
            'search_products',
            'get_product',
            'search_orders',
            'get_order',
            'get_customer'
        ]);
        expect(result.structuredContent).toMatchObject({ stock: { salableQuantity: 97, sourceQuantity: 100 } });

        expect(transport.stdoutLines.length).toBeGreaterThan(0);
        for (const line of transport.stdoutLines) {
            expect(() => deserializeMessage(line), line).not.toThrow();
        }
    });

    it("announces fixture mode on stderr, naming the package's own fixtures", async () => {
        const { code, stdout, stderr } = await run(environment());

        expect(code).toBe(0);
        expect(stdout).toBe('');
        expect(stderr).toContain('FIXTURE MODE');
        expect(stderr).toContain(join(ROOT, 'fixtures'));
        expect(stderr).toContain('No write tools enabled: read-only.');
    });

    it('registers a write tool named in the allowlist, and says which on stderr', async () => {
        const transport = new RecordingTransport(environment({ MAGENTO_MCP_WRITE_TOOLS: 'add_order_comment' }));
        const client = new Client({ name: 'process-spec', version: '0.0.0' });

        await client.connect(transport);
        const { tools } = await client.listTools();
        await client.close();

        // The five read tools, plus the one write tool named.
        expect(tools.map((t) => t.name)).toEqual([
            'search_products',
            'get_product',
            'search_orders',
            'get_order',
            'get_customer',
            'add_order_comment'
        ]);
        expect(transport.stderr).toContain('Write tools enabled: add_order_comment.');
    });

    describe('refuses to start, exiting 1 with stdout untouched', () => {
        it('when credentials are set but the mode is still fixture', async () => {
            const { code, stdout, stderr } = await run(environment({ MAGENTO_BASE_URL: 'https://shop.example.com' }));

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('MAGENTO_BASE_URL is set while MAGENTO_MODE is "fixture"');
            expect(stderr).not.toContain('FIXTURE MODE');
        });

        it('when the write allowlist names an unknown tool', async () => {
            const { code, stdout, stderr } = await run(environment({ MAGENTO_MCP_WRITE_TOOLS: 'update_product_stok' }));

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('MAGENTO_MCP_WRITE_TOOLS contains unknown tool "update_product_stok"');
        });

        it('when plain http would carry the token to a remote host', async () => {
            const { code, stdout, stderr } = await run(httpEnvironment('http://shop.example.com'));

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('MAGENTO_BASE_URL uses http:// for shop.example.com');
            expect(stderr).not.toContain(TOKEN);
        });

        it("when the base URL does not reach Magento's REST API", async () => {
            const magento = await fakeMagento();

            const { code, stdout, stderr } = await run(httpEnvironment(magento.baseUrl));

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain(
                `MAGENTO_BASE_URL does not reach Magento's REST API: GET ${magento.baseUrl}/rest/V1/directory/currency ` +
                    'answered HTTP 404'
            );
            expect(stderr).not.toContain(TOKEN);
            // The probe, and nothing after it.
            expect(magento.received.map((r) => r.request)).toEqual(['GET /rest/V1/directory/currency']);
        });

        it('when the base URL already ends in the REST path, saying so', async () => {
            const magento = await fakeMagento({ 'GET /rest/V1/directory/currency': CURRENCY });

            const { code, stderr } = await run(httpEnvironment(`${magento.baseUrl}/rest/V1`));

            expect(code).toBe(1);
            expect(stderr).toContain('/rest/V1/rest/V1/directory/currency answered HTTP 404');
            expect(stderr).toContain("Its path already contains /rest: set it to the store's base URL");
        });

        it('when the fixtures directory does not exist', async () => {
            const missing = join(tmpdir(), 'magento2-mcp-server-no-such-fixtures');

            const { code, stdout, stderr } = await run(environment({ MAGENTO_FIXTURES_DIR: missing }));

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain(`Fixture directory ${missing} does not exist`);
            expect(stderr).not.toContain('FIXTURE MODE');
        });
    });

    describe('in http mode', () => {
        it('probes the REST API, then serves a tool call through it with the bearer token', async () => {
            const magento = await fakeMagento({
                'GET /rest/V1/directory/currency': CURRENCY,
                'GET /rest/V1/customers/1': CUSTOMER
            });
            const transport = new RecordingTransport(httpEnvironment(magento.baseUrl, { LOG_LEVEL: 'debug' }));
            const client = new Client({ name: 'process-spec', version: '0.0.0' });

            await client.connect(transport);
            const result = await client.callTool({ name: 'get_customer', arguments: { customerId: 1 } });
            await client.close();

            expect(result.isError).toBeFalsy();
            expect(result.structuredContent).toMatchObject({ customer: { id: 1, email: 'roni_cost@example.com' } });
            expect(magento.received.map((r) => r.request)).toEqual([
                'GET /rest/V1/directory/currency',
                'GET /rest/V1/customers/1'
            ]);
            expect(magento.received.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);

            expect(transport.stderr).toContain(`Magento REST API at ${magento.baseUrl}/rest/V1.`);
            expect(transport.stderr).toContain('GET /rest/V1/customers/1 → 200');
            expect(transport.stderr).not.toContain('FIXTURE MODE');
            expect(transport.stderr).not.toContain(TOKEN);
            for (const line of transport.stdoutLines) {
                expect(() => deserializeMessage(line), line).not.toThrow();
            }
        });

        // Magento may be back by the first tool call; each call then reports
        // its own failure in the envelope.
        it('serves anyway when the probe cannot reach Magento, and warns', async () => {
            const transport = new RecordingTransport(httpEnvironment(`http://127.0.0.1:${await closedPort()}`));
            const client = new Client({ name: 'process-spec', version: '0.0.0' });

            await client.connect(transport);
            const { tools } = await client.listTools();
            const result = await client.callTool({ name: 'get_customer', arguments: { customerId: 1 } });
            await client.close();

            expect(tools).toHaveLength(5);
            expect(result.isError).toBe(true);
            expect(result.structuredContent).toMatchObject({ error: { code: 'UPSTREAM_UNAVAILABLE', retryable: true } });
            expect(transport.stderr).toContain(
                "WARN Could not confirm that MAGENTO_BASE_URL reaches Magento's REST API; serving anyway."
            );
            expect(transport.stderr).toContain('ECONNREFUSED');
            expect(transport.stderr).not.toContain(TOKEN);
        });
    });
});
