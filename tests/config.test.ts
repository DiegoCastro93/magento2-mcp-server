import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.js';
import { PACKAGE_ROOT } from '../src/package-root.js';

const TOKEN = 'abc123secrettoken';

function expectProblems(env: Record<string, string | undefined>): readonly string[] {
    try {
        loadConfig(env);
    } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        return (error as ConfigError).problems;
    }
    throw new Error('Expected loadConfig to throw, but it succeeded.');
}

describe('loadConfig', () => {
    describe('defaults', () => {
        it('runs against fixtures with no configuration at all', () => {
            const config = loadConfig({});

            expect(config.mode).toBe('fixture');
            expect(config.sourceCode).toBe('default');
            expect(config.stockId).toBe(1);
            expect(config.timeoutMs).toBe(10_000);
            expect(config.logLevel).toBe('info');
        });

        // MCP clients launch servers from an arbitrary cwd, so a relative default
        // would find the fixtures only when started from the package root.
        it("defaults the fixtures to the package's own directory, as an absolute path", () => {
            const { fixturesDir } = loadConfig({});

            expect(isAbsolute(fixturesDir)).toBe(true);
            expect(fixturesDir).toBe(join(PACKAGE_ROOT, 'fixtures'));
        });

        it('keeps a configured fixtures directory as given', () => {
            expect(loadConfig({ MAGENTO_FIXTURES_DIR: './my-fixtures' }).fixturesDir).toBe('./my-fixtures');
        });

        it('registers no write tools by default', () => {
            expect(loadConfig({}).writeTools).toEqual([]);
        });

        it('treats an empty variable as absent', () => {
            const config = loadConfig({ MAGENTO_SOURCE_CODE: '   ', MAGENTO_MCP_WRITE_TOOLS: '' });

            expect(config.sourceCode).toBe('default');
            expect(config.writeTools).toEqual([]);
        });
    });

    describe('http mode', () => {
        it('accepts a complete http configuration', () => {
            const config = loadConfig({
                MAGENTO_MODE: 'http',
                MAGENTO_BASE_URL: 'https://shop.example.com',
                MAGENTO_ACCESS_TOKEN: TOKEN
            });

            expect(config.mode).toBe('http');
            // Narrowed by the discriminated union — no optional access needed.
            if (config.mode === 'http') {
                expect(config.baseUrl).toBe('https://shop.example.com');
                expect(config.accessToken).toBe(TOKEN);
            }
        });

        it('requires both credentials', () => {
            const problems = expectProblems({ MAGENTO_MODE: 'http' });

            expect(problems).toHaveLength(2);
            expect(problems.join('\n')).toContain('MAGENTO_BASE_URL is required');
            expect(problems.join('\n')).toContain('MAGENTO_ACCESS_TOKEN is required');
        });

        it('rejects a malformed base URL', () => {
            const problems = expectProblems({
                MAGENTO_MODE: 'http',
                MAGENTO_BASE_URL: 'not a url',
                MAGENTO_ACCESS_TOKEN: TOKEN
            });

            expect(problems.join('\n')).toContain('not a valid URL');
        });
    });

    describe('fixture/credential conflict guard', () => {
        // The dangerous case: credentials present, mode left at its default, so
        // the operator believes they are talking to their store and are not.
        it('aborts when a base URL is set but the mode was never switched', () => {
            const problems = expectProblems({ MAGENTO_BASE_URL: 'https://shop.example.com' });

            expect(problems).toHaveLength(1);
            expect(problems[0]).toContain('MAGENTO_BASE_URL');
            expect(problems[0]).toContain('MAGENTO_MODE=http');
        });

        it('aborts when only a token is set', () => {
            const problems = expectProblems({ MAGENTO_ACCESS_TOKEN: TOKEN });

            expect(problems[0]).toContain('MAGENTO_ACCESS_TOKEN');
        });

        it('names both variables when both are set', () => {
            const problems = expectProblems({
                MAGENTO_MODE: 'fixture',
                MAGENTO_BASE_URL: 'https://shop.example.com',
                MAGENTO_ACCESS_TOKEN: TOKEN
            });

            expect(problems[0]).toContain('MAGENTO_BASE_URL and MAGENTO_ACCESS_TOKEN');
        });

        it('never echoes the token value in the error', () => {
            const problems = expectProblems({ MAGENTO_ACCESS_TOKEN: TOKEN });

            // Naming the variable is the point; printing its value would put a
            // live credential into logs and CI output.
            expect(problems.join('\n')).not.toContain(TOKEN);
        });

        it('does not fire when the mode itself is invalid', () => {
            // Reporting "your credentials are unused" on top of "your mode is
            // nonsense" would only obscure the real problem.
            const problems = expectProblems({
                MAGENTO_MODE: 'htp',
                MAGENTO_BASE_URL: 'https://shop.example.com'
            });

            expect(problems).toHaveLength(1);
            expect(problems[0]).toContain('MAGENTO_MODE');
        });
    });

    describe('write tool allowlist', () => {
        it('accepts known tool names', () => {
            const config = loadConfig({
                MAGENTO_MCP_WRITE_TOOLS: 'update_product_stock,add_order_comment'
            });

            expect(config.writeTools).toEqual(['update_product_stock', 'add_order_comment']);
        });

        it('allows enabling one write tool without the other', () => {
            expect(loadConfig({ MAGENTO_MCP_WRITE_TOOLS: 'add_order_comment' }).writeTools).toEqual([
                'add_order_comment'
            ]);
        });

        it('tolerates whitespace and duplicates', () => {
            const config = loadConfig({
                MAGENTO_MCP_WRITE_TOOLS: ' add_order_comment , add_order_comment '
            });

            expect(config.writeTools).toEqual(['add_order_comment']);
        });

        // Without this, a typo leaves the tool unregistered — which looks exactly
        // like the gate deliberately withholding it. Silent success is the worst
        // failure mode a permission boundary can have.
        it('aborts on a misspelled tool name and lists the valid ones', () => {
            const problems = expectProblems({ MAGENTO_MCP_WRITE_TOOLS: 'update_product_stok' });

            expect(problems).toHaveLength(1);
            expect(problems[0]).toContain('update_product_stok');
            expect(problems[0]).toContain('update_product_stock');
            expect(problems[0]).toContain('add_order_comment');
        });

        it('aborts on a read tool name, which is never writable', () => {
            const problems = expectProblems({ MAGENTO_MCP_WRITE_TOOLS: 'get_product' });

            expect(problems[0]).toContain('unknown tool "get_product"');
        });
    });

    describe('scalar validation', () => {
        it('rejects a non-numeric stock id', () => {
            expect(expectProblems({ MAGENTO_STOCK_ID: 'one' })[0]).toContain('MAGENTO_STOCK_ID');
        });

        it('rejects an unknown log level', () => {
            expect(expectProblems({ LOG_LEVEL: 'verbose' })[0]).toContain('LOG_LEVEL');
        });
    });

    it('reports every problem in one run rather than stopping at the first', () => {
        const problems = expectProblems({
            MAGENTO_MODE: 'http',
            MAGENTO_STOCK_ID: 'one',
            LOG_LEVEL: 'verbose',
            MAGENTO_MCP_WRITE_TOOLS: 'nope'
        });

        // Missing base URL, missing token, bad stock id, bad log level, bad tool.
        expect(problems.length).toBeGreaterThanOrEqual(5);
    });
});
