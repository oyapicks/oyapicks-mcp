#!/usr/bin/env node
/**
 * OyaPicks MCP server
 *
 * Exposes prediction-market data endpoints as MCP tools, paid per call in
 * USDC on either rail:
 *   - Algorand mainnet (via the GoPlausible facilitator)
 *   - Base mainnet     (via Coinbase's facilitator)
 * The live catalogue decides the tools. With every perps product switched off
 * (2026-11-18) that is 11 products and 21 paid endpoints: 11 tools on Algorand
 * and 10 on Base, because Alpha Book is sold on Algorand only.
 *
 * ⚠️ v0.3.1, 2026-11-18: THE ALGORAND RAIL COULD NOT START IN 0.3.0. This file
 * imports `algosdk`, `@x402-avm/fetch` and `@x402-avm/avm` for the Algorand
 * rail, and 0.3.0's package.json listed none of them, so `npx oyapicks-mcp`
 * with OYAPICKS_ALGO_MNEMONIC set died at startup with "Cannot find package
 * 'algosdk'". 0.3.1 lists all three. This file changed only its version and
 * these comments; the payment code is untouched.
 *
 * The USER supplies their own funded wallet. Their wallet pays OyaPicks per
 * call. This package never sees an OyaPicks key.
 *
 * IMPORTANT: everything logs to stderr. stdout is the JSON-RPC channel and
 * ANY stray write to it will silently break the server. The Algorand payment
 * library writes debug lines with console.log, so console.log/info/debug are
 * redirected to stderr below, BEFORE any payment library is loaded.
 *
 * ⚠️ THE TOOL LIST IS NOT IN THIS FILE ANY MORE.  v0.3.0, 2026-10-31.
 *
 * It reads https://oyapicks.app/api/catalog at start, and again every five
 * minutes, and registers exactly the products that are on sale. The reason:
 * OyaPicks can switch a data product on or off from its own settings, and a
 * hardcoded list here meant a product switched on was never offered and one
 * switched off could be offered and answer 404. The catalogue carries the id,
 * price, both rail paths and the parameter; the hand-written tool copy below
 * stays, because an agent chooses a tool from its description.
 *
 * ⚠️ IF THE CATALOGUE CANNOT BE READ, this server falls back to the
 * prediction-market products written out below (always on sale: 11 tools on
 * Algorand, 10 on Base) and says so on stderr. The
 * fallback can only UNDER-offer, never over-offer: a product that needs the
 * live catalogue to appear is simply absent.
 *
 * ⚠️ NOTHING ABOUT PAYMENT CHANGED. The rails, the $0.30 ceiling, the payTo
 * allowlist and the guard hook are byte for byte what they were in v0.2.0.
 */

console.log = (...args) => console.error(...args);
console.info = (...args) => console.error(...args);
console.debug = (...args) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VERSION = "0.3.1";
const BASE_URL = (process.env.OYAPICKS_BASE_URL || "https://oyapicks.app").replace(/\/$/, "");

// Ceiling per call, in USDC base units (6 decimals).
// 300000 = $0.30. Top real price is $0.25.
const MAX_PER_CALL = 300000n;

// Where the live product list comes from, and how often it is re-read.
const CATALOG_URL = `${BASE_URL}/api/catalog`;
const CATALOG_TIMEOUT_MS = 8000;
const CATALOG_POLL_MS = 5 * 60 * 1000;

// ────────────────────────────────────────────────────────────────── the rails
// The ONLY addresses this server will ever sign a payment to.

const RAILS = {
  base: {
    label: "Base",
    network: "eip155:8453",
    payTo: "0x7df9C5eDBf039b1C645d7697F58EfD143f0986E1",
    suffix: "",
  },
  algorand: {
    label: "Algorand",
    network: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    payTo: "NMVLONWVRZUTUSHOVJLPQZTKII4RNCHA33R5HRRWHBCHGMU4BLIKIJAVA4",
    asset: "31566704", // USDC on Algorand mainnet
    suffix: "-algo",
  },
};

// ─────────────────────────────────────────────────────── the tool copy, by id
// ⚠️ COPY ONLY: no paths, no prices, no rails. Those come from the live
// catalogue, because they are the parts that change without this package
// being republished. What stays here is the wording an agent reads when it
// decides which tool to call, which is worth writing by hand.
//
// ⚠️ A PRODUCT WITH NO ENTRY HERE IS STILL OFFERED, with copy generated from
// the catalogue. Missing wording must never be able to hide a product that is
// on sale - that is the bug this version exists to end.

// The prediction products' prices, for the fallback only. The live catalogue
// is the price of record, and the payment guard refuses anything over $0.30
// whatever either of them says.
const FALLBACK_PRICES = {
  "single-market": "$0.01",
  "search": "$0.02",
  "closing-soon": "$0.02",
  "movers": "$0.03",
  "volume-spikes": "$0.03",
  "new-markets": "$0.03",
  "probability-history": "$0.03",
  "resolutions": "$0.03",
  "arbitrage": "$0.05",
  "analyze": "$0.25",
  "alpha-book": "$0.03",
};

const TOOL_COPY = {
  "single-market": {
    tool: "oyapicks_single_market",
    title: "Look up one prediction market",
    description:
      "Find the single highest-volume live prediction market matching a keyword. " +
      "Returns venue, implied probability, 24h USD volume, and end date. " +
      "Use this when you want the odds on one specific event.",
    params: { q: z.string().describe("Keyword, e.g. 'bitcoin' or 'fed rate'") },
  },
  "search": {
    tool: "oyapicks_search",
    title: "Search live prediction markets",
    description:
      "Keyword search across live prediction markets. Returns a list of matches with " +
      "current prices and venues. Use this when you want several candidates rather than " +
      "one answer; use oyapicks_single_market if you want just the top match.",
    params: { q: z.string().describe("Keyword to search for") },
  },
  "closing-soon": {
    tool: "oyapicks_closing_soon",
    title: "Markets resolving within 48 hours",
    description:
      "Prediction markets that resolve in the next 48 hours, with current prices. " +
      "Use this to find near-term events whose outcome is about to be settled.",
    params: {},
  },
  "movers": {
    tool: "oyapicks_movers",
    title: "Biggest probability swings",
    description:
      "Prediction markets whose implied probability moved most recently, with the size " +
      "and direction of the move. Use this to spot events where sentiment just shifted.",
    params: {},
  },
  "volume-spikes": {
    tool: "oyapicks_volume_spikes",
    title: "Biggest 24h volume spikes",
    description:
      "Prediction markets with the largest jumps in 24-hour trading volume. " +
      "Use this to find where money is suddenly flowing, which often precedes a price move.",
    params: {},
  },
  "new-markets": {
    tool: "oyapicks_new_markets",
    title: "Newly listed markets",
    description:
      "Prediction markets listed since the last snapshot, with opening prices. " +
      "Use this to catch new events before they are widely priced.",
    params: {},
  },
  "probability-history": {
    tool: "oyapicks_probability_history",
    title: "Probability over time for one market",
    description:
      "The implied-probability time series for a prediction market matched by keyword. " +
      "Use this to see how the odds on an event have moved, rather than just where they stand now.",
    params: { q: z.string().describe("Keyword identifying the market") },
  },
  "resolutions": {
    tool: "oyapicks_resolutions",
    title: "Recently resolved markets and outcomes",
    description:
      "Prediction markets that recently settled, with the winning outcome. " +
      "Use this to check what actually happened on an event, or to score earlier forecasts.",
    params: {},
  },
  "arbitrage": {
    tool: "oyapicks_arbitrage",
    title: "Same outcome, different price across venues",
    description:
      "Events where the same outcome is priced differently on Polymarket versus Alpha Arcade, " +
      "with both prices and the size of the gap. Use this to find cross-venue mispricings. " +
      "Note that gaps sometimes reflect differing resolution criteria rather than genuine mispricing.",
    params: {},
  },
  "analyze": {
    tool: "oyapicks_analyze",
    title: "Top 3 markets by 24h volume",
    description:
      "The three highest-volume prediction markets over the last 24 hours, with current prices. " +
      "The broadest single snapshot of where attention and money are concentrated right now.",
    params: {},
    costNote: ", the most expensive tool here",
  },
  "alpha-book": {
    tool: "oyapicks_alpha_book",
    title: "Alpha Arcade catalog, filtered",
    description:
      "Pays once for the complete live Alpha Arcade catalog (about 1,000 markets), then returns " +
      "only the top matches by 24h volume so your context stays small. Each market includes " +
      "outcome labels, per-outcome implied probabilities, 24h USD volume, end date, and the " +
      "per-outcome Algorand application IDs. Includes multi-choice markets.",
    params: {
      q: z.string().optional().describe("Optional keyword filter on the market question"),
      limit: z.number().int().min(1).max(200).optional().describe("How many markets to return (default 25, max 200)"),
    },
    localParams: ["q", "limit"],
  },
};

/** `perps-volatility-rank` -> `oyapicks_perps_volatility_rank` */
const toolNameFor = (id) => `oyapicks_${id.replace(/-/g, "_")}`;

/**
 * Turn one catalogue product into a route for the configured rail, or null if
 * it does not run on that rail.
 *
 * ⚠️ THE RAIL IS DERIVED, NOT DECLARED. A product with no Algorand route is
 * absent on the Algorand rail and a product with no Base route is absent on
 * Base, read straight off the catalogue. v0.2.0 carried a hand-maintained
 * `rails: ["algorand"]` on the one product that needed it, which is one more
 * thing to remember when a product ships.
 */
function routeFor(product, railName) {
  const url = railName === "algorand" ? product.algo : product.base;
  if (!url) return null;
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return null;
  }
  const copy = TOOL_COPY[product.id] ?? {};
  const params = copy.params ?? (
    product.param === "q"
      ? { q: z.string().describe("Keyword identifying the market") }
      : product.param === "ticker"
        ? { ticker: z.string().describe("Market ticker, for example KXBTCPERP") }
        : {}
  );
  return {
    tool: copy.tool ?? toolNameFor(product.id),
    path,
    price: product.price,
    title: copy.title ?? product.name,
    description: copy.description ?? product.description,
    params,
    costNote: copy.costNote,
    localParams: copy.localParams,
  };
}

/**
 * Read the live catalogue.
 *
 * ⚠️ IT VALIDATES THE SHAPE RATHER THAN TRUSTING IT. A truncated or redirected
 * response must not register a tool pointing at a path we never published; the
 * payment guard would still refuse to overpay, but an agent would be told a
 * tool exists when it does not.
 */
async function fetchCatalog() {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CATALOG_TIMEOUT_MS);
  try {
    const res = await fetch(CATALOG_URL, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const products = Array.isArray(body?.products) ? body.products : null;
    if (!products || products.length === 0) throw new Error("no products in the catalogue");
    for (const p of products) {
      if (typeof p?.id !== "string" || !/^\$\d+\.\d\d$/.test(String(p?.price))) {
        throw new Error(`a product is malformed: ${JSON.stringify(p).slice(0, 120)}`);
      }
      if (!p.base && !p.algo) throw new Error(`${p.id} has no route`);
    }
    return products;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ⚠️ THE FALLBACK, AND WHAT IT DELIBERATELY LEAVES OUT.
 *
 * The eleven prediction-market products, which are always on sale, built from
 * the tool copy above plus their conventional paths. It carries NOTHING that
 * depends on a switch, so a failed catalogue read can only offer fewer tools
 * than the truth, never more.
 */
const FALLBACK_PRODUCTS = Object.entries(TOOL_COPY).map(([id, copy]) => ({
  id,
  name: copy.title,
  description: copy.description,
  price: FALLBACK_PRICES[id],
  // ⚠️ null, BECAUSE THE COPY ABOVE ALREADY CARRIES THE SCHEMA. `routeFor`
  // prefers `copy.params`, and every fallback product has copy, so a guessed
  // `param` here would be dead and misleading - alpha-book's `q` is a LOCAL
  // filter, not a query the route takes.
  param: null,
  base: id === "alpha-book" ? null : `${BASE_URL}/api/x402/${id}`,
  algo: `${BASE_URL}/api/x402/${id}${id === "alpha-book" ? "" : "-algo"}`,
}));

// ─────────────────────────────────────────────────────────── payment plumbing

function guardHook(rail) {
  return async (ctx) => {
    const req = ctx.selectedRequirements;
    if (!req) return { abort: true, reason: "No payment requirement selected." };
    if (String(req.payTo).toLowerCase() !== rail.payTo.toLowerCase()) {
      console.error(`[oyapicks] BLOCKED: payment addressed to ${req.payTo}, not OyaPicks.`);
      return { abort: true, reason: "Recipient is not the OyaPicks address." };
    }
    if (BigInt(req.amount) > MAX_PER_CALL) {
      console.error(`[oyapicks] BLOCKED: amount ${req.amount} exceeds ceiling ${MAX_PER_CALL}.`);
      return { abort: true, reason: "Amount exceeds the per-call ceiling." };
    }
    if (req.network !== rail.network) {
      console.error(`[oyapicks] BLOCKED: network ${req.network} is not ${rail.label} mainnet.`);
      return { abort: true, reason: `Network is not ${rail.label} mainnet.` };
    }
    if (rail.asset && String(req.asset) !== rail.asset) {
      console.error(`[oyapicks] BLOCKED: asset ${req.asset} is not USDC (${rail.asset}).`);
      return { abort: true, reason: "Asset is not USDC." };
    }
    console.error(`[oyapicks] paying ${req.amount} to ${req.payTo} on ${rail.label}`);
  };
}

async function buildBaseFetch(privateKey) {
  const { x402Client } = await import("@x402/core/client");
  const { ExactEvmScheme } = await import("@x402/evm/exact/client");
  const { wrapFetchWithPayment } = await import("@x402/fetch");
  const { privateKeyToAccount } = await import("viem/accounts");

  const rail = RAILS.base;
  const client = x402Client.fromConfig({
    schemes: [{ network: rail.network, client: new ExactEvmScheme(privateKeyToAccount(privateKey)) }],
    policies: [(version, reqs) => reqs.filter((r) => BigInt(r.amount) <= MAX_PER_CALL)],
  });
  client.onBeforePaymentCreation(guardHook(rail));
  return { fetch: wrapFetchWithPayment(fetch, client), reason: () => "" };
}

async function buildAlgorandFetch(b64Key) {
  const { x402Client, x402HTTPClient, wrapFetchWithPayment } = await import("@x402-avm/fetch");
  const { ExactAvmScheme } = await import("@x402-avm/avm/exact/client");
  const { toClientAvmSigner, NETWORK_TO_ALGOD } = await import("@x402-avm/avm");

  const rail = RAILS.algorand;
  // Pass the node explicitly. @x402-avm/avm 2.6.1 builds against TestNet when
  // no algodUrl is given, and MainNet payments then fail verification with
  // "Transaction genesis hash does not match expected network".
  const algodUrl = process.env.OYAPICKS_ALGOD_URL || NETWORK_TO_ALGOD[rail.network];

  const client = x402Client.fromConfig({
    schemes: [{ network: rail.network, client: new ExactAvmScheme(toClientAvmSigner(b64Key), { algodUrl }) }],
    policies: [
      (version, reqs) =>
        reqs.filter(
          (r) => BigInt(r.amount) <= MAX_PER_CALL && r.network === rail.network && String(r.asset) === rail.asset,
        ),
    ],
  });
  client.onBeforePaymentCreation(guardHook(rail));

  // On a rejected payment the facilitator's reason is in the PAYMENT-REQUIRED
  // header of the second 402, not the body.
  const reason = (res, bodyText) => {
    try {
      let body;
      try { body = bodyText ? JSON.parse(bodyText) : undefined; } catch { body = undefined; }
      const pr = new x402HTTPClient(new x402Client()).getPaymentRequiredResponse((n) => res.headers.get(n), body);
      return pr?.error ? ` Facilitator said: ${pr.error}.` : "";
    } catch {
      return "";
    }
  };
  return { fetch: wrapFetchWithPayment(fetch, client), reason };
}

async function algorandKeyFromEnv() {
  if (process.env.OYAPICKS_ALGO_PRIVATE_KEY) return process.env.OYAPICKS_ALGO_PRIVATE_KEY.trim();
  const words = (process.env.OYAPICKS_ALGO_MNEMONIC || "").trim();
  if (!words) return "";
  const algosdk = (await import("algosdk")).default;
  try {
    return Buffer.from(algosdk.mnemonicToSecretKey(words).sk).toString("base64");
  } catch (e) {
    console.error(`[oyapicks] OYAPICKS_ALGO_MNEMONIC is not a valid 25-word Algorand mnemonic (${e.message}).`);
    process.exit(1);
  }
}

// ──────────────────────────────────────────────────────────────────── startup

const EVM_KEY = process.env.OYAPICKS_WALLET_PRIVATE_KEY || "";
const ALGO_KEY = await algorandKeyFromEnv();

let railName = (process.env.OYAPICKS_RAIL || "").toLowerCase();
if (!railName) {
  if (ALGO_KEY && EVM_KEY) {
    console.error("[oyapicks] Both an Algorand and a Base key are set. Add OYAPICKS_RAIL=algorand or OYAPICKS_RAIL=base.");
    process.exit(1);
  }
  railName = ALGO_KEY ? "algorand" : EVM_KEY ? "base" : "";
}
if (!railName) {
  console.error("[oyapicks] No wallet configured. Add ONE of these to the env block of your MCP client config:");
  console.error("[oyapicks]   OYAPICKS_ALGO_MNEMONIC      25-word Algorand mnemonic (pay on Algorand)");
  console.error("[oyapicks]   OYAPICKS_WALLET_PRIVATE_KEY 0x-prefixed Base private key (pay on Base)");
  process.exit(1);
}
if (!RAILS[railName]) {
  console.error(`[oyapicks] OYAPICKS_RAIL must be "algorand" or "base", not "${railName}".`);
  process.exit(1);
}
const rail = RAILS[railName];

let paying;
if (railName === "base") {
  if (!EVM_KEY.startsWith("0x") || EVM_KEY.length !== 66) {
    console.error("[oyapicks] OYAPICKS_WALLET_PRIVATE_KEY does not look like a private key.");
    console.error("[oyapicks] Expected 0x followed by 64 hex characters.");
    process.exit(1);
  }
  paying = await buildBaseFetch(EVM_KEY);
} else {
  if (!ALGO_KEY) {
    console.error("[oyapicks] OYAPICKS_RAIL=algorand but no OYAPICKS_ALGO_MNEMONIC is set.");
    process.exit(1);
  }
  paying = await buildAlgorandFetch(ALGO_KEY);
}

const unfundedHelp =
  railName === "algorand"
    ? "The most likely cause is that the wallet has no USDC on Algorand, has not opted in to USDC " +
      "(ASA 31566704), or is below the ALGO minimum balance. The network fee itself is covered by the facilitator."
    : "The most likely cause is that the wallet has no USDC on Base. " +
      "Check the balance of the address derived from OYAPICKS_WALLET_PRIVATE_KEY " +
      "and top it up with USDC on the Base network. No ETH is needed; gas is sponsored.";

const server = new McpServer({ name: "oyapicks", version: VERSION });

// ⚠️ THE LIVE PRODUCT LIST, READ BEFORE ANY TOOL IS REGISTERED.
let products;
try {
  products = await fetchCatalog();
  console.error(`[oyapicks] read ${products.length} products from ${CATALOG_URL}`);
} catch (e) {
  products = FALLBACK_PRODUCTS;
  console.error(`[oyapicks] could not read ${CATALOG_URL} (${e.message}).`);
  console.error(`[oyapicks] falling back to the ${products.length} always-on prediction-market products.`);
  console.error(`[oyapicks] any product OyaPicks has switched on recently will be missing until this succeeds.`);
}

/** Registered tool handles, by tool name, so the poller can remove one. */
const live = new Map();

function registerRoute(route) {
  const local = new Set(route.localParams || []);

  const handle = server.registerTool(
    route.tool,
    {
      title: route.title,
      description: `${route.description} Costs ${route.price} in USDC on ${rail.label}${route.costNote || ""}.`,
      inputSchema: route.params,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      const url = new URL(BASE_URL + path);
      for (const [k, v] of Object.entries(args ?? {})) {
        if (!local.has(k) && v !== undefined && v !== null) url.searchParams.set(k, String(v));
      }

      try {
        const res = await paying.fetch(url.toString(), { method: "GET" });

        if (!res.ok) {
          const body = await res.text();
          if (res.status === 402) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: `Payment for ${route.tool} (${route.price}) did not go through.${paying.reason(res, body)} ${unfundedHelp}`,
                },
              ],
            };
          }
          return {
            isError: true,
            content: [{ type: "text", text: `${route.tool} failed: HTTP ${res.status}.${railName === "algorand" ? " No payment was settled." : ""} ${body.slice(0, 400)}` }],
          };
        }

        let data = await res.json();

        // alpha-book: the full catalog is ~1,000 markets. Filter locally so an
        // agent's context isn't flooded; the call itself is priced once.
        if (route.tool === "oyapicks_alpha_book" && Array.isArray(data?.markets)) {
          const q = (args?.q || "").toLowerCase().trim();
          const limit = args?.limit ?? 25;
          const matched = q ? data.markets.filter((m) => String(m.question || "").toLowerCase().includes(q)) : data.markets;
          data = { ...data, totalInCatalog: data.markets.length, matched: matched.length, returned: Math.min(limit, matched.length), markets: matched.slice(0, limit) };
        }

        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
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
    },
  );
  live.set(route.tool, handle);
}

function routesFrom(list) {
  return list.map((p) => routeFor(p, railName)).filter(Boolean);
}

for (const route of routesFrom(products)) registerRoute(route);

/**
 * ⚠️ RE-READ EVERY FIVE MINUTES, so a product switched on reaches a running
 * client without the user restarting anything.
 *
 * `registerTool` / `handle.remove()` make the MCP SDK send
 * `notifications/tools/list_changed`, which is how the client finds out.
 *
 * ⚠️ A FAILED POLL CHANGES NOTHING. It keeps the tools it has and logs. The
 * one thing it must never do is drop every tool because a request timed out.
 */
function startPolling() {
  const timer = setInterval(async () => {
    let next;
    try {
      next = await fetchCatalog();
    } catch (e) {
      console.error(`[oyapicks] catalogue re-read failed (${e.message}); keeping the current ${live.size} tools.`);
      return;
    }
    const wanted = new Map(routesFrom(next).map((r) => [r.tool, r]));
    let added = 0, removed = 0;
    for (const [name, handle] of [...live]) {
      if (wanted.has(name)) continue;
      try {
        handle.remove();
        live.delete(name);
        removed++;
      } catch (e) {
        console.error(`[oyapicks] could not withdraw ${name} (${e.message}); it stays listed.`);
      }
    }
    for (const [name, route] of wanted) {
      if (live.has(name)) continue;
      try {
        registerRoute(route);
        added++;
      } catch (e) {
        console.error(`[oyapicks] could not register ${name} (${e.message}).`);
      }
    }
    if (added || removed) {
      console.error(`[oyapicks] catalogue changed: +${added} -${removed}, now ${live.size} tools.`);
    }
  }, CATALOG_POLL_MS);
  // Don't hold the process open on this alone.
  timer.unref?.();
}

await server.connect(new StdioServerTransport());
startPolling();
console.error(`[oyapicks] MCP server v${VERSION} ready. ${live.size} tools. ${rail.label} mainnet.`);
console.error(`[oyapicks] product list re-read from ${CATALOG_URL} every ${CATALOG_POLL_MS / 60000} minutes.`);
