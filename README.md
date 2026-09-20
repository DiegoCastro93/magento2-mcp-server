# magento2-mcp-server

An MCP server that exposes a Magento 2 Open Source store — catalog, orders and customers — to LLM
agents over stdio, with a strict separation between reading and writing.

> **Status: in development.** The scaffold, configuration layer and CI are in place. The Magento
> adapter and the tools themselves are being built increment by increment.

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

- Node.js 20 or newer (developed on 22 LTS)
- For live use: a Magento 2 Open Source instance and an integration access token

## Getting started

```bash
npm install
npm test          # runs entirely against fixtures — no Magento needed
npm run typecheck
npm run build
```

The server defaults to `MAGENTO_MODE=fixture`, so it runs with no configuration at all.

## Configuration

See [`.env.example`](./.env.example) for the full list. Two startup guards are worth knowing about,
because both exist to stop a misconfiguration from looking like correct operation:

- **Starting in fixture mode with `MAGENTO_BASE_URL` or `MAGENTO_ACCESS_TOKEN` set aborts.**
  Credentials configured but unused almost always mean someone forgot `MAGENTO_MODE=http` and is
  about to mistake canned data for their real store.
- **An unrecognised name in `MAGENTO_MCP_WRITE_TOOLS` aborts.** A typo would otherwise leave the
  tool unregistered, which is indistinguishable from the permission gate deliberately withholding
  it.

### Supplying a real token

This repository lives under a web document root, so **do not put a production token in a `.env`
file here.** Supply it through the `env` block of your MCP client configuration instead:

```json
{
  "mcpServers": {
    "magento": {
      "command": "node",
      "args": ["/var/www/html/magento2-mcp-server/dist/index.js"],
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
| `add_order_comment` | **write** | Appends to status history — additive, *not* idempotent |

The two write tools carry deliberately different annotations. Overwriting a quantity destroys the
previous value but repeats harmlessly; appending a comment destroys nothing but leaves two comments
if called twice. The protocol's `destructiveHint` and `idempotentHint` express exactly that
distinction, so they are set accordingly rather than uniformly.

## Scope

v1 covers the tools above over stdio. Out of scope: OAuth, multi-store, inventory source selection,
order creation, an MCP client, and deployment.

## License

MIT
