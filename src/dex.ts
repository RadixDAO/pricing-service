/** Reading spot prices from Ociswap and DefiPlaza pools, batched into a few Gateway previews. */
import type { PoolConfig } from "./config";
import { batchCalls, type Call, type Gateway } from "./gateway";

export interface PoolReading {
  pool: PoolConfig;
  /** Units of `base` per unit of `quote` (the original repo's convention). */
  raw?: number;
  /** DefiPlaza only: ask/bid - 1 at the probe size, fee excluded. */
  spread?: number;
  error?: string;
}

export const poolKey = (p: PoolConfig) => `${p.component}|${p.base}|${p.quote}`;

/**
 * A DefiPlaza PlazaPair's p0 (quote per base) and token addresses, read from its component state.
 * Older PlazaPair packages on mainnet have no get_state/get_tokens methods, but every version
 * stores these fields, so the state works for all of them.
 */
export function plazaState(state: any): { p0?: number; base?: string; quote?: string } {
  const fields: any[] = state?.fields ?? [];
  const named = (name: string) => fields.find((f) => f?.field_name === name);
  const pairState = named("state");
  const p0 = Number((pairState?.fields ?? []).find((f: any) => f?.field_name === "p0")?.value);
  return {
    p0: p0 > 0 && isFinite(p0) ? p0 : undefined,
    base: named("base_address")?.value,
    quote: named("quote_address")?.value,
  };
}

/**
 * @param probeQuoteUnits size of the DefiPlaza probe trade, in units of the pair's quote token;
 *        receives the pool and p0 (quote per base). Return undefined to use the default of 100.
 * @param states component states (from `holdings`); DefiPlaza pairs with p0 in their state skip
 *        the get_state call, which older PlazaPair packages do not have.
 */
export async function readPools(
  gw: Gateway,
  epoch: number,
  pools: PoolConfig[],
  probeQuoteUnits: (p: PoolConfig, spot: Map<string, number>) => number | undefined,
  states?: Map<string, any>,
): Promise<Map<string, PoolReading>> {
  const out = new Map<string, PoolReading>();
  const comps = [...new Map(pools.map((p) => [p.component, p])).values()];
  const ociRaw = new Map<string, number>();
  const plazaP0 = new Map<string, number>();
  const errors = new Map<string, string>();
  for (const p of comps) {
    const p0 = p.dex === "defiplaza" ? plazaState(states?.get(p.component)).p0 : undefined;
    if (p0 !== undefined) plazaP0.set(p.component, p0);
  }

  // Stage A: spot price (Ociswap) or pair state (DefiPlaza, unless known), one call per component.
  const needA = comps.filter((p) => !plazaP0.has(p.component));
  const stageA: Call[] = needA.map((p) => ({
    component: p.component,
    method: p.dex === "ociswap" ? "price_sqrt" : "get_state",
  }));
  const resA = await batchCalls(gw, epoch, stageA);
  needA.forEach((p, i) => {
    const r = resA[i];
    try {
      if (!r.ok) throw new Error(r.error);
      if (p.dex === "ociswap") {
        const v = r.value;
        const s = Number(v.fields ? v.fields[0].value : v.value);
        const raw = s * s;
        if (!(raw > 0) || !isFinite(raw)) throw new Error("price <= 0");
        ociRaw.set(p.component, raw);
      } else {
        const p0 = Number(field(r.value, "p0", 0).value);
        if (!(p0 > 0)) throw new Error("p0 <= 0");
        plazaP0.set(p.component, p0);
      }
    } catch (e) {
      errors.set(p.component, e instanceof Error ? e.message : String(e));
    }
  });

  // Rough XRD price per symbol from stage A, used only to size the DefiPlaza probes.
  const spot = new Map<string, number>();
  for (const p of pools) {
    const raw = ociRaw.get(p.component) ?? (plazaP0.has(p.component) ? 1 / plazaP0.get(p.component)! : undefined);
    if (raw === undefined) continue;
    if (p.base === "XRD" && !spot.has(p.quote)) spot.set(p.quote, raw);
    if (p.quote === "XRD" && !spot.has(p.base)) spot.set(p.base, 1 / raw);
  }

  // Stage B: DefiPlaza quotes in both directions at the probe size.
  const plazaPools = comps.filter((p) => p.dex === "defiplaza" && plazaP0.has(p.component));
  const probes = plazaPools.map((p) => {
    const p0 = plazaP0.get(p.component)!;
    const qIn = probeQuoteUnits(p, spot) ?? 100;
    return { p, p0, qIn, bIn: qIn / p0 };
  });
  const stageB: Call[] = probes.flatMap(({ p, qIn, bIn }) => [
    { component: p.component, method: "quote", args: [`Decimal("${fmtDec(bIn)}")`, "false"] },
    { component: p.component, method: "quote", args: [`Decimal("${fmtDec(qIn)}")`, "true"] },
  ]);
  const resB = await batchCalls(gw, epoch, stageB);
  const plazaRaw = new Map<string, { raw: number; spread: number }>();
  probes.forEach(({ p, qIn, bIn }, i) => {
    const sell = resB[2 * i];
    const buy = resB[2 * i + 1];
    try {
      if (!sell.ok) throw new Error(sell.error);
      if (!buy.ok) throw new Error(buy.error);
      // quote() returns (output - fee, remainder, fee, allocation, state); the fee is in output units.
      const gross = (o: any) => {
        const f = o.fields;
        return [Number(f[0].value) + Number(f[2].value), Number(f[1].value)] as const;
      };
      const [qOut, bRem] = gross(sell.value);
      const [bOut, qRem] = gross(buy.value);
      if (!(qOut > 0) || !(bOut > 0) || bRem >= bIn || qRem >= qIn) throw new Error("no liquidity on one side");
      const bid = qOut / (bIn - bRem); // quote received per base sold
      const ask = (qIn - qRem) / bOut; // quote paid per base bought
      plazaRaw.set(p.component, { raw: 1 / Math.sqrt(bid * ask), spread: ask / bid - 1 });
    } catch (e) {
      errors.set(p.component, e instanceof Error ? e.message : String(e));
    }
  });

  for (const p of pools) {
    const key = poolKey(p);
    const err = errors.get(p.component);
    if (p.dex === "ociswap" && ociRaw.has(p.component)) out.set(key, { pool: p, raw: ociRaw.get(p.component) });
    else if (p.dex === "defiplaza" && plazaRaw.has(p.component)) out.set(key, { pool: p, ...plazaRaw.get(p.component)! });
    else out.set(key, { pool: p, error: err ?? "no reading" });
  }
  return out;
}

function field(obj: any, name: string, idx: number): any {
  for (const f of obj.fields ?? []) if (f.field_name === name) return f;
  return obj.fields[idx];
}

/** Number -> manifest Decimal literal: no exponent, at most 18 decimals. */
export function fmtDec(x: number): string {
  if (!isFinite(x) || x <= 0 || x >= 1e21) throw new Error(`cannot express ${x} as a Decimal`);
  const s = x.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  if (s === "0") throw new Error(`${x} rounds to zero`);
  return s;
}
