import { describe, expect, it } from 'vitest';
import { interpolate, toToolError, type UpstreamContext } from '../../src/errors/map-upstream.js';
import { toToolResult } from '../../src/errors/to-result.js';
import { ERROR_CODES, ToolError, type ErrorCode } from '../../src/errors/tool-error.js';
import { MagentoRequestError, MagentoUnavailableError } from '../../src/magento/client.js';

const TOKEN = 'abc123secrettoken';
const HOST = 'shop.example.com';

const READ: UpstreamContext = { tokenAccepted: false, idempotent: true };
const VERIFY = "Check the order's comments with get_order before retrying.";
const COMMENT: UpstreamContext = { tokenAccepted: false, idempotent: false, verifyBeforeRetry: VERIFY };

/**
 * A real 401 from a Magento 2.4.9 sandbox, for a token without
 * `Magento_Catalog::products`, trimmed to its first two trace frames. An
 * unusable token draws the same body, byte for byte.
 */
const UNAUTHORIZED = {
    message: "The consumer isn't authorized to access %resources.",
    parameters: { resources: 'Magento_Catalog::products' },
    trace:
        '#0 /var/www/html/vendor/magento/module-webapi/Controller/Rest/RequestValidator.php(92): ' +
        'Magento\\Webapi\\Controller\\Rest\\RequestValidator->checkPermissions()\n' +
        '#1 /var/www/html/vendor/magento/framework/Interception/Interceptor.php(58): ' +
        'Magento\\Webapi\\Controller\\Rest\\RequestValidator->validate()'
};

/** Everything the agent receives for a failure, as one string. */
function envelope(error: unknown, context: UpstreamContext = READ): string {
    return JSON.stringify(toToolResult(toToolError(error, context)));
}

interface Row {
    readonly name: string;
    readonly input: unknown;
    readonly code: ErrorCode;
    readonly retryable: boolean;
    readonly message: string;
}

const TABLE: readonly Row[] = [
    {
        name: '400 with Magento message',
        input: new MagentoRequestError(400, {
            message: 'Unable to add comment: The status "%1" is not part of the order status history.',
            parameters: ['fraud']
        }),
        code: 'INVALID_INPUT',
        retryable: false,
        message: 'Unable to add comment: The status "fraud" is not part of the order status history.'
    },
    {
        name: '400 without a body',
        input: new MagentoRequestError(400),
        code: 'INVALID_INPUT',
        retryable: false,
        message: 'Magento rejected the request as invalid.'
    },
    {
        name: '401',
        input: new MagentoRequestError(401, UNAUTHORIZED),
        code: 'AUTH_FAILED',
        retryable: false,
        message: 'Magento refused access to Magento_Catalog::products.'
    },
    {
        name: '403',
        input: new MagentoRequestError(403),
        code: 'PERMISSION_DENIED',
        retryable: false,
        message: 'A server in front of Magento refused the request (HTTP 403).'
    },
    {
        name: '404 with Magento message',
        input: new MagentoRequestError(404, {
            message: "The entity that was requested doesn't exist. Verify the entity and try again."
        }),
        code: 'NOT_FOUND',
        retryable: false,
        message: "The entity that was requested doesn't exist. Verify the entity and try again."
    },
    {
        name: '404 without a body',
        input: new MagentoRequestError(404),
        code: 'NOT_FOUND',
        retryable: false,
        message: 'Magento answered 404 without its own error body.'
    },
    {
        name: '429',
        input: new MagentoRequestError(429, { message: 'Too Many Requests' }),
        code: 'RATE_LIMITED',
        retryable: true,
        message: 'Magento is rate-limiting requests.'
    },
    {
        name: '500',
        input: new MagentoRequestError(500, { message: 'Internal Error. Details are available in Magento log file.' }),
        code: 'UPSTREAM_ERROR',
        retryable: true,
        message: 'Magento failed to process the request (HTTP 500).'
    },
    {
        name: '501',
        input: new MagentoRequestError(501),
        code: 'UPSTREAM_ERROR',
        retryable: true,
        message: 'Magento failed to process the request (HTTP 501).'
    },
    {
        name: '502',
        input: new MagentoRequestError(502),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Magento is temporarily unavailable (HTTP 502).'
    },
    {
        name: '503 (maintenance mode)',
        input: new MagentoRequestError(503),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Magento is temporarily unavailable (HTTP 503).'
    },
    {
        name: '504',
        input: new MagentoRequestError(504),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Magento is temporarily unavailable (HTTP 504).'
    },
    {
        name: '405, which Magento never sends',
        input: new MagentoRequestError(405),
        code: 'UPSTREAM_ERROR',
        retryable: false,
        message: 'Magento answered with an unexpected HTTP 405.'
    },
    {
        name: '413, which Magento never sends',
        input: new MagentoRequestError(413),
        code: 'UPSTREAM_ERROR',
        retryable: false,
        message: 'Magento answered with an unexpected HTTP 413.'
    },
    {
        name: 'a 200 without Magento JSON, such as an HTML page',
        input: new MagentoRequestError(200),
        code: 'UPSTREAM_ERROR',
        retryable: false,
        message: "The server at MAGENTO_BASE_URL answered HTTP 200 without Magento's JSON."
    },
    {
        name: 'a redirect, which the http adapter never follows',
        input: new MagentoRequestError(302),
        code: 'UPSTREAM_ERROR',
        retryable: false,
        message: "The server at MAGENTO_BASE_URL answered HTTP 302 without Magento's JSON."
    },
    {
        name: 'unreachable',
        input: new MagentoUnavailableError(HOST, 'unreachable'),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Magento at shop.example.com is not reachable.'
    },
    {
        name: 'timeout',
        input: new MagentoUnavailableError(HOST, 'timeout'),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'Magento at shop.example.com did not answer in time.'
    },
    {
        name: 'interrupted',
        input: new MagentoUnavailableError(HOST, 'interrupted'),
        code: 'UPSTREAM_UNAVAILABLE',
        retryable: true,
        message: 'The connection to Magento at shop.example.com was interrupted.'
    },
    {
        name: 'a TypeError from a defect',
        input: new TypeError("Cannot read properties of undefined (reading 'items')"),
        code: 'INTERNAL_ERROR',
        retryable: false,
        message: 'The MCP server failed while handling this request.'
    },
    {
        name: 'a thrown non-Error',
        input: 'boom',
        code: 'INTERNAL_ERROR',
        retryable: false,
        message: 'The MCP server failed while handling this request.'
    }
];

describe('toToolError', () => {
    describe('the mapping table, for an idempotent call', () => {
        it.each(TABLE)('$name → $code', ({ input, code, retryable, message }) => {
            expect(toToolError(input, READ)).toMatchObject({ code, retryable, message });
        });

        it('produces every error code', () => {
            const produced = new Set(TABLE.map((row) => row.code));
            expect([...produced].sort()).toEqual([...ERROR_CODES].sort());
        });

        it('keeps the original failure as the cause, for the operator', () => {
            const refusal = new MagentoRequestError(500);
            expect(toToolError(refusal, READ).cause).toBe(refusal);
        });

        it('returns a ToolError it is given unchanged', () => {
            const notFound = new ToolError('NOT_FOUND', 'No product with SKU "24-XX99".');
            expect(toToolError(notFound, READ)).toBe(notFound);
        });

        it('points at MAGENTO_BASE_URL only when the 404 is not Magento’s own', () => {
            expect(toToolError(new MagentoRequestError(404), READ).suggestion).toContain('MAGENTO_BASE_URL');
            expect(toToolError(new MagentoRequestError(404, { message: 'x' }), READ).suggestion).toBeUndefined();
        });
    });

    describe('401: a rejected token and a missing ACL look the same', () => {
        it('names both causes while the token is unproven', () => {
            const error = toToolError(new MagentoRequestError(401, UNAUTHORIZED), READ);

            expect(error.code).toBe('AUTH_FAILED');
            expect(error.suggestion).toContain('MAGENTO_ACCESS_TOKEN is invalid, expired or revoked');
            expect(error.suggestion).toContain('lacks the ACL resource');
        });

        it('is a missing ACL once another call accepted the token', () => {
            const error = toToolError(new MagentoRequestError(401, UNAUTHORIZED), { ...READ, tokenAccepted: true });

            expect(error).toMatchObject({
                code: 'PERMISSION_DENIED',
                retryable: false,
                message: 'The integration lacks access to Magento_Catalog::products.'
            });
            expect(error.suggestion).toContain('other tools may still work');
        });

        it('does without the resource name when the body has none', () => {
            expect(toToolError(new MagentoRequestError(401), READ).message).toBe(
                'Magento refused the request as unauthorized.'
            );
            expect(toToolError(new MagentoRequestError(401), { ...READ, tokenAccepted: true }).message).toBe(
                'The integration is not allowed to perform this operation.'
            );
        });

        it('takes the resource only from a named parameter', () => {
            const positional = new MagentoRequestError(401, { message: 'Refused %1.', parameters: ['x'] });
            expect(toToolError(positional, READ).message).toBe('Magento refused the request as unauthorized.');
        });
    });

    describe('a write that may be applied twice', () => {
        const uncertain: readonly [string, unknown][] = [
            ['timeout', new MagentoUnavailableError(HOST, 'timeout')],
            ['interrupted', new MagentoUnavailableError(HOST, 'interrupted')],
            ['500', new MagentoRequestError(500)],
            ['502', new MagentoRequestError(502)],
            ['503', new MagentoRequestError(503)],
            ['504', new MagentoRequestError(504)],
            ['a defect', new TypeError('x is not a function')]
        ];

        it.each(uncertain)('%s: not retryable, and says how to verify', (_, input) => {
            const idempotent = toToolError(input, READ);
            const error = toToolError(input, COMMENT);

            expect(error.code).toBe(idempotent.code);
            expect(error.message).toBe(idempotent.message);
            expect(error.retryable).toBe(false);
            expect(error.suggestion).toBe(`Magento may have applied the request before the failure. ${VERIFY}`);
        });

        // Magento answers every LocalizedException with a 400, wherever the service
        // throws it: OrderService::addComment saves the order, then a failed email
        // is a MailException, a 400 with the comment already stored.
        it('400: keeps the code, the message and retryable, and says how to verify', () => {
            const input = new MagentoRequestError(400, { message: 'Unable to send mail. Please try again later.' });
            const idempotent = toToolError(input, READ);
            const error = toToolError(input, COMMENT);

            expect(error).toMatchObject({ code: 'INVALID_INPUT', message: idempotent.message, retryable: false });
            expect(error.suggestion).toBe(
                `Magento may have applied the request before the failure. ${VERIFY} ` +
                    'If it was not applied, correct the input before calling again.'
            );
        });

        // Each of these was refused before the operation ran. A 429 included:
        // Magento's backpressure check sits in RequestValidator, before the service.
        const notApplied: readonly [string, unknown][] = [
            ['unreachable', new MagentoUnavailableError(HOST, 'unreachable')],
            ['401', new MagentoRequestError(401, UNAUTHORIZED)],
            ['403', new MagentoRequestError(403)],
            ['404', new MagentoRequestError(404)],
            ['429', new MagentoRequestError(429)]
        ];

        it.each(notApplied)('%s: maps exactly as for an idempotent call', (_, input) => {
            const { code, message, retryable, suggestion } = toToolError(input, READ);
            expect(toToolError(input, COMMENT)).toMatchObject({ code, message, retryable, suggestion });
        });

        it('keeps a request that never left retryable', () => {
            expect(toToolError(new MagentoUnavailableError(HOST, 'unreachable'), COMMENT).retryable).toBe(true);
        });
    });

    describe('Retry-After', () => {
        it('passes the delay through when the response carried one', () => {
            const error = toToolError(new MagentoRequestError(429, undefined, { retryAfterSeconds: 30 }), READ);

            expect(error.retryAfterSeconds).toBe(30);
            expect(error.suggestion).toBe('Wait 30 seconds before retrying.');
        });

        it('still asks for a wait when it did not, as Magento’s own 429 never does', () => {
            const error = toToolError(new MagentoRequestError(429, { message: 'Too Many Requests' }), READ);

            expect(error.retryAfterSeconds).toBeUndefined();
            expect(error.suggestion).toBe('Wait before retrying.');
        });
    });

    describe('what never reaches the agent', () => {
        it('a Magento stack trace', () => {
            const result = envelope(new MagentoRequestError(401, UNAUTHORIZED));

            expect(result).not.toContain('#0');
            expect(result).not.toContain('RequestValidator.php');
        });

        it('the access token, even inside a trace that carries it', () => {
            // A trace with arguments, as PHP writes it when exception_ignore_args is off.
            const body = {
                ...UNAUTHORIZED,
                trace: `#0 /var/www/html/vendor/magento/module-webapi/Model/Authorization/TokenUserContext.php(155): Magento\\Integration\\Model\\UserToken\\UserTokenReader->read('${TOKEN}')`
            };

            expect(envelope(new MagentoRequestError(401, body))).not.toContain(TOKEN);
            expect(envelope(new MagentoRequestError(401, body), { ...READ, tokenAccepted: true })).not.toContain(TOKEN);
        });

        it('the access token, from the cause of a network failure', () => {
            const cause = new Error(`connect ECONNREFUSED, request headers: Authorization: Bearer ${TOKEN}`);
            expect(envelope(new MagentoUnavailableError(HOST, 'unreachable', { cause }))).not.toContain(TOKEN);
        });

        it('a 5xx message, which developer mode fills with SQL and paths', () => {
            const refusal = new MagentoRequestError(500, {
                message: "SQLSTATE[42S22]: Column not found: 1054 Unknown column 'e.foo' in 'where clause'"
            });

            expect(envelope(refusal)).not.toContain('SQLSTATE');
        });

        it("a defect's message or stack", () => {
            const defect = new TypeError(`Cannot read properties of undefined (reading 'Bearer ${TOKEN}')`);
            const result = envelope(defect);

            expect(result).not.toContain(TOKEN);
            expect(result).not.toContain('Cannot read properties');
            expect(result).not.toContain('map-upstream.test.ts');
        });
    });
});

describe('interpolate', () => {
    it('fills a positional placeholder from index 0', () => {
        expect(interpolate('The status "%1" is not valid.', ['fraud'])).toBe('The status "fraud" is not valid.');
    });

    it('fills a named placeholder', () => {
        expect(interpolate('Access to %resources.', { resources: 'Magento_Sales::actions_view' })).toBe(
            'Access to Magento_Sales::actions_view.'
        );
    });

    it('prefers the longest placeholder, as strtr does', () => {
        const ten = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
        expect(interpolate('%1 and %10', ten)).toBe('a and j');
    });

    it('treats a numeric key as an index, as PHP stores it', () => {
        expect(interpolate('Value %1.', { '0': 'x' })).toBe('Value x.');
    });

    it('never scans a substituted value again', () => {
        expect(interpolate('%1 then %2', ['%2', 'b'])).toBe('%2 then b');
    });

    it('leaves a placeholder without a value as written', () => {
        expect(interpolate('%1 and %2', ['a'])).toBe('a and %2');
    });

    it("casts values the way PHP's string conversion does", () => {
        expect(interpolate('[%1][%2][%3][%4]', [true, false, null, 3.5])).toBe('[1][][][3.5]');
    });

    it('matches a key holding regex characters literally', () => {
        expect(interpolate('%a.b %aXb', { 'a.b': 'x' })).toBe('x %aXb');
    });

    it('returns the message unchanged without parameters', () => {
        expect(interpolate('No placeholders %1.', undefined)).toBe('No placeholders %1.');
        expect(interpolate('No placeholders %1.', [])).toBe('No placeholders %1.');
    });
});
