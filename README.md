# magento2-mcp-server

An MCP server that exposes a Magento 2 Open Source store — catalog, orders and customers — to LLM
agents over stdio, with a strict separation between reading and writing.

> **Status: v1 complete.** Five read tools and two gated write tools, over stdio, against a live
> Magento 2.4 store or against the bundled fixtures. Verified against a Magento 2.4.9 install with
> sample data.

## Why this exists

Pointing an agent at Magento's REST API directly does not work well. A single product response runs
to thousands of tokens of `custom_attributes`, errors arrive as stack traces or HTML, and every
write endpoint is one call away from changing real inventory. This server sits in between and takes
four positions:

1. **A token budget.** Every tool returns a projection built from an explicit field allowlist, with
   bounded pagination. When anything is cut — a result page or a long string — the response says so,
   because a model that cannot tell a clipped answer from a complete one will report the clipped one
   as complete.
2. **A permission boundary.** Write tools are not merely refused at call time; they are never
   registered unless an environment variable names them, so the model cannot see them. They carry
   the protocol's destructiveness annotations so hosts can require human approval.
3. **Errors an agent can act on.** Structured codes with a `retryable` flag and a suggested next
   step, never a stack trace. An expired token reports as not retryable, because telling an agent
   otherwise just produces a retry loop against a dead credential.
4. **An adapter seam.** The server runs against a real Magento instance or against local fixtures,
   so the test suite needs no Magento and anyone can clone the repo and run it.

## Requirements

- Node.js 20 or newer (developed on 22 LTS; the test suite needs 22.19 or newer)
- For live use: a Magento 2.4 Open Source store with MSI, and an integration access token

## Getting started

```bash
npm install
npm test          # runs entirely against fixtures — no Magento needed
npm run typecheck
npm run build
```

The server defaults to `MAGENTO_MODE=fixture`, so it runs with no configuration at all.

### Try it

```bash
npm run inspector   # builds, then opens the MCP Inspector on dist/index.js
```

Or register it with Claude Code:

```bash
claude mcp add magento -- node /path/to/magento2-mcp-server/dist/index.js
```

Either way it starts in fixture mode with no configuration. Call `get_product`
with `24-MB01` for a product with its full stock, or with `24-WG085_Group` to
see how the answer explains a grouped product, which has no stock of its own.

In fixture mode the server says so on stderr and serves the demo catalogue in `fixtures/`. Call
`get_product` with `24-MB01` for a product with its full stock, or with `24-WG085_Group` to see how
the answer explains a grouped product, which has no stock of its own.

## Fixture mode

Fixture mode is what makes the repository runnable and testable without a store. The fixtures are
Magento 2.4.9 REST payloads, shaped from captures of a real install, with hand-set values for the
scenarios the tests need: a product with a huge `custom_attributes` block, a grouped product with no
price, orders in five statuses, a guest order, a customer carrying a confirmation token the projection
must drop. The fixture adapter filters, sorts and paginates them as Magento does, and the boundary
rules it shares with the http adapter — date boundaries, `like` escaping, sort order — live in one
module that both import. Writes change memory only; a restart returns to the committed files.

Canned data mistaken for a real store is the failure this mode most has to rule out, so:

- every fixture-mode start prints a `FIXTURE MODE` banner on stderr, whatever the log level;
- starting in fixture mode with `MAGENTO_BASE_URL` or `MAGENTO_ACCESS_TOKEN` set **aborts**.
  Credentials configured but unused almost always mean someone forgot `MAGENTO_MODE=http`.

CI runs the whole suite against fixtures, with no secrets and no services, which is why it must not
define either variable.

## Connecting a store

1. **Create an integration** in the Magento admin (System › Extensions › Integrations), grant it the
   resources below under *API*, then save and activate it. Use its *Access Token*.
2. **Allow it as a bearer token.** Since Magento 2.4.4, integration tokens are refused as standalone
   bearer tokens unless the store allows it (Stores › Configuration › Services › OAuth › Consumer
   Settings › *Allow OAuth Access Tokens to be used as standalone Bearer tokens*):

   ```bash
   bin/magento config:set oauth/consumer/enable_integration_as_bearer 1
   ```
3. **Configure the server** through your MCP client's `env` block (see below):
   - `MAGENTO_MODE=http`.
   - `MAGENTO_BASE_URL` is the store's base URL, such as `https://shop.example.com`, including the
     path of an install in a subdirectory. The server adds `/rest/V1` itself, which addresses the
     default store view.
   - `MAGENTO_BASE_URL` must use `https://`. Every request carries the token, and Magento never
     expires an integration token, so plain `http://` is accepted only for `localhost`.
   - A store whose certificate comes from a private CA (mkcert, a corporate CA) needs Node to trust
     it: set `NODE_EXTRA_CA_CERTS` to the CA's PEM file in the same `env` block.

At startup the server checks the base URL before serving, with one anonymous request to
`GET /rest/V1/directory/currency`. If that answers with a 404, a redirect, or anything that is not
Magento's JSON, the server **refuses to start** and says why. The check exists because a 404 from a
lookup by key means "no such product", so a base URL that misses the REST API would otherwise make the
store look empty instead of misconfigured. If the check proves nothing either way — a timeout, a 503
during maintenance — the server logs a warning and serves anyway. The check proves the path, not the
token: Magento treats an unusable token as a guest.

### ACL resources

Grant exactly what the tools you enable need. The write resources are needed only when the write
tools are enabled.

| Resource | Admin tree | Endpoints | Used by |
| --- | --- | --- | --- |
| `Magento_Catalog::products` | Catalog › Inventory › Products | `GET /V1/products`, `GET /V1/products/{sku}` | `search_products`, `get_product`, `update_product_stock` |
| `Magento_CatalogInventory::cataloginventory` | Stores › Settings › Configuration › Inventory Section | `stock_item` on `GET /V1/products/{sku}` | `get_product`'s `manageStock` |
| `Magento_InventoryApi::source` | Stores › Inventory › Sources | `GET /V1/inventory/source-items` | `get_product`, `update_product_stock` |
| `Magento_InventorySalesApi::stock` | Stores › Inventory › Sales Stock | `GET /V1/inventory/get-product-salable-quantity/…`, `GET /V1/inventory/is-product-salable/…` | `get_product` |
| `Magento_Sales::actions_view` | Sales › Operations › Orders › Actions › View | `GET /V1/orders` | `search_orders`, `get_order`, `add_order_comment` |
| `Magento_Customer::customer` | Customers | `GET /V1/customers/{id}`, `GET /V1/customers/search` | `get_customer` |
| `Magento_InventoryApi::stock_source_item_assign` | Stores › Inventory › Stocks › Source Item Assigning | `POST /V1/inventory/source-items` | `update_product_stock` (write) |
| `Magento_Sales::comment` | Sales › Operations › Orders › Actions › Comment | `POST /V1/orders/{id}/comments` | `add_order_comment` (write) |

Two of them are easy to get wrong:

- **`Magento_CatalogInventory::cataloginventory` is not `Magento_Catalog::catalog_inventory`.** The
  second is the near-namesake *Catalog › Inventory* node above Products. Without the first, Magento
  does not refuse anything: it silently drops `stock_item` from the product, and `get_product`'s
  answer says that `manageStock` is unknown and why.
- **The MSI resources degrade rather than fail.** `get_product` makes four calls; if the inventory
  ones are refused, it still answers with the product and names the missing stock fields in its
  `notice`, so a partial stock picture is never mistaken for zero stock.

### Supplying a real token

Do not put a production token in a `.env` file, least of all in a checkout that sits under a
web-served directory, where a misconfigured vhost would serve it to anyone who asks. Supply it through
the `env` block of your MCP client configuration instead:

```json
{
  "mcpServers": {
    "magento": {
      "command": "node",
      "args": ["/path/to/magento2-mcp-server/dist/index.js"],
      "env": {
        "MAGENTO_MODE": "http",
        "MAGENTO_BASE_URL": "https://your-store.example.com",
        "MAGENTO_ACCESS_TOKEN": "your-integration-token",
        "MAGENTO_MCP_WRITE_TOOLS": ""
      }
    }
  }
}
```

## Configuration

See [`.env.example`](./.env.example) for the full list. Every startup check follows one rule: a
misconfiguration must never be indistinguishable from correct operation, so each one stops the
server with a message naming the variable at fault:

- fixture mode with `MAGENTO_BASE_URL` or `MAGENTO_ACCESS_TOKEN` set (see *Fixture mode*);
- an unrecognised name in `MAGENTO_MCP_WRITE_TOOLS` (see *The write gate*);
- a `MAGENTO_BASE_URL` that is plain `http://` beyond `localhost`, or that does not reach Magento's
  REST API (see *Connecting a store*).

## Tools

Read tools are always registered. Write tools appear only when named in `MAGENTO_MCP_WRITE_TOOLS`.

| Tool | Kind | Notes |
| --- | --- | --- |
| `search_products` | read | Filter by name, SKU, category and price range; paginated |
| `get_product` | read | Detail plus MSI stock: source quantity, salable quantity, is-salable |
| `search_orders` | read | Filter by status, email and creation date range; paginated |
| `get_order` | read | By customer-facing increment ID |
| `get_customer` | read | By email or customer ID |
| `update_product_stock` | **write** | Overwrites an absolute quantity — destructive, idempotent |
| `add_order_comment` | **write** | Appends to status history; the save can move a lagging order — destructive, *not* idempotent |

Both write tools are marked destructive, and they differ in `idempotentHint`. Overwriting a quantity
destroys the previous value but repeats harmlessly. A comment looks additive, and the agent cannot
choose the order's status, but Magento saves the whole order with the comment, and every order save
re-derives the state from the order's invoices, shipments and credit memos. An order whose state lags
behind them moves on — from processing to complete, say — just as it would after a comment from the
admin. REST offers no way to add a comment without that save, so the tool says so in its annotations
and reports the order's state before and after. And a comment sent twice is two comments.

### Why `openWorldHint` is `true` on every tool

This is a judgment call. The protocol describes an open-world tool as one that interacts with external
entities, and a closed-world one as working within a bounded domain. A store's database can look like
the second. It is marked open here because the answers come from an external system that other people
change between two calls — an order's status, a product's stock — and because a write reaches beyond
it: `add_order_comment` with `notifyCustomer` emails a real person. A host that treats open-world tools
with more caution is treating these correctly.

## The write gate

`MAGENTO_MCP_WRITE_TOOLS` is a per-tool allowlist, empty by default:

```bash
MAGENTO_MCP_WRITE_TOOLS=update_product_stock,add_order_comment
```

A write tool that is not named is **never registered**: it is absent from `tools/list`, and a call
to it is refused by the protocol layer before any handler runs. Refusing it at call time instead
would still show the model a tool it cannot use, and invite it to try. An unrecognised name aborts
startup, because a typo would otherwise leave a tool unregistered, which looks exactly like the gate
withholding it on purpose. At every start, the server states the gate on stderr, so an operator can
check it without a client:

```
Write tools enabled: update_product_stock.
No write tools enabled: read-only.
```

Approving each call is the host's job, driven by the annotations; nothing in this server asks a human.

## Errors

A tool that fails answers with a tool result marked `isError: true`, never a protocol error, which the
model would not see. Its `structuredContent` carries a code, whether retrying can help, and what to do
next. (A malformed argument, such as a `pageSize` over 50, is refused earlier by the SDK's own schema
check, in the SDK's words.) This one is what a store answered for an unusable token:

```json
{
  "code": "AUTH_FAILED",
  "message": "Magento refused access to Magento_Customer::customer.",
  "retryable": false,
  "suggestion": "Either MAGENTO_ACCESS_TOKEN is invalid, expired or revoked, or the integration lacks the ACL resource for this operation: Magento answers both the same way. A human operator must check both; retrying will not help."
}
```

| Code | When | Retryable |
| --- | --- | --- |
| `NOT_FOUND` | No such product, order or customer | no |
| `INVALID_INPUT` | A contradictory input, or Magento's own 400, with its message | no |
| `AUTH_FAILED` | A 401 before the token has proven itself in the same call | no |
| `PERMISSION_DENIED` | A 401 after it has, so only this resource is missing; or a 403 from a proxy | no |
| `RATE_LIMITED` | A 429, with `retryAfterSeconds` when the proxy sends one | yes |
| `UPSTREAM_UNAVAILABLE` | Unreachable, timed out, interrupted, or a 502/503/504 | yes, unless a write may already have been applied |
| `UPSTREAM_ERROR` | Another 5xx, or an answer that is not Magento's | 5xx only |
| `INTERNAL_ERROR` | A defect in this server; details go to the server log | no |

A write that fails after it may have reached Magento — a timeout, a 5xx, or a 400 from a comment
email that failed after the comment was stored — is never marked retryable, and its suggestion says
how to check first. The server log on stderr carries the detail the agent never sees, with the token
redacted.

## Verified against Magento, not assumed

1. addStatusHistory() does transition the order (increment 2)
The original contract stated that status in a comment “does not transition the order.” Order::addStatusHistory() calls setStatus($history->getStatus()). Source: module-sales/Model/Order.php, Model/Service/OrderService.php. The status argument was removed from add_order_comment, so an agent cannot choose an order’s status through this server.

2. The payment title is not at additional_information[0] (increment 4)
The plan assumed that index. ToOrderPayment::convert appends method_title after the quote’s own keys, so index 0 holds the title only for methods with no additional information. The reliable source is extension_attributes.payment_additional_info[key=method_title].

3. A 400 does not mean nothing was applied (increment 7)
The error table classified a 400 as “definitely not applied.” An SMTP failure throws a MailException after the order has already been saved, and the Web API converts it into a 400. Source: Transport.php:247. On a non-idempotent write, a 400 now keeps INVALID_INPUT but is never retryable, and its suggestion tells the agent to check the order before retrying.

4. MAGENTO_DEFAULT_MANAGE_STOCK was redundant (increment 5)
The plan introduced this variable on the assumption that REST returned the raw column value. stock_item.manage_stock already contains the effective value resolved by Stock\Item::getManageStock(). The variable would have replaced actual data with an assumption. It was removed, along with the manageStockSource field that existed only to flag the fallback.

5. Commenting on an order can change its state (increment 8)
Removing status from the payload was not enough: State.php:41-50 re-derives state and status from invoices, shipments, and credit memos after save. This was caught by the smoke test against a real Magento instance, not by reading the source. destructiveHint was changed from false to true.

## Known limitations

1. Nothing guards the size of tools/list.
With both write tools enabled, it comes to 18,427 bytes. That payload is paid on every startup of every client, and it consumes context before the first call. The project does have a byte-size guard for the search_products projection, but not for tools/list: adding a description or a field to a schema inflates it without any test failing.

2. An SKU with an encoded slash is untested behind Apache.
The adapter encodes path segments, and products/a%2Fb reaches the route correctly on the sandbox’s nginx. Apache, with AllowEncodedSlashes at its default value, rejects %2F with a 404 before the request reaches PHP. This wasn’t tested because the sandbox runs nginx.

## Scope

v1 covers the tools above over stdio. Out of scope: OAuth, multi-store, inventory source selection,
order creation, an MCP client, and deployment.

## License

MIT
