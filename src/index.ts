#!/usr/bin/env node
/**
 * The entrypoint: validate the configuration, load the data source once, then
 * serve MCP over stdio.
 *
 * stdout belongs to the protocol from the first byte, so everything this
 * process has to say goes to stderr, and a failure to start sets a non-zero
 * exit code rather than serving in a state nobody asked for.
 */
import './stdout-guard.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { ConfigError, loadConfig, type Config } from './config.js';
import type { MagentoClient } from './magento/client.js';
import { FixtureMagentoClient } from './magento/fixture-client.js';
import { HttpMagentoClient } from './magento/http-client.js';
import { PACKAGE_ROOT } from './package-root.js';
import { createServer, type ServerInfo } from './server.js';
import { createLogger, type Logger } from './shared/logger.js';

async function main(): Promise<void> {
    let config: Config;
    try {
        config = loadConfig(process.env);
    } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        // Never carries a credential's value: config errors name variables only.
        process.stderr.write(`magento2-mcp-server: ${error.message}\n`);
        process.exitCode = 1;
        return;
    }

    const logger = createLogger({
        level: config.logLevel,
        secrets: config.mode === 'http' ? [config.accessToken] : []
    });
    const fail = (message: string, error?: unknown): void => {
        logger.error(message, error);
        process.exitCode = 1;
    };
    process.on('uncaughtException', (error) => {
        fail('Uncaught exception; shutting down.', error);
        process.exit();
    });
    process.on('unhandledRejection', (reason) => {
        fail('Unhandled rejection; shutting down.', reason);
        process.exit();
    });

    try {
        await serve(config, logger);
    } catch (error) {
        fail('Startup failed.', error);
    }
}

async function serve(config: Config, logger: Logger): Promise<void> {
    const client =
        config.mode === 'http' ? await connect(config, logger) : await loadFixtures(config.fixturesDir, logger);
    if (client === undefined) {
        process.exitCode = 1;
        return;
    }

    const serverInfo = await readServerInfo();
    const deps = {
        client,
        logger,
        sourceCode: config.sourceCode,
        stockId: config.stockId,
        serverInfo,
        writeTools: config.writeTools
    };
    const handle = serveStdio(() => createServer(deps), {
        onerror: (error) => logger.error('stdio transport error', error)
    });

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.once(signal, () => {
            void handle.close().finally(() => process.exit());
        });
    }
    logger.info(`${serverInfo.name} ${serverInfo.version} is serving over stdio.`);
    // The permission boundary's state, for the operator, without a tools/list.
    logger.info(
        config.writeTools.length === 0
            ? 'No write tools enabled: read-only.'
            : `Write tools enabled: ${config.writeTools.join(', ')}.`
    );
}

/**
 * The http adapter, once the startup probe has not ruled the base URL out.
 * Every lookup by key reads a 404 as "does not exist", so a base URL that does
 * not reach Magento would make the store look empty instead of misconfigured:
 * that is refused here, like the config guards. A probe that proves nothing
 * either way, such as a timeout, only warns, since Magento may be back by the
 * first tool call.
 *
 * @returns `undefined` when the server must not start, already logged.
 */
async function connect(config: Extract<Config, { mode: 'http' }>, logger: Logger): Promise<MagentoClient | undefined> {
    const client = new HttpMagentoClient({
        baseUrl: config.baseUrl,
        accessToken: config.accessToken,
        timeoutMs: config.timeoutMs,
        logger
    });
    const check = await client.checkRestApi();
    switch (check.outcome) {
        case 'ok':
            logger.info(`Magento REST API at ${client.apiRoot}.`);
            return client;
        case 'inconclusive':
            logger.warn(
                "Could not confirm that MAGENTO_BASE_URL reaches Magento's REST API; serving anyway.",
                check.error
            );
            return client;
        case 'wrong-path': {
            const hint = /(?:^|\/)rest(?:\/|$)/i.test(new URL(config.baseUrl).pathname)
                ? "Its path already contains /rest: set it to the store's base URL; the server adds /rest/V1 itself."
                : "Set it to the store's base URL, including the path of an install in a subdirectory.";
            logger.error(
                `MAGENTO_BASE_URL does not reach Magento's REST API: GET ${check.url} answered HTTP ${check.status}, ` +
                    `not Magento. ${hint}`
            );
            return undefined;
        }
    }
}

/** @returns `undefined` when the fixtures cannot be loaded, already logged. */
async function loadFixtures(fixturesDir: string, logger: Logger): Promise<MagentoClient | undefined> {
    let client: FixtureMagentoClient;
    try {
        client = await FixtureMagentoClient.load(fixturesDir);
    } catch (error) {
        logger.error('Could not load the fixtures.', error);
        return undefined;
    }
    fixtureBanner(fixturesDir);
    return client;
}

/**
 * Written whatever the log level: canned data mistaken for a real store is the
 * failure this server most wants to rule out. The conflict guard in
 * `loadConfig` is the control; this is the reminder.
 */
function fixtureBanner(fixturesDir: string): void {
    const rule = '='.repeat(72);
    process.stderr.write(
        [
            rule,
            'magento2-mcp-server: FIXTURE MODE',
            `Serving canned demo data from ${fixturesDir}, not a real Magento store.`,
            'To connect a store, set MAGENTO_MODE=http with MAGENTO_BASE_URL and MAGENTO_ACCESS_TOKEN.',
            rule
        ].join('\n') + '\n'
    );
}

/** Read from the package itself, since importing JSON would reach outside the build's `rootDir`. */
async function readServerInfo(): Promise<ServerInfo> {
    const manifest = JSON.parse(await readFile(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
    };
    return { name: manifest.name, version: manifest.version };
}

void main();
