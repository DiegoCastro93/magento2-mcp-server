/**
 * Narrowing for raw Magento values, shared by the projectors.
 *
 * An optional raw scalar may be absent or `null` (see `raw-types.ts`), and a
 * custom attribute's value is `unknown`; every helper here answers `undefined`
 * for anything it cannot read, so a surprising value drops one field instead of
 * failing the whole tool call.
 */
import { htmlToText } from './html-text.js';
import { truncateText, type Notices } from './truncate.js';

const MAGENTO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}/;
const DECIMAL = /^-?\d+(\.\d+)?$/;

/**
 * Magento's `YYYY-MM-DD HH:MM:SS`, which is UTC for `created_at` and
 * `updated_at`, as ISO 8601 with a `Z`, so the time zone is in the value
 * itself. Anything else passes through unchanged.
 */
export function utcTimestamp(value: string): string {
    const match = MAGENTO_TIMESTAMP.exec(value);
    return match === null ? value : `${match[1]}T${match[2]}Z`;
}

/**
 * The `YYYY-MM-DD` of a date attribute such as `special_from_date`, which
 * Magento stores with a `00:00:00` time and compares against the store's local
 * date. It is not a UTC instant, so it is not given a `Z`.
 */
export function calendarDate(value: unknown): string | undefined {
    return typeof value === 'string' && CALENDAR_DATE.test(value) ? value.slice(0, 10) : undefined;
}

/** A non-empty string, or `undefined`. */
export function text(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A finite number, from a number or from a decimal string such as `"32.000000"`. */
export function decimal(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    return typeof value === 'string' && DECIMAL.test(value) ? Number(value) : undefined;
}

/** `null` read as absent. */
export function present<T>(value: T | null | undefined): T | undefined {
    return value ?? undefined;
}

/**
 * Stored HTML as plain text, cut to `limit` characters with the cut recorded in
 * `notices`. Text that is empty once the markup is gone is absent.
 */
export function htmlField(value: unknown, limit: number, path: string, notices: Notices): string | undefined {
    if (typeof value !== 'string') return undefined;
    const plain = htmlToText(value);
    return plain === '' ? undefined : truncateText(plain, limit, path, notices);
}
