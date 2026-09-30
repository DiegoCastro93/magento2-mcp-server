/**
 * A {@link ToolError} as the tool result the model reads.
 *
 * `structuredContent` carries the error even though it does not match the
 * tool's `outputSchema`: the SDK skips output validation when `isError` is set.
 */
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ErrorCode, ToolError } from './tool-error.js';

/** The `error` object inside an error result's `structuredContent`. */
export interface ErrorPayload {
    readonly code: ErrorCode;
    readonly message: string;
    readonly retryable: boolean;
    readonly suggestion?: string;
    readonly retryAfterSeconds?: number;
}

export function toToolResult(error: ToolError): CallToolResult {
    const payload: ErrorPayload = {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...(error.suggestion !== undefined && { suggestion: error.suggestion }),
        ...(error.retryAfterSeconds !== undefined && { retryAfterSeconds: error.retryAfterSeconds })
    };

    const text =
        error.suggestion === undefined
            ? `${error.code}: ${error.message}`
            : `${error.code}: ${error.message} — ${error.suggestion}`;

    return {
        content: [{ type: 'text', text }],
        structuredContent: { error: payload },
        isError: true
    };
}
