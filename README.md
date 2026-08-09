# oyapicks-mcp

Prediction-market data as MCP tools. Pay per call in USDC on Base. No API key, no account, no signup.

Ten read-only tools covering live market prices, keyword lookup, probability history,
volume spikes, cross-venue price gaps, and resolutions. Prices run from $0.01 to $0.25 per call.

## Setup

You need a Base wallet with a little USDC. Treat it as petty cash, not your main wallet.

Add this to your MCP client config:

```json
{
  "mcpServers": {
    "oyapicks": {
      "command": "npx",
      "args": ["-y", "oyapicks-mcp"],
      "env": {
        "OYAPICKS_WALLET_PRIVATE_KEY": "0xyourkey"
      }
    }
  }
}
```

- Claude Desktop: `claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`
- Windsurf: MCP settings

## What this can and cannot do with your key

Your key stays on your machine. It is never sent anywhere.

Before signing any payment, this server checks three things and refuses if any fail:

1. The recipient is the OyaPicks address, hardcoded in `index.js`. Nothing else.
2. The amount is at or under $0.30.
3. The network is Base mainnet.

The address is a constant in the source, not something read from the server's response,
so a redirected or spoofed endpoint cannot point payments somewhere else. Read `index.js`
and check for yourself; it is one file.

## Tools

| Tool | Price | What it returns |
|---|---|---|
| `oyapicks_single_market` | $0.01 | Top live market for a keyword, with probability and volume |
| `oyapicks_search` | $0.02 | List of live markets matching a keyword |
| `oyapicks_closing_soon` | $0.02 | Markets resolving within 48 hours |
| `oyapicks_movers` | $0.03 | Biggest recent probability swings |
| `oyapicks_volume_spikes` | $0.03 | Biggest 24h volume jumps |
| `oyapicks_new_markets` | $0.03 | Newly listed markets |
| `oyapicks_probability_history` | $0.03 | Probability over time for one market |
| `oyapicks_resolutions` | $0.03 | Recently settled markets and outcomes |
| `oyapicks_arbitrage` | $0.05 | Same outcome priced differently across venues |
| `oyapicks_analyze` | $0.25 | Top 3 markets by 24h volume |

## License

MIT
