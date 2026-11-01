# oyapicks-mcp

Prediction-market data as MCP tools. Pay per call in USDC on **Algorand** or **Base**. No API key, no account, no signup.

Read-only tools covering live market prices, keyword lookup, probability history, volume spikes,
cross-venue price gaps, resolutions, and (on Algorand) the complete Alpha Arcade catalog.
Prices run from $0.01 to $0.25 per call.

## Setup

Use a wallet with a little USDC. Treat it as petty cash, not your main wallet.

### Pay on Algorand

The wallet needs USDC (opted in to ASA `31566704`) and enough ALGO for its minimum balance.
The network fee on each payment is covered by the GoPlausible facilitator.

```json
{
  "mcpServers": {
    "oyapicks": {
      "command": "npx",
      "args": ["-y", "oyapicks-mcp"],
      "env": {
        "OYAPICKS_ALGO_MNEMONIC": "your twenty five words"
      }
    }
  }
}
```

### Pay on Base

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

Set one wallet. If both are set, add `"OYAPICKS_RAIL": "algorand"` or `"OYAPICKS_RAIL": "base"`.

- Claude Desktop: `claude_desktop_config.json`
- Cursor: `~/.cursor/mcp.json`
- Windsurf: MCP settings

## What this can and cannot do with your key

Your key stays on your machine. It is never sent anywhere.

Before signing any payment, this server checks these and refuses if any fail:

1. The recipient is the OyaPicks address for that network, hardcoded in `index.js`. Nothing else.
2. The amount is at or under $0.30.
3. The network is Algorand mainnet or Base mainnet, matching the wallet you configured.
4. On Algorand, the asset is USDC (ASA `31566704`).

The addresses are constants in the source, not read from the server's response, so a redirected
or spoofed endpoint cannot point payments somewhere else. Read `index.js` and check for yourself;
it is one file.

## Tools

Since v0.3.0 the tool list is **not written into this package**. The server reads
<https://oyapicks.app/api/catalog> when it starts, and again every five minutes, and registers
exactly the products that are on sale. When OyaPicks lists a new data product it appears in your
client without you reinstalling anything, and a product that is withdrawn disappears the same way.

To see the current list and prices before installing, open
[https://oyapicks.app/api/catalog](https://oyapicks.app/api/catalog) (free, no payment) or
[https://oyapicks.app/products](https://oyapicks.app/products).

Some products run on one rail only, so the number of tools differs between Algorand and Base.
The server prints the count on startup.

If the catalogue cannot be reached, the server falls back to the eleven always-on
prediction-market products and says so on stderr. The fallback can only offer fewer tools than
the truth, never more.

On Algorand, a call that fails on the server side is never settled, so it costs nothing.

## License

MIT
