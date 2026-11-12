/**
 * A simulated market: Radix Gateway, CoinGecko, MEXC, KuCoin, Astrolescent and GitHub, answering through an
 * injected fetch. Each test sets up a scenario and then breaks it in a specific way.
 */
import { type TokensFile, XRD } from "../src/config";

export const addr = (kind: "resource" | "component" | "pool", tag: string) =>
  `${kind}_rdx1${(tag.toLowerCase().replace(/[^0-9a-z]/g, "") + "q".repeat(54)).slice(0, 54)}`;

export const A = {
  hUSDC: addr("resource", "husdc"),
  FOO: addr("resource", "foo"),
  BAR: addr("resource", "bar"),
  hETH: addr("resource", "heth"),
  hBNB: addr("resource", "hbnb"),
  LSU: addr("resource", "lsu"),
};
export const C = {
  husdcPlaza: addr("component", "husdcplaza"),
  fooOci: addr("component", "foooci"),
  fooOci2: addr("component", "foooci2"),
  barOci: addr("component", "baroci"),
  hethOci: addr("component", "hethoci"),
  hbnbOci: addr("component", "hbnboci"),
};

export const TOKENS: TokensFile = {
  usd_anchors: ["hUSDC"],
  tokens: {
    XRD: { resource_address: XRD, coingecko_id: "radix", pools: [] },
    hUSDC: {
      resource_address: A.hUSDC,
      coingecko_id: "usd-coin",
      pools: [{ dex: "defiplaza", component: C.husdcPlaza, base: "hUSDC", quote: "XRD" }],
    },
    FOO: {
      resource_address: A.FOO,
      pools: [
        { dex: "ociswap", component: C.fooOci, base: "XRD", quote: "FOO" },
        { dex: "ociswap", component: C.fooOci2, base: "XRD", quote: "FOO" },
      ],
    },
    BAR: { resource_address: A.BAR, pools: [{ dex: "ociswap", component: C.barOci, base: "BAR", quote: "XRD" }] },
    hETH: {
      resource_address: A.hETH,
      coingecko_id: "ethereum",
      pools: [{ dex: "ociswap", component: C.hethOci, base: "XRD", quote: "hETH" }],
    },
    hBNB: {
      resource_address: A.hBNB,
      coingecko_id: "binancecoin",
      coingecko_only: true,
      pools: [{ dex: "ociswap", component: C.hbnbOci, base: "XRD", quote: "hBNB" }],
    },
  },
};

export interface OciPool {
  /** units of base per unit of quote (what price_sqrt^2 returns) */
  raw: number;
  /** XRD held by the pool */
  xrd: number;
}
export interface PlazaPool {
  /** quote per base */
  p0: number;
  spread: number;
  xrd: number;
}

export interface Market {
  cg: Record<string, number> | "down";
  /** XRD/USD mid price on MEXC (order book +-0.5% around it), or down. */
  mexc: number | "down";
  /** KuCoin: like MEXC; rate limited (429) by default, as seen from Cloudflare. */
  kucoin: number | "down";
  gateway: "up" | "down";
  oci: Record<string, OciPool | "fail">;
  plaza: Record<string, PlazaPool>;
  lsuRedemption: number;
  /** Astrolescent entries: XRD per token, updated-at (unix s), and a deliberately bogus USD price. */
  astro: Record<string, { xrd: number; updatedAt?: number }> | "down";
  /** HTTP status the Gateway answers with when "down". */
  gatewayStatus: number;
  /** unix seconds the simulated sources stamp their quotes with */
  now: number;
  calls: string[];
  issues: Array<{ method: string; path: string; body: any }>;
}

/** A healthy market: XRD = $0.0003, hUSDC on peg, FOO = $0.03, BAR = $0.000006, hETH = $3000, hBNB = $600. */
export function healthyMarket(): Market {
  const xrdUsd = 0.0003;
  return {
    cg: { radix: xrdUsd, "usd-coin": 1, ethereum: 3000, binancecoin: 600 },
    mexc: xrdUsd * 1.001,
    kucoin: "down",
    gateway: "up",
    oci: {
      [C.fooOci]: { raw: 100, xrd: 5_000_000 }, // 100 XRD per FOO, $3000 depth
      [C.fooOci2]: { raw: 101, xrd: 2_000_000 },
      [C.barOci]: { raw: 50, xrd: 2_000_000 }, // base BAR: 50 BAR per XRD -> 0.02 XRD per BAR
      [C.hethOci]: { raw: 3000 / xrdUsd, xrd: 50_000_000 },
      [C.hbnbOci]: { raw: 600 / xrdUsd, xrd: 1_000_000 },
    },
    plaza: { [C.husdcPlaza]: { p0: 1 / xrdUsd, spread: 0.01, xrd: 4_000_000 } },
    lsuRedemption: 1.1,
    astro: {
      [A.FOO]: { xrd: 99 },
      [A.BAR]: { xrd: 0.02 },
      [A.hETH]: { xrd: 3000 / xrdUsd },
      [A.hUSDC]: { xrd: 0.5 / xrdUsd },
    },
    gatewayStatus: 502,
    now: 1_800_000_000,
    calls: [],
    issues: [],
  };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const dec = (v: number) => ({ kind: "Decimal", value: String(v) });

export function marketFetch(m: Market): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    m.calls.push(`${url.host}${url.pathname}`);

    if (url.host === "api.coingecko.com") {
      if (m.cg === "down") return new Response("rate limited", { status: 429 });
      const ids = (url.searchParams.get("ids") ?? "").split(",");
      const now = m.now;
      const cg = m.cg;
      return ok(Object.fromEntries(ids.filter((i) => i in cg).map((i) => [i, { usd: cg[i], last_updated_at: now }])));
    }
    if (url.host === "api.mexc.com") {
      if (m.mexc === "down") return new Response("down", { status: 503 });
      return ok({ symbol: "XRDUSDT", bidPrice: String(m.mexc * 0.995), askPrice: String(m.mexc * 1.005) });
    }
    if (url.host === "api.kucoin.com") {
      if (m.kucoin === "down") return new Response(JSON.stringify({ code: "429000" }), { status: 429 });
      return ok({ code: "200000", data: { time: m.now * 1000, bestBid: String(m.kucoin * 0.995), bestAsk: String(m.kucoin * 1.005) } });
    }
    if (url.host === "api.astrolescent.com") {
      if (m.astro === "down") return new Response("down", { status: 503 });
      // Real responses carry ~880 entries with free-text descriptions; include awkward ones.
      const entries: Record<string, unknown> = {
        [addr("resource", "decoy")]: { description: 'has } and { and \\" and "quotes"', tokenPriceXRD: 1, tokenPriceUSD: 1, updatedAt: new Date(m.now * 1000).toISOString() },
      };
      for (const [a, e] of Object.entries(m.astro)) {
        entries[a] = {
          address: a,
          description: "Token {with} braces",
          tokenPriceXRD: e.xrd,
          tokenPriceUSD: e.xrd * 0.0006, // Astrolescent's own USD: wrong on purpose, must be ignored
          updatedAt: new Date((e.updatedAt ?? m.now - 60) * 1000).toISOString(),
        };
      }
      return new Response(JSON.stringify(entries, null, 1), { status: 200 });
    }
    if (url.host === "api.github.com") {
      m.issues.push({ method: init?.method ?? "GET", path: url.pathname, body });
      return ok({ number: 7 });
    }
    if (url.host !== "gateway.test") return new Response("unexpected host", { status: 500 });
    if (m.gateway === "down") return new Response("unavailable", { status: m.gatewayStatus });

    if (url.pathname === "/status/gateway-status") return ok({ ledger_state: { epoch: 1000 } });
    if (url.pathname === "/transaction/preview") {
      const outs: any[] = [];
      for (const [, comp, method, args] of String(body.manifest).matchAll(/Address\("([^"]+)"\)\n"([^"]+)"\n?(.*?);/gs)) {
        const plaza = m.plaza[comp];
        if (plaza) {
          if (method === "get_state") {
            outs.push({ programmatic_json: { kind: "Tuple", fields: [{ ...dec(plaza.p0), field_name: "p0" }] } });
            continue;
          }
          const amount = Number(/Decimal\("([^"]+)"\)/.exec(args)![1]);
          const isQuote = args.includes("true");
          const gross = isQuote ? amount / (plaza.p0 * (1 + plaza.spread)) : amount * plaza.p0 * (1 - plaza.spread);
          const fee = gross * 0.01;
          outs.push({ programmatic_json: { kind: "Tuple", fields: [dec(gross - fee), dec(0), dec(fee), {}, {}] } });
          continue;
        }
        const oci = m.oci[comp];
        if (!oci || oci === "fail") return ok({ receipt: { status: "Failed", error_message: "boom" } });
        outs.push({ programmatic_json: { kind: "PreciseDecimal", value: String(Math.sqrt(oci.raw)) } });
      }
      return ok({ receipt: { status: "Succeeded", output: outs } });
    }
    if (url.pathname === "/state/entity/details") {
      if (body.aggregation_level === "Global") {
        return ok({
          items: body.addresses.map((a: string) => {
            const p = m.oci[a] ?? m.plaza[a];
            const xrd = p && p !== "fail" ? p.xrd : 0;
            return { address: a, details: { state: {} }, fungible_resources: { items: [{ resource_address: XRD, amount: String(xrd) }] } };
          }),
        });
      }
      const validator = addr("component", "validator").replace("component_", "validator_");
      if (body.addresses[0] === validator) {
        return ok({
          items: [
            {
              address: validator,
              details: { state: { stake_unit_resource_address: A.LSU, stake_xrd_vault: { entity_address: "internal_vault_stake" } } },
              fungible_resources: {
                items: [{ resource_address: XRD, vaults: { items: [{ vault_address: "internal_vault_stake", amount: String(1000 * m.lsuRedemption) }] } }],
              },
            },
          ],
        });
      }
      return ok({
        items: body.addresses.map((a: string) => ({
          address: a,
          metadata: { items: a === A.LSU ? [{ key: "validator", value: { typed: { type: "GlobalAddress", value: validator } } }] : [] },
          details: { total_supply: "1000" },
        })),
      });
    }
    return new Response("not found", { status: 404 });
  };
}
