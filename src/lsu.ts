/** LSU (liquid stake unit) redemption values: XRD in the validator's stake vault / LSU supply. */
import { XRD } from "./config";
import { errMsg, type Gateway } from "./gateway";

const FAILED_TTL_SECS = 60;

export async function lsuRedemptionValues(db: D1Database, gw: Gateway, addresses: string[], now: number, cacheSecs: number, log: (m: string) => void): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (addresses.length === 0) return out;

  const known = new Set<string>();
  // D1 caps bound parameters per query, so look up in slices.
  for (let i = 0; i < addresses.length; i += 90) {
    const slice = addresses.slice(i, i + 90);
    const { results } = await db
      .prepare(`SELECT address, xrd_redemption_value v FROM lsu_cache WHERE expires_at > ? AND address IN (${slice.map(() => "?").join(",")})`)
      .bind(now, ...slice)
      .all<{ address: string; v: number | null }>();
    for (const r of results) {
      known.add(r.address);
      if (r.v !== null) out.set(r.address, r.v);
    }
  }
  const need = addresses.filter((a) => !known.has(a));
  if (need.length === 0) return out;

  const fresh = new Map<string, number | null>(need.map((a) => [a, null]));
  const chunks: string[][] = [];
  for (let i = 0; i < need.length; i += 20) chunks.push(need.slice(i, i + 20));
  await Promise.all(
    chunks.map(async (chunk) => {
      try {
        const data = await gw.post("/state/entity/details", { addresses: chunk, aggregation_level: "Vault", explicit_metadata: ["validator"] });
        const supply = new Map<string, string>();
        const validators: string[] = [];
        for (const it of data.items) {
          const v = (it.metadata?.items ?? []).find((m: any) => m.key === "validator");
          const typed = v?.value?.typed;
          if (typed?.type === "GlobalAddress" && String(typed.value).startsWith("validator_")) {
            supply.set(it.address, it.details?.total_supply);
            validators.push(typed.value);
          }
        }
        if (validators.length === 0) return;
        const vdata = await gw.post("/state/entity/details", { addresses: [...new Set(validators)], aggregation_level: "Vault" });
        for (const val of vdata.items) {
          const st = val.details?.state;
          const su = st?.stake_unit_resource_address;
          const vault = st?.stake_xrd_vault?.entity_address;
          if (!su || !supply.has(su)) continue;
          const xrdRes = (val.fungible_resources?.items ?? []).find((r: any) => r.resource_address === XRD);
          const bal = (xrdRes?.vaults?.items ?? []).find((v: any) => v.vault_address === vault)?.amount;
          const red = Number(bal) / Number(supply.get(su));
          if (Number.isFinite(red) && red > 0) fresh.set(su, red);
        }
      } catch (e) {
        log(`LSU redemption failed for ${chunk.length} addresses: ${errMsg(e)}`);
      }
    }),
  );

  const stmt = db.prepare(
    "INSERT INTO lsu_cache (address, xrd_redemption_value, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(address) DO UPDATE SET xrd_redemption_value = ?2, expires_at = ?3",
  );
  // Cache failures briefly too, so a client cannot make every request fan out to the Gateway.
  await db.batch([...fresh].map(([a, v]) => stmt.bind(a, v, now + (v === null ? FAILED_TTL_SECS : cacheSecs))));
  for (const [a, v] of fresh) if (v !== null) out.set(a, v);
  return out;
}
