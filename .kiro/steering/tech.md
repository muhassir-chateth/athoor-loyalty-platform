# Tech Stack

## Runtime & Language
- **Node.js** v24.17.0 (managed via nvm)
- **JavaScript** (CommonJS wrapper; underlying shopify-mcp package is TypeScript compiled to ESM)

## Key Dependencies
- `shopify-mcp` v1.0.8 — MCP server wrapping Shopify GraphQL Admin API
- `@modelcontextprotocol/sdk` — MCP protocol implementation
- `graphql-request` — GraphQL HTTP client
- `zod` — Schema validation
- `dotenv` — Environment variable loading
- `minimist` — CLI argument parsing

## Package Manager
- npm

## Authentication
- Static Shopify access token (`shpat_` prefix) passed via CLI arguments
- Configured in `.kiro/settings/mcp.json`

## Common Commands

All commands run from the `shopify-mcp-local/` directory:

```bash
# Install dependencies
npm install

# Run MCP server directly (for debugging)
node node_modules/shopify-mcp/dist/index.js --domain=myathoorlondon.myshopify.com --accessToken=<TOKEN>
```

The MCP server is normally started automatically by Kiro based on the configuration in `.kiro/settings/mcp.json`. Manual execution is only needed for debugging.

## MCP Tools Available
- **Products**: get-products, get-product-by-id, create-product, update-product, delete-product, manage-product-options, manage-product-variants, delete-product-variants
- **Customers**: get-customers, update-customer, get-customer-orders
- **Orders**: get-orders, get-order-by-id, update-order
