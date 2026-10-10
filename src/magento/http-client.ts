/**
 * The http adapter: the port spoken over Magento's REST API.
 *
 * It decides on the status alone. A web server in front of Magento can replace
 * an error body with its own page — ddev's nginx does, for every 404 — so a
 * body is read to keep Magento's message when there is one, never to decide
 * what happened. A 404 therefore means "does not exist" only for the three
 * lookups by key, and only once `checkRestApi` has shown, at startup, that the
 * base URL reaches Magento at all.
 *
 * Query strings come from `search-criteria.ts`, which the fixture adapter
 * shares, so this file only sends them.
 */
import type { Logger } from '../shared/logger.js';
import {
    MagentoRequestError,
    MagentoUnavailableError,
    SOURCE_ITEM_STATUS,
    type MagentoClient,
    type OrderCommentInput,
    type OrderSearchParams,
    type ProductSearchParams,
    type SourceItemUpdate,
    type UnavailableReason
} from './client.js';
import type {
    RawCustomer,
    RawErrorBody,
    RawOrder,
    RawProduct,
    RawSearchResult,
    RawSourceItem
} from './raw-types.js';
import {
    customerEmailQuery,
    orderIncrementIdQuery,
    orderSearchQuery,
    productSearchQuery,
    sourceItemQuery
} from './search-criteria.js';

/**
 * The part of `fetch` this adapter uses. Both Node's global `fetch` and
 * undici's satisfy it, so tests can pass undici's bound to a `MockAgent`: Node
 * bundles its own, older undici, whose global dispatcher a newer `MockAgent`
 * should not be mixed into.
 */
export type Fetch = (url: string, init: FetchInit) => Promise<FetchResponse>;

export interface FetchInit {
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    /**
     * Never follow: a followed 301 or 302 turns a POST into a GET, and a write
     * that never happened would come back as a 2xx.
     */
    readonly redirect: 'manual';
    readonly signal: AbortSignal;
}

export interface FetchResponse {
    readonly status: number;
    readonly headers: { get(name: string): string | null };
    text(): Promise<string>;
}

export interface HttpClientOptions {
    /** The store's base URL; see `Config`. Validated by `loadConfig`. */
    readonly baseUrl: string;
    readonly accessToken: string;
    /** Covers the whole exchange, body included. */
    readonly timeoutMs: number;
    /** Defaults to the global `fetch`. */
    readonly fetch?: Fetch | undefined;
    /** Receives one `debug` line per request. */
    readonly logger?: Logger | undefined;
}

/** What the startup probe found. */
export type RestApiCheck =
    | { readonly outcome: 'ok' }
    /**
     * Something answered, and it was not Magento's REST API: a redirect, a 404,
     * or a 2xx without Magento's JSON. `MAGENTO_BASE_URL` is wrong.
     */
    | { readonly outcome: 'wrong-path'; readonly url: string; readonly status: number }
    /** No answer that settles it either way, such as a timeout or a 503. */
    | { readonly outcome: 'inconclusive'; readonly error: unknown };

/** The probe's route: anonymous on a stock install, and left alone by `Magento_WebapiSecurity`. */
const PROBE_PATH = '/directory/currency';

/** `cause.code` values for a request that certainly never left. */
const NEVER_SENT = new Set([
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNREFUSED',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'UND_ERR_CONNECT_TIMEOUT'
]);

/** TLS failures, which happen in the handshake, before any request is sent. */
const TLS_FAILURE = new RegExp(
    '^(?:ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_)' +
        '|^(?:DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)$'
);

export class HttpMagentoClient implements MagentoClient {
    /** `<base URL>/rest/V1`, with no trailing slash. */
    readonly apiRoot: string;
    /** The base URL's host, which is not a secret. */
    private readonly host: string;
    private readonly accessToken: string;
    private readonly timeoutMs: number;
    private readonly fetch: Fetch;
    private readonly logger: Logger | undefined;

    constructor(options: HttpClientOptions) {
        const base = new URL(options.baseUrl);
        this.apiRoot = `${base.origin}${base.pathname.replace(/\/+$/, '')}/rest/V1`;
        this.host = base.host;
        this.accessToken = options.accessToken;
        this.timeoutMs = options.timeoutMs;
        this.fetch = options.fetch ?? fetch;
        this.logger = options.logger;
    }

    searchProducts(params: ProductSearchParams): Promise<RawSearchResult<RawProduct>> {
        return this.read(`/products?${productSearchQuery(params)}`);
    }

    getProduct(sku: string): Promise<RawProduct | undefined> {
        return this.lookup(`/products/${encodeURIComponent(sku)}`);
    }

    async getSourceItem(sku: string, sourceCode: string): Promise<RawSourceItem | undefined> {
        return first(await this.read<RawSearchResult<RawSourceItem>>(
            `/inventory/source-items?${sourceItemQuery(sku, sourceCode)}`
        ));
    }

    getSalableQuantity(sku: string, stockId: number): Promise<number | undefined> {
        return this.lookup(`/inventory/get-product-salable-quantity/${encodeURIComponent(sku)}/${stockId}`);
    }

    isProductSalable(sku: string, stockId: number): Promise<boolean> {
        return this.read(`/inventory/is-product-salable/${encodeURIComponent(sku)}/${stockId}`);
    }

    searchOrders(params: OrderSearchParams): Promise<RawSearchResult<RawOrder>> {
        return this.read(`/orders?${orderSearchQuery(params)}`);
    }

    async findOrderByIncrementId(incrementId: string): Promise<RawOrder | undefined> {
        return first(await this.read<RawSearchResult<RawOrder>>(`/orders?${orderIncrementIdQuery(incrementId)}`));
    }

    getCustomerById(customerId: number): Promise<RawCustomer | undefined> {
        return this.lookup(`/customers/${customerId}`);
    }

    async findCustomerByEmail(email: string): Promise<RawCustomer | undefined> {
        return first(await this.read<RawSearchResult<RawCustomer>>(`/customers/search?${customerEmailQuery(email)}`));
    }

    updateSourceItem(update: SourceItemUpdate): Promise<void> {
        return this.write('/inventory/source-items', {
            sourceItems: [
                {
                    sku: update.sku,
                    source_code: update.sourceCode,
                    quantity: update.quantity,
                    status: SOURCE_ITEM_STATUS[update.status]
                }
            ]
        });
    }

    addOrderComment(orderId: number, input: OrderCommentInput): Promise<void> {
        // No `status`: `OrderService::addComment` then records the order's
        // current status on the entry. Sending it explicitly would change
        // nothing about the save that follows; see the port.
        return this.write(`/orders/${orderId}/comments`, {
            statusHistory: {
                comment: input.comment,
                is_customer_notified: input.notifyCustomer ? 1 : 0,
                is_visible_on_front: input.visibleOnFront ? 1 : 0
            }
        });
    }

    /**
     * Asks an anonymous route that every install has, to tell a base URL that
     * reaches Magento's REST API from one that does not. It proves the path,
     * not the token: Magento treats an unusable token as a guest, and a guest
     * may call this route.
     */
    async checkRestApi(): Promise<RestApiCheck> {
        const url = this.apiRoot + PROBE_PATH;
        let answer: Answer;
        try {
            answer = await this.send('GET', PROBE_PATH);
        } catch (error) {
            if (error instanceof MagentoRequestError && (error.status < 400 || error.status === 404)) {
                return { outcome: 'wrong-path', url, status: error.status };
            }
            return { outcome: 'inconclusive', error };
        }
        return isCurrencyInformation(parseJson(answer.text))
            ? { outcome: 'ok' }
            : { outcome: 'wrong-path', url, status: answer.status };
    }

    /** A GET by key, whose 404 means the entity does not exist. */
    private async lookup<T>(path: string): Promise<T | undefined> {
        try {
            return await this.read<T>(path);
        } catch (error) {
            if (error instanceof MagentoRequestError && error.status === 404) return undefined;
            throw error;
        }
    }

    /**
     * A GET whose 2xx body is Magento's JSON. One that is not came from
     * something else answering at that address, so it is reported with its
     * status and no body, like a refusal from a proxy.
     */
    private async read<T>(path: string): Promise<T> {
        const { status, text } = await this.send('GET', path);
        const parsed = parseJson(text);
        if (parsed === undefined) throw new MagentoRequestError(status);
        return parsed as T;
    }

    /** A POST. Its 2xx body is not read: a stored write must never be reported as failed. */
    private async write(path: string, payload: unknown): Promise<void> {
        await this.send('POST', path, JSON.stringify(payload));
    }

    /**
     * @throws {MagentoRequestError} for any status outside 2xx, redirects included.
     * @throws {MagentoUnavailableError} when no complete answer arrived.
     */
    private async send(method: 'GET' | 'POST', path: string, body?: string): Promise<Answer> {
        const url = this.apiRoot + path;
        const headers: Record<string, string> = {
            Authorization: `Bearer ${this.accessToken}`,
            Accept: 'application/json'
        };
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        const init: FetchInit = {
            method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: 'manual',
            signal: AbortSignal.timeout(this.timeoutMs)
        };

        const started = Date.now();
        let response: FetchResponse;
        let text: string;
        try {
            response = await this.fetch(url, init);
            text = await response.text();
        } catch (error) {
            const reason = unavailableReason(error);
            if (reason === undefined) throw error;
            throw new MagentoUnavailableError(this.host, reason, { cause: error });
        }
        const { pathname, search } = new URL(url);
        this.logger?.debug(`${method} ${pathname}${search} → ${response.status} in ${Date.now() - started} ms`);

        if (response.status >= 200 && response.status < 300) return { status: response.status, text };
        throw new MagentoRequestError(response.status, errorBody(text), {
            retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after'))
        });
    }
}

interface Answer {
    readonly status: number;
    readonly text: string;
}

function first<T>(result: RawSearchResult<T>): T | undefined {
    return result.items[0];
}

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/**
 * Magento's error body, kept whole — a developer-mode `trace` included, for
 * the operator's log, where secrets are redacted — or `undefined` for anything
 * else, such as a proxy's HTML page.
 */
function errorBody(text: string): RawErrorBody | undefined {
    const parsed = parseJson(text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
    const { message, parameters } = parsed as { message?: unknown; parameters?: unknown };
    if (typeof message !== 'string') return undefined;
    if (parameters !== undefined && (typeof parameters !== 'object' || parameters === null)) return undefined;
    return parsed as RawErrorBody;
}

function isCurrencyInformation(value: unknown): boolean {
    return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { base_currency_code?: unknown }).base_currency_code === 'string'
    );
}

/**
 * `Retry-After` in seconds: delta-seconds as given, an HTTP-date as the time
 * left until it, never below 0. Anything else is `undefined`. A date must hold
 * a letter, since `Date.parse` reads a bare number such as `1.5` as a date.
 */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
    if (value === null) return undefined;
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    if (!/[a-z]/i.test(trimmed)) return undefined;
    const date = Date.parse(trimmed);
    return Number.isNaN(date) ? undefined : Math.max(0, Math.ceil((date - now) / 1000));
}

/**
 * How a failed exchange failed, or `undefined` when the throw is not a
 * network failure and so is a defect.
 *
 * undici reports a failed request as `TypeError('fetch failed')` and a body
 * cut short as `TypeError('terminated')`, each with the cause; the timeout
 * signal rejects with a `TimeoutError`. Only a cause that rules out sending
 * counts as `unreachable`. Any other is `interrupted`, the safe reading: the
 * request may have reached Magento.
 */
function unavailableReason(error: unknown): UnavailableReason | undefined {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return 'timeout';
    if (!(error instanceof TypeError) || (error.message !== 'fetch failed' && error.message !== 'terminated')) {
        return undefined;
    }
    const cause = error.cause;
    const code =
        typeof cause === 'object' && cause !== null && typeof (cause as { code?: unknown }).code === 'string'
            ? (cause as { code: string }).code
            : undefined;
    if (code !== undefined && (NEVER_SENT.has(code) || TLS_FAILURE.test(code))) return 'unreachable';
    // fetch refuses a port on its blocklist before connecting.
    if (code === undefined && cause instanceof Error && cause.message === 'bad port') return 'unreachable';
    return 'interrupted';
}
