import { describe, expect, it } from "vitest";
import { blendCoingecko, combinePools, jumpGate, pegCheck, type XrdCandidate, xrdConsensus } from "../src/consensus";

const S = { singleSourceMaxAgeSecs: 3600, singleSourceMaxMove: 0.1 };
const cg = (v: number): XrdCandidate => ({ source: "coingecko", usdPerXrd: v, offchain: true, tol: 0.03 });
const cp = (v: number): XrdCandidate => ({ source: "mexc", usdPerXrd: v, offchain: true, tol: 0.03 });
const chain = (v: number, name = "hUSDC@defiplaza"): XrdCandidate => ({ source: name, usdPerXrd: v, offchain: false, tol: 0.06 });
const NOW = 1_800_000_000;

describe("XRD/USD consensus", () => {
  it("uses all sources when they agree, including a thin pool a few percent off", () => {
    const r = xrdConsensus([cg(0.0003), cp(0.0003003), chain(0.000314)], undefined, NOW, S);
    expect(r.ok && r.agreeing).toEqual(["coingecko", "mexc", "hUSDC@defiplaza"]);
    expect(r.ok && r.value).toBeCloseTo(0.0003003, 10);
  });

  it("ignores a stablecoin that lost 90% of its peg (the old oracle's failure)", () => {
    // The depegged stablecoin buys 10x less XRD, so taking it as $1 implies XRD 10x too high.
    const r = xrdConsensus([cg(0.0003), cp(0.0003), chain(0.003)], undefined, NOW, S);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value).toBeCloseTo(0.0003, 10);
    expect(r.ok && r.outliers).toEqual(["hUSDC@defiplaza"]);
  });

  it("does not let two on-chain pools outvote the off-chain sources", () => {
    const r = xrdConsensus([cg(0.0003), cp(0.0003), chain(0.0005, "hUSDC"), chain(0.0005, "xUSDC")], undefined, NOW, S);
    expect(r.ok && r.value).toBeCloseTo(0.0003, 10);
  });

  it("never trusts on-chain pools alone", () => {
    const r = xrdConsensus([chain(0.0003, "a"), chain(0.0003, "b")], undefined, NOW, S);
    expect(r.ok).toBe(false);
  });

  it("fails when the off-chain sources disagree and nothing breaks the tie", () => {
    const r = xrdConsensus([cg(0.0003), cp(0.0004)], undefined, NOW, S);
    expect(r.ok).toBe(false);
  });

  it("lets the last validated price break a tie when only one source is near it", () => {
    const last = { value: 0.0003, at: NOW - 60 };
    const r = xrdConsensus([cg(0.000305), cp(0.0004)], last, NOW, S);
    expect(r.ok && r.mode).toBe("single_source");
    expect(r.ok && r.value).toBe(0.000305);
    // both near the last price but apart from each other: cannot tell, fail
    expect(xrdConsensus([cg(0.00028), cp(0.00032)], last, NOW, S).ok).toBe(false);
  });

  it("lets the on-chain pool break a tie between disagreeing off-chain sources", () => {
    const r = xrdConsensus([cg(0.0003), cp(0.0004), chain(0.000305)], undefined, NOW, S);
    expect(r.ok && r.agreeing.sort()).toEqual(["coingecko", "hUSDC@defiplaza"]);
  });

  it("accepts a lone off-chain source only near a recent validated price", () => {
    const last = { value: 0.0003, at: NOW - 600 };
    expect(xrdConsensus([cg(0.00031)], last, NOW, S).ok).toBe(true);
    expect(xrdConsensus([cg(0.0004)], last, NOW, S).ok).toBe(false);
    expect(xrdConsensus([cg(0.00031)], { value: 0.0003, at: NOW - 7200 }, NOW, S).ok).toBe(false);
    expect(xrdConsensus([cg(0.00031)], undefined, NOW, S).ok).toBe(false);
  });

  it("does not let a drained on-chain pool veto a lone off-chain source", () => {
    const r = xrdConsensus([cg(0.0003), chain(0.003)], { value: 0.0003, at: NOW - 60 }, NOW, S);
    expect(r.ok && r.mode).toBe("single_source");
  });

  it("fails with no sources at all", () => {
    expect(xrdConsensus([], undefined, NOW, S).ok).toBe(false);
    expect(xrdConsensus([cg(NaN), cp(0)], undefined, NOW, S).ok).toBe(false);
  });
});

describe("jump gate", () => {
  const opts = { maxMove: 0.15, confirmTol: 0.03, lastMaxAgeSecs: 900, pendingMaxAgeSecs: 300 };
  const last = { value: 0.0003, at: NOW - 60 };

  it("passes normal moves", () => {
    expect(jumpGate(0.00033, last, undefined, NOW, opts).accept).toBe(true);
  });

  it("holds a large move for one cycle, then accepts it when confirmed", () => {
    const g1 = jumpGate(0.0006, last, undefined, NOW, opts);
    expect(g1.accept).toBe(false);
    const g2 = jumpGate(0.000601, last, g1.pending, NOW + 60, opts);
    expect(g2.accept).toBe(true);
  });

  it("never publishes a one-off spike", () => {
    const g1 = jumpGate(0.003, last, undefined, NOW, opts);
    const g2 = jumpGate(0.0003, last, g1.pending, NOW + 60, opts);
    expect(g1.accept).toBe(false);
    expect(g2.accept).toBe(true); // back to normal: accepted as a normal move, spike never shown
  });

  it("accepts anything after a long outage (nothing recent to compare with)", () => {
    expect(jumpGate(0.0006, { value: 0.0003, at: NOW - 3600 }, undefined, NOW, opts).accept).toBe(true);
  });
});

describe("stablecoin peg", () => {
  it("reports the real market price and flags a depeg", () => {
    const p = pegCheck("hUSDC", "c", 333.33, 0.0003, 0.1); // 333 XRD per hUSDC at $0.0003 = $0.10
    expect(p.usd).toBeCloseTo(0.1, 3);
    expect(p.depegged).toBe(true);
    expect(pegCheck("hUSDC", "c", 3200, 0.0003, 0.1).depegged).toBe(false); // $0.96
  });
});

describe("combining pools", () => {
  it("drops a shallow pool that disagrees with the deepest", () => {
    const r = combinePools(
      [
        { key: "deep", xrdPerToken: 100, depthUsd: 3000 },
        { key: "also", xrdPerToken: 102, depthUsd: 1000 },
        { key: "drained", xrdPerToken: 400, depthUsd: 120 },
      ],
      0.1,
    );
    expect(r.value).toBeCloseTo(101, 6);
    expect(r.dropped).toEqual(["drained"]);
  });

  it("returns nothing for no pools", () => {
    expect(combinePools([], 0.1).value).toBeUndefined();
  });
});

describe("CoinGecko blend", () => {
  it("blends when CoinGecko and pools agree", () => {
    expect(blendCoingecko(100, 102, 0.8, 0.1, false)).toMatchObject({ usd: 0.8 * 102 + 0.2 * 100, source: "coingecko_weighted" });
  });
  it("withdraws the price when they disagree (bridge broken or pool stale: cannot tell)", () => {
    const b = blendCoingecko(100, 250, 0.8, 0.1, false);
    expect(b?.usd).toBeUndefined();
    expect(b?.divergence).toBeCloseTo(1.5);
  });
  it("uses CoinGecko for tokens explicitly marked coingecko_only", () => {
    expect(blendCoingecko(100, 250, 0.8, 0.1, true)).toMatchObject({ usd: 250, source: "coingecko_pool_diverged" });
    expect(blendCoingecko(undefined, 250, 0.8, 0.1, true)).toMatchObject({ usd: 250, source: "coingecko_only" });
  });
  it("never uses CoinGecko alone otherwise", () => {
    expect(blendCoingecko(undefined, 250, 0.8, 0.1, false)).toBeUndefined();
  });
});
