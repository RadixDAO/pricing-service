/** tokens.json: which tokens are priced and from which pools. */

export const XRD = "resource_rdx1tknxxxxxxxxxradxrdxxxxxxxxx009923554798xxxxxxxxxradxrd";

export const DEXES = ["ociswap", "defiplaza"] as const;
export type Dex = (typeof DEXES)[number];

export interface PoolConfig {
  dex: Dex;
  component: string;
  /** Symbols as keys of `tokens`. One of base/quote is the token the pool is listed under. */
  base: string;
  quote: string;
  blueprint_name?: string;
}

export interface TokenConfig {
  resource_address: string;
  name?: string;
  /** CoinGecko ID used to blend with (and cross-check) the on-chain price. */
  coingecko_id?: string;
  /** Share of CoinGecko in the blended price, 0..1. */
  coingecko_weight?: number;
  /**
   * Allow publishing the CoinGecko price when no healthy pool exists.
   * Off by default: for a bridged token, the CoinGecko price is that of the
   * underlying asset and would hide a broken bridge.
   */
  coingecko_only?: boolean;
  /** Overrides MIN_POOL_DEPTH_USD for this token's pools. */
  min_depth_usd?: number;
  pools: PoolConfig[];
}

export interface TokensFile {
  /** Stablecoins whose pools give an on-chain XRD/USD reading (assumed $1, then checked). */
  usd_anchors: string[];
  tokens: Record<string, TokenConfig>;
}

const RESOURCE_RE = /^resource_rdx1[0-9a-z]{54}$/;
const COMPONENT_RE = /^component_rdx1[0-9a-z]{54}$/;
const SYMBOL_RE = /^[A-Za-z0-9._-]{1,32}$/;
const CG_ID_RE = /^[a-z0-9-]{1,100}$/;

/** Returns a list of problems; empty means valid. */
export function validateTokensFile(d: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(d)) return ["tokens file must be a JSON object"];
  const tokens = d.tokens;
  const anchors = d.usd_anchors;
  if (!isObj(tokens)) return ["`tokens` must be an object"];
  if (!Array.isArray(anchors) || anchors.length === 0) errs.push("`usd_anchors` must be a non-empty array");

  const syms = Object.keys(tokens);
  const seenAddr = new Map<string, string>();
  const seenPool = new Map<string, string>();

  for (const sym of syms) {
    const t = tokens[sym];
    const at = `tokens.${sym}`;
    if (!SYMBOL_RE.test(sym)) errs.push(`${at}: invalid symbol`);
    if (!isObj(t)) {
      errs.push(`${at}: must be an object`);
      continue;
    }
    if (typeof t.resource_address !== "string" || !RESOURCE_RE.test(t.resource_address)) {
      errs.push(`${at}.resource_address: not a mainnet resource address`);
    } else {
      const prev = seenAddr.get(t.resource_address);
      if (prev) errs.push(`${at}.resource_address: same address as ${prev}`);
      seenAddr.set(t.resource_address, sym);
    }
    if (t.name !== undefined && (typeof t.name !== "string" || t.name.length > 100)) errs.push(`${at}.name: invalid`);
    if (t.coingecko_id !== undefined && (typeof t.coingecko_id !== "string" || !CG_ID_RE.test(t.coingecko_id))) {
      errs.push(`${at}.coingecko_id: invalid`);
    }
    if (
      t.coingecko_weight !== undefined &&
      (typeof t.coingecko_weight !== "number" || t.coingecko_weight < 0 || t.coingecko_weight > 1)
    ) {
      errs.push(`${at}.coingecko_weight: must be a number between 0 and 1`);
    }
    if (t.coingecko_only !== undefined && typeof t.coingecko_only !== "boolean") errs.push(`${at}.coingecko_only: must be boolean`);
    if (t.min_depth_usd !== undefined && (typeof t.min_depth_usd !== "number" || !(t.min_depth_usd >= 0))) {
      errs.push(`${at}.min_depth_usd: must be a non-negative number`);
    }
    if (t.coingecko_only && !t.coingecko_id) errs.push(`${at}: coingecko_only needs a coingecko_id`);
    if (!Array.isArray(t.pools)) {
      errs.push(`${at}.pools: must be an array`);
      continue;
    }
    t.pools.forEach((p: unknown, i: number) => {
      const ap = `${at}.pools[${i}]`;
      if (!isObj(p)) return errs.push(`${ap}: must be an object`);
      if (!DEXES.includes(p.dex as Dex)) errs.push(`${ap}.dex: must be one of ${DEXES.join(", ")}`);
      if (typeof p.component !== "string" || !COMPONENT_RE.test(p.component)) errs.push(`${ap}.component: not a mainnet component address`);
      for (const side of ["base", "quote"] as const) {
        const s = p[side];
        if (typeof s !== "string" || !(s in tokens)) errs.push(`${ap}.${side}: must be a symbol listed in tokens`);
      }
      if (p.base === p.quote) errs.push(`${ap}: base and quote are the same`);
      if (p.base !== sym && p.quote !== sym) errs.push(`${ap}: one of base/quote must be ${sym}`);
      if (p.base !== "XRD" && p.quote !== "XRD" && p.base !== sym) {
        errs.push(`${ap}: a pool without XRD must have ${sym} as its base (it is priced via the quote token)`);
      }
      const key = `${p.component}|${p.base}|${p.quote}`;
      const prev = seenPool.get(key);
      if (prev) errs.push(`${ap}: same pool already listed under ${prev}`);
      seenPool.set(key, sym);
    });
    if (sym !== "XRD" && t.pools.length === 0 && !t.coingecko_only) {
      errs.push(`${at}: needs at least one pool (or coingecko_only)`);
    }
  }

  const xrd = tokens.XRD;
  if (!isObj(xrd)) errs.push("tokens.XRD is required");
  else if (xrd.resource_address !== XRD) errs.push("tokens.XRD.resource_address must be the XRD resource");

  if (Array.isArray(anchors)) {
    for (const a of anchors) {
      const t = typeof a === "string" ? tokens[a] : undefined;
      if (!isObj(t)) errs.push(`usd_anchors: ${String(a)} is not a listed token`);
      else if (!Array.isArray(t.pools) || !t.pools.some((p: any) => p?.base === "XRD" || p?.quote === "XRD")) {
        errs.push(`usd_anchors: ${a} needs a pool against XRD`);
      }
    }
  }
  return errs;
}

export function parseTokensFile(d: unknown): TokensFile {
  const errs = validateTokensFile(d);
  if (errs.length) throw new Error(`invalid tokens file:\n- ${errs.join("\n- ")}`);
  return d as TokensFile;
}

function isObj(x: unknown): x is Record<string, any> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
