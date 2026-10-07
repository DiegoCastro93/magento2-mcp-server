/**
 * Ways to make a working client misbehave, one method at a time, so a spec can
 * fail exactly the upstream call it is about and leave the rest answering.
 */
import { fileURLToPath } from 'node:url';
import type { MagentoClient } from '../../src/magento/client.js';
import { FixtureMagentoClient } from '../../src/magento/fixture-client.js';
import { createLogger, type Logger } from '../../src/shared/logger.js';

export const FIXTURES = fileURLToPath(new URL('../../fixtures', import.meta.url));

export function loadFixtureClient(): Promise<FixtureMagentoClient> {
    return FixtureMagentoClient.load(FIXTURES);
}

/** `client`, with the given methods replaced and every other one passed through. */
export function override(client: MagentoClient, overrides: Partial<MagentoClient>): MagentoClient {
    return new Proxy(client, {
        get(target, property, receiver) {
            if (Object.hasOwn(overrides, property)) return overrides[property as keyof MagentoClient];
            const value: unknown = Reflect.get(target, property, receiver);
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
}

/** `client`, with `method` rejecting with `error`. */
export function failing(client: MagentoClient, method: keyof MagentoClient, error: unknown): MagentoClient {
    return override(client, { [method]: () => Promise.reject(error) });
}

/** A logger that keeps what it is given. */
export function memoryLogger(): { logger: Logger; output: () => string } {
    const written: string[] = [];
    const logger = createLogger({ level: 'debug', write: (text) => written.push(text) });
    return { logger, output: () => written.join('') };
}
