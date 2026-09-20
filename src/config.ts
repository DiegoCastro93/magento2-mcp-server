/**
 * Environment parsing and validation.
 *
 * `loadConfig` is pure: it takes an environment record and either returns a
 * validated {@link Config} or throws {@link ConfigError} listing *every*
 * problem at once. Nothing here touches `process` or exits, so the guards are
 * directly testable.
 *
 * Two of those guards exist for the same reason: a misconfiguration must never
 * be indistinguishable from correct operation. See {@link loadConfig}.
 */
import { WRITE_TOOL_NAMES, isWriteToolName, type WriteToolName } from './tools/names.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

interface BaseConfig {
    /** MSI source that stock is read from and written to. */
    readonly sourceCode: string;
    /** MSI stock used for salable-quantity and is-salable lookups. */
    readonly stockId: number;
    /** Fallback for products whose `use_config_manage_stock` is true. */
    readonly defaultManageStock: boolean;
    /** Write tools permitted to register. Empty means a read-only server. */
    readonly writeTools: readonly WriteToolName[];
    readonly timeoutMs: number;
    readonly fixturesDir: string;
    readonly logLevel: LogLevel;
}

/**
 * Discriminated on `mode` so that http credentials are guaranteed present by
 * the type system wherever they are used — no optional-chaining on a token.
 */
export type Config =
    | (BaseConfig & { readonly mode: 'fixture' })
    | (BaseConfig & { readonly mode: 'http'; readonly baseUrl: string; readonly accessToken: string });

/** Carries every validation failure, so one run reports all of them. */
export class ConfigError extends Error {
    readonly problems: readonly string[];

    constructor(problems: readonly string[]) {
        super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
        this.name = 'ConfigError';
        this.problems = problems;
    }
}

type Env = Record<string, string | undefined>;

/** Treats an empty or whitespace-only variable as absent. */
function read(env: Env, key: string): string | undefined {
    const raw = env[key];
    if (raw === undefined) return undefined;
    const trimmed = raw.trim();
    return trimmed === '' ? undefined : trimmed;
}

function parseBoolean(value: string, key: string, problems: string[], fallback: boolean): boolean {
    const normalised = value.toLowerCase();
    if (['true', '1', 'yes'].includes(normalised)) return true;
    if (['false', '0', 'no'].includes(normalised)) return false;
    problems.push(`${key} must be one of true/false/1/0/yes/no, got "${value}".`);
    return fallback;
}

function parseInteger(value: string, key: string, problems: string[], fallback: number): number {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0) {
        problems.push(`${key} must be a positive integer, got "${value}".`);
        return fallback;
    }
    return parsed;
}

/**
 * Validates an environment and returns the configuration it describes.
 *
 * @throws {ConfigError} listing every problem found, never just the first.
 */
export function loadConfig(env: Env): Config {
    const problems: string[] = [];

    const modeRaw = read(env, 'MAGENTO_MODE') ?? 'fixture';
    if (modeRaw !== 'fixture' && modeRaw !== 'http') {
        problems.push(`MAGENTO_MODE must be "fixture" or "http", got "${modeRaw}".`);
    }
    const mode = modeRaw === 'http' ? 'http' : 'fixture';

    const baseUrl = read(env, 'MAGENTO_BASE_URL');
    const accessToken = read(env, 'MAGENTO_ACCESS_TOKEN');

    if (baseUrl !== undefined) {
        try {
            new URL(baseUrl);
        } catch {
            problems.push(`MAGENTO_BASE_URL is not a valid URL: "${baseUrl}".`);
        }
    }

    if (mode === 'http') {
        if (baseUrl === undefined) problems.push('MAGENTO_BASE_URL is required when MAGENTO_MODE=http.');
        if (accessToken === undefined) problems.push('MAGENTO_ACCESS_TOKEN is required when MAGENTO_MODE=http.');
    } else if (modeRaw === 'fixture') {
        // Conflict guard. Credentials configured but unused almost always mean
        // someone forgot MAGENTO_MODE=http and is about to mistake canned
        // fixture data for their real store. Refusing to start is the only
        // reading of that contradiction that cannot mislead.
        const configured = [
            baseUrl !== undefined ? 'MAGENTO_BASE_URL' : undefined,
            accessToken !== undefined ? 'MAGENTO_ACCESS_TOKEN' : undefined
        ].filter((name): name is string => name !== undefined);

        if (configured.length > 0) {
            problems.push(
                `${configured.join(' and ')} ${configured.length === 1 ? 'is' : 'are'} set while ` +
                    'MAGENTO_MODE is "fixture", so the server would serve canned data and ignore ' +
                    'those credentials. Set MAGENTO_MODE=http to use them, or unset them to run ' +
                    'against fixtures.'
            );
        }
    }

    // Write allowlist. An unknown name is a hard failure: left unvalidated, a
    // typo would leave the tool unregistered, which is indistinguishable from
    // the gate deliberately withholding it.
    const writeToolsRaw = read(env, 'MAGENTO_MCP_WRITE_TOOLS');
    const writeTools: WriteToolName[] = [];
    if (writeToolsRaw !== undefined) {
        const seen = new Set<string>();
        for (const entry of writeToolsRaw.split(',')) {
            const name = entry.trim();
            if (name === '') continue;
            if (!isWriteToolName(name)) {
                problems.push(
                    `MAGENTO_MCP_WRITE_TOOLS contains unknown tool "${name}". ` +
                        `Known write tools: ${WRITE_TOOL_NAMES.join(', ')}.`
                );
                continue;
            }
            if (seen.has(name)) continue;
            seen.add(name);
            writeTools.push(name);
        }
    }

    const stockIdRaw = read(env, 'MAGENTO_STOCK_ID');
    const stockId = stockIdRaw === undefined ? 1 : parseInteger(stockIdRaw, 'MAGENTO_STOCK_ID', problems, 1);

    const timeoutRaw = read(env, 'MAGENTO_TIMEOUT_MS');
    const timeoutMs =
        timeoutRaw === undefined ? 10_000 : parseInteger(timeoutRaw, 'MAGENTO_TIMEOUT_MS', problems, 10_000);

    const manageStockRaw = read(env, 'MAGENTO_DEFAULT_MANAGE_STOCK');
    const defaultManageStock =
        manageStockRaw === undefined
            ? true
            : parseBoolean(manageStockRaw, 'MAGENTO_DEFAULT_MANAGE_STOCK', problems, true);

    const logLevelRaw = read(env, 'LOG_LEVEL') ?? 'info';
    if (!(LOG_LEVELS as readonly string[]).includes(logLevelRaw)) {
        problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}, got "${logLevelRaw}".`);
    }
    const logLevel = (LOG_LEVELS as readonly string[]).includes(logLevelRaw)
        ? (logLevelRaw as LogLevel)
        : 'info';

    if (problems.length > 0) {
        throw new ConfigError(problems);
    }

    const base: BaseConfig = {
        sourceCode: read(env, 'MAGENTO_SOURCE_CODE') ?? 'default',
        stockId,
        defaultManageStock,
        writeTools,
        timeoutMs,
        fixturesDir: read(env, 'MAGENTO_FIXTURES_DIR') ?? './fixtures',
        logLevel
    };

    if (mode === 'http') {
        // Both are guaranteed defined here: their absence was pushed as a
        // problem above, and problems throw before reaching this point.
        return { ...base, mode, baseUrl: baseUrl as string, accessToken: accessToken as string };
    }

    return { ...base, mode: 'fixture' };
}
