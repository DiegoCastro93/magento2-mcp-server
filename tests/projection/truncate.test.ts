import { describe, expect, it } from 'vitest';
import { Notices, TRUNCATION_MARKER, truncateText } from '../../src/projection/truncate.js';

describe('truncateText', () => {
    it('returns a value at the limit unchanged, and records nothing', () => {
        const notices = new Notices();

        expect(truncateText('abcde', 5, 'name', notices)).toBe('abcde');
        expect(notices.toNotice()).toBeUndefined();
    });

    it('cuts a longer value to the limit, marks it, and records it', () => {
        const notices = new Notices();

        expect(truncateText('abcdefgh', 5, 'description', notices)).toBe(`abcde${TRUNCATION_MARKER}`);
        expect(notices.toNotice()).toBe('description was truncated to 5 characters.');
    });

    it('does not leave trailing whitespace before the marker', () => {
        expect(truncateText('abcd   efgh', 7, 'description', new Notices())).toBe(`abcd${TRUNCATION_MARKER}`);
    });

    it('counts code points, so a cut never splits a surrogate pair', () => {
        // Each emoji is one code point and two UTF-16 units.
        const value = '😀😀😀😀';

        expect(truncateText(value, 4, 'comment', new Notices())).toBe(value);
        expect(truncateText(value, 3, 'comment', new Notices())).toBe(`😀😀😀${TRUNCATION_MARKER}`);
    });
});

describe('Notices', () => {
    it('is empty until something is recorded', () => {
        expect(new Notices().toNotice()).toBeUndefined();
    });

    it('groups truncations that share a limit into one sentence', () => {
        const notices = new Notices();
        notices.truncated('comments[0].comment', 500);
        notices.truncated('description', 1000);
        notices.truncated('comments[3].comment', 500);
        notices.truncated('comments[7].comment', 500);

        expect(notices.toNotice()).toBe(
            'comments[0].comment, comments[3].comment, and comments[7].comment were truncated to 500 characters. ' +
                'description was truncated to 1000 characters.'
        );
    });

    it('keeps sentences in the order they were first recorded', () => {
        const notices = new Notices();
        notices.add('Showing the 10 most recent of 12 comments.');
        notices.truncated('comments[0].comment', 500);
        notices.truncated('comments[1].comment', 500);

        expect(notices.toNotice()).toBe(
            'Showing the 10 most recent of 12 comments. ' +
                'comments[0].comment and comments[1].comment were truncated to 500 characters.'
        );
    });
});
