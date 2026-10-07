import { describe, expect, it } from 'vitest';
import type { LogLevel } from '../../src/config.js';
import { toToolError } from '../../src/errors/map-upstream.js';
import { ToolError } from '../../src/errors/tool-error.js';
import { MagentoRequestError } from '../../src/magento/client.js';
import { REDACTED, createLogger, logToolError, type Logger } from '../../src/shared/logger.js';

const TOKEN = 'abc123/secret+token';
const NOW = new Date('2026-10-06T03:00:00.000Z');

/** A logger whose output is collected, with the token registered as a secret. */
function capture(level: LogLevel = 'debug'): { logger: Logger; lines: () => string } {
    const written: string[] = [];
    const logger = createLogger({ level, secrets: [TOKEN], write: (text) => written.push(text), now: () => NOW });
    return { logger, lines: () => written.join('') };
}

/** A 401 body whose trace carries arguments, as PHP writes it when exception_ignore_args is off. */
function unauthorizedWithToken(): MagentoRequestError {
    const body = {
        message: "The consumer isn't authorized to access %resources.",
        parameters: { resources: 'Magento_Catalog::products' },
        trace: `#0 .../TokenUserContext.php(155): UserTokenReader->read('${TOKEN}')`
    };
    return new MagentoRequestError(401, body);
}

describe('createLogger', () => {
    it('writes one timestamped line per entry', () => {
        const { logger, lines } = capture();

        logger.info('server started');

        expect(lines()).toBe('2026-10-06T03:00:00.000Z INFO server started\n');
    });

    it('drops entries below the configured level', () => {
        const { logger, lines } = capture('warn');

        logger.debug('noise');
        logger.info('routine');
        logger.warn('look at this');
        logger.error('broken');

        expect(lines()).not.toContain('noise');
        expect(lines()).not.toContain('routine');
        expect(lines()).toContain('WARN look at this');
        expect(lines()).toContain('ERROR broken');
    });

    it("appends an error's stack and its cause chain under the line", () => {
        const { logger, lines } = capture();
        const root = new Error('socket hang up');
        const wrapped = new Error('fetch failed', { cause: root });

        logger.error('get_product failed', wrapped);

        const [head, ...detail] = lines().trimEnd().split('\n');
        expect(head).toBe('2026-10-06T03:00:00.000Z ERROR get_product failed');
        expect(detail[0]).toBe('    Error: fetch failed');
        expect(lines()).toContain('Caused by: Error: socket hang up');
        expect(detail.every((line) => line.startsWith('    '))).toBe(true);
    });

    it("includes Magento's status and full body, which the agent never sees", () => {
        const { logger, lines } = capture();

        logger.warn('refused', new MagentoRequestError(400, { message: 'Invalid SKU "%1".', parameters: ['X'] }));

        expect(lines()).toContain('HTTP 400, body: {"message":"Invalid SKU \\"%1\\".","parameters":["X"]}');
    });

    it('describes a thrown value that is not an Error', () => {
        const { logger, lines } = capture();

        logger.error('defect', { reason: 'odd' });

        expect(lines()).toContain('Thrown value: {"reason":"odd"}');
    });

    it('stops following a cause chain that loops', () => {
        const { logger, lines } = capture();
        const a = new Error('a');
        const b = new Error('b', { cause: a });
        (a as { cause?: unknown }).cause = b;

        logger.error('loop', a);

        expect(lines()).toContain('Caused by: (chain truncated)');
    });

    describe('never writes the access token', () => {
        it('when a 401 body carries it in the trace', () => {
            const { logger, lines } = capture();

            logger.warn('get_product failed', unauthorizedWithToken());

            expect(lines()).not.toContain(TOKEN);
            expect(lines()).toContain(`UserTokenReader->read('${REDACTED}')`);
        });

        it("when a defect's message carries it", () => {
            const { logger, lines } = capture();

            logger.error('defect', new TypeError(`Cannot read properties of undefined (reading 'Bearer ${TOKEN}')`));

            expect(lines()).not.toContain(TOKEN);
        });

        it('when a URL carries it encoded', () => {
            const { logger, lines } = capture();

            logger.info(`GET https://shop.example.com/rest/V1/products?token=${encodeURIComponent(TOKEN)}`);

            expect(lines()).not.toContain(encodeURIComponent(TOKEN));
            expect(lines()).toContain(`token=${REDACTED}`);
        });

        it('in the first line logged for a failed tool call', () => {
            const { logger, lines } = capture();
            const toolError = toToolError(unauthorizedWithToken(), { tokenAccepted: false, idempotent: true });

            logToolError(logger, 'get_product', toolError);

            expect(lines()).toContain('get_product: AUTH_FAILED');
            expect(lines()).not.toContain(TOKEN);
        });
    });

    it('ignores an empty secret instead of redacting everything', () => {
        const written: string[] = [];
        const write = (text: string): void => void written.push(text);
        const logger = createLogger({ level: 'info', secrets: [''], write, now: () => NOW });

        logger.info('fixture mode');

        expect(written.join('')).toContain('INFO fixture mode');
    });
});

describe('logToolError', () => {
    it('logs a defect as an error, with the original failure underneath', () => {
        const { logger, lines } = capture();
        const toolError = toToolError(new TypeError('x is undefined'), { tokenAccepted: false, idempotent: true });

        logToolError(logger, 'get_product', toolError);

        expect(lines()).toContain('ERROR get_product: INTERNAL_ERROR: The MCP server failed');
        expect(lines()).toContain('TypeError: x is undefined');
    });

    it("logs an agent's mistake as routine", () => {
        const { logger, lines } = capture();

        logToolError(logger, 'get_product', new ToolError('NOT_FOUND', "No product with SKU 'X'."));

        expect(lines()).toContain("INFO get_product: NOT_FOUND: No product with SKU 'X'.");
    });

    it('logs an upstream failure as a warning', () => {
        const { logger, lines } = capture();
        const toolError = toToolError(new MagentoRequestError(503), { tokenAccepted: false, idempotent: true });

        logToolError(logger, 'get_product', toolError);

        expect(lines()).toContain('WARN get_product: UPSTREAM_UNAVAILABLE');
    });

    it('takes an explicit level over the one the code implies', () => {
        const { logger, lines } = capture();

        logToolError(logger, 'get_product salableQuantity', new ToolError('INVALID_INPUT', 'Refused.'), 'warn');

        expect(lines()).toContain('WARN get_product salableQuantity: INVALID_INPUT: Refused.');
    });
});
