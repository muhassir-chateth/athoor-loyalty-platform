# Project Structure

```
kiro_athoor/
├── .kiro/
│   ├── settings/
│   │   └── mcp.json              # MCP server config (Shopify connection, auth, auto-approve)
│   └── steering/                 # AI assistant guidance documents (this directory)
├── .vscode/
│   └── settings.json             # Kiro agent settings, trusted commands
└── shopify-mcp-local/
    ├── package.json              # Wrapper package — installs shopify-mcp dependency
    ├── package-lock.json
    └── node_modules/
        └── shopify-mcp/          # The MCP server package (v1.0.8)
            ├── dist/index.js     # Compiled entry point (started by Kiro)
            ├── package.json
            └── README.md
```

## Architecture Pattern

**Thin wrapper / installer pattern.** The workspace exists to:
1. Install the `shopify-mcp` npm package locally
2. Configure it as an MCP server for the Kiro IDE via `.kiro/settings/mcp.json`

There is no custom source code — the intelligence lives in the MCP server package and the AI assistant that consumes its tools.

## Key Files
- `.kiro/settings/mcp.json` — Defines how the Shopify MCP server is launched (command, args, auto-approve list)
- `.vscode/settings.json` — Kiro agent notification preferences and trusted command patterns
- `shopify-mcp-local/package.json` — Declares the `shopify-mcp` dependency
