# magento2-mcp-server — v1 implementation plan

## Context

We are building an MCP server in TypeScript that exposes Magento 2 Open Source catalog, sales and
customer data to LLM agents over stdio, with a strict read/write split. The working copy lives inside
a web-served document root by the owner's decision; see "Secret handling" below for how the
integration token is kept out of that directory instead.

This repo is a portfolio piece for AI Application Engineer roles, so design quality outranks feature
count. The four things it has to demonstrate are: a token budget that survives Magento's enormous
REST payloads, a permission boundary around writes, errors an agent can actually act on, and an
adapter seam that lets anyone clone the repo and run it without a Magento instance.

Out of scope for v1 (do not add): OAuth, multi-store, source selection UI, order creation, an MCP
client, deployment, Streamable HTTP.

Plan language is English to match the repo convention (code, identifiers, tool descriptions,
commits, README all in English).

---

## Status — 2026-09-26

Increments 0 and 1 are done, committed and pushed: `3999292` (scaffold, config guards, CI) and
`4669022` (CI actions pinned to `@v5`, whose own runtime was the deprecated Node 20 — the project's
`node-version: '22'` is a different thing and stays — plus this plan under `docs/`).

**Increment 2 is done**: the `MagentoClient` port, the `searchCriteria` grammar and the fixture
adapter, with fixtures shaped from a Magento 2.4.9 sandbox. `npm run typecheck && npm test` is green.
"Increment 2 — outcome" below records what the sandbox settled and the notes it leaves for later
increments.

**Next: increment 3 — error taxonomy + mapper.** One decision is the owner's before it starts: how to
tell `AUTH_FAILED` from `PERMISSION_DENIED` when Magento 2.4.9 answers both with the same 401.

This is the versioned copy of the plan. The working copy lives outside the repository; keep the two in
step whenever either changes, with one deliberate difference: this copy's "Environment blockers"
section is trimmed of host-specific detail — local paths, the machine's tooling inventory and
neighbouring projects — which belongs in the working copy and not in a published repository.

---

## Environment blockers

1. **Secret handling — this repository lives inside a web-served document root.** That is a deliberate
   choice about where the working copy sits, and it is the one standing constraint in this section: a
   Magento integration token in a directory a web server may serve is readable by anyone who can
   reach it.

   **Resolution that makes staying there safe: the token never goes in a file in this repo.** An MCP
   server over stdio receives its environment from the MCP client that spawns it, so the real
   credential belongs in the client's `env` block:
   ```json
   { "mcpServers": { "magento": { "command": "node", "args": ["…/dist/index.js"],
       "env": { "MAGENTO_MODE": "http", "MAGENTO_BASE_URL": "…", "MAGENTO_ACCESS_TOKEN": "…" } } } }
   ```
   `.env` remains supported as a local development convenience and stays gitignored, but the README
   documents the client `env` block as the way to supply a real token, and `.env.example` carries an
   inline warning that the directory may be web-served.

   Worth confirming on any host that serves the directory: that no vhost has a document root at or
   above the repository. If one does, a deny rule for dotfiles is worth adding regardless of where
   the token lives.
2. **Node 22 LTS is required.** — **Resolved in increment 0.** The SDK v2 requires **Node 20+**;
   `engines.node` declares `>=20` and CI pins 22.
3. **TypeScript ≥ 6 no longer auto-includes `@types/*`.** — **Resolved in increment 1**: `tsconfig.json`
   sets `compilerOptions.types: ["node"]`, without which every `process.env` reference fails to
   compile.
4. **Verify SDK surface against the installed `.d.ts` as the first act of increment 1.** —
   **Resolved in increment 1**, and pinned by `tests/sdk-contract.test.ts`: `McpServer` from
   `@modelcontextprotocol/server`, the `registerTool(name, config, handler)` shape, all four
   annotation hints surviving the round trip to `tools/list`, `structuredContent` validated against
   `outputSchema`, and a thrown handler becoming a readable tool error rather than a protocol error.
   Still unverified, because nothing needs it until increment 5: the stdio transport handle — the
   contract test uses `InMemoryTransport.createLinkedPair()`. Original note: every SDK
   snippet below follows the published v2 docs (`ts.sdk.modelcontextprotocol.io/v2`), but the exact
   export names (`McpServer` vs `Server`), the `serveStdio` handle shape, and whether the
   `annotations` type accepts `openWorldHint` should be confirmed from the shipped types, not from
   this document.

---

## Locked decisions

| Decision | Choice |
|---|---|
| Result shape | `structuredContent` validated by `outputSchema`; the text block carries only a one-line summary plus any truncation notice. Not duplicated. |
| Adapter | `MagentoClient` port with `http` and `fixture` implementations for runtime, **plus** an HTTP-level mock (undici `MockAgent`, falling back to MSW) used only in tests for the HTTP client and the error mapper. |
| Write gate | Per-tool allowlist: `MAGENTO_MCP_WRITE_TOOLS=update_product_stock,add_order_comment`. Empty/unset registers no write tools. Unknown names fail startup. |
| Inventory | MSI `source-items`, with `source_code` fixed by env var (default `default`). `get_product` exposes `is_salable`, `manage_stock` (resolving `use_config_manage_stock` inheritance), `salable_quantity` and `source_quantity`. Multi-store and source selection stay out of scope. |

**`MAGENTO_MODE` defaults to `fixture`**, so a fresh clone runs with zero configuration — confirmed,
on the condition below.

A default of `fixture` has one dangerous failure mode: someone sets `MAGENTO_BASE_URL` and
`MAGENTO_ACCESS_TOKEN`, forgets `MAGENTO_MODE=http`, and gets invented data while believing it came
from their store. That is the same silent failure this plan refuses to tolerate for the write
allowlist, so it gets the same treatment:

> **Conflict guard.** If `MAGENTO_MODE` is `fixture` and either `MAGENTO_BASE_URL` or
> `MAGENTO_ACCESS_TOKEN` is set, **abort at startup.** Configured credentials that go unused are a
> statement of intent, and the only safe reading of that contradiction is to stop and make the
> operator say which one they meant.

Plus a loud `stderr` banner on every fixture-mode start, so canned data is never mistaken for a real
store even when the config is unambiguous. Guard first, banner second — the banner is a reminder,
not a control.

---

## Folder structure

```
magento2-mcp-server/
├── src/
│   ├── index.ts                    # entrypoint: load config → build server → serveStdio
│   ├── server.ts                   # createServer(deps): registers read tools, gates write tools
│   ├── config.ts                   # zod-validated env, fails fast with a readable report
│   ├── magento/
│   │   ├── client.ts               # MagentoClient port (interface) + shared DTO types
│   │   ├── http-client.ts          # fetch + bearer token + timeout + response→error mapping
│   │   ├── fixture-client.ts       # serves canned JSON from fixtures/
│   │   ├── search-criteria.ts      # searchCriteria[...] query builder
│   │   └── raw-types.ts            # partial types for the raw Magento payloads we touch
│   ├── tools/
│   │   ├── registry.ts             # ToolDefinition type + read/write tool lists
│   │   ├── read/
│   │   │   ├── search-products.ts
│   │   │   ├── get-product.ts
│   │   │   ├── search-orders.ts
│   │   │   ├── get-order.ts
│   │   │   └── get-customer.ts
│   │   └── write/
│   │       ├── update-product-stock.ts
│   │       └── add-order-comment.ts
│   ├── projection/
│   │   ├── fields.ts               # the allowlists, as `as const` tuples
│   │   ├── product.ts
│   │   ├── order.ts
│   │   ├── customer.ts
│   │   └── truncate.ts             # string truncation + notice collection
│   ├── errors/
│   │   ├── tool-error.ts           # ToolError class + code union
│   │   ├── map-upstream.ts         # HTTP status / network failure → ToolError
│   │   └── to-result.ts            # ToolError → isError tool result
│   └── shared/
│       ├── pagination.ts           # clamps, envelope, hasMore/notice construction
│       └── result.ts               # ok() / fail() result builders
├── fixtures/
│   ├── products/ orders/ customers/ inventory/
├── tests/
│   ├── tools/                      # one spec per tool, against the fixture client
│   ├── projection/                 # allowlist + truncation specs
│   ├── magento/                    # search-criteria + http-client (undici MockAgent)
│   ├── errors/                     # upstream → envelope mapping
│   └── server/                     # tools/list gating snapshots
├── .github/
│   └── workflows/
│       └── ci.yml                  # typecheck + test on every push and PR
├── .env.example                    # versioned
├── .gitignore                      # ignores .env
├── package.json                    # type: module, engines.node >=20, bin entry
├── tsconfig.json                   # types: ["node"], strict, NodeNext
├── vitest.config.ts
└── README.md
```

Each tool file exports a `defineX(deps): ToolDefinition` returning `{ name, config, handler }`.
Registration is then data-driven, and every handler is unit-testable without constructing a server.

---

## Tool contracts

Shared conventions:

- **Input**: `page` defaults to 1; `pageSize` defaults to 20 with `.max(50)`, so the bound is visible
  to the model in the schema rather than being silently clamped.
- **Output**: `{ <payload>, pagination?, notice? }` in `structuredContent`; the text block is one line.
- **Annotations**: all four spec hints are set explicitly on every tool. This matters because the
  spec's defaults are conservative — an omitted `destructiveHint` means *true*, so read tools that
  say nothing get treated as destructive by cautious hosts.
- `openWorldHint: true` everywhere: results depend on an external, mutable system whose contents are
  not a closed enumerable set. Documented as a judgment call in the README.

### Read tools

All read tools: `readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true`.

**`search_products`**
> Search the Magento catalog and return a compact page of matching products. Every result is reduced
> to an allowlisted set of fields — call get_product for full detail and live stock on a single SKU.
> Combine filters to narrow the result set; with no filters this returns the most recently created
> products, not the whole catalog. Capped at 50 results per call.

```ts
z.object({
  name:       z.string().min(2).optional(),   // substring, case-insensitive
  sku:        z.string().min(1).optional(),   // substring; exact lookups go to get_product
  categoryId: z.number().int().positive().optional(),
  priceMin:   z.number().nonnegative().optional(),
  priceMax:   z.number().nonnegative().optional(),
  page:       z.number().int().min(1).default(1),
  pageSize:   z.number().int().min(1).max(50).default(20),
}).refine(v => !(v.priceMin && v.priceMax) || v.priceMin <= v.priceMax,
          { message: 'priceMin must be less than or equal to priceMax.' })
```
Output: `{ products: ProductSummary[], pagination, notice? }`
Upstream: `GET /V1/products` with filter groups (groups AND together, filters within a group OR),
`name`/`sku` via `condition_type=like` wrapped in `%`, price via `gteq`/`lteq`, sort `created_at DESC`.

**`get_product`**
> Get detail and current inventory for exactly one product, by SKU. Returns an allowlisted subset of
> the product's attributes plus its stock at the configured inventory source: on-hand source
> quantity, salable quantity (on-hand minus open order reservations), and whether Magento currently
> considers it sellable. Use search_products first if you do not know the exact SKU.

```ts
z.object({ sku: z.string().min(1) })
```
Output: `{ product: ProductDetail, stock: StockDetail, notice? }`
Upstream — four independent calls, all keyed off the SKU, issued concurrently via
**`Promise.allSettled`** (one round trip of latency, not four):
1. `GET /V1/products/{sku}` — attributes, and `extension_attributes.stock_item` for `manage_stock`
2. `GET /V1/inventory/source-items?…sku=…&source_code={MAGENTO_SOURCE_CODE}` — `source_quantity`, source status
3. `GET /V1/inventory/get-product-salable-quantity/{sku}/{MAGENTO_STOCK_ID}` — `salable_quantity`
4. `GET /V1/inventory/is-product-salable/{sku}/{MAGENTO_STOCK_ID}` — `is_salable`

`allSettled`, **not `Promise.all`** — this is load-bearing. `Promise.all` rejects on the first
failure, so an MSI endpoint being unavailable would also throw away the product attributes that call
1 returned successfully, which is the exact opposite of the degradation this tool promises.

Failure handling is therefore per-call:
- **Call 1 is the only blocking one.** Rejected → `NOT_FOUND` (or the mapped upstream error), and
  results 2–4 are discarded. Firing 2–4 against a SKU that turns out not to exist wastes three
  read-only requests; that is an acceptable price for keeping the latency at one round trip.
- **Calls 2–4 degrade individually.** MSI modules disabled, a non-MSI install, or one endpoint
  timing out must still produce an answer: return the attributes plus whatever stock data did
  resolve, fall back to legacy `extension_attributes.stock_item.qty` from call 1, and name the
  missing pieces in `notice` so the model knows the stock picture is partial rather than assuming a
  missing field means zero.

Every stock field is therefore optional in `outputSchema`, and a test drives each of calls 2–4 to
failure independently to prove the other three still answer.

`manage_stock` resolution: `extension_attributes.stock_item.use_config_manage_stock === true` means
the effective value comes from store config `cataloginventory/item_options/manage_stock`, which Open
Source does not expose over REST. We fall back to `MAGENTO_DEFAULT_MANAGE_STOCK` and report which
source was used:
```ts
stock: { sourceCode, sourceQuantity, sourceStatus, salableQuantity, isSalable,
         manageStock: boolean, manageStockSource: 'product' | 'config-default' }
```

**`search_orders`**
> Search sales orders and return a compact page of matching orders. Filter by status, customer email
> and creation date range; with no filters this returns the most recent orders. Each result is
> reduced to summary fields — call get_order with an increment ID for line items and addresses.

```ts
z.object({
  status:      z.enum(['pending','processing','complete','closed','canceled',
                       'holded','payment_review','fraud']).optional(),
  email:       z.string().email().optional(),
  createdFrom: z.iso.date().optional(),   // YYYY-MM-DD
  createdTo:   z.iso.date().optional(),
  page, pageSize,
}).refine(createdFrom <= createdTo)
```
Output: `{ orders: OrderSummary[], pagination, notice? }`
Upstream: `GET /V1/orders`, sort `created_at DESC`. Date filters use `from`/`to` condition types.

**`get_order`**
> Get one sales order in full by its increment ID — the customer-facing number such as 000000123,
> not the internal entity ID. Returns totals, status, addresses and line items, each reduced to an
> allowlisted set of fields.

```ts
z.object({ incrementId: z.string().min(1) })
```
Magento has no `GET /V1/orders/by-increment-id`, so this is a `searchCriteria` query on
`increment_id` with `pageSize=1`. Zero results → `NOT_FOUND`. This increment-ID → entity-ID
resolution is shared with `add_order_comment`, so it lives in one helper
(`magento/client.ts: findOrderByIncrementId`).

**`get_customer`**
> Look up one customer account by email address or by numeric customer ID. Provide exactly one of
> the two. Returns profile and address fields only — never credentials or tokens. Guest checkouts
> have no customer account and will not be found here; use search_orders by email instead.

```ts
z.object({
  email:      z.string().email().optional(),
  customerId: z.number().int().positive().optional(),
}).refine(exactly one present, { message: 'Provide exactly one of email or customerId.' })
```
Upstream: `GET /V1/customers/{id}` or `GET /V1/customers/search` filtered on `email`.

### Write tools — registered only when listed in `MAGENTO_MCP_WRITE_TOOLS`

The two write tools deliberately carry **different** annotations, because the spec's `destructiveHint`
distinguishes overwrites from additions:

**`update_product_stock`** — `readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true`

Destructive because it overwrites a value that cannot be recovered through this server; idempotent
because it sets an absolute quantity, so repeating the same call is a no-op.

> Set the on-hand quantity for one SKU at the configured inventory source. This overwrites the
> current quantity with an absolute value — it is not a delta, and the previous quantity cannot be
> recovered through this server. Salable quantity may differ from the value you set, because Magento
> subtracts open order reservations. Requires human approval.

```ts
z.object({
  sku:      z.string().min(1),
  quantity: z.number().min(0),
  status:   z.enum(['in_stock','out_of_stock']).optional(),  // defaults from quantity
})
```
Upstream: `POST /V1/inventory/source-items` with
`{ sourceItems: [{ sku, source_code: MAGENTO_SOURCE_CODE, quantity, status }] }`.
That endpoint upserts and does not reliably 404 on an unknown SKU, so the handler **verifies the SKU
exists first** (`GET /V1/products/{sku}`) to produce a clean `NOT_FOUND` instead of silently creating
a source item for a typo. Response echoes previous and new quantity.

**`add_order_comment`** — `readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true`

Additive, not destructive; *not* idempotent, since calling it twice appends two comments.

> Append a comment to an order's status history. This is additive and cannot be undone through this
> server. Set notifyCustomer only when the shopper should receive an email — that sends real mail to
> a real person. Set visibleOnFront to expose the comment in the customer's account area.

```ts
z.object({
  incrementId:    z.string().min(1),
  comment:        z.string().min(1).max(2000),
  status:         z.string().optional(),      // 2.4.9 applies it to the order: see the increment 7 note
  notifyCustomer: z.boolean().default(false),
  visibleOnFront: z.boolean().default(false),
})
```
Upstream: resolve increment ID → entity ID, then `POST /V1/orders/{entityId}/comments`.

---

## Projection strategy (requirement 1)

**One rule: a field reaches the model only if it is named in an allowlist.** Allowlists live in
`projection/fields.ts` as `as const` tuples, and the projected TypeScript types are *derived* from
those tuples, so adding a field to the output requires editing the allowlist — it cannot leak in
through a spread.

We deliberately do **not** use Magento's `?fields=` query parameter as the contract. It is quirky and
uneven across endpoints, and it does not exist for the fixture client, which would break the
real/fixture parity that requirement 4 depends on. It stays available as a later bandwidth
optimisation layered *behind* the projection, never as a replacement for it.

- `ProductSummary`: `sku, name, price, status, type`
- `ProductDetail`: summary + `weight, urlKey, shortDescription, categoryIds, createdAt, updatedAt`.
  `custom_attributes` is collapsed to an allowlisted handful; everything else is dropped.
- `OrderSummary`: `incrementId, status, state, createdAt, customerEmail, customerName, grandTotal,
  currency, itemCount`. The internal `entity_id` is *not* exposed — no tool accepts it, so it would
  be pure token cost and an invitation to hallucinate calls. Nor is `protect_code`, the secret behind
  guest order-view links.
- `OrderDetail`: summary + `shippingMethod, paymentMethod, billingAddress, shippingAddress,
  items[{sku, name, qty, price, rowTotal}], totals{subtotal, shipping, tax, discount, grandTotal}`
- `Customer`: `id, email, firstname, lastname, createdAt, group, addresses[...]`. Explicitly denied:
  `confirmation` (a pending-confirmation token REST does return) and arbitrary `custom_attributes`.
  REST never returns password hashes or `rp_token`.

**Two kinds of truncation, both announced** (the "aviso al modelo" requirement):

1. *Pagination* — when `totalCount > page * pageSize`:
   `"Showing 20 of 3412 products (page 1 of 171). Narrow the filters or request page 2."`
2. *Field-level* — long strings (descriptions, comments) are cut at a per-field limit with an
   explicit marker, and `truncate.ts` collects the affected field names into the same `notice`:
   `"shortDescription was truncated to 300 characters."`

A model that cannot tell a complete answer from a clipped one will confidently report the clipped
one as complete, so the notice is part of the contract, not a nicety.

---

## Error design (requirement 3)

Everything the agent sees is a **tool error** — a normal result with `isError: true` — never a
protocol error, because the docs are explicit that protocol errors are addressed to the host and the
model never sees them. Handlers throw `ToolError`; a wrapper in `to-result.ts` converts it.

```ts
{ content: [{ type: 'text', text: '<CODE>: <message> — <suggestion>' }],
  structuredContent: { error: { code, message, retryable, suggestion? } },
  isError: true }
```
(Output validation is skipped for error results, so attaching `structuredContent` here is safe even
though it does not match `outputSchema`.)

| Code | Trigger | Retryable | Suggestion given to the agent |
|---|---|---|---|
| `NOT_FOUND` | 404, or empty search for a by-ID lookup | no | Entity-specific: "No product with SKU 'X'. Use search_products to find the correct SKU." |
| `INVALID_INPUT` | 400, bad filter combination | no | Surfaces Magento's own message, with `%1` parameters interpolated |
| `AUTH_FAILED` | 401 | no | "The integration token is invalid or expired. A human operator must refresh MAGENTO_ACCESS_TOKEN — retrying will not help." |
| `PERMISSION_DENIED` | 403 (2.4.9 sends 401: see the increment 3 note) | no | "The integration token lacks the ACL for this resource." |
| `RATE_LIMITED` | 429 | yes | Honours `Retry-After` when present |
| `UPSTREAM_UNAVAILABLE` | ECONNREFUSED / ENOTFOUND / timeout / abort | yes | "Magento at {host} is not reachable." |
| `UPSTREAM_ERROR` | 5xx and anything unmapped | yes | Generic |

Hard rules, each with a test:
- **No stack traces, no raw HTML error pages, no raw Magento bodies** in the result. Full detail goes
  to `stderr`, which is free on stdio (stdout is the protocol channel and a single `console.log`
  corrupts it — enforced by a lint rule banning `console.log` under `src/`).
- **The access token never appears in an error message, a log line or a URL.** A dedicated test
  asserts the 401 envelope does not contain the token string.
- `retryable` is honest: an expired token is not retryable, and telling an agent otherwise produces a
  retry loop against a dead credential.

---

## Configuration (requirement 5)

`config.ts` parses `process.env` through a zod schema at startup and exits with a readable report
listing *all* problems at once. `.env.example` is versioned; `.env` is gitignored.

```
MAGENTO_MODE=fixture                  # fixture | http   (default: fixture)
MAGENTO_BASE_URL=                     # required when MAGENTO_MODE=http
MAGENTO_ACCESS_TOKEN=                 # required when MAGENTO_MODE=http; integration token
MAGENTO_SOURCE_CODE=default           # MSI source for stock read/write
MAGENTO_STOCK_ID=1                    # MSI stock for salable-quantity / is-salable
MAGENTO_DEFAULT_MANAGE_STOCK=true     # fallback when use_config_manage_stock is true
MAGENTO_MCP_WRITE_TOOLS=              # empty = read-only. e.g. update_product_stock,add_order_comment
MAGENTO_TIMEOUT_MS=10000
MAGENTO_FIXTURES_DIR=./fixtures
LOG_LEVEL=info
```

Two startup checks share one principle — **a misconfiguration must never be indistinguishable from
correct operation**:

1. **Write allowlist names are validated** against the known write-tool names, so a typo
   (`update_product_stok`) fails at startup instead of silently leaving the tool unregistered. A
   silent failure here looks exactly like the security control working correctly, which is the worst
   possible failure mode for a permission boundary.
2. **Fixture mode with http credentials present aborts** (the conflict guard above). Silently
   serving canned data to someone who configured a real store is the same class of bug pointed the
   other way: the system looks like it is working, and the operator has no signal that it is not.

Both are covered by config tests asserting the process exits non-zero with a message naming the
offending variable.

---

## Implementation increments

Each increment ends green (`npm run typecheck && npm test`) and gets its own commit.

0. **Done. Install Node 22 LTS.** Nothing downstream runs without it. Preferred route is the host install
   (NodeSource apt repo or a version manager under `$HOME`); the `node:22` container with the repo
   bind-mounted is the fallback if the host install is not possible. Requires a privileged step, so
   it needs the owner at the keyboard for the `sudo` prompt.
   **Verify**: `node --version` reports v22.x and `npm --version` resolves, both from this project
   directory.
1. **Done. Scaffold.** `package.json` (`type: module`, `engines.node >=20`, `bin`), `tsconfig.json`
   (`types: ["node"]`, strict, NodeNext), vitest config, `.gitignore`, `.env.example`, README stub.
   Also `config.ts` with both startup guards (write-allowlist name validation, fixture-mode
   credential conflict).

   **CI — `.github/workflows/ci.yml`.** Runs on every push and on pull requests: `actions/checkout`,
   `actions/setup-node` pinned to Node 22 with `cache: npm`, `npm ci`, then `npm run typecheck` and
   `npm test` as separate steps so a type error and a test failure are distinguishable at a glance.
   Two properties worth preserving as the repo grows:
   - **No secrets, no services.** The whole suite runs against the fixture adapter, so CI needs no
     Magento instance and no token. That is the adapter seam paying for itself, and it is what lets
     a reviewer fork the repo and get a green build with zero setup.
   - **CI must not define `MAGENTO_BASE_URL` or `MAGENTO_ACCESS_TOKEN`.** With the default
     `MAGENTO_MODE=fixture`, setting either would trip the conflict guard and fail the build — which
     is the guard working correctly, but it is a confusing way to discover it. `.env.example` and
     the workflow both carry a comment saying so.

   *First action: install the SDK and read its `.d.ts` to confirm the exports this plan assumes.*
   **Verify**: typecheck passes; config tests cover both guards exiting non-zero with a message
   naming the offending variable, and a valid fixture-only config starting clean; the workflow goes
   green on the first push.
2. **Done. Magento port + query builder + fixtures.** `client.ts` interface, `search-criteria.ts`,
   `fixture-client.ts`, and fixture JSON shaped from sandbox captures (a few products incl. one with a huge
   `custom_attributes` block, orders in several statuses, customers, MSI source items).
   **Verify**: unit tests asserting exact query strings for every filter combination, plus fixture
   adapter specs for filtering, ordering, pagination and the absent-entity path.
   See "Increment 2 — settled design" and "Increment 2 — outcome" below.
3. **← NEXT. Error taxonomy + mapper.** `tool-error.ts`, `map-upstream.ts`, `to-result.ts`.
   **Verify**: table-driven tests for every row above, plus the no-token-leak and no-stack-trace tests.
4. **Projection layer.** Allowlists, projectors, truncation + notice collection.
   **Verify**: "huge fixture in, small object out"; assert the output has *no* key outside the
   allowlist; assert truncation emits a notice.
5. **First read tool end-to-end + server wiring.** `get_product` (the richest one — four upstream
   calls, graceful MSI degradation), `server.ts`, `index.ts` with `serveStdio`.
   **Verify**: in-process client test via `InMemoryTransport.createLinkedPair()`; a degradation
   suite that fails each of calls 2–4 independently and asserts the tool still answers with the
   remaining data plus a `notice` (this is what proves `allSettled` was used and not `Promise.all`);
   call 1 failing still yields `NOT_FOUND`; manual smoke with
   `npx @modelcontextprotocol/inspector node dist/index.js`.
6. **Remaining read tools.** `search_products`, `search_orders`, `get_order`, `get_customer`.
   **Verify**: per-tool specs incl. NOT_FOUND paths and pagination notices.
7. **Write tools + the gate.** Both write tools, allowlist parsing, annotations.
   **Verify**: `tools/list` omits both when the allowlist is empty; lists exactly one when only one is
   named; annotations assert `destructiveHint: true` on stock and `false` on the comment.
8. **HTTP client + docs.** `http-client.ts` against a real instance, README (setup, integration-token
   ACLs, the write-gate rationale, the fixture story, the `openWorldHint` judgment call).
   **Verify**: `undici MockAgent` tests for status mapping; manual run against a real Magento.

---

## Increment 2 — settled design

Four choices taken on 2026-09-23, recorded so the next session does not reopen them.

1. **Fixture payloads are hand-written** from the known shapes of Magento 2.4 REST responses, so the
   increment does not block on access to a live store — there is no Magento install on this host to
   dump from. The cost is that an invented shape can be subtly wrong, so increment 8, the first point
   where real responses are in hand, verifies them and corrects any drift. **Superseded on
   2026-09-26, before any fixture was written:** see "Increment 2 — outcome".
2. **The port's full contract is defined now** and the fixture adapter implements all of it, rather
   than the interface growing increment by increment. This increment already owes fixtures for
   products, orders, customers and MSI source items, so the data lands here either way; deferring the
   methods would mean reopening the interface three times and moving signatures once the first order
   tool arrives.
3. **`search-criteria.ts` holds both layers**: a generic
   `buildSearchCriteria({ filterGroups, sortOrders, page, pageSize })`, plus the per-domain mappers on
   top of it — `productSearchQuery`, `orderSearchQuery`, `orderIncrementIdQuery`,
   `customerEmailQuery`, `sourceItemQuery`. The whole query grammar is then one pure module, which is
   what the "exact query string for every filter combination" tests target, and it leaves
   `http-client.ts` a thin fetch wrapper in increment 8.
4. **The fixture adapter filters, sorts and paginates faithfully in memory** — the same domain
   parameters, case-insensitive substring matching, price ranges, category membership, `created_at`
   ordering, and a true `total_count`. That is what makes a clone with no Magento a real demo instead
   of a stub, and what lets the pagination-notice and `NOT_FOUND` tests in increments 4–6 run without
   HTTP. The cost is Magento semantics reimplemented in a second place, which is exactly why the
   boundary decisions below live in one module that both adapters import.

Details that follow, each worth a test:

- **Absence vs failure.** `undefined` means "does not exist"; a thrown error means "I could not
  answer". Search methods return an empty `items` with a truthful `total_count` — no matches is an
  answer, not an absence.
- **Date boundaries.** A `createdTo` of `2026-03-04` has to include that whole day. Magento compares a
  bare date as `created_at <= '2026-03-04 00:00:00'` and silently drops that day's orders, so the
  mapper sends `from`/`to` as `YYYY-MM-DD 00:00:00` / `YYYY-MM-DD 23:59:59`. `startOfDay` and
  `endOfDay` are exported from `search-criteria.ts` and used by the fixture adapter too, so the two
  modes cannot drift. `created_at` is UTC, so the day is a UTC day — say so in the tool description.
- **Stable ordering.** `created_at DESC` alone is not a total order, and sample catalogues share
  timestamps freely; an unstable sort makes page 2 skip and repeat rows. Products sort
  `created_at DESC, sku ASC`; orders sort `created_at DESC, increment_id DESC`. Both adapters, same
  comparators.
- **`like` values** are wrapped as `%value%` with `\`, `%` and `_` escaped, so a search for `50%`
  means those literal characters and not a wildcard. It also makes the HTTP semantics match the
  fixture adapter's plain substring match. Escaping behaviour against a real instance is an
  assumption for increment 8 to confirm.
- **A product with no `price`** — a `grouped` product, for instance — is excluded by any price filter,
  matching SQL's treatment of NULL in a comparison. One fixture is shaped that way on purpose.
- **Fixture layout.** `fixtures/products/`, `orders/` and `customers/` hold one JSON file per entity,
  keyed by the payload's own `sku` / `increment_id` / `id` rather than by filename, so a SKU with a
  path-unsafe character is not a problem. `fixtures/inventory/source-items.json` and
  `fixtures/inventory/salable.json` hold the MSI rows.
- **Fixtures load eagerly at construction**, so a wrong `MAGENTO_FIXTURES_DIR` fails at startup with a
  readable message instead of surfacing as a puzzling tool error on the first call. `Promise.all` is
  the right primitive there — a missing fixture file is a startup failure, not something to degrade
  around. (Contrast increment 5, where `allSettled` is load-bearing.)
- **Fixture writes mutate memory only**, never the files on disk, so the write tools are exercisable
  through the inspector with no store, and a restart returns to the committed fixtures.
  `updateSourceItem` upserts exactly as the real endpoint does, which is what keeps the handler's own
  SKU pre-check the single source of `NOT_FOUND` in both modes. A quantity change shifts
  `salable_quantity` by the same delta — not invented arithmetic: salable is on-hand minus
  reservations, so the delta carries.

Fixture content to write: six products, including one with a deliberately huge `custom_attributes`
block for the projection and truncation tests, one `grouped` product with no `price` and no source
item, and two products sharing a `created_at` so the secondary sort is observable; five orders
spanning `complete` / `processing` / `pending` / `canceled` / `holded`, one of them a guest order and
one already carrying a comment in `status_histories`; two customers, one holding
`confirmation` and an arbitrary custom attribute so the projection test has something real to prove
it drops (orders carry `protect_code` for the same reason); and MSI rows where
`salable_quantity` sits below on-hand for at least one SKU, since that gap is precisely what
`get_product`'s description promises to explain.

---

## Increment 2 — outcome (2026-09-26)

Done. Before any fixture was written, a clean Magento 2.4.9 + sample-data sandbox became available, so
settled decision 1 changed in its favour: fixture *shapes* come from the sandbox's REST responses, and
scenario *values* stay hand-set, since sample data ships one customer and two orders. Reading the
2.4.9 source and those responses settled the following, which the fixture adapter reproduces:

- `like` escaping works: `%\_%` matches only the SKU with a literal underscore, while `%_%` matches
  every product.
- A price filter excludes a product with no price (grouped), as NULL against the price index does.
- `eq` on `customer_email` is case-insensitive, and both two-key sorts order ties as specified.
- A page past the end is empty and carries the true `total_count`.
- Search results are byte-identical to the single GET — full `custom_attributes`, links and media —
  except that they never carry `stock_item`.
- `stock_item` appears on a single GET only when the token holds
  `Magento_CatalogInventory::cataloginventory`. Without it, Magento drops the field silently.
- Salable quantity is a 400 for a type without source items (grouped, configurable, bundle) and a 404
  for an unknown SKU. `is-product-salable` answers an unknown SKU with a plain `false`, so the port
  returns `boolean` there. After a default-source save, salable is `max(0, on-hand + reservations)`,
  through the reservation-aware stock status, and the legacy `stock_item` is synced (forced out of
  stock at quantity 0).
- `addOrderComment` follows `OrderService::addComment`: a status outside the order's current state is
  a 400, a valid one **is applied to the order**, and the entry is prepended.
- Error bodies are `{message, parameters?}`, with positional (`%1`) or named (`%resources`)
  placeholders. Developer mode adds a server-side `trace`.
- Magento sends `null` when a getter is declared non-nullable and omits the field otherwise, so an
  optional raw field may be absent or `null`.
- REST never returns `rp_token` or password hashes. It does return a customer's `confirmation` and an
  order's `protect_code`.

### Notes for later increments

- **Inc 3 — contradicts the error table.** 2.4.9 answers an unrecognised token and a valid token that
  lacks the ACL with the same 401 and a byte-identical body: `TokenUserContext` falls back to guest on
  any token failure, and `ErrorProcessor` maps every `AuthorizationException` to 401. The
  `AUTH_FAILED` / `PERMISSION_DENIED` split cannot come from the status alone; the owner decides how
  to handle it. `MagentoRequestError` is the mapper's Magento-refusal input. Interpolate positional
  and named placeholders, and never pass a body through.
- **Inc 4:** order-item projection must skip child rows (`parent_item_id` set), or a configurable is
  listed twice. Sample-data orders lack child rows; a checkout creates them. `protect_code` and
  `confirmation` never reach the model.
- **Inc 5 — touches a locked decision.** `stock_item.manage_stock` already carries the effective value:
  `Stock\Item::getManageStock()` resolves store config when `use_config_manage_stock` is true. That
  answers the manage-stock item under "Assumptions to confirm", so `MAGENTO_DEFAULT_MANAGE_STOCK` and
  `manageStockSource: 'config-default'` may be unnecessary. Confirm it empirically (flip the config,
  recapture), then the owner decides. An absent `stock_item` (a token without the ACL) means manage
  stock and legacy qty are unknown: say so in `notice`. Resolve the default `MAGENTO_FIXTURES_DIR`
  against the package root, not the cwd, since MCP clients launch servers from an arbitrary cwd.
- **Inc 6:** the `priceMin`/`priceMax` refine tests truthiness, so `{ priceMin: 5, priceMax: 0 }`
  passes. Use `!== undefined`.
- **Inc 7:** the `add_order_comment` contract's "does not transition the order" is false for 2.4.9.
  Rewrite it, and decide whether `status` stays, given that on a stock install it can flag an order as
  `fraud`.
- **Inc 8:** the README documents `oauth/consumer/enable_integration_as_bearer=1` and the ACL list,
  naming `Magento_CatalogInventory::cataloginventory` (for `stock_item`) next to its near-namesake
  `Magento_Catalog::catalog_inventory`. The http adapter maps a lookup 404 to `undefined` and any other
  non-2xx to `MagentoRequestError`, deciding on the status alone: a web server in front of Magento can
  replace an error body with its own HTML page.

---

## Verification

- `npm run typecheck` — `tsc --noEmit`
- `npm test` — vitest, all layers
- CI: the same two commands run on every push and PR via `.github/workflows/ci.yml`, against
  fixtures only, with no secrets configured
- `npm run build && npx @modelcontextprotocol/inspector node dist/index.js` — manual tool calls
- Gate check: run the inspector with `MAGENTO_MCP_WRITE_TOOLS` unset and confirm only five tools list
- Config guards: starting with `MAGENTO_MODE=fixture` plus a `MAGENTO_BASE_URL` must exit non-zero;
  starting with a misspelled write-tool name must exit non-zero
- Degradation: `get_product` answers with partial stock and a `notice` when the MSI endpoints fail
- Secrets: `.env` is gitignored; a real token is supplied through the MCP client's `env` block, and
  no committed file in the repo contains a credential
- Token-budget guard: a test asserting a 50-result `search_products` projection stays under a fixed
  byte ceiling, so a future field addition fails loudly instead of quietly inflating every call
- Real-instance smoke (increment 8): `MAGENTO_MODE=http` against a live Magento, read tools only

---

## Assumptions to confirm during implementation

- `MAGENTO_STOCK_ID=1` is the default stock on a stock installation; parameterised rather than hardcoded.
- Store config `cataloginventory/item_options/manage_stock` is not reachable via Open Source REST, so
  `MAGENTO_DEFAULT_MANAGE_STOCK` is the documented fallback. If your instance exposes it, increment 5
  should read it instead and drop the env var. **Answered 2026-09-26:** `stock_item.manage_stock`
  already carries the effective value — see the increment 5 note.
- The order status enum matches stock Magento; installs with custom statuses will need it widened.
