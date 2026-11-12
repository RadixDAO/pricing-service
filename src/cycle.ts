/** One price cycle: read sources, validate, publish. Runs from the Cron Trigger every minute. */
import { processAlerts } from "./alerts";
import { type TokensFile, XRD } from "./config";
import {
  blendCoingecko,
  combinePools,
  jumpGate,
  median,
  pegCheck,
  type PoolValue,
  type XrdCandidate,
  xrdConsensus,
} from "./consensus";
import { poolKey, readPools, type PoolReading } from "./dex";
import { errMsg, type FetchFn, getEpoch, holdings, type EntityHoldings, makeGateway } from "./gateway";
import { fetchAstrolescent } from "./astrolescent";
import { fetchOffchain } from "./offchain";
import type { Settings } from "./settings";
import { loadState, pruneHistory, saveState, type ServiceState, writeHistory } from "./store";

export interface CycleResult {
  state: ServiceState;
  log: string[];
}

interface PoolHealth {
  reading: PoolReading;
  depthUsd?: number;
  healthy: boolean;
  why?: string;
}

export async function runCycle(db: D1Database, cfg: TokensFile, s: Settings, now: number, fetchFn: FetchFn = fetch): Promise<CycleResult> {
  const log: string[] = [];
  const st = await loadState(db);
  const issues: string[] = [];
  const alerts = new Map<string, string>();
  const tokens = cfg.tokens;
  const xrdCgId = tokens.XRD.coingecko_id;

  // 1. Off-chain prices first: they size the pool probes and value pool depth.
  const cgIds = [...new Set(Object.values(tokens).flatMap((t) => (t.coingecko_id ? [t.coingecko_id] : [])))];
  const astroP = fetchAstrolescent(
    s.astrolescentUrl,
    Object.values(tokens).map((t) => t.resource_address),
    now,
    s.astrolescentMaxAgeSecs,
    s.httpTimeoutMs,
    fetchFn,
  );
  const off = await fetchOffchain(
    cgIds,
    {
      coingeckoUrl: s.coingeckoUrl,
      coingeckoApiKey: s.coingeckoApiKey,
      xrdSources: s.xrdSources,
      maxBookSpread: s.maxBookSpread,
      maxQuoteAgeSecs: s.offchainMaxQuoteAgeSecs,
      timeoutMs: s.httpTimeoutMs,
    },
    now,
    fetchFn,
  );
  for (const e of off.errors) log.push(`offchain: ${e}`);
  const cgXrd = xrdCgId ? off.coingecko.get(xrdCgId) : undefined;
  const offXrd = [cgXrd, ...off.xrd.map((q) => q.usd)].filter((x): x is number => x !== undefined);
  // Rough XRD/USD for sizing and depth only; never published.
  const roughXrdUsd = offXrd.length ? median(offXrd) : st.xrd?.value;

  // 2. On-chain pools. A Gateway outage leaves pools empty but does not stop XRD itself.
  const allPools = Object.values(tokens).flatMap((t) => t.pools);
  let readings = new Map<string, PoolReading>();
  let hold = new Map<string, EntityHoldings>();
  let gatewayDown = false;
  try {
    const gw = makeGateway(s.gatewayUrl, fetchFn, s.httpTimeoutMs);
    const epoch = await getEpoch(gw);
    const probeXrd = roughXrdUsd ? s.plazaProbeUsd / roughXrdUsd : undefined;
    [readings, hold] = await Promise.all([
      readPools(gw, epoch, allPools, (p, spot) => {
        if (!probeXrd) return undefined;
        if (p.quote === "XRD") return probeXrd;
        const x = spot.get(p.quote);
        return x ? probeXrd / x : undefined;
      }),
      holdings(gw, allPools.map((p) => p.component)),
    ]);
  } catch (e) {
    gatewayDown = true;
    issues.push(`Radix Gateway unavailable: ${errMsg(e)}`);
    alerts.set("gateway", `Radix Gateway unavailable: ${errMsg(e)}`);
    log.push(`gateway: ${errMsg(e)}`);
  }

  const astro = await astroP;
  if (astro.error) log.push(astro.error);
  const anchorSet = new Set(cfg.usd_anchors);
  /** Symbols priced from Astrolescent instead of our own pool reads. */
  const fromAstro = new Set<string>();

  // 3. Pool health and XRD price per token (healthy pools only).
  const health = new Map<string, PoolHealth>();
  const xrdPer = new Map<string, number | undefined>([["XRD", 1]]);
  const busy = new Set<string>();
  const addrOf = (sym: string) => tokens[sym]?.resource_address;

  const depthXrd = (p: (typeof allPools)[number]): number | undefined => {
    const srcs = [p.component, ...(hold.get(p.component)?.refs ?? [])].filter((a) => hold.has(a));
    if (srcs.length === 0) return undefined;
    const sum = (res: string) => srcs.reduce((a, x) => a + (hold.get(x)!.amounts.get(res) ?? 0), 0);
    if (p.base === "XRD" || p.quote === "XRD") return 2 * sum(XRD);
    const via = resolve(p.quote);
    const q = addrOf(p.quote);
    return via && q ? 2 * sum(q) * via : undefined;
  };

  const poolHealth = (p: (typeof allPools)[number], minDepth: number): PoolHealth => {
    const key = poolKey(p);
    const cached = health.get(key);
    if (cached) return cached;
    const reading = readings.get(key) ?? { pool: p, error: "not read" };
    const h: PoolHealth = { reading, healthy: false };
    health.set(key, h);
    if (reading.raw === undefined) h.why = reading.error ?? "no price";
    else {
      const dx = depthXrd(p);
      h.depthUsd = dx !== undefined && roughXrdUsd ? dx * roughXrdUsd : undefined;
      if (h.depthUsd === undefined) h.why = "depth unknown";
      else if (h.depthUsd < minDepth) h.why = `depth $${h.depthUsd.toFixed(0)} < $${minDepth}`;
      else if (reading.spread !== undefined && reading.spread > s.plazaMaxSpread) {
        h.why = `spread ${(reading.spread * 100).toFixed(1)}% at $${s.plazaProbeUsd}`;
      } else h.healthy = true;
    }
    return h;
  };

  const poolXrdPerToken = (p: (typeof allPools)[number], raw: number): number | undefined => {
    if (p.base === "XRD") return raw; // XRD per quote token
    if (p.quote === "XRD") return 1 / raw; // XRD per base token
    const via = resolve(p.quote);
    return via === undefined ? undefined : (1 / raw) * via;
  };

  function resolve(sym: string): number | undefined {
    if (xrdPer.has(sym)) return xrdPer.get(sym);
    if (busy.has(sym) || !tokens[sym]) return undefined;
    busy.add(sym);
    const t = tokens[sym];
    const vals: PoolValue[] = [];
    for (const p of t.pools) {
      const h = poolHealth(p, t.min_depth_usd ?? s.minPoolDepthUsd);
      if (!h.healthy) continue;
      // Config guarantees the pool's non-XRD side (or its base, for pools without XRD) is `sym`.
      const v = poolXrdPerToken(p, h.reading.raw!);
      if (v !== undefined && v > 0 && Number.isFinite(v)) vals.push({ key: poolKey(p), xrdPerToken: v, depthUsd: h.depthUsd ?? 0 });
    }
    busy.delete(sym);
    const c = combinePools(vals, s.poolAgreeTol);
    if (c.dropped.length) log.push(`${sym}: dropped pools disagreeing with the deepest: ${c.dropped.join(", ")}`);
    let value = c.value;
    const a = astro.prices.get(t.resource_address);
    if (value !== undefined && a && Math.abs(a.xrdPerToken / value - 1) > s.poolAgreeTol) {
      log.push(`${sym}: Astrolescent differs ${(100 * (a.xrdPerToken / value - 1)).toFixed(1)}% from our pools`);
    }
    // Backup only while the Gateway is unreachable, and only for tokens whose pools passed our
    // checks at the last good read: a pool we rejected as too thin is not made acceptable by
    // reading it through an aggregator. Stablecoin references always come from our own reads.
    if (value === undefined && gatewayDown && a && !anchorSet.has(sym) && st.pooled?.includes(sym)) {
      value = a.xrdPerToken;
      fromAstro.add(sym);
    }
    xrdPer.set(sym, value);
    return value;
  }

  for (const sym of Object.keys(tokens)) resolve(sym);
  if (!gatewayDown) st.pooled = Object.keys(tokens).filter((sym) => sym !== "XRD" && xrdPer.get(sym) !== undefined);

  // 4. XRD/USD: off-chain sources plus each healthy stablecoin pool as an on-chain witness.
  const cands: XrdCandidate[] = [];
  if (cgXrd !== undefined) cands.push({ source: "coingecko", usdPerXrd: cgXrd, offchain: true, tol: s.offchainAgreeTol });
  for (const q of off.xrd) cands.push({ source: q.source, usdPerXrd: q.usd, offchain: true, tol: s.offchainAgreeTol });
  const anchorPools: Array<{ sym: string; p: (typeof allPools)[number]; xrdPerAnchor: number }> = [];
  for (const a of cfg.usd_anchors) {
    for (const p of tokens[a].pools) {
      if (p.base !== "XRD" && p.quote !== "XRD") continue;
      const h = poolHealth(p, tokens[a].min_depth_usd ?? s.minPoolDepthUsd);
      if (!h.healthy) {
        const msg = `${a} pool on ${p.dex} is not usable as a USD reference: ${h.why}`;
        log.push(msg);
        issues.push(msg);
        alerts.set(`anchor-${a}-${p.component}`, msg);
        continue;
      }
      const xrdPerAnchor = p.base === "XRD" ? h.reading.raw! : 1 / h.reading.raw!;
      anchorPools.push({ sym: a, p, xrdPerAnchor });
      cands.push({ source: `${a}@${p.dex}`, usdPerXrd: 1 / xrdPerAnchor, offchain: false, tol: s.onchainAgreeTol });
    }
  }

  const cons = xrdConsensus(cands, st.xrd, now, s);
  let xrdUsd: number | undefined;
  let xrdPending = st.xrd_pending;
  if (cons.ok) {
    const gate = jumpGate(cons.value, st.xrd, st.xrd_pending, now, {
      maxMove: s.jumpMaxMove,
      confirmTol: s.offchainAgreeTol,
      lastMaxAgeSecs: s.maxPriceAgeSecs,
      pendingMaxAgeSecs: 300,
    });
    if (gate.accept) {
      xrdUsd = cons.value;
      xrdPending = undefined;
    } else {
      xrdPending = gate.pending;
      issues.push(gate.reason!);
    }
    if (cons.mode === "single_source") issues.push(`XRD/USD from ${cons.agreeing[0]} only`);
    if (cons.outliers.length) log.push(`XRD/USD outliers: ${cons.outliers.join(", ")}`);
  } else {
    issues.push(cons.reason);
    const why = off.errors.length ? ` (${off.errors.join("; ")})` : "";
    alerts.set("xrd-usd", cons.reason + why);
  }
  // Individual XRD sources failing is expected now and then; only CoinGecko, which the other
  // tokens' cross-checks depend on, is alerted on its own.
  const cgErr = off.errors.find((x) => x.startsWith("coingecko"));
  if (cgErr) alerts.set("source-coingecko", `CoinGecko unavailable: ${cgErr}`);
  // A single exchange failing for a while is normal; failing for a day suggests it delisted
  // XRD or closed, and should be replaced while the other sources still give a margin.
  const downSince = { ...(st.source_down_since ?? {}) };
  const answered = new Set(off.xrd.map((q) => q.source));
  for (const name of s.xrdSources) {
    if (answered.has(name)) {
      delete downSince[name];
      continue;
    }
    downSince[name] ??= now;
    const hours = (now - downSince[name]) / 3600;
    if (now - downSince[name] >= s.sourceDownAlertSecs) {
      const err = off.errors.find((x) => x.startsWith(`${name}:`)) ?? "no answer";
      alerts.set(
        `source-down-${name}`,
        `XRD source ${name} has failed for ${hours.toFixed(0)} hours (${err}); replace or remove it in XRD_SOURCES`,
      );
    }
  }
  for (const name of Object.keys(downSince)) if (!s.xrdSources.includes(name)) delete downSince[name];
  st.source_down_since = downSince;

  // 5. Publish.
  const prices = { ...st.prices };
  const updated: Array<[string, number]> = [];
  if (xrdUsd !== undefined) {
    st.xrd = { value: xrdUsd, at: now, mode: cons.ok ? cons.mode : "", sources: cons.ok ? cons.agreeing : [] };
    prices[XRD] = { usd: xrdUsd, at: now, src: `xrd_${cons.ok ? cons.mode : ""}` };
    updated.push([XRD, xrdUsd]);

    for (const { sym, p, xrdPerAnchor } of anchorPools) {
      const pc = pegCheck(sym, p.component, xrdPerAnchor, xrdUsd, s.pegAlertTol);
      if (pc.depegged) {
        const msg = `${sym} trades at $${pc.usd.toFixed(4)} on ${p.dex} (more than ${(s.pegAlertTol * 100).toFixed(0)}% off its peg)`;
        issues.push(msg);
        alerts.set(`depeg-${sym}`, msg);
      }
    }

    for (const [sym, t] of Object.entries(tokens)) {
      if (sym === "XRD") continue;
      const x = xrdPer.get(sym);
      const ledger = x !== undefined ? x * xrdUsd : undefined;
      // Stablecoins are shown at their market price on Radix, never assumed to be $1.
      const cg = !anchorSet.has(sym) && t.coingecko_id ? off.coingecko.get(t.coingecko_id) : undefined;
      const b = blendCoingecko(ledger, cg, t.coingecko_weight ?? s.coingeckoDefaultWeight, s.coingeckoMaxDivergence, !!t.coingecko_only && !anchorSet.has(sym));
      if (!b) continue;
      if (b.divergence !== undefined) {
        const what = b.usd === undefined ? "price withdrawn" : "using CoinGecko";
        log.push(`${sym}: CoinGecko differs ${(b.divergence * 100).toFixed(1)}% from pools; ${what}`);
      }
      if (b.usd === undefined) continue;
      prices[t.resource_address] = { usd: b.usd, at: now, src: fromAstro.has(sym) ? `${b.source}:astrolescent` : b.source };
      updated.push([t.resource_address, b.usd]);
    }
    st.last_ok_at = now;
  }

  // Drop tokens no longer configured.
  const listed = new Set(Object.values(tokens).map((t) => t.resource_address));
  for (const a of Object.keys(prices)) if (!listed.has(a)) delete prices[a];

  st.prices = prices;
  st.xrd_pending = xrdPending;
  st.cycle_at = now;
  st.issues = issues;
  st.status = xrdUsd === undefined ? "stale" : issues.length ? "degraded" : "ok";

  // 6. History and retention.
  if (xrdUsd !== undefined && now - (st.last_history_at ?? 0) >= s.historyEverySecs) {
    await writeHistory(db, updated, now);
    st.last_history_at = now;
  }
  if (s.retentionDays > 0 && now - (st.last_prune_at ?? 0) >= 86400) {
    const n = await pruneHistory(db, now - s.retentionDays * 86400);
    if (n) log.push(`history: pruned ${n} rows`);
    st.last_prune_at = now;
  }

  await saveState(db, st, now);
  log.push(...(await processAlerts(db, alerts, now, {
    githubToken: s.githubToken,
    alertRepo: s.alertRepo,
    openAfter: s.alertOpenAfter,
    closeAfter: s.alertCloseAfter,
    timeoutMs: s.httpTimeoutMs,
  }, fetchFn)));

  const unhealthy = [...health.values()].filter((h) => !h.healthy).map((h) => `${h.reading.pool.quote === "XRD" ? h.reading.pool.base : h.reading.pool.quote}@${h.reading.pool.dex}: ${h.why}`);
  if (unhealthy.length) log.push(`pools not used: ${unhealthy.join("; ")}`);
  log.unshift(
    `cycle ${st.status}: XRD=${xrdUsd !== undefined ? `$${xrdUsd.toPrecision(6)} (${cons.ok ? cons.agreeing.join("+") : ""})` : "not validated"}, ` +
      `${updated.length}/${Object.keys(tokens).length} prices updated` + (issues.length ? `; ${issues.join("; ")}` : ""),
  );
  return { state: st, log };
}
