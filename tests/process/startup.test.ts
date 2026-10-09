/**
 * The built server as a client launches it: `node dist/index.js`, from an
 * arbitrary working directory, with a clean environment.
 *
 * This is the only spec that runs `index.ts`: `serveStdio`, the exit code of a
 * refused start, the fixture banner, and the rule that stdout carries nothing
 * but JSON-RPC.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
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

        it('in http mode, which has no adapter yet, without printing the token', async () => {
            const { code, stdout, stderr } = await run(
                environment({
                    MAGENTO_MODE: 'http',
                    MAGENTO_BASE_URL: 'https://shop.example.com',
                    MAGENTO_ACCESS_TOKEN: TOKEN
                })
            );

            expect(code).toBe(1);
            expect(stdout).toBe('');
            expect(stderr).toContain('MAGENTO_MODE=http is not available yet');
            expect(stderr).not.toContain(TOKEN);
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
});
