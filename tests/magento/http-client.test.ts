/**
 * The http adapter against an HTTP-level mock: undici's `MockAgent`, through
 * undici's own `fetch`, injected. Every request is recorded as it went out,
 * and every reply is scripted, so each spec states exactly what Magento — or
 * whatever stands in front of it — answered.
 */
import { MockAgent, fetch as undiciFetch } from 'undici';
import { afterEach, describe, expect, it } from 'vitest';
import {
    MagentoRequestError,
    MagentoUnavailableError,
    type MagentoClient,
    type OrderSearchParams,
    type ProductSearchParams
} from '../../src/magento/client.js';
import { HttpMagentoClient, parseRetryAfter, type Fetch, type FetchResponse } from '../../src/magento/http-client.js';
import {
    customerEmailQuery,
    orderIncrementIdQuery,
    orderSearchQuery,
    productSearchQuery,
    sourceItemQuery
} from '../../src/magento/search-criteria.js';
import { memoryLogger } from '../tools/client-stubs.js';

const BASE = 'https://shop.example.com';
const HOST = 'shop.example.com';
const TOKEN = 'abc123secrettoken';

/** What ddev's nginx sends in place of every Magento 404 body. */
const HTML_PAGE = '<!DOCTYPE html><html><head><title>404 Not Found</title></head><body>Not Found</body></html>';

const CURRENCY = {
    base_currency_code: 'USD',
    base_currency_symbol: '$',
    default_display_currency_code: 'USD',
    available_currency_codes: ['USD']
};

interface Sent {
    readonly method: string;
    readonly path: string;
    /** Names lower-cased. */
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | undefined;
}

interface Reply {
    readonly status: number;
    /** A string goes out as is; anything else as JSON. */
    readonly body?: unknown;
    readonly headers?: Readonly<Record<string, string>>;
    /** Milliseconds before the answer starts. */
    readonly delay?: number;
}

const agents: MockAgent[] = [];

afterEach(async () => {
    for (const agent of agents.splice(0)) await agent.close();
});

/**
 * An adapter whose requests reach a `MockAgent` that refuses the network.
 * Replies are consumed in order, one per request; a request with none left
 * fails as a network error would, so an unexpected extra request — such as a
 * followed redirect — cannot pass unnoticed.
 */
function harness(options: { readonly baseUrl?: string; readonly timeoutMs?: number } = {}) {
    const baseUrl = options.baseUrl ?? BASE;
    const agent = new MockAgent();
    agent.disableNetConnect();
    agents.push(agent);
    const pool = agent.get(new URL(baseUrl).origin);
    const sent: Sent[] = [];
    const { logger, output } = memoryLogger();
    const client = new HttpMagentoClient({
        baseUrl,
        accessToken: TOKEN,
        timeoutMs: options.timeoutMs ?? 1_000,
        logger,
        fetch: (url, init) => undiciFetch(url, { ...init, dispatcher: agent })
    });
    const any = { path: () => true, method: () => true };

    return {
        client,
        sent,
        log: output,
        reply(reply: Reply): void {
            const scope = pool.intercept(any).reply((request) => {
                sent.push({
                    method: request.method,
                    path: request.path,
                    headers: lowerCased(request.headers),
                    body: typeof request.body === 'string' ? request.body : undefined
                });
                const body = reply.body ?? '';
                return {
                    statusCode: reply.status,
                    data: typeof body === 'string' ? body : JSON.stringify(body),
                    responseOptions: { headers: { ...reply.headers } }
                };
            });
            if (reply.delay !== undefined) scope.delay(reply.delay);
        },
        fail(error: Error): void {
            pool.intercept(any).replyWithError(error);
        }
    };
}

function lowerCased(headers: unknown): Record<string, string> {
    const entries: [string, string][] =
        headers instanceof Headers
            ? [...headers.entries()]
            : Object.entries((headers ?? {}) as Record<string, string>);
    return Object.fromEntries(entries.map(([name, value]) => [name.toLowerCase(), value]));
}

/** An error as undici's connector reports one, with Node's `code`. */
function networkError(code: string): Error {
    return Object.assign(new Error(`${code} (simulated)`), { code });
}

/** An adapter over a hand-written `fetch`, for failures a `MockAgent` cannot produce. */
function withFetch(fetch: Fetch): HttpMagentoClient {
    return new HttpMagentoClient({ baseUrl: BASE, accessToken: TOKEN, timeoutMs: 1_000, fetch });
}

function answering(status: number, text: () => Promise<string>): Fetch {
    const response: FetchResponse = { status, headers: { get: () => null }, text };
    return () => Promise.resolve(response);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
    } catch (error) {
        return error;
    }
    throw new Error('Expected a rejection, but the call resolved.');
}

const PRODUCT_SEARCH: ProductSearchParams = { name: 'bag', priceMax: 50, page: 2, pageSize: 10 };
const ORDER_SEARCH: OrderSearchParams = { status: 'processing', createdFrom: '2026-09-01', page: 1, pageSize: 20 };
const PAGE = { items: [{ sku: '24-MB01' }, { sku: '24-MB04' }], total_count: 2 };

describe('HttpMagentoClient', () => {
    describe('requests', () => {
        it('sends the bearer token and asks for JSON, with no content type on a GET', async () => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: { sku: '24-MB01' } });

            await client.getProduct('24-MB01');

            expect(sent).toHaveLength(1);
            expect(sent[0]?.method).toBe('GET');
            expect(sent[0]?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
            expect(sent[0]?.headers['accept']).toBe('application/json');
            expect(sent[0]?.headers['content-type']).toBeUndefined();
        });

        type Read = readonly [string, (client: MagentoClient) => Promise<unknown>, string, unknown, unknown];
        const reads: readonly Read[] = [
            [
                'searchProducts',
                (c) => c.searchProducts(PRODUCT_SEARCH),
                `/rest/V1/products?${productSearchQuery(PRODUCT_SEARCH)}`,
                PAGE,
                PAGE
            ],
            ['getProduct', (c) => c.getProduct('24-MB01'), '/rest/V1/products/24-MB01', { sku: '24-MB01' }, { sku: '24-MB01' }],
            [
                'getSourceItem',
                (c) => c.getSourceItem('24-MB01', 'default'),
                `/rest/V1/inventory/source-items?${sourceItemQuery('24-MB01', 'default')}`,
                { items: [{ sku: '24-MB01', source_code: 'default', quantity: 100, status: 1 }], total_count: 1 },
                { sku: '24-MB01', source_code: 'default', quantity: 100, status: 1 }
            ],
            [
                'getSalableQuantity',
                (c) => c.getSalableQuantity('24-MB01', 1),
                '/rest/V1/inventory/get-product-salable-quantity/24-MB01/1',
                98,
                98
            ],
            [
                'isProductSalable',
                (c) => c.isProductSalable('24-MB01', 2),
                '/rest/V1/inventory/is-product-salable/24-MB01/2',
                true,
                true
            ],
            [
                'searchOrders',
                (c) => c.searchOrders(ORDER_SEARCH),
                `/rest/V1/orders?${orderSearchQuery(ORDER_SEARCH)}`,
                PAGE,
                PAGE
            ],
            [
                'findOrderByIncrementId',
                (c) => c.findOrderByIncrementId('000000001'),
                `/rest/V1/orders?${orderIncrementIdQuery('000000001')}`,
                { items: [{ increment_id: '000000001' }], total_count: 1 },
                { increment_id: '000000001' }
            ],
            ['getCustomerById', (c) => c.getCustomerById(1), '/rest/V1/customers/1', { id: 1 }, { id: 1 }],
            [
                'findCustomerByEmail',
                (c) => c.findCustomerByEmail('roni_cost@example.com'),
                `/rest/V1/customers/search?${customerEmailQuery('roni_cost@example.com')}`,
                { items: [{ id: 1 }], total_count: 1 },
                { id: 1 }
            ]
        ];

        it.each(reads)('%s: GET %s', async (_, call, path, payload, expected) => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: payload });

            await expect(call(client)).resolves.toEqual(expected);
            expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([`GET ${path}`]);
        });

        it.each<readonly [string, (client: MagentoClient) => Promise<unknown>]>([
            ['findOrderByIncrementId', (c) => c.findOrderByIncrementId('999999999')],
            ['findCustomerByEmail', (c) => c.findCustomerByEmail('nobody@example.com')],
            ['getSourceItem', (c) => c.getSourceItem('24-WG085_Group', 'default')]
        ])('%s: an empty page is undefined', async (_, call) => {
            const { client, reply } = harness();
            reply({ status: 200, body: { items: [], total_count: 0 } });

            await expect(call(client)).resolves.toBeUndefined();
        });

        it("updateSourceItem: POSTs one source item, with Magento's integer status", async () => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: [] });

            await client.updateSourceItem({ sku: '24-MB01', sourceCode: 'default', quantity: 0, status: 'out_of_stock' });

            expect(sent[0]?.method).toBe('POST');
            expect(sent[0]?.path).toBe('/rest/V1/inventory/source-items');
            expect(sent[0]?.headers['content-type']).toBe('application/json');
            expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
                sourceItems: [{ sku: '24-MB01', source_code: 'default', quantity: 0, status: 0 }]
            });
        });

        // A status in the body would be applied to the order by
        // OrderService::addComment: the port has none, and none is sent.
        it('addOrderComment: POSTs the comment by entity ID, with no status', async () => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: true });

            await client.addOrderComment(7, { comment: 'Packed.', notifyCustomer: true, visibleOnFront: false });

            expect(sent[0]?.method).toBe('POST');
            expect(sent[0]?.path).toBe('/rest/V1/orders/7/comments');
            expect(JSON.parse(sent[0]?.body ?? '')).toEqual({
                statusHistory: { comment: 'Packed.', is_customer_notified: 1, is_visible_on_front: 0 }
            });
        });

        it.each(['https://shop.example.com/magento', 'https://shop.example.com/magento/'])(
            'keeps the path of an install in a subdirectory: %s',
            async (baseUrl) => {
                const { client, sent, reply } = harness({ baseUrl });
                reply({ status: 200, body: { id: 1 } });

                await client.getCustomerById(1);

                expect(client.apiRoot).toBe('https://shop.example.com/magento/rest/V1');
                expect(sent[0]?.path).toBe('/magento/rest/V1/customers/1');
            }
        );

        it('sends a SKU as one path segment, whatever it holds', async () => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: { sku: 'a/b c%' } });

            await client.getProduct('a/b c%');

            expect(sent[0]?.path).toBe('/rest/V1/products/a%2Fb%20c%25');
        });

        it('logs one debug line per request, without the token', async () => {
            const { client, reply, log } = harness();
            reply({ status: 200, body: { sku: '24-MB01' } });

            await client.getProduct('24-MB01');

            expect(log()).toMatch(/DEBUG GET \/rest\/V1\/products\/24-MB01 → 200 in \d+ ms/);
            expect(log()).not.toContain(TOKEN);
        });
    });

    // The status decides, never the body: ddev's nginx replaces every Magento
    // 404 body with its own page, so a real "no such SKU" arrives as HTML.
    describe('a 404', () => {
        it.each<readonly [string, (client: MagentoClient) => Promise<unknown>]>([
            ['getProduct', (c) => c.getProduct('NO-SUCH-SKU')],
            ['getCustomerById', (c) => c.getCustomerById(999_999)],
            ['getSalableQuantity', (c) => c.getSalableQuantity('NO-SUCH-SKU', 1)]
        ])('is "does not exist" for %s, a lookup by key, whatever the body', async (_, call) => {
            const { client, reply } = harness();
            reply({ status: 404, body: HTML_PAGE });
            reply({ status: 404, body: { message: 'The product with SKU "%1" does not exist.', parameters: ['X'] } });

            await expect(call(client)).resolves.toBeUndefined();
            await expect(call(client)).resolves.toBeUndefined();
        });

        it.each<readonly [string, (client: MagentoClient) => Promise<unknown>]>([
            ['searchProducts', (c) => c.searchProducts({ page: 1, pageSize: 20 })],
            ['getSourceItem', (c) => c.getSourceItem('24-MB01', 'default')],
            ['isProductSalable', (c) => c.isProductSalable('24-MB01', 1)],
            ['findOrderByIncrementId', (c) => c.findOrderByIncrementId('000000001')],
            ['findCustomerByEmail', (c) => c.findCustomerByEmail('roni_cost@example.com')],
            [
                'addOrderComment',
                (c) => c.addOrderComment(999, { comment: 'x', notifyCustomer: false, visibleOnFront: false })
            ]
        ])('is a refusal for %s', async (_, call) => {
            const { client, reply } = harness();
            reply({ status: 404, body: HTML_PAGE });

            const error = await rejection(call(client));

            expect(error).toBeInstanceOf(MagentoRequestError);
            expect((error as MagentoRequestError).status).toBe(404);
            expect((error as MagentoRequestError).body).toBeUndefined();
        });
    });

    describe('refusals', () => {
        it("keeps Magento's error body whole, its developer-mode trace included", async () => {
            const body = {
                message: "The consumer isn't authorized to access %resources.",
                parameters: { resources: 'Magento_Catalog::products' },
                trace: '#0 RequestValidator.php(92): checkPermissions()'
            };
            const { client, reply } = harness();
            reply({ status: 401, body });

            const error = await rejection(client.getProduct('24-MB01'));

            expect(error).toBeInstanceOf(MagentoRequestError);
            expect((error as MagentoRequestError).status).toBe(401);
            expect((error as MagentoRequestError).body).toEqual(body);
        });

        it.each<readonly [string, unknown]>([
            ['an HTML page', HTML_PAGE],
            ['an empty body', ''],
            ['JSON without a message', { error: 'nope' }],
            ['a JSON list', ['nope']],
            ['a message that is not a string', { message: 42 }],
            ['parameters that are not a list or an object', { message: 'x %1', parameters: 'y' }]
        ])('carries no body for %s', async (_, body) => {
            const { client, reply } = harness();
            reply({ status: 400, body });

            const error = await rejection(client.searchProducts({ page: 1, pageSize: 20 }));

            expect((error as MagentoRequestError).status).toBe(400);
            expect((error as MagentoRequestError).body).toBeUndefined();
        });

        it('reads Retry-After into seconds', async () => {
            const { client, reply } = harness();
            reply({ status: 429, headers: { 'retry-after': '120' } });
            reply({ status: 429 });

            const withHeader = await rejection(client.searchProducts({ page: 1, pageSize: 20 }));
            const without = await rejection(client.searchProducts({ page: 1, pageSize: 20 }));

            expect((withHeader as MagentoRequestError).retryAfterSeconds).toBe(120);
            expect((without as MagentoRequestError).retryAfterSeconds).toBeUndefined();
        });

        // Followed, a 302 would turn the POST into a GET, and its 2xx would
        // report a comment that was never stored.
        it('does not follow a redirect, so a POST is never repeated as a GET', async () => {
            const { client, sent, reply } = harness();
            reply({ status: 302, headers: { location: `${BASE}/rest/V1/orders/7/comments` } });

            const error = await rejection(
                client.addOrderComment(7, { comment: 'x', notifyCustomer: false, visibleOnFront: false })
            );

            expect((error as MagentoRequestError).status).toBe(302);
            expect(sent).toHaveLength(1);
        });

        it('reports a 2xx read without JSON by its status, with no body', async () => {
            const { client, reply } = harness();
            reply({ status: 200, body: HTML_PAGE });

            const error = await rejection(client.getProduct('24-MB01'));

            expect(error).toBeInstanceOf(MagentoRequestError);
            expect((error as MagentoRequestError).status).toBe(200);
            expect((error as MagentoRequestError).body).toBeUndefined();
        });

        // The write was stored: whatever comes with the 2xx, it must not be
        // reported as failed.
        it.each<readonly [number, string]>([
            [200, 'true'],
            [200, '[]'],
            [200, HTML_PAGE],
            [204, '']
        ])('resolves a write on %i whatever the body: %s', async (status, body) => {
            const { client, reply } = harness();
            reply({ status, body });

            await expect(
                client.updateSourceItem({ sku: '24-MB01', sourceCode: 'default', quantity: 5, status: 'in_stock' })
            ).resolves.toBeUndefined();
        });
    });

    describe('when no answer arrives', () => {
        it('reports a timeout, naming the host', async () => {
            const { client, reply } = harness({ timeoutMs: 20 });
            reply({ status: 200, body: { sku: '24-MB01' }, delay: 500 });

            const error = await rejection(client.getProduct('24-MB01'));

            expect(error).toBeInstanceOf(MagentoUnavailableError);
            expect((error as MagentoUnavailableError).reason).toBe('timeout');
            expect((error as MagentoUnavailableError).host).toBe(HOST);
        });

        it.each([
            'ECONNREFUSED',
            'ENOTFOUND',
            'EAI_AGAIN',
            'EHOSTUNREACH',
            'UND_ERR_CONNECT_TIMEOUT',
            'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
            'DEPTH_ZERO_SELF_SIGNED_CERT',
            'CERT_HAS_EXPIRED',
            'ERR_TLS_CERT_ALTNAME_INVALID'
        ])('reads %s as unreachable: the request never left', async (code) => {
            const { client, fail } = harness();
            fail(networkError(code));

            const error = await rejection(client.getProduct('24-MB01'));

            expect(error).toBeInstanceOf(MagentoUnavailableError);
            expect((error as MagentoUnavailableError).reason).toBe('unreachable');
            expect((error as MagentoUnavailableError).host).toBe(HOST);
        });

        it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])(
            'reads %s as interrupted: the request may have reached Magento',
            async (code) => {
                const { client, fail } = harness();
                fail(networkError(code));

                const error = await rejection(
                    client.addOrderComment(7, { comment: 'x', notifyCustomer: false, visibleOnFront: false })
                );

                expect((error as MagentoUnavailableError).reason).toBe('interrupted');
            }
        );

        it('reads a failure without a code as interrupted', async () => {
            const { client, fail } = harness();
            fail(new Error('socket hang up'));

            expect(((await rejection(client.getProduct('24-MB01'))) as MagentoUnavailableError).reason).toBe(
                'interrupted'
            );
        });

        it('reads a body cut short as interrupted', async () => {
            const terminated = new TypeError('terminated', { cause: networkError('UND_ERR_SOCKET') });
            const client = withFetch(answering(200, () => Promise.reject(terminated)));

            const error = await rejection(client.getProduct('24-MB01'));

            expect((error as MagentoUnavailableError).reason).toBe('interrupted');
            expect((error as MagentoUnavailableError).cause).toBe(terminated);
        });

        it("reads fetch's refusal of a blocked port as unreachable", async () => {
            const client = withFetch(() => Promise.reject(new TypeError('fetch failed', { cause: new Error('bad port') })));

            expect(((await rejection(client.getProduct('24-MB01'))) as MagentoUnavailableError).reason).toBe(
                'unreachable'
            );
        });

        it('rethrows anything that is not a network failure, as a defect', async () => {
            const defect = new TypeError('Failed to parse URL from https://shop.example.com/rest/V1/x');
            const client = withFetch(() => Promise.reject(defect));

            await expect(client.getProduct('24-MB01')).rejects.toBe(defect);
        });

        it('keeps the token out of every failure it reports', async () => {
            const { client, reply, fail } = harness();
            reply({ status: 401, body: { message: 'Unauthorized.' } });
            fail(networkError('ECONNRESET'));
            const { logger, output } = memoryLogger();

            logger.error('refused', await rejection(client.getProduct('24-MB01')));
            logger.error('interrupted', await rejection(client.getProduct('24-MB01')));

            expect(output()).toContain('HTTP 401');
            expect(output()).toContain('ECONNRESET');
            expect(output()).not.toContain(TOKEN);
        });
    });

    describe('checkRestApi', () => {
        it("is ok when the route answers with Magento's currency information", async () => {
            const { client, sent, reply } = harness();
            reply({ status: 200, body: CURRENCY });

            await expect(client.checkRestApi()).resolves.toEqual({ outcome: 'ok' });
            expect(sent[0]?.path).toBe('/rest/V1/directory/currency');
        });

        it.each<readonly [string, Reply]>([
            ['a 404 page', { status: 404, body: HTML_PAGE }],
            ["Magento's own route miss", { status: 404, body: { message: 'Request does not match any route.' } }],
            ['a 200 HTML page', { status: 200, body: HTML_PAGE }],
            ['a 200 JSON answer that is not the currency', { status: 200, body: { items: [] } }],
            ['a redirect', { status: 301, headers: { location: 'https://www.shop.example.com/rest/V1/directory/currency' } }]
        ])('finds the path wrong on %s', async (_, reply) => {
            const harnessed = harness();
            harnessed.reply(reply);

            await expect(harnessed.client.checkRestApi()).resolves.toEqual({
                outcome: 'wrong-path',
                url: `${BASE}/rest/V1/directory/currency`,
                status: reply.status
            });
        });

        it.each<readonly [string, Reply]>([
            ['a 503, as in maintenance mode', { status: 503, body: HTML_PAGE }],
            ['a 403 from a WAF', { status: 403, body: HTML_PAGE }],
            ['a 401 from a module that restricts the route', { status: 401, body: { message: 'Unauthorized.' } }]
        ])('is inconclusive on %s', async (_, reply) => {
            const harnessed = harness();
            harnessed.reply(reply);

            const check = await harnessed.client.checkRestApi();

            expect(check.outcome).toBe('inconclusive');
            expect(check.outcome === 'inconclusive' && check.error).toBeInstanceOf(MagentoRequestError);
        });

        it('is inconclusive when Magento cannot be reached', async () => {
            const { client, fail } = harness();
            fail(networkError('ECONNREFUSED'));

            const check = await client.checkRestApi();

            expect(check.outcome).toBe('inconclusive');
            expect(check.outcome === 'inconclusive' && check.error).toBeInstanceOf(MagentoUnavailableError);
        });
    });
});

describe('parseRetryAfter', () => {
    const NOW = Date.parse('2026-10-09T12:00:00Z');

    it.each<readonly [string | null, number | undefined]>([
        ['120', 120],
        [' 30 ', 30],
        ['0', 0],
        ['Fri, 09 Oct 2026 12:00:45 GMT', 45],
        ['Fri, 09 Oct 2026 11:59:00 GMT', 0],
        ['1.5', undefined],
        ['-5', undefined],
        ['soon', undefined],
        ['', undefined],
        [null, undefined]
    ])('%j → %j', (value, seconds) => {
        expect(parseRetryAfter(value, NOW)).toBe(seconds);
    });
});
