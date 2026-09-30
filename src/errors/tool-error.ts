/**
 * The one error type a tool handler throws. `to-result.ts` turns it into a
 * tool result with `isError: true`, which is what the model reads; a protocol
 * error would go to the host and the model would never see it.
 *
 * `retryable` is a promise to the agent, so it must be honest: telling it to
 * retry a dead credential or a deterministic bug produces a retry loop.
 */

export const ERROR_CODES = [
    'NOT_FOUND',
    'INVALID_INPUT',
    'AUTH_FAILED',
    'PERMISSION_DENIED',
    'RATE_LIMITED',
    'UPSTREAM_UNAVAILABLE',
    'UPSTREAM_ERROR',
    'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * What each code means for a retry when nothing more specific is known. The
 * mapper overrides it where the status or the operation says otherwise: an
 * unexpected 4xx, or a write that may already have been applied.
 */
export const RETRYABLE_BY_DEFAULT = {
    NOT_FOUND: false,
    INVALID_INPUT: false,
    AUTH_FAILED: false,
    PERMISSION_DENIED: false,
    RATE_LIMITED: true,
    UPSTREAM_UNAVAILABLE: true,
    UPSTREAM_ERROR: true,
    INTERNAL_ERROR: false
} as const satisfies Record<ErrorCode, boolean>;

export interface ToolErrorOptions {
    /** Defaults to {@link RETRYABLE_BY_DEFAULT} for the code. */
    readonly retryable?: boolean | undefined;
    /** What the agent can do about it. */
    readonly suggestion?: string | undefined;
    readonly retryAfterSeconds?: number | undefined;
    /** The original failure, kept for the operator's log. It never reaches the agent. */
    readonly cause?: unknown;
}

export class ToolError extends Error {
    readonly code: ErrorCode;
    readonly retryable: boolean;
    readonly suggestion: string | undefined;
    readonly retryAfterSeconds: number | undefined;

    constructor(code: ErrorCode, message: string, options: ToolErrorOptions = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = 'ToolError';
        this.code = code;
        this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT[code];
        this.suggestion = options.suggestion;
        this.retryAfterSeconds = options.retryAfterSeconds;
    }
}
