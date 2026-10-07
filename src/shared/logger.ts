/**
 * The operator's log, on stderr.
 *
 * On stdio, stdout is the protocol channel: one stray line there corrupts the
 * session. stderr is free, and it is where the detail the agent never sees
 * goes — a defect's stack, Magento's full error body.
 *
 * Secrets are redacted at the sink: every line is scrubbed of them just before
 * it is written, so the access token stays out of the log whatever an error
 * happens to carry, such as a developer-mode `trace` with arguments.
 */
import { LOG_LEVELS, type LogLevel } from '../config.js';
import { MagentoRequestError } from '../magento/client.js';
import type { ErrorCode, ToolError } from '../errors/tool-error.js';

export interface Logger {
    debug(message: string): void;
    info(message: string, error?: unknown): void;
    warn(message: string, error?: unknown): void;
    error(message: string, error?: unknown): void;
}

export interface LoggerOptions {
    /** The least severe level written. */
    readonly level: LogLevel;
    /** Values never to be written, such as the access token. Empty strings are ignored. */
    readonly secrets?: readonly string[];
    /** Receives each finished entry, newline included. Defaults to stderr. */
    readonly write?: (text: string) => void;
    readonly now?: () => Date;
}

export const REDACTED = '[REDACTED]';

/** How deep a `cause` chain is followed, so a cycle cannot loop. */
const MAX_CAUSE_DEPTH = 5;

const INDENT = '    ';

export function createLogger(options: LoggerOptions): Logger {
    const threshold = LOG_LEVELS.indexOf(options.level);
    const write = options.write ?? ((text: string) => void process.stderr.write(text));
    const now = options.now ?? (() => new Date());
    const redact = redactor(options.secrets ?? []);

    const log = (level: LogLevel, message: string, error?: unknown): void => {
        if (LOG_LEVELS.indexOf(level) < threshold) return;
        const head = `${now().toISOString()} ${level.toUpperCase()} ${message}`;
        const detail = error === undefined ? [] : describe(error, 0).map((line) => INDENT + line);
        write(redact([head, ...detail].join('\n')) + '\n');
    };

    return {
        debug: (message) => log('debug', message),
        info: (message, error) => log('info', message, error),
        warn: (message, error) => log('warn', message, error),
        error: (message, error) => log('error', message, error)
    };
}

/**
 * The level a tool error is logged at: a defect is an error, an agent's
 * mistake is routine, and everything between needs an operator's eye.
 */
const LEVEL_BY_CODE = {
    NOT_FOUND: 'info',
    INVALID_INPUT: 'info',
    AUTH_FAILED: 'warn',
    PERMISSION_DENIED: 'warn',
    RATE_LIMITED: 'warn',
    UPSTREAM_UNAVAILABLE: 'warn',
    UPSTREAM_ERROR: 'warn',
    INTERNAL_ERROR: 'error'
} as const satisfies Record<ErrorCode, Exclude<LogLevel, 'debug'>>;

/**
 * Logs what the agent was told, and under it the original failure.
 *
 * @param subject who failed, such as `get_product` or `get_product salableQuantity`.
 * @param level overrides the level the code implies.
 */
export function logToolError(
    logger: Logger,
    subject: string,
    error: ToolError,
    level: Exclude<LogLevel, 'debug'> = LEVEL_BY_CODE[error.code]
): void {
    logger[level](`${subject}: ${error.code}: ${error.message}`, error.cause);
}

function redactor(secrets: readonly string[]): (text: string) => string {
    const forms = [...new Set(secrets.filter((s) => s !== '').flatMap((s) => [s, encodeURIComponent(s)]))]
        // Longest first, so a secret that contains another is replaced whole.
        .sort((a, b) => b.length - a.length);
    return (text) => forms.reduce((scrubbed, secret) => scrubbed.split(secret).join(REDACTED), text);
}

/** An error as log lines: its stack, Magento's body when there is one, then its causes. */
function describe(error: unknown, depth: number): string[] {
    if (!(error instanceof Error)) return [`Thrown value: ${stringify(error)}`];

    const lines = (error.stack ?? `${error.name}: ${error.message}`).split('\n');
    if (error instanceof MagentoRequestError) {
        const body = error.body === undefined ? '(not Magento JSON)' : stringify(error.body);
        lines.push(`HTTP ${error.status}, body: ${body}`);
    }
    if (error.cause !== undefined) {
        if (depth + 1 >= MAX_CAUSE_DEPTH) {
            lines.push('Caused by: (chain truncated)');
        } else {
            const [first = '', ...rest] = describe(error.cause, depth + 1);
            lines.push(`Caused by: ${first}`, ...rest);
        }
    }
    return lines;
}

function stringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}
