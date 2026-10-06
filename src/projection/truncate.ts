/**
 * Field-level truncation, and the notice that announces it.
 *
 * A model that cannot tell a complete answer from a clipped one will report the
 * clipped one as complete, so every cut is named in the result's `notice`. The
 * same collector takes the other sentences a tool owes the agent — a capped
 * list, a page that is not the last — so one tool result carries one notice.
 */

/** Appended to a cut value, so the cut is visible in the value as well as in the notice. */
export const TRUNCATION_MARKER = '…[truncated]';

interface TruncationGroup {
    readonly limit: number;
    readonly paths: string[];
}

type Entry = string | TruncationGroup;

/**
 * Collects a tool result's notice. A tool handler creates one, passes it to
 * every projector it calls, and reads {@link Notices.toNotice} last.
 */
export class Notices {
    readonly #entries: Entry[] = [];

    /** Records that the value at `path` was cut to `limit` characters. */
    truncated(path: string, limit: number): void {
        const group = this.#entries.find(
            (entry): entry is TruncationGroup => typeof entry !== 'string' && entry.limit === limit
        );
        if (group === undefined) {
            this.#entries.push({ limit, paths: [path] });
        } else {
            group.paths.push(path);
        }
    }

    /** Adds a complete sentence, such as "Showing the 10 most recent of 37 comments." */
    add(sentence: string): void {
        this.#entries.push(sentence);
    }

    /**
     * Every sentence in the order it was first recorded, truncations sharing a
     * limit grouped into one; `undefined` when there is nothing to say.
     */
    toNotice(): string | undefined {
        if (this.#entries.length === 0) return undefined;
        return this.#entries.map(sentenceOf).join(' ');
    }
}

/**
 * Cuts `value` to `limit` characters and records the cut in `notices`; returns
 * `value` unchanged when it fits. Characters are code points, so a cut never
 * splits a surrogate pair.
 *
 * @param path the field's name in the projected output, such as `description`
 *   or `comments[2].comment`, which is how the notice names it.
 */
export function truncateText(value: string, limit: number, path: string, notices: Notices): string {
    const characters = Array.from(value);
    if (characters.length <= limit) return value;

    notices.truncated(path, limit);
    return characters.slice(0, limit).join('').trimEnd() + TRUNCATION_MARKER;
}

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function sentenceOf(entry: Entry): string {
    if (typeof entry === 'string') return entry;
    const verb = entry.paths.length === 1 ? 'was' : 'were';
    return `${LIST.format(entry.paths)} ${verb} truncated to ${entry.limit} characters.`;
}
