/** D1 access. */
import type { LastGood } from "./consensus";

export interface PriceEntry {
  usd: number;
  /** unix seconds when this price was last validated */
  at: number;
  src: string;
}

export interface ServiceState {
  /** Last cycle attempt. */
  cycle_at?: number;
  /** Last cycle that published a validated XRD price. */
  last_ok_at?: number;
  status: "ok" | "degraded" | "stale";
  /** Current problems, human-readable. */
  issues: string[];
  xrd?: LastGood & { mode: string; sources: string[] };
  xrd_pending?: LastGood;
  /** resource address -> latest validated price */
  prices: Record<string, PriceEntry>;
  last_history_at?: number;
  last_prune_at?: number;
}

const STATE_KEY = "state";

export function emptyState(): ServiceState {
  return { status: "stale", issues: ["no price cycle has completed yet"], prices: {} };
}

export async function loadState(db: D1Database): Promise<ServiceState> {
  const row = await db.prepare("SELECT value FROM kv WHERE key = ?").bind(STATE_KEY).first<{ value: string }>();
  if (!row) return emptyState();
  try {
    return { ...emptyState(), ...JSON.parse(row.value) };
  } catch {
    return emptyState();
  }
}

export async function saveState(db: D1Database, st: ServiceState, now: number): Promise<void> {
  await db
    .prepare("INSERT INTO kv (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = ?2, updated_at = ?3")
    .bind(STATE_KEY, JSON.stringify(st), now)
    .run();
}

export async function writeHistory(db: D1Database, rows: Array<[string, number]>, ts: number): Promise<void> {
  if (rows.length === 0) return;
  const stmt = db.prepare("INSERT OR REPLACE INTO history (resource_address, ts, usd_price) VALUES (?, ?, ?)");
  await db.batch(rows.map(([addr, usd]) => stmt.bind(addr, ts, usd)));
}

export async function pruneHistory(db: D1Database, olderThan: number): Promise<number> {
  const r = await db.prepare("DELETE FROM history WHERE ts < ?").bind(olderThan).run();
  return r.meta.changes ?? 0;
}

/** Closest sample to `ts` within [day-1, day+2) UTC, as the original API did. */
export async function closestHistory(db: D1Database, addr: string, ts: number): Promise<{ ts: number; usd_price: number } | null> {
  const day = Math.floor(ts / 86400) * 86400;
  const lo = day - 86400;
  const hi = day + 2 * 86400;
  const [before, after] = await db.batch<{ ts: number; usd_price: number }>([
    db.prepare("SELECT ts, usd_price FROM history WHERE resource_address = ? AND ts <= ? AND ts > ? ORDER BY ts DESC LIMIT 1").bind(addr, ts, lo),
    db.prepare("SELECT ts, usd_price FROM history WHERE resource_address = ? AND ts >= ? AND ts < ? ORDER BY ts ASC LIMIT 1").bind(addr, ts, hi),
  ]);
  const cands = [...before.results, ...after.results];
  if (cands.length === 0) return null;
  return cands.reduce((a, b) => (Math.abs(b.ts - ts) < Math.abs(a.ts - ts) ? b : a));
}
