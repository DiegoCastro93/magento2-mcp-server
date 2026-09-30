import { describe, expect, it } from 'vitest';
import { ERROR_CODES, RETRYABLE_BY_DEFAULT, ToolError } from '../../src/errors/tool-error.js';

describe('ToolError', () => {
    it.each(ERROR_CODES)('%s takes its retryable default from the table', (code) => {
        expect(new ToolError(code, 'x').retryable).toBe(RETRYABLE_BY_DEFAULT[code]);
    });

    it('retries only what a later attempt can change', () => {
        const retryable = ERROR_CODES.filter((code) => RETRYABLE_BY_DEFAULT[code]);
        expect(retryable).toEqual(['RATE_LIMITED', 'UPSTREAM_UNAVAILABLE', 'UPSTREAM_ERROR']);
    });

    it('lets the mapper override the default', () => {
        expect(new ToolError('UPSTREAM_ERROR', 'x', { retryable: false }).retryable).toBe(false);
    });

    it('keeps the cause, and has none when not given one', () => {
        const cause = new Error('original');

        expect(new ToolError('INTERNAL_ERROR', 'x', { cause }).cause).toBe(cause);
        expect('cause' in new ToolError('INTERNAL_ERROR', 'x')).toBe(false);
    });
});
