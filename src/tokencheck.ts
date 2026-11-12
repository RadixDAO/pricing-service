/**
 * Checks for token requests (GitHub issues) and the weekly recheck of listed tokens.
 * Runs in GitHub Actions; uses the same pool reading and thresholds as the live service, so a
 * token that passes here is one the service will actually price.
 */
import { type PoolConfig, type TokenConfig, type TokensFile, validateTokensFile, XRD } from "./config";
import { combinePools, xrdConsensus, type XrdCandidate } from "./consensus";
import { poolKey, readPools } from "./dex";
import { batchCalls, errMsg, type FetchFn, type Gateway, getEpoch, holdings } from "./gateway";
import { fetchOffchain } from "./offchain";
import type { Settings } from "./settings";

// ---------------------------------------------------------------- issue parsing

/** Labels of the issue form fields; the form renders each as "### <label>". */
export const FIELDS = {
  symbol: "Symbol",
  name: "Name",
  resource: "Resource address",
  pools: "Pools",
  coingecko: "CoinGecko ID",
  reason: "Reason",
} as const;

export interface AddRequest {
  kind: "add";
  symbol: string;
  name?: string;
  resource_address: string;
  pools: PoolConfig[];
  coingecko_id?: string;
}
export interface RemoveRequest {
  kind: "remove";
  symbol: string;
  reason: string;
}
export type TokenRequest = AddRequest | RemoveRequest;

/** Split an issue-form body into {label: value}. "_No response_" means empty. */
export function formSections(body: string): Map<string, string> {
  const out = new Map<string, string>();
  const parts = body.replace(/\r\n/g, "\n").split(/^###[ \t]+/m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf("\n");
    const label = (nl < 0 ? p : p.slice(0, nl)).trim();
    let value = nl < 0 ? "" : p.slice(nl + 1).trim();
    value = value.replace(/^```[a-z]*\n?/, "").replace(/\n?```$/, "").trim();
    if (value === "_No response_") value = "";
    out.set(label, value);
  }
  return out;
}

export function parseRequest(body: string, labels: string[]): TokenRequest | { error: string } {
  const f = formSections(body);
  const get = (k: string) => f.get(k) ?? "";
  if (labels.includes("remove-token")) {
    const symbol = get(FIELDS.symbol);
    if (!symbol) return { error: `missing "${FIELDS.symbol}"` };
    return { kind: "remove", symbol, reason: get(FIELDS.reason) };
  }
  if (!labels.includes("add-token")) return { error: "the issue needs the add-token or remove-token label" };
  const symbol = get(FIELDS.symbol);
  const resource = get(FIELDS.resource);
  if (!symbol) return { error: `missing "${FIELDS.symbol}"` };
  if (!resource) return { error: `missing "${FIELDS.resource}"` };
  const pools: PoolConfig[] = [];
  const lines = get(FIELDS.pools).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const [i, line] of lines.entries()) {
    const w = line.split(/[\s,]+/).filter(Boolean);
    if (w.length !== 4) return { error: `pool line ${i + 1} must be "dex component base quote", got: ${line.slice(0, 120)}` };
    const [dex, component, base, quote] = w;
    pools.push({ dex: dex.toLowerCase() as PoolConfig["dex"], component, base, quote });
  }
  if (pools.length === 0) return { error: `"${FIELDS.pools}" needs at least one pool` };
  const name = get(FIELDS.name) || undefined;
  const coingecko_id = get(FIELDS.coingecko) || undefined;
  return { kind: "add", symbol, name, resource_address: resource, pools, coingecko_id };
}

// ---------------------------------------------------------------- results

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  checks: Check[];
  /** The proposed tokens.json when the request passes. */
  tokens?: TokensFile;
  /** One-line description for the PR title. */
  summary: string;
}

export interface Deps {
  gw: Gateway;
  fetchFn: FetchFn;
  s: Settings;
  now: number;
}

// ---------------------------------------------------------------- shared pool assessment

export interface PoolAssessment {
  pool: PoolConfig;
  xrdPerToken?: number;
  depthUsd?: number;
  spread?: number;
  problems: string[];
}

/** Validated XRD/USD from the off-chain sources (no on-chain witness needed here). */
export async function referenceXrdUsd(d: Deps): Promise<{ value?: number; detail: string }> {
  const off = await fetchOffchain(
    ["radix"],
    {
      coingeckoUrl: d.s.coingeckoUrl,
      coingeckoApiKey: d.s.coingeckoApiKey,
      xrdSources: d.s.xrdSources,
      maxBookSpread: d.s.maxBookSpread,
      maxQuoteAgeSecs: d.s.offchainMaxQuoteAgeSecs,
      timeoutMs: d.s.httpTimeoutMs,
    },
    d.now,
    d.fetchFn,
  );
  const cands: XrdCandidate[] = [];
  const cg = off.coingecko.get("radix");
  if (cg !== undefined) cands.push({ source: "coingecko", usdPerXrd: cg, offchain: true, tol: d.s.offchainAgreeTol });
  for (const q of off.xrd) cands.push({ source: q.source, usdPerXrd: q.usd, offchain: true, tol: d.s.offchainAgreeTol });
  const c = xrdConsensus(cands, undefined, d.now, d.s);
  if (!c.ok) return { detail: `${c.reason}${off.errors.length ? ` (${off.errors.join("; ")})` : ""}` };
  return { value: c.value, detail: `$${c.value.toPrecision(5)} (${c.agreeing.join(", ")})` };
}

/**
 * Read and judge pools the way the live service does, plus the checks that only matter when a
 * pool is first listed: that it holds the token, and that base/quote are the right way round.
 */
export async function assessPools(pools: PoolConfig[], cfg: TokensFile, xrdUsd: number, d: Deps): Promise<Map<string, PoolAssessment>> {
  const out = new Map<string, PoolAssessment>(pools.map((p) => [poolKey(p), { pool: p, problems: [] }]));
  const tokens = cfg.tokens;
  // Pools without XRD are priced via their quote token, so its pools are needed too.
  const quoteSyms = [...new Set(pools.filter((p) => p.base !== "XRD" && p.quote !== "XRD").map((p) => p.quote))];
  const viaPools = quoteSyms.flatMap((q) => tokens[q]?.pools ?? []).filter((p) => p.base === "XRD" || p.quote === "XRD");
  const all = [...pools, ...viaPools];

  const epoch = await getEpoch(d.gw);
  const probeXrd = d.s.plazaProbeUsd / xrdUsd;
  const [readings, hold] = await Promise.all([
    readPools(d.gw, epoch, all, (p, spot) => (p.quote === "XRD" ? probeXrd : spot.get(p.quote) ? probeXrd / spot.get(p.quote)! : undefined)),
    holdings(d.gw, all.map((p) => p.component)),
  ]);
  const plaza = pools.filter((p) => p.dex === "defiplaza");
  const plazaTokens = await batchCalls(d.gw, epoch, plaza.map((p) => ({ component: p.component, method: "get_tokens" })));

  const amountsOf = (component: string) => {
    const m = new Map<string, number>();
    const h = hold.get(component);
    for (const a of [component, ...(h?.refs ?? [])]) for (const [r, v] of hold.get(a)?.amounts ?? []) m.set(r, (m.get(r) ?? 0) + v);
    return m;
  };
  const addr = (sym: string) => (sym === "XRD" ? XRD : tokens[sym]?.resource_address);

  // XRD per quote token for pools without XRD, from the quote token's own XRD pools.
  const viaPrice = new Map<string, number>();
  for (const q of quoteSyms) {
    const vals = (tokens[q]?.pools ?? [])
      .map((p) => readings.get(poolKey(p)))
      .filter((r) => r?.raw !== undefined)
      .map((r) => (r!.pool.base === "XRD" ? r!.raw! : 1 / r!.raw!));
    if (vals.length) viaPrice.set(q, vals.reduce((a, b) => a + b) / vals.length);
  }

  for (const p of pools) {
    const a = out.get(poolKey(p))!;
    const r = readings.get(poolKey(p));
    if (r?.raw === undefined) {
      a.problems.push(`price could not be read: ${r?.error ?? "no reading"}`);
      continue;
    }
    a.spread = r.spread;
    // Which tokens the pool holds, and in which direction its price is quoted.
    const amounts = amountsOf(p.component);
    const baseAmt = amounts.get(addr(p.base) ?? "") ?? 0;
    const quoteAmt = amounts.get(addr(p.quote) ?? "") ?? 0;
    if (baseAmt <= 0 || quoteAmt <= 0) {
      a.problems.push(`pool does not hold both ${p.base} and ${p.quote}`);
      continue;
    }
    const ratio = baseAmt / quoteAmt;
    if (Math.abs(Math.log(r.raw / ratio)) > Math.abs(Math.log(r.raw * ratio))) {
      a.problems.push(`base and quote look swapped (the pool's price matches ${p.quote}/${p.base})`);
      continue;
    }
    if (p.base === "XRD") a.xrdPerToken = r.raw;
    else if (p.quote === "XRD") a.xrdPerToken = 1 / r.raw;
    else if (viaPrice.has(p.quote)) a.xrdPerToken = (1 / r.raw) * viaPrice.get(p.quote)!;
    else a.problems.push(`no XRD price for ${p.quote} to value this pool`);
    const xrdSide = p.base === "XRD" || p.quote === "XRD" ? amounts.get(XRD) ?? 0 : quoteAmt * (viaPrice.get(p.quote) ?? 0);
    a.depthUsd = 2 * xrdSide * xrdUsd;
  }

  plaza.forEach((p, i) => {
    const a = out.get(poolKey(p))!;
    const t = plazaTokens[i];
    if (!t.ok) return void a.problems.push(`get_tokens failed: ${t.error}`);
    const got = [t.value.fields?.[0]?.value, t.value.fields?.[1]?.value];
    if (got[0] !== addr(p.base) || got[1] !== addr(p.quote)) a.problems.push(`DefiPlaza pair is ${got.join(" / ")}, not ${p.base} / ${p.quote}`);
  });
  return out;
}

function judge(a: PoolAssessment, minDepth: number, s: Settings): string[] {
  const probs = [...a.problems];
  if (a.depthUsd !== undefined && a.depthUsd < minDepth) probs.push(`depth $${a.depthUsd.toFixed(0)} is below the $${minDepth} minimum`);
  if (a.spread !== undefined && a.spread > s.plazaMaxSpread) probs.push(`spread ${(a.spread * 100).toFixed(1)}% at a $${s.plazaProbeUsd} trade`);
  return probs;
}

const usd = (x: number) => (x >= 1 ? `$${x.toFixed(2)}` : `$${x.toPrecision(4)}`);
const short = (c: string) => `${c.slice(0, 18)}…${c.slice(-6)}`;

// ---------------------------------------------------------------- add / remove

export async function checkAdd(req: AddRequest, cfg: TokensFile, d: Deps): Promise<CheckResult> {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const done = (summary: string, tokens?: TokensFile): CheckResult => ({ ok: checks.every((c) => c.ok), checks, tokens, summary });
  const existing = cfg.tokens[req.symbol];
  const summary = `${existing ? "Update" : "Add"} ${req.symbol}`;

  // 1. The request against the current list.
  const sameAddr = Object.entries(cfg.tokens).find(([, t]) => t.resource_address === req.resource_address);
  if (existing && existing.resource_address !== req.resource_address) {
    add("Symbol", false, `${req.symbol} is already listed with a different resource address`);
  } else if (sameAddr && sameAddr[0] !== req.symbol) {
    add("Resource address", false, `already listed as ${sameAddr[0]}`);
  } else {
    add("Symbol", true, existing ? `${req.symbol} is listed; its pools will be replaced` : `${req.symbol} is new`);
  }
  if (req.symbol === "XRD" || cfg.usd_anchors.includes(req.symbol)) add("Symbol", false, `${req.symbol} cannot be changed through a request`);

  const token: TokenConfig = {
    resource_address: req.resource_address,
    ...(req.name ? { name: req.name } : {}),
    ...(req.coingecko_id ? { coingecko_id: req.coingecko_id } : {}),
    ...(existing?.coingecko_weight !== undefined ? { coingecko_weight: existing.coingecko_weight } : {}),
    ...(existing?.min_depth_usd !== undefined ? { min_depth_usd: existing.min_depth_usd } : {}),
    // Keep details a maintainer added to pools that stay the same.
    pools: req.pools.map((p) => {
      const old = existing?.pools.find((o) => o.component === p.component && o.base === p.base && o.quote === p.quote);
      return old?.blueprint_name ? { ...p, blueprint_name: old.blueprint_name } : p;
    }),
  };
  const proposed: TokensFile = { ...cfg, tokens: { ...cfg.tokens, [req.symbol]: token } };
  const errs = validateTokensFile(proposed);
  add("Format", errs.length === 0, errs.length ? errs.join("; ") : "valid tokens.json entry");
  if (checks.some((c) => !c.ok)) return done(summary);

  // 2. The resource on the ledger.
  try {
    const r = await d.gw.post("/state/entity/details", { addresses: [req.resource_address], aggregation_level: "Global" });
    const it = r.items?.[0];
    const type = it?.details?.type;
    const ledgerSym = (it?.metadata?.items ?? []).find((m: any) => m.key === "symbol")?.value?.typed?.value;
    if (type !== "FungibleResource") add("Resource", false, `not a fungible resource (${type ?? "not found"})`);
    else if (ledgerSym && String(ledgerSym).toLowerCase() !== req.symbol.toLowerCase()) {
      add("Resource", true, `fungible; its on-ledger symbol is "${ledgerSym}", please confirm "${req.symbol}" is intended`);
    } else add("Resource", true, `fungible${ledgerSym ? `, symbol "${ledgerSym}"` : ""}`);
  } catch (e) {
    add("Resource", false, `could not read it from the Gateway: ${errMsg(e)}`);
  }

  // 3. Pools, priced and judged like the live service.
  const xrd = await referenceXrdUsd(d);
  if (xrd.value === undefined) {
    add("XRD/USD reference", false, `cannot value the pools right now: ${xrd.detail}. Edit the issue to retry later.`);
    return done(summary);
  }
  const minDepth = token.min_depth_usd ?? d.s.minPoolDepthUsd;
  let assessed: Map<string, PoolAssessment>;
  try {
    assessed = await assessPools(req.pools, proposed, xrd.value, d);
  } catch (e) {
    add("Pools", false, `could not read pools from the Gateway: ${errMsg(e)}. Edit the issue to retry.`);
    return done(summary);
  }
  const healthy = [];
  for (const a of assessed.values()) {
    const probs = judge(a, minDepth, d.s);
    const price = a.xrdPerToken !== undefined ? `${usd(a.xrdPerToken * xrd.value)}` : "no price";
    const depth = a.depthUsd !== undefined ? `, depth $${Math.round(a.depthUsd).toLocaleString("en-US")}` : "";
    add(`Pool ${a.pool.dex} ${short(a.pool.component)}`, probs.length === 0, probs.length ? probs.join("; ") : `${price}${depth}`);
    if (probs.length === 0 && a.xrdPerToken !== undefined) healthy.push({ key: poolKey(a.pool), xrdPerToken: a.xrdPerToken, depthUsd: a.depthUsd ?? 0 });
  }
  if (healthy.length > 1) {
    const c = combinePools(healthy, d.s.poolAgreeTol);
    add("Pools agree", c.dropped.length === 0, c.dropped.length ? `these pools differ more than ${d.s.poolAgreeTol * 100}% from the deepest: ${c.dropped.map((k) => short(k.split("|")[0])).join(", ")}` : `within ${d.s.poolAgreeTol * 100}%`);
  }

  // 4. CoinGecko, when given: must exist and agree with the pools.
  if (req.coingecko_id && healthy.length) {
    const off = await fetchOffchain(
      [req.coingecko_id],
      { coingeckoUrl: d.s.coingeckoUrl, coingeckoApiKey: d.s.coingeckoApiKey, xrdSources: [], maxBookSpread: 1, maxQuoteAgeSecs: d.s.offchainMaxQuoteAgeSecs, timeoutMs: d.s.httpTimeoutMs },
      d.now,
      d.fetchFn,
    );
    const cg = off.coingecko.get(req.coingecko_id);
    const ledger = combinePools(healthy, d.s.poolAgreeTol).value! * xrd.value;
    if (cg === undefined) add("CoinGecko", false, `no price for "${req.coingecko_id}"${off.errors.length ? ` (${off.errors.join("; ")})` : ""}`);
    else {
      const div = Math.abs(cg / ledger - 1);
      add("CoinGecko", div <= d.s.coingeckoMaxDivergence, `${usd(cg)} vs pools ${usd(ledger)} (${(div * 100).toFixed(1)}% apart, max ${d.s.coingeckoMaxDivergence * 100}%)`);
    }
  }
  return done(summary, proposed);
}

export function checkRemove(req: RemoveRequest, cfg: TokensFile): CheckResult {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const t = cfg.tokens[req.symbol];
  if (!t) add("Symbol", false, `${req.symbol} is not listed`);
  else if (req.symbol === "XRD") add("Symbol", false, "XRD cannot be removed");
  else if (cfg.usd_anchors.includes(req.symbol)) add("Symbol", false, `${req.symbol} is a USD reference for XRD/USD; change usd_anchors in a normal PR`);
  else {
    const users = Object.entries(cfg.tokens).filter(([s, o]) => s !== req.symbol && o.pools.some((p) => p.base === req.symbol || p.quote === req.symbol));
    if (users.length) add("Symbol", false, `pools of ${users.map(([s]) => s).join(", ")} are priced through ${req.symbol}; remove or change those first`);
    else add("Symbol", true, `${req.symbol} is listed and nothing depends on it`);
  }
  const ok = checks.every((c) => c.ok);
  let tokens: TokensFile | undefined;
  if (ok) {
    const rest = { ...cfg.tokens };
    delete rest[req.symbol];
    tokens = { ...cfg, tokens: rest };
  }
  return { ok, checks, tokens, summary: `Remove ${req.symbol}` };
}

// ---------------------------------------------------------------- weekly recheck

export interface RecheckFinding {
  symbol: string;
  /** No pool usable and no CoinGecko fallback: the service shows no price for it. */
  unpriced: boolean;
  problems: string[];
}

export async function recheck(cfg: TokensFile, d: Deps): Promise<{ findings: RecheckFinding[]; error?: string }> {
  const xrd = await referenceXrdUsd(d);
  if (xrd.value === undefined) return { findings: [], error: `no XRD/USD reference: ${xrd.detail}` };
  const pools = Object.entries(cfg.tokens).flatMap(([, t]) => t.pools);
  const assessed = await assessPools(pools, cfg, xrd.value, d);
  const findings: RecheckFinding[] = [];
  for (const [sym, t] of Object.entries(cfg.tokens)) {
    if (sym === "XRD") continue;
    const minDepth = t.min_depth_usd ?? d.s.minPoolDepthUsd;
    const problems: string[] = [];
    let healthy = 0;
    for (const p of t.pools) {
      const probs = judge(assessed.get(poolKey(p))!, minDepth, d.s);
      if (probs.length) problems.push(`${p.dex} ${short(p.component)}: ${probs.join("; ")}`);
      else healthy++;
    }
    if (problems.length) findings.push({ symbol: sym, unpriced: healthy === 0 && !t.coingecko_only, problems });
  }
  return { findings };
}

// ---------------------------------------------------------------- markdown

export function resultMarkdown(r: CheckResult, req: TokenRequest, runUrl?: string): string {
  const head = r.ok
    ? `✅ **All checks passed.** A pull request with the change has been opened; a maintainer reviews and merges it, and the merge deploys the service.`
    : `❌ **Some checks failed.** Edit this issue to fix the request; the checks run again automatically.`;
  const rows = r.checks.map((c) => `| ${c.ok ? "✅" : "❌"} | ${c.name} | ${c.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  return [
    `### ${r.summary}`,
    "",
    head,
    "",
    "| | Check | Result |",
    "|---|---|---|",
    ...rows,
    "",
    runUrl ? `<sub>Checked against Radix mainnet by [this run](${runUrl}).</sub>` : "",
  ].join("\n");
}
