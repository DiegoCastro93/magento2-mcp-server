/**
 * Turns whatever a tool handler caught into a {@link ToolError}.
 *
 * The inputs are the port's two error types, so the mapper never learns which
 * adapter produced them. Anything else is a defect in this server and becomes
 * `INTERNAL_ERROR`. The mapper reads statuses and the port's own fields, and
 * surfaces nothing verbatim except Magento's 4xx message, interpolated: no
 * trace, no HTML page, no 5xx message (developer mode puts SQL and file paths
 * there), and never the original error's message or stack.
 */
import { MagentoRequestError, MagentoUnavailableError, type UnavailableReason } from '../magento/client.js';
import type { RawErrorBody } from '../magento/raw-types.js';
import { ToolError, type ErrorCode } from './tool-error.js';

/** What the tool knows about the failed call that the error itself does not. */
export type UpstreamContext = {
    /**
     * Another call in this tool invocation already succeeded with the token.
     *
     * Magento 2.4.9 answers a token it cannot use and a token lacking the ACL
     * resource with the same 401: `TokenUserContext` treats the first as a
     * guest, and the guest then fails the same ACL check. A token Magento has
     * just accepted rules out the first reading.
     */
    readonly tokenAccepted: boolean;
} & (
    | {
          /** Repeating the call cannot apply it twice: every read, and an absolute stock set. */
          readonly idempotent: true;
      }
    | {
          readonly idempotent: false;
          /**
           * The sentence telling the agent how to confirm whether the call was
           * applied, such as "Check the order's comments with get_order before
           * retrying."
           */
          readonly verifyBeforeRetry: string;
      }
);

const MAY_HAVE_APPLIED = 'Magento may have applied the request before the failure.';

const UNAVAILABLE_MESSAGES = {
    unreachable: (host) => `Magento at ${host} is not reachable.`,
    timeout: (host) => `Magento at ${host} did not answer in time.`,
    interrupted: (host) => `The connection to Magento at ${host} was interrupted.`
} as const satisfies Record<UnavailableReason, (host: string) => string>;

/**
 * @param context what the calling tool knows; see {@link UpstreamContext}.
 * @returns `error` itself when it is already a `ToolError`.
 */
export function toToolError(error: unknown, context: UpstreamContext): ToolError {
    if (error instanceof ToolError) return error;
    if (error instanceof MagentoRequestError) return fromStatus(error, context);
    if (error instanceof MagentoUnavailableError) return fromUnavailable(error, context);

    return afterSend(
        'INTERNAL_ERROR',
        'The MCP server failed while handling this request.',
        'This is a defect in the server, not in Magento; repeating the same call will most likely fail the ' +
            'same way. A human operator can find the details in the server log.',
        context,
        error
    );
}

function fromStatus(error: MagentoRequestError, context: UpstreamContext): ToolError {
    const { status, body } = error;

    switch (status) {
        case 400:
            return new ToolError('INVALID_INPUT', magentoMessage(body) ?? 'Magento rejected the request as invalid.', {
                // Magento answers every LocalizedException with a 400, wherever the
                // service throws it, so a 400 does not prove nothing was applied:
                // OrderService::addComment saves the order, then a failed email is a
                // MailException, a 400 with the comment already stored.
                suggestion: context.idempotent
                    ? 'Correct the input before calling again; the same call will be refused the same way.'
                    : `${MAY_HAVE_APPLIED} ${context.verifyBeforeRetry} If it was not applied, correct the input ` +
                      'before calling again.',
                cause: error
            });
        case 401:
            return fromUnauthorized(error, context);
        case 403:
            return new ToolError('PERMISSION_DENIED', 'A server in front of Magento refused the request (HTTP 403).', {
                suggestion:
                    "Magento's REST API never answers 403, so a web server, WAF or IP allowlist refused it. " +
                    'A human operator must check it; retrying will not help.',
                cause: error
            });
        case 404:
            return new ToolError(
                'NOT_FOUND',
                magentoMessage(body) ?? 'Magento answered 404 without its own error body.',
                body === undefined
                    ? {
                          suggestion:
                              'If every call answers this way, a human operator must check MAGENTO_BASE_URL.',
                          cause: error
                      }
                    : { cause: error }
            );
        case 429:
            return new ToolError('RATE_LIMITED', 'Magento is rate-limiting requests.', {
                suggestion:
                    error.retryAfterSeconds === undefined
                        ? 'Wait before retrying.'
                        : `Wait ${error.retryAfterSeconds} seconds before retrying.`,
                retryAfterSeconds: error.retryAfterSeconds,
                cause: error
            });
        case 502:
        case 503:
        case 504:
            return afterSend(
                'UPSTREAM_UNAVAILABLE',
                `Magento is temporarily unavailable (HTTP ${status}).`,
                'Retry shortly. Magento also answers 503 while in maintenance mode, as during a deployment.',
                context,
                error
            );
    }

    if (status >= 500) {
        return afterSend(
            'UPSTREAM_ERROR',
            `Magento failed to process the request (HTTP ${status}).`,
            'Retry once; if it fails again, a human operator must check the Magento logs.',
            context,
            error
        );
    }

    // Magento itself answers only the statuses above, so this came from
    // something in front of it, and repeating the request will not change it.
    return new ToolError('UPSTREAM_ERROR', `Magento answered with an unexpected HTTP ${status}.`, {
        retryable: false,
        suggestion: 'A human operator must check the server in front of Magento; retrying will not help.',
        cause: error
    });
}

function fromUnauthorized(error: MagentoRequestError, context: UpstreamContext): ToolError {
    const resources = aclResources(error.body);

    if (context.tokenAccepted) {
        return new ToolError(
            'PERMISSION_DENIED',
            resources === undefined
                ? 'The integration is not allowed to perform this operation.'
                : `The integration lacks access to ${resources}.`,
            {
                suggestion:
                    'Magento accepted the token for another call in this request, so only this operation is ' +
                    'refused and other tools may still work. A human operator must grant the resource to the ' +
                    'integration.',
                cause: error
            }
        );
    }

    return new ToolError(
        'AUTH_FAILED',
        resources === undefined ? 'Magento refused the request as unauthorized.' : `Magento refused access to ${resources}.`,
        {
            suggestion:
                'Either MAGENTO_ACCESS_TOKEN is invalid, expired or revoked, or the integration lacks the ACL ' +
                'resource for this operation: Magento answers both the same way. A human operator must check ' +
                'both; retrying will not help.',
            cause: error
        }
    );
}

function fromUnavailable(error: MagentoUnavailableError, context: UpstreamContext): ToolError {
    const message = UNAVAILABLE_MESSAGES[error.reason](error.host);

    if (error.reason === 'unreachable') {
        // Never sent, so repeating it is safe whatever the operation.
        return new ToolError('UPSTREAM_UNAVAILABLE', message, {
            suggestion:
                'Retry shortly; if it persists, a human operator must check that Magento is up and that ' +
                'MAGENTO_BASE_URL is right.',
            cause: error
        });
    }

    return afterSend('UPSTREAM_UNAVAILABLE', message, 'Retry shortly.', context, error);
}

/**
 * A failure after the request may have reached Magento. Repeating an
 * idempotent call is harmless. Repeating any other may apply it twice — a
 * second comment, a second email to a real customer — so the agent is told to
 * verify first, and `retryable` says no.
 */
function afterSend(
    code: ErrorCode,
    message: string,
    retrySuggestion: string,
    context: UpstreamContext,
    cause: unknown
): ToolError {
    if (context.idempotent) {
        return new ToolError(code, message, { suggestion: retrySuggestion, cause });
    }
    return new ToolError(code, message, {
        retryable: false,
        suggestion: `${MAY_HAVE_APPLIED} ${context.verifyBeforeRetry}`,
        cause
    });
}

/** Magento's message with its placeholders filled, or `undefined` when there is none. */
function magentoMessage(body: RawErrorBody | undefined): string | undefined {
    if (body === undefined || body.message === '') return undefined;
    return interpolate(body.message, body.parameters);
}

/** The `%resources` value of Magento's "The consumer isn't authorized to access %resources." */
function aclResources(body: RawErrorBody | undefined): string | undefined {
    const parameters = body?.parameters;
    if (parameters === undefined || Array.isArray(parameters)) return undefined;
    const resources = (parameters as Readonly<Record<string, unknown>>)['resources'];
    return typeof resources === 'string' && resources !== '' ? resources : undefined;
}

/**
 * Fills Magento's placeholders the way `Phrase\Renderer\Placeholder::render`
 * does, which is `strtr`: the longest placeholder wins, the text is scanned
 * once, and a substituted value is never scanned again.
 *
 * A list's index 0 fills `%1`. A named key fills `%key`, except that a key
 * holding a decimal integer counts as an index, since PHP stores it as one. A
 * placeholder with no value stays as written.
 */
export function interpolate(message: string, parameters: RawErrorBody['parameters']): string {
    if (parameters === undefined) return message;

    const entries: [string | number, unknown][] = Array.isArray(parameters)
        ? parameters.map((value, index): [number, unknown] => [index, value])
        : Object.entries(parameters).map(([key, value]): [string | number, unknown] => [
              /^(?:0|[1-9]\d*)$/.test(key) ? Number(key) : key,
              value
          ]);

    const pairs = new Map(
        entries.map(([key, value]) => [`%${typeof key === 'number' ? key + 1 : key}`, phpString(value)])
    );
    if (pairs.size === 0) return message;

    const pattern = new RegExp(
        [...pairs.keys()]
            .sort((a, b) => b.length - a.length)
            .map(escapeRegExp)
            .join('|'),
        'g'
    );
    return message.replace(pattern, (placeholder) => pairs.get(placeholder) ?? placeholder);
}

/** PHP's string conversion, as `strtr` applies it to each value. */
function phpString(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number') return String(value);
    if (typeof value === 'boolean') return value ? '1' : '';
    if (value === null || value === undefined) return '';
    return JSON.stringify(value);
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
