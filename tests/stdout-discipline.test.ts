/**
 * On stdio, stdout is the protocol channel: a single stray line corrupts the
 * session. This spec keeps every write to it out of `src/`.
 *
 * `console` is banned whole, not just `console.log`: `info`, `debug`, `dir`
 * and `table` write to stdout too. The logger writes to stderr directly.
 *
 * It is a text scan, not a parse — TypeScript 7 ships no compiler API to walk
 * an AST with — so it catches accidents, not someone determined to evade it.
 * Comments are blanked first; a `//` inside a string blanks the rest of that
 * line, which can only hide a match, never invent one.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

/** The module that points `console` at stderr has to name it. */
const EXEMPT = new Set(['stdout-guard.ts']);

const FORBIDDEN = [/\bconsole\b/, /\bprocess\.stdout\b/];

/** Blanks comments, keeping line breaks so reported line numbers hold. */
function withoutComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/** `line: text` for every forbidden reference in `source`. */
function violations(source: string): string[] {
    return withoutComments(source)
        .split('\n')
        .flatMap((line, index) =>
            FORBIDDEN.some((pattern) => pattern.test(line)) ? [`${index + 1}: ${line.trim()}`] : []
        );
}

async function sourceFiles(): Promise<string[]> {
    const entries = await readdir(SRC, { recursive: true });
    return entries.filter((entry) => entry.endsWith('.ts')).sort();
}

describe('stdout discipline', () => {
    it('no module under src/ writes to stdout', async () => {
        const found: string[] = [];
        for (const file of await sourceFiles()) {
            if (EXEMPT.has(file)) continue;
            const source = await readFile(join(SRC, file), 'utf8');
            found.push(...violations(source).map((v) => `src/${file}:${v}`));
        }

        expect(found).toEqual([]);
    });

    it('scans a non-trivial set of files', async () => {
        const files = await sourceFiles();

        expect(files).toContain('index.ts');
        expect(files).toContain(join('tools', 'read', 'get-product.ts'));
    });

    it('keeps its exemption only while the exempt file still needs it', async () => {
        for (const file of EXEMPT) {
            expect(violations(await readFile(join(SRC, file), 'utf8'))).not.toEqual([]);
        }
    });

    // A scanner that matched nothing would pass the first spec vacuously.
    describe('the scanner', () => {
        it.each([
            "console.log('hi');",
            'console.info(value);',
            'const c = console;',
            "process.stdout.write('x');",
            'globalThis.console.debug(1);'
        ])('flags %s', (line) => {
            expect(violations(line)).toHaveLength(1);
        });

        it.each([
            "// console.log('commented out')",
            "/* process.stdout.write('x') */",
            "process.stderr.write('fine');",
            'const consoleWidth = 80;'
        ])('ignores %s', (line) => {
            expect(violations(line)).toEqual([]);
        });

        it('reports the line a match is on, past a multi-line comment', () => {
            expect(violations('/**\n * console\n */\nconsole.error(1);')).toEqual(['4: console.error(1);']);
        });
    });
});
