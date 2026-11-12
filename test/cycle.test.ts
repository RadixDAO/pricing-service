/**
 * Failure scenarios, end to end: simulated market -> price cycle -> D1 -> HTTP API.
 * Each test starts from a healthy market and breaks one thing.
 */
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { clearStateCache, handle } from "../src/api";
import { XRD } from "../src/config";
import { runCycle } from "../src/cycle";
import { settings } from "../src/settings";
import { loadState } from "../src/store";
import { A, C, healthyMarket, type Market, marketFetch, TOKENS } from "./market";

const db = env.DB;
const T0 = 1_800_000_000;
const S = settings({ DB: db, GATEWAY_URL: "https://gateway.test", API_KEY: "test-key-0123456789abcdef", GITHUB_ALERT_TOKEN: "ghp_test" });

let m: Market;
beforeEach(async () => {
  m = healthyMarket();
  await db.batch(["kv", "history", "lsu_cache", "alerts"].map((t) => db.prepare(`DELETE FROM ${t}`)));
  clearStateCache();
});

const cycle = (now: number) => {
  m.now = now;
  return runCycle(db, TOKENS, S, now, marketFetch(m));
};

async function api(path: string, body: unknown, now: number, headers: Record<string, string> = {}) {
  clearStateCache();
  const req = new Request(`https://price.test${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const r = await handle(req, db, TOKENS, S, now * 1000, marketFetch(m));
  return { status: r.status, body: (await r.json()) as any };
}

async function priced(now: number, tokens = Object.values(TOKENS.tokens).map((t) => t.resource_address)) {
  const r = await api("/price/tokens", { currency: "USD", tokens }, now);
  return Object.fromEntries(r.body.tokens.map((t: any) => [t.resource_address, t.usd_price])) as Record<string, number>;
}

describe("healthy market", () => {
  it("publishes XRD from consensus and prices every token", async () => {
    const { state, log } = await cycle(T0);
    expect(state.status, log.join("\n")).toBe("ok");
    expect(state.xrd?.sources).toEqual(["coingecko", "mexc", "hUSDC@defiplaza"]);
    const p = await priced(T0);
    expect(p[XRD]).toBeCloseTo(0.0003, 6);
    expect(p[A.hUSDC]).toBeCloseTo(1, 2);
    expect(p[A.FOO]).toBeCloseTo(100.5 * 0.0003, 4); // mean of the two FOO pools
    expect(p[A.BAR]).toBeCloseTo(0.02 * 0.0003, 9);
    expect(p[A.hETH]).toBeCloseTo(3000, 0);
    expect(p[A.hBNB]).toBeCloseTo(600, 0);
  });

  it("uses at most 5 Gateway calls per cycle, independent of traffic", async () => {
    await cycle(T0);
    // 4 here; 5 on mainnet, where DefiPlaza pairs reference native pools (one more holdings call).
    expect(m.calls.filter((c) => c.startsWith("gateway.test")).length).toBeLessThanOrEqual(5);
  });
});

describe("the old oracle's failure: a stablecoin loses its peg", () => {
  it("keeps XRD correct, shows the stablecoin at its real price and raises an alert", async () => {
    // hUSDC now buys 10x less XRD: it is worth $0.10.
    m.plaza[C.husdcPlaza].p0 = 0.1 / 0.0003;
    const { state } = await cycle(T0);
    const p = await priced(T0);
    expect(p[XRD]).toBeCloseTo(0.0003, 6); // not 10x too high
    expect(p[A.FOO]).toBeCloseTo(100.5 * 0.0003, 4);
    expect(p[A.hUSDC]).toBeCloseTo(0.1, 3); // never assumed to be $1
    expect(state.issues.join()).toMatch(/hUSDC trades at \$0\.1000/);
  });

  it("opens one GitHub issue after the condition persists, and closes it after recovery", async () => {
    m.plaza[C.husdcPlaza].p0 = 0.1 / 0.0003;
    for (let i = 0; i < S.alertOpenAfter + 2; i++) await cycle(T0 + 60 * i);
    const opened = m.issues.filter((x) => x.method === "POST" && x.path.endsWith("/issues"));
    expect(opened).toHaveLength(1);
    expect(opened[0].path).toBe("/repos/RadixDAO/pricing-service/issues");
    expect(opened[0].body.title).toMatch(/hUSDC/);

    m.plaza[C.husdcPlaza].p0 = 1 / 0.0003;
    for (let i = 0; i < S.alertCloseAfter; i++) await cycle(T0 + 3600 + 60 * i);
    expect(m.issues.some((x) => x.method === "PATCH" && x.path.endsWith("/issues/7"))).toBe(true);
  });
});

describe("drained pools", () => {
  it("stops using a drained stablecoin pool and alerts, XRD continues from off-chain", async () => {
    m.plaza[C.husdcPlaza].xrd = 1000; // $0.60 left
    const { state } = await cycle(T0);
    expect(state.xrd?.sources).toEqual(["coingecko", "mexc"]);
    expect(state.issues.join()).toMatch(/hUSDC pool on defiplaza is not usable/);
    expect((await priced(T0))[XRD]).toBeCloseTo(0.0003, 6);
  });

  it("drops a drained token pool whose price runs away", async () => {
    m.oci[C.fooOci2] = { raw: 400, xrd: 200_000 }; // $120 deep, 4x the price
    await cycle(T0);
    expect((await priced(T0))[A.FOO]).toBeCloseTo(100 * 0.0003, 5);
  });

  it("withdraws a token whose only pool is too shallow", async () => {
    m.oci[C.barOci] = { raw: 50, xrd: 10_000 }; // $6
    await cycle(T0);
    expect((await priced(T0))[A.BAR]).toBeUndefined();
  });

  it("withdraws a bridged token when its pool and CoinGecko disagree", async () => {
    m.oci[C.hethOci] = { raw: 300 / 0.0003, xrd: 50_000_000 }; // bridge broken? pool says $300
    await cycle(T0);
    expect((await priced(T0))[A.hETH]).toBeUndefined();
  });

  it("uses CoinGecko for a coingecko_only token when its pool disagrees", async () => {
    m.oci[C.hbnbOci] = { raw: 250 / 0.0003, xrd: 1_000_000 };
    await cycle(T0);
    expect((await priced(T0))[A.hBNB]).toBeCloseTo(600, 0);
  });
});

describe("source outages", () => {
  it("serves the last good price for up to 15 minutes, then nothing", async () => {
    await cycle(T0);
    m.cg = "down";
    m.mexc = "down";
    const { state } = await cycle(T0 + 60);
    expect(state.status).toBe("stale");
    expect((await priced(T0 + 60))[XRD]).toBeCloseTo(0.0003, 6);
    expect((await priced(T0 + 15 * 60))[XRD]).toBeCloseTo(0.0003, 6);
    expect((await priced(T0 + 15 * 60 + 1))[XRD]).toBeUndefined();
    const h = await handle(new Request("https://price.test/healthz"), db, TOKENS, S, (T0 + 16 * 60) * 1000);
    expect(h.status).toBe(503);
    expect(((await h.json()) as any).Everything).toBe("Stale");
  });

  it("keeps XRD alive through a Gateway outage; without a backup, pool prices age out", async () => {
    await cycle(T0);
    m.gateway = "down";
    m.astro = "down";
    const { state } = await cycle(T0 + 600);
    expect(state.xrd?.at).toBe(T0 + 600);
    const p = await priced(T0 + 960);
    expect(p[XRD]).toBeCloseTo(0.0003, 6);
    expect(p[A.FOO]).toBeUndefined(); // last pool price was at T0, now 16 minutes old
    expect(p[A.hETH]).toBeUndefined(); // not CoinGecko alone: it is not coingecko_only
  });

  it("continues on one off-chain source near the last validated price", async () => {
    await cycle(T0);
    m.mexc = "down";
    m.cg = { ...(m.cg as Record<string, number>), radix: 0.00031 };
    m.plaza[C.husdcPlaza].xrd = 1000; // and the on-chain witness is unusable
    const { state } = await cycle(T0 + 60);
    expect(state.xrd?.mode).toBe("single_source");
    expect(state.xrd?.value).toBeCloseTo(0.00031, 8);
  });

  it("refuses to start from a single source with no history", async () => {
    m.mexc = "down";
    m.plaza[C.husdcPlaza].xrd = 1000;
    const { state } = await cycle(T0);
    expect(state.status).toBe("stale");
    expect((await priced(T0))[XRD]).toBeUndefined();
  });
});

describe("sudden XRD moves", () => {
  it("holds a 50% jump for a minute and publishes it once confirmed", async () => {
    await cycle(T0);
    const up = (v: number) => {
      m.cg = { ...(m.cg as Record<string, number>), radix: v };
      m.mexc = v;
      m.plaza[C.husdcPlaza].p0 = 1 / v;
    };
    up(0.00045);
    const s1 = await cycle(T0 + 60);
    expect(s1.state.xrd?.value).toBeCloseTo(0.0003, 6);
    expect(s1.state.issues.join()).toMatch(/waiting for confirmation/);
    const s2 = await cycle(T0 + 120);
    expect(s2.state.xrd?.value).toBeCloseTo(0.00045, 7);
  });
});

describe("API", () => {
  it("validates input like the old service", async () => {
    await cycle(T0);
    expect((await api("/price/tokens", { currency: "EUR", tokens: [] }, T0)).status).toBe(400);
    expect((await api("/price/tokens", { tokens: [] }, T0)).status).toBe(422);
    expect((await api("/price/tokens", { currency: "usd", tokens: "x" }, T0)).status).toBe(422);
    expect((await api("/nope", { a: 1 }, T0)).status).toBe(404);
  });

  it("rejects oversized bodies", async () => {
    const r = await handle(
      new Request("https://price.test/price/tokens", { method: "POST", body: "x".repeat(300 * 1024) }),
      db,
      TOKENS,
      S,
      T0 * 1000,
    );
    expect(r.status).toBe(413);
  });

  it("prices LSUs from the validator's stake vault, cached", async () => {
    await cycle(T0);
    const r = await api("/price/tokens", { currency: "USD", tokens: [], lsus: [A.LSU, A.FOO] }, T0);
    expect(r.body.lsus).toEqual([{ resource_address: A.LSU, xrd_redemption_value: 1.1, usd_price: expect.closeTo(1.1 * 0.0003, 6) }]);
    const before = m.calls.length;
    await api("/price/tokens", { currency: "USD", tokens: [], lsus: [A.LSU, A.FOO] }, T0 + 30);
    expect(m.calls.length).toBe(before); // both the hit and the miss came from cache
  });

  it("serves history behind an API key", async () => {
    await cycle(T0);
    const key = { "x-api-key": "test-key-0123456789abcdef" };
    expect((await api("/price/historicalPrice", { tokens: [XRD], timestamp: T0 }, T0)).status).toBe(401);
    expect((await api("/price/historicalPrice", { tokens: [XRD], timestamp: T0 }, T0, { "x-api-key": "wrong" })).status).toBe(401);
    const r = await api("/price/historicalPrice", { tokens: [XRD], timestamp: String(T0 + 100) }, T0, key);
    expect(r.status).toBe(200);
    expect(r.body.prices[XRD].usd_price).toBeCloseTo(0.0003, 6);
    expect((await api("/price/historicalPrice", { tokens: [XRD], timestamp: T0 - 10 * 86400 }, T0, key)).status).toBe(424);
  });

  it("treats the example API key as unset", () => {
    expect(settings({ DB: db, API_KEY: "change-me" }).apiKey).toBeUndefined();
  });

  it("lists configured tokens with fresh prices", async () => {
    await cycle(T0);
    const r = await api("/tokens", {}, T0);
    expect(r.body.map((t: any) => t.symbol)).toEqual(["XRD", "hUSDC", "FOO", "BAR", "hETH", "hBNB"]);
  });

  it("state survives in D1 between cycles", async () => {
    await cycle(T0);
    expect((await loadState(db)).prices[XRD].usd).toBeCloseTo(0.0003, 6);
  });
});

describe("Astrolescent", () => {
  /** A healthy cycle, then the Gateway goes away. */
  async function outage() {
    await cycle(T0 - 600);
    m.gateway = "down";
  }

  it("prices tokens from Astrolescent's XRD prices while the Gateway is down, using our XRD/USD", async () => {
    await outage();
    const { state } = await cycle(T0);
    const p = await priced(T0);
    expect(p[XRD]).toBeCloseTo(0.0003, 6);
    expect(p[A.FOO]).toBeCloseTo(99 * p[XRD], 9); // its own USD price (2x off) is ignored
    expect(p[A.BAR]).toBeCloseTo(0.02 * p[XRD], 12);
    expect(state.prices[A.FOO].src).toBe("ledger_only:astrolescent");
    expect(state.prices[A.hUSDC].at).toBe(T0 - 600); // stablecoins only from our own reads
  });

  it("does not back up a token whose pools were rejected at the last good read", async () => {
    m.oci[C.barOci] = { raw: 50, xrd: 10_000 }; // $6 deep
    await outage();
    await cycle(T0);
    expect((await priced(T0))[A.BAR]).toBeUndefined();
  });

  it("still cross-checks Astrolescent-based prices against CoinGecko", async () => {
    await outage();
    (m.astro as any)[A.hETH] = { xrd: 1000 / 0.0003 }; // says $1000, CoinGecko says $3000
    const { state } = await cycle(T0);
    expect(state.prices[A.hETH].at).toBe(T0 - 600); // not updated from the bad value
  });

  it("ignores stale Astrolescent entries", async () => {
    await outage();
    (m.astro as any)[A.FOO] = { xrd: 99, updatedAt: T0 - 3600 };
    const { state } = await cycle(T0);
    expect(state.prices[A.FOO].at).toBe(T0 - 600);
  });

  it("is not used while the Gateway is up (our pools win)", async () => {
    const { state } = await cycle(T0);
    expect(state.prices[A.FOO].src).toBe("ledger_only");
    expect((await priced(T0))[A.FOO]).toBeCloseTo(100.5 * 0.0003, 4);
  });

  it("an Astrolescent outage changes nothing", async () => {
    m.astro = "down";
    const { state } = await cycle(T0);
    expect(state.status).toBe("ok");
  });
});

describe("Gateway rate limiting", () => {
  it("does not retry harder when the Gateway rejects calls", async () => {
    await cycle(T0);
    m.gateway = "down";
    m.gatewayStatus = 429;
    m.calls = [];
    await cycle(T0 + 60);
    expect(m.calls.filter((c) => c.startsWith("gateway.test")).length).toBeLessThanOrEqual(1);
  });
});

describe("off-chain XRD sources", () => {
  it("counts every source that answers: CoinGecko, MEXC and KuCoin", async () => {
    m.kucoin = 0.0003;
    const { state } = await cycle(T0);
    expect(state.xrd?.sources).toEqual(["coingecko", "mexc", "kucoin", "hUSDC@defiplaza"]);
  });

  it("outvotes an exchange quoting far off (Gate.io was 31% off)", async () => {
    m.kucoin = 0.0003;
    m.mexc = 0.000393;
    const { state } = await cycle(T0);
    expect(state.xrd?.value).toBeCloseTo(0.0003, 6);
    expect(state.xrd?.sources).not.toContain("mexc");
  });

  it("ignores an order book with a wide spread", async () => {
    await cycle(T0);
    const f = marketFetch(m);
    const wide: typeof fetch = async (input, init) => {
      const u = String(input instanceof Request ? input.url : input);
      if (u.includes("api.mexc.com")) return new Response(JSON.stringify({ bidPrice: "0.0002", askPrice: "0.0004" }));
      return f(input, init);
    };
    m.now = T0 + 60;
    const { state } = await runCycle(db, TOKENS, S, T0 + 60, wide);
    expect(state.xrd?.sources).not.toContain("mexc");
  });

  it("works with CoinGecko alone being rate limited", async () => {
    m.cg = "down";
    m.kucoin = 0.0003;
    const { state } = await cycle(T0);
    expect(state.xrd?.sources).toEqual(["mexc", "kucoin", "hUSDC@defiplaza"]);
  });
});
