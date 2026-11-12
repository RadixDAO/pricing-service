/** HTTP API, compatible with radixdlt/token-pricing-service as used by the Radix Wallet. */
import { type TokensFile, XRD } from "./config";
import { type FetchFn, makeGateway } from "./gateway";
import { lsuRedemptionValues } from "./lsu";
import type { Settings } from "./settings";
import { closestHistory, loadState, type ServiceState } from "./store";

const MAX_BODY = 256 * 1024;

class ApiError extends Error {
  constructor(readonly status: number, readonly detail: string) {
    super(detail);
  }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// State is one small JSON row; keep it per isolate for a few seconds to save D1 reads.
let cached: { st: ServiceState; at: number } | undefined;
async function state(db: D1Database, nowMs: number): Promise<ServiceState> {
  if (cached && nowMs - cached.at < 10_000) return cached.st;
  const st = await loadState(db);
  cached = { st, at: nowMs };
  return st;
}
export function clearStateCache() {
  cached = undefined;
}

export async function handle(req: Request, db: D1Database, cfg: TokensFile, s: Settings, nowMs = Date.now(), fetchFn: FetchFn = fetch): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const now = Math.floor(nowMs / 1000);
  try {
    if (req.method === "GET" && path === "/healthz") return health(await state(db, nowMs), now, s);
    if (req.method !== "POST") throw new ApiError(404, "Not Found");
    switch (path) {
      case "/price/tokens":
      case "/price/tokens-legacy":
        return json(200, await prices(await body(req), await state(db, nowMs), db, now, s, fetchFn));
      case "/price/historicalPrice":
      case "/price/historicalPrice-legacy":
        return json(200, await historical(req, db, s));
      case "/tokens":
        return json(200, tokenList(await state(db, nowMs), cfg, now, s));
      default:
        throw new ApiError(404, "Not Found");
    }
  } catch (e) {
    if (e instanceof ApiError) return json(e.status, { detail: e.detail });
    console.error(`error in ${path}:`, e);
    return json(500, { detail: "Internal Server Error" });
  }
}

async function body(req: Request): Promise<Record<string, unknown>> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BODY) throw new ApiError(413, "body too large");
  const text = await req.text();
  if (text.length > MAX_BODY) throw new ApiError(413, "body too large");
  let d: unknown;
  try {
    d = JSON.parse(text || "null");
  } catch {
    throw new ApiError(422, "invalid JSON");
  }
  if (typeof d !== "object" || d === null || Array.isArray(d)) throw new ApiError(422, "body must be a JSON object");
  return d as Record<string, unknown>;
}

function addrList(b: Record<string, unknown>, key: string, max: number): string[] {
  const v = b[key];
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw new ApiError(422, `${key} must be a list of strings`);
  if (v.length > max) throw new ApiError(422, `too many ${key} (max ${max})`);
  return [...new Set(v as string[])];
}

const isoNaive = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 19);

function fresh(st: ServiceState, addr: string, now: number, s: Settings) {
  const p = st.prices[addr];
  return p && now - p.at <= s.maxPriceAgeSecs ? p : undefined;
}

async function prices(b: Record<string, unknown>, st: ServiceState, db: D1Database, now: number, s: Settings, fetchFn: FetchFn) {
  const cur = b.currency;
  if (typeof cur !== "string") throw new ApiError(422, "currency is required");
  if (cur.toUpperCase() !== "USD") throw new ApiError(400, `Currency: ${cur} not supported. Supported currencies: USD`);
  const tokens = addrList(b, "tokens", s.maxAddresses);
  const lsus = addrList(b, "lsus", s.maxLsus);

  const resT = [];
  for (const a of tokens) {
    const p = fresh(st, a, now, s);
    if (p) resT.push({ resource_address: a, usd_price: p.usd, last_updated_at: isoNaive(p.at) });
  }
  const resL = [];
  const xrd = fresh(st, XRD, now, s);
  if (lsus.length && xrd) {
    const gw = makeGateway(s.gatewayUrl, fetchFn, s.httpTimeoutMs);
    const red = await lsuRedemptionValues(db, gw, lsus, now, s.lsuCacheSecs, (m) => console.warn(m));
    for (const [a, v] of red) resL.push({ resource_address: a, xrd_redemption_value: v, usd_price: xrd.usd * v });
  }
  return { tokens: resT, lsus: resL };
}

async function historical(req: Request, db: D1Database, s: Settings) {
  if (!s.apiKey || !(await keyMatches(req.headers.get("x-api-key"), s.apiKey))) throw new ApiError(401, "Invalid or missing API Key");
  const b = await body(req);
  const tokens = addrList(b, "tokens", s.maxAddresses);
  if (tokens.length === 0) throw new ApiError(400, "Token list must be provided.");
  // The old service also accepted a numeric string.
  const raw = b.timestamp;
  const ts = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isSafeInteger(ts)) throw new ApiError(400, "Timestamp must be an integer (unix seconds).");
  const found: Record<string, { usd_price: number; last_updated_at: string }> = {};
  const missing: string[] = [];
  for (const a of tokens) {
    const r = await closestHistory(db, a, ts);
    if (r) found[a] = { usd_price: r.usd_price, last_updated_at: isoNaive(r.ts) };
    else missing.push(a);
  }
  if (missing.length) throw new ApiError(424, `Price missing for tokens: ${missing.join(", ")}`);
  return { prices: found };
}

/** Constant-time comparison (hashing first makes the lengths equal). */
async function keyMatches(given: string | null, expected: string): Promise<boolean> {
  if (!given) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(expected))]);
  return crypto.subtle.timingSafeEqual(a, b);
}

function tokenList(st: ServiceState, cfg: TokensFile, now: number, s: Settings) {
  const out = [];
  let i = 0;
  for (const [sym, t] of Object.entries(cfg.tokens)) {
    i++;
    const p = fresh(st, t.resource_address, now, s);
    if (p) out.push({ id: i, resource_address: t.resource_address, symbol: sym, name: t.name ?? sym, price: p.usd, currency: "USD" });
  }
  return out;
}

function health(st: ServiceState, now: number, s: Settings): Response {
  const okAge = st.last_ok_at ? now - st.last_ok_at : undefined;
  const serving = okAge !== undefined && okAge <= s.maxPriceAgeSecs;
  const status = !serving ? "Stale" : st.status === "ok" && okAge! <= 300 ? "Ok" : "Degraded";
  return json(okAge !== undefined && okAge <= 300 ? 200 : 503, {
    Everything: status,
    last_cycle_age_secs: st.cycle_at ? now - st.cycle_at : null,
    last_validated_age_secs: okAge ?? null,
    xrd_usd: st.xrd && serving ? st.xrd.value : null,
    xrd_sources: st.xrd?.sources ?? [],
    issues: st.issues,
    tokens: Object.keys(st.prices).filter((a) => fresh(st, a, now, s)).length,
  });
}
