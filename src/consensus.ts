/**
 * Price validation. Pure functions, no I/O, so every failure scenario can be unit-tested.
 *
 * The rule: a price is only published when independent sources agree. A stablecoin is never
 * assumed to be worth $1 without checking, and thin or broken pools are left out.
 */

export interface XrdCandidate {
  source: string;
  usdPerXrd: number;
  offchain: boolean;
  /** Relative tolerance this source needs to count as agreeing (thin on-chain pools get more room). */
  tol: number;
}

export type XrdConsensus =
  | { ok: true; value: number; mode: "consensus" | "single_source"; agreeing: string[]; outliers: string[] }
  | { ok: false; reason: string; outliers: string[] };

export interface LastGood {
  value: number;
  at: number; // unix seconds
}

export interface ConsensusSettings {
  /** Max age of the last validated price for a lone off-chain source to be checked against it. */
  singleSourceMaxAgeSecs: number;
  /** Max move from the last validated price for a lone off-chain source to be accepted. */
  singleSourceMaxMove: number;
}

const rel = (a: number, b: number) => Math.abs(a / b - 1);

/**
 * Find the largest group of sources that agree with each other.
 *
 * Accepted when at least two sources agree and at least one of them is off-chain, so the
 * on-chain pools (cheap to move) can never set the XRD price on their own. If only one
 * off-chain source is reachable and nothing contradicts it, it is accepted only when it is
 * close to the last validated price.
 */
export function xrdConsensus(cands: XrdCandidate[], last: LastGood | undefined, now: number, s: ConsensusSettings): XrdConsensus {
  const valid = cands.filter((c) => Number.isFinite(c.usdPerXrd) && c.usdPerXrd > 0);
  if (valid.length === 0) return { ok: false, reason: "no XRD/USD source available", outliers: [] };

  let best: XrdCandidate[] = [];
  for (const c of valid) {
    const group = valid.filter((o) => rel(o.usdPerXrd, c.usdPerXrd) <= Math.max(c.tol, o.tol));
    const better =
      group.length > best.length ||
      (group.length === best.length && offCount(group) > offCount(best));
    if (better) best = group;
  }

  if (best.length >= 2 && offCount(best) >= 1) {
    const value = median(best.map((c) => c.usdPerXrd));
    // Report as outliers only those that also disagree with the final value.
    const outliers = valid.filter((c) => !best.includes(c)).map((c) => c.source);
    return { ok: true, value, mode: "consensus", agreeing: best.map((c) => c.source), outliers };
  }

  // One off-chain source left (the other unreachable). On-chain pools that contradict it are
  // not trusted to veto it, but it must be close to the last validated price.
  const off = valid.filter((c) => c.offchain);
  if (off.length === 1) {
    const only = off[0];
    const onchainOut = valid.filter((c) => !c.offchain).map((c) => c.source);
    if (last && now - last.at <= s.singleSourceMaxAgeSecs && rel(only.usdPerXrd, last.value) <= s.singleSourceMaxMove) {
      return { ok: true, value: only.usdPerXrd, mode: "single_source", agreeing: [only.source], outliers: onchainOut };
    }
    return {
      ok: false,
      reason: `only ${only.source} is available off-chain and it cannot be checked against a recent validated price`,
      outliers: onchainOut,
    };
  }

  if (off.length === 0) {
    return { ok: false, reason: "no off-chain XRD/USD source available; on-chain pools alone are not trusted", outliers: [] };
  }
  const desc = valid.map((c) => `${c.source}=${c.usdPerXrd.toPrecision(6)}`).join(", ");
  return { ok: false, reason: `XRD/USD sources disagree: ${desc}`, outliers: valid.map((c) => c.source) };
}

export interface JumpState {
  pending?: LastGood;
}

/**
 * Hold a large one-minute move until the next cycle confirms it. A real crash shows up one
 * minute late; a one-off glitch never gets published.
 */
export function jumpGate(
  value: number,
  last: LastGood | undefined,
  pending: LastGood | undefined,
  now: number,
  opts: { maxMove: number; confirmTol: number; lastMaxAgeSecs: number; pendingMaxAgeSecs: number },
): { accept: boolean; pending?: LastGood; reason?: string } {
  if (!last || now - last.at > opts.lastMaxAgeSecs) return { accept: true };
  if (rel(value, last.value) <= opts.maxMove) return { accept: true };
  if (pending && now - pending.at <= opts.pendingMaxAgeSecs && rel(value, pending.value) <= opts.confirmTol) {
    return { accept: true };
  }
  return {
    accept: false,
    pending: { value, at: now },
    reason: `XRD moved ${(100 * (value / last.value - 1)).toFixed(1)}% in one cycle; waiting for confirmation`,
  };
}

export interface PegCheck {
  symbol: string;
  pool: string;
  /** Market price of the stablecoin in USD at the validated XRD price. */
  usd: number;
  depegged: boolean;
}

/** A stablecoin's real price from its pool against XRD, given a validated XRD/USD. */
export function pegCheck(symbol: string, pool: string, xrdPerToken: number, usdPerXrd: number, tol: number): PegCheck {
  const usd = xrdPerToken * usdPerXrd;
  return { symbol, pool, usd, depegged: Math.abs(usd - 1) > tol };
}

export interface PoolValue {
  key: string;
  xrdPerToken: number;
  depthUsd: number;
}

/**
 * Combine a token's healthy pools. The deepest pool is the reference; pools that disagree with
 * it by more than `tol` are dropped, since a shallow pool is the one most likely to be wrong.
 */
export function combinePools(vals: PoolValue[], tol: number): { value?: number; used: string[]; dropped: string[] } {
  if (vals.length === 0) return { used: [], dropped: [] };
  const ref = vals.reduce((a, b) => (b.depthUsd > a.depthUsd ? b : a));
  const used = vals.filter((v) => rel(v.xrdPerToken, ref.xrdPerToken) <= tol);
  const dropped = vals.filter((v) => !used.includes(v)).map((v) => v.key);
  const value = used.reduce((a, v) => a + v.xrdPerToken, 0) / used.length;
  return { value, used: used.map((v) => v.key), dropped };
}

export interface CgBlend {
  /** Undefined when the price is withdrawn. */
  usd?: number;
  source: string;
  /** Set when CoinGecko and the pools disagree beyond tolerance. */
  divergence?: number;
}

/**
 * Blend CoinGecko with the on-chain price.
 *
 * When they disagree neither is trusted: for a bridged token CoinGecko quotes the underlying
 * asset and cannot see a broken bridge, while a thin pool may simply be stale. The price is
 * withdrawn, except for tokens marked coingecko_only, where CoinGecko was chosen explicitly.
 */
export function blendCoingecko(
  ledgerUsd: number | undefined,
  cgUsd: number | undefined,
  weight: number,
  maxDivergence: number,
  coingeckoOnly: boolean,
): CgBlend | undefined {
  if (ledgerUsd !== undefined && cgUsd !== undefined) {
    const d = rel(cgUsd, ledgerUsd);
    if (d <= maxDivergence) return { usd: weight * cgUsd + (1 - weight) * ledgerUsd, source: "coingecko_weighted" };
    if (coingeckoOnly) return { usd: cgUsd, source: "coingecko_pool_diverged", divergence: d };
    return { source: "withdrawn_diverged", divergence: d };
  }
  if (ledgerUsd !== undefined) return { usd: ledgerUsd, source: "ledger_only" };
  if (cgUsd !== undefined && coingeckoOnly) return { usd: cgUsd, source: "coingecko_only" };
  return undefined;
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function offCount(g: XrdCandidate[]) {
  return g.filter((c) => c.offchain).length;
}
