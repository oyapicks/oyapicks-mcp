#!/usr/bin/env node
/**
 * OyaPicks MCP server
 *
 * Exposes 10 prediction-market data endpoints as MCP tools.
 * The USER supplies their own funded Base wallet. Their wallet pays
 * OyaPicks per call. This package never sees an OyaPicks key.
 *
 * IMPORTANT: everything logs to stderr. stdout is the JSON-RPC channel
 * and ANY stray write to it will silently break the server.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────── hard limits

// The ONLY address this server will ever sign a payment to.
// TODO: replace with the real OyaPicks payTo address before publishing.
const OYA_PAYTO = "0x7df9C5eDBf039b1C645d7697F58EfD143f0986E1";

// Base mainnet.
const NETWORK = "eip155:8453";

// Ceiling per call, in USDC base units (6 decimals).
// 300000 = $0.30. Top real price is $0.25.
const MAX_PER_CALL = 300000n;

const BASE_URL = "https://oyapicks.app";

// ────────────────────────────────────────────────────────────────── the routes

const ROUTES = [
  {
    tool: "oyapicks_single_market",
    path: "/api/x402/single-market",
    price: "$0.01",
    title: "Look up one prediction market",
    description:
      "Find the single highest-volume live prediction market matching a keyword. " +
      "Returns venue, implied probability, 24h USD volume, and end date. " +
      "Use this when you want the odds on one specific event. Costs $0.01 in USDC on Base.",
    params: { q: z.string().describe("Keyword, e.g. 'world cup' or 'fed rate'") },
  },
  {
    tool: "oyapicks_search",
    path: "/api/x402/search",
    price: "$0.02",
    title: "Search live prediction markets",
    description:
      "Keyword search across live prediction markets. Returns a list of matches with " +
      "current prices and venues. Use this when you want several candidates rather than " +
      "one answer; use oyapicks_single_market if you want just the top match. Costs $0.02 in USDC on Base.",
    params: { q: z.string().describe("Keyword to search for") },
  },
  {
    tool: "oyapicks_closing_soon",
    path: "/api/x402/closing-soon",
    price: "$0.02",
    title: "Markets resolving within 48 hours",
    description:
      "Prediction markets that resolve in the next 48 hours, with current prices. " +
      "Use this to find near-term events whose outcome is about to be settled. Costs $0.02 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_movers",
    path: "/api/x402/movers",
    price: "$0.03",
    title: "Biggest probability swings",
    description:
      "Prediction markets whose implied probability moved most recently, with the size " +
      "and direction of the move. Use this to spot events where sentiment just shifted. Costs $0.03 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_volume_spikes",
    path: "/api/x402/volume-spikes",
    price: "$0.03",
    title: "Biggest 24h volume spikes",
    description:
      "Prediction markets with the largest jumps in 24-hour trading volume. " +
      "Use this to find where money is suddenly flowing, which often precedes a price move. Costs $0.03 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_new_markets",
    path: "/api/x402/new-markets",
    price: "$0.03",
    title: "Newly listed markets",
    description:
      "Prediction markets listed since the last snapshot, with opening prices. " +
      "Use this to catch new events before they are widely priced. Costs $0.03 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_probability_history",
    path: "/api/x402/probability-history",
    price: "$0.03",
    title: "Probability over time for one market",
    description:
      "The implied-probability time series for a prediction market matched by keyword. " +
      "Use this to see how the odds on an event have moved, rather than just where they stand now. Costs $0.03 in USDC on Base.",
    params: { q: z.string().describe("Keyword identifying the market") },
  },
  {
    tool: "oyapicks_resolutions",
    path: "/api/x402/resolutions",
    price: "$0.03",
    title: "Recently resolved markets and outcomes",
    description:
      "Prediction markets that recently settled, with the winning outcome. " +
      "Use this to check what actually happened on an event, or to score earlier forecasts. Costs $0.03 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_arbitrage",
    path: "/api/x402/arbitrage",
    price: "$0.05",
    title: "Same outcome, different price across venues",
    description:
      "Events where the same outcome is priced differently on Polymarket versus Alpha Arcade, " +
      "with both prices and the size of the gap. Use this to find cross-venue mispricings. " +
      "Note that gaps sometimes reflect differing resolution criteria rather than genuine mispricing. Costs $0.05 in USDC on Base.",
    params: {},
  },
  {
    tool: "oyapicks_analyze",
    path: "/api/x402/analyze",
    price: "$0.25",
    title: "Top 3 markets by 24h volume",
    description:
      "The three highest-volume prediction markets over the last 24 hours, with current prices. " +
      "The broadest single snapshot of where attention and money are concentrated right now. " +
      "Costs $0.25 in USDC on Base, the most expensive tool here.",
    params: {},
  },
];

// ─────────────────────────────────────────────────────────── payment plumbing

function buildPayingFetch(privateKey) {
  const account = privateKeyToAccount(privateKey);

  const client = x402Client.fromConfig({
    schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
    policies: [
      // Guard 1: drop any payment requirement above our ceiling.
      (version, reqs) => reqs.filter((r) => BigInt(r.amount) <= MAX_PER_CALL),
    ],
  });

  // Guard 2: refuse to sign anything not addressed to OyaPicks.
  client.onBeforePaymentCreation(async (ctx) => {
    const req = ctx.selectedRequirements;

    if (!req) {
      return { abort: true, reason: "No payment requirement selected." };
    }
    if (String(req.payTo).toLowerCase() !== OYA_PAYTO.toLowerCase()) {
      console.error(`[oyapicks] BLOCKED: payment addressed to ${req.payTo}, not OyaPicks.`);
      return { abort: true, reason: "Recipient is not the OyaPicks address." };
    }
    if (BigInt(req.amount) > MAX_PER_CALL) {
      console.error(`[oyapicks] BLOCKED: amount ${req.amount} exceeds ceiling ${MAX_PER_CALL}.`);
      return { abort: true, reason: "Amount exceeds the per-call ceiling." };
    }
    if (req.network !== NETWORK) {
      console.error(`[oyapicks] BLOCKED: network ${req.network} is not Base mainnet.`);
      return { abort: true, reason: "Network is not Base mainnet." };
    }

    console.error(`[oyapicks] paying ${req.amount} to ${req.payTo}`);
  });

  return wrapFetchWithPayment(fetch, client);
}

// ──────────────────────────────────────────────────────────────────── startup

const PRIVATE_KEY = process.env.OYAPICKS_WALLET_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("[oyapicks] Missing OYAPICKS_WALLET_PRIVATE_KEY.");
  console.error("[oyapicks] Add it to the env block of your MCP client config.");
  process.exit(1);
}
if (!PRIVATE_KEY.startsWith("0x") || PRIVATE_KEY.length !== 66) {
  console.error("[oyapicks] OYAPICKS_WALLET_PRIVATE_KEY does not look like a private key.");
  console.error("[oyapicks] Expected 0x followed by 64 hex characters.");
  process.exit(1);
}
if (OYA_PAYTO === "0xREPLACE_ME") {
  console.error("[oyapicks] OYA_PAYTO is still the placeholder. Set it before running.");
  process.exit(1);
}

const payingFetch = buildPayingFetch(PRIVATE_KEY);

const server = new McpServer({
  name: "oyapicks",
  version: "0.1.0",
});

for (const route of ROUTES) {
  server.registerTool(
    route.tool,
    {
      title: route.title,
      description: route.description,
      inputSchema: route.params,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      const url = new URL(BASE_URL + route.path);
      for (const [k, v] of Object.entries(args ?? {})) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }

      try {
        const res = await payingFetch(url.toString(), { method: "GET" });

        if (!res.ok) {
          const body = await res.text();

          // A 402 here means the payment did not go through. The single most
          // common cause by far is an empty wallet.
          if (res.status === 402) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text:
                    `Payment for ${route.tool} (${route.price}) did not go through. ` +
                    `The most likely cause is that the wallet has no USDC on Base. ` +
                    `Check the balance of the address derived from OYAPICKS_WALLET_PRIVATE_KEY ` +
                    `and top it up with USDC on the Base network. ` +
                    `No ETH is needed; gas is sponsored.`,
                },
              ],
            };
          }

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `${route.tool} failed: HTTP ${res.status}. ${body.slice(0, 400)}`,
              },
            ],
          };
        }

        const data = await res.json();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        console.error(`[oyapicks] ${route.tool} error:`, err?.message ?? err);
        return {
          isError: true,
          content: [
            {
              type: "text",
              text:
                `${route.tool} could not complete. ` +
                `This is usually an unfunded wallet, a blocked payment, or a network problem. ` +
                `Details: ${err?.message ?? String(err)}`,
            },
          ],
        };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
console.error(`[oyapicks] MCP server ready. ${ROUTES.length} tools. Base mainnet.`);
