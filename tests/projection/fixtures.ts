/**
 * Reads committed fixtures straight from disk, so the projection specs do not
 * depend on the fixture adapter. Hand-authored variants are built in each spec
 * from one of these, with fields replaced, so no extra fixture file shifts the
 * adapter's counts.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { RawCustomer, RawOrder, RawProduct } from '../../src/magento/raw-types.js';

const FIXTURES = new URL('../../fixtures/', import.meta.url);

async function load<T>(path: string): Promise<T> {
    return JSON.parse(await readFile(fileURLToPath(new URL(path, FIXTURES)), 'utf8')) as T;
}

export const loadProduct = (sku: string): Promise<RawProduct> => load(`products/${sku}.json`);
export const loadOrder = (incrementId: string): Promise<RawOrder> => load(`orders/${incrementId}.json`);
export const loadCustomer = (id: number): Promise<RawCustomer> => load(`customers/${id}.json`);

/** What crosses stdio: keys whose value is `undefined` are gone. */
export function wire<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}
