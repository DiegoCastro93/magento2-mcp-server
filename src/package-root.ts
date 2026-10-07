/**
 * The package's own root directory, absolute.
 *
 * This module sits directly under `src/`, and compiles directly under `dist/`,
 * so one level up is the package root from either. MCP clients launch a
 * server from an arbitrary working directory, so a path the package owns —
 * its fixtures, its `package.json` — must be resolved from here, never from
 * the cwd.
 */
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));
