/**
 * Points the global `console` at stderr. The entrypoint imports this module
 * first, before anything else can run.
 *
 * On stdio, stdout is the protocol channel, and `console.log`, `info`,
 * `debug`, `dir` and `table` all write to it: one stray line corrupts the
 * session. Nothing under `src/` uses `console` — `tests/stdout-discipline.test.ts`
 * enforces that, and exempts this file alone — so this is the safety net for
 * code that the scan cannot see: the dependencies.
 */
import { Console } from 'node:console';

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
