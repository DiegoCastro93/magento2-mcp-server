/**
 * Turns the HTML that Magento stores in product descriptions and order comments
 * into plain text for the model. Tags cost tokens and carry nothing an agent
 * can use, and a cut made by truncation must not land inside one.
 *
 * This is a display conversion, not a sanitiser: its output is never rendered
 * as HTML, so it only has to read well. It removes `<style>` and `<script>`
 * elements with their contents, because Page Builder, which ships with 2.4.9,
 * embeds a `<style>` block in the content it saves, and stripping only the tags
 * would leave its CSS behind as text.
 */

const COMMENTS = /<!--[\s\S]*?-->/g;
const CONTENT_FREE_ELEMENTS = /<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const LIST_ITEM = /<li\b[^>]*>/gi;
/** Either edge of a block element, so `intro<p>body` does not read as one word. */
const LINE_BREAKS = /<br\s*\/?>|<\/?(?:p|div|h[1-6]|li|tr|ul|ol|table|blockquote|section)\b[^>]*>/gi;
const CELL_ENDS = /<\/t[dh]\s*>/gi;
/** A tag starts with a letter, so a literal `a < b` in the text survives. */
const TAGS = /<\/?[a-zA-Z][^>]*>/g;
const ENTITIES = /&(#\d+|#x[0-9a-f]+|[a-z]+);/gi;

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    ndash: '–',
    mdash: '—',
    lsquo: '‘',
    rsquo: '’',
    ldquo: '“',
    rdquo: '”',
    deg: '°',
    times: '×',
    copy: '©',
    reg: '®',
    trade: '™'
};

export function htmlToText(html: string): string {
    const text = html
        .replace(COMMENTS, '')
        .replace(CONTENT_FREE_ELEMENTS, '')
        .replace(LIST_ITEM, '\n- ')
        .replace(LINE_BREAKS, '\n')
        .replace(CELL_ENDS, ' ')
        .replace(TAGS, '')
        // Entities decode after the tags are gone, so an escaped `&lt;b&gt;` stays text.
        .replace(ENTITIES, decodeEntity);

    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[^\S\n]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line !== '')
        .join('\n');
}

/**
 * One pass over the text, so a decoded `&` is never read again as the start of
 * an entity: `&amp;lt;` becomes `&lt;`, not `<`. An entity it does not know is
 * left as written, which still reads.
 */
function decodeEntity(entity: string, body: string): string {
    if (body.startsWith('#')) {
        const hex = body[1] === 'x' || body[1] === 'X';
        const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return isScalarValue(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

/** Excludes NUL and lone surrogates, which are not text. */
function isScalarValue(codePoint: number): boolean {
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff);
}
