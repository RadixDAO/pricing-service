/** Off-chain prices: CoinGecko (all mapped tokens) and CoinPaprika (XRD only, as a second opinion). */
import { errMsg, type FetchFn } from "./gateway";

export interface OffchainPrices {
  /** coingecko_id -> USD */
  coingecko: Map<string, number>;
  /** XRD/USD from CoinPaprika */
  paprikaXrd?: number;
  errors: string[];
}

export interface OffchainSettings {
  coingeckoUrl: string; // "" disables
  coingeckoApiKey?: string;
  paprikaUrl: string; // "" disables
  paprikaXrdId: string;
  /** Quotes older than this are ignored. */
  maxQuoteAgeSecs: number;
  timeoutMs: number;
}

export async function fetchOffchain(ids: string[], s: OffchainSettings, now: number, fetchFn: FetchFn = fetch): Promise<OffchainPrices> {
  const out: OffchainPrices = { coingecko: new Map(), errors: [] };
  const getJson = async (url: string, headers: Record<string, string> = {}) => {
    const r = await fetchFn(url, {
      headers: { Accept: "application/json", "User-Agent": "radixdao-pricing-service", ...headers },
      signal: AbortSignal.timeout(s.timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as any;
  };

  const cg = async () => {
    if (!s.coingeckoUrl || ids.length === 0) return;
    const q = new URLSearchParams({ ids: [...new Set(ids)].sort().join(","), vs_currencies: "usd", include_last_updated_at: "true" });
    const headers: Record<string, string> = s.coingeckoApiKey ? { "x-cg-demo-api-key": s.coingeckoApiKey } : {};
    try {
      const d = await getJson(`${s.coingeckoUrl}/simple/price?${q}`, headers);
      for (const id of ids) {
        const e = d?.[id];
        const usd = Number(e?.usd);
        const at = Number(e?.last_updated_at);
        if (!(usd > 0)) continue;
        if (at && now - at > s.maxQuoteAgeSecs) {
          out.errors.push(`coingecko ${id}: quote is ${Math.round(now - at)}s old`);
          continue;
        }
        out.coingecko.set(id, usd);
      }
    } catch (e) {
      out.errors.push(`coingecko: ${errMsg(e)}`);
    }
  };

  const paprika = async () => {
    if (!s.paprikaUrl) return;
    try {
      const d = await getJson(`${s.paprikaUrl}/tickers/${encodeURIComponent(s.paprikaXrdId)}`);
      const usd = Number(d?.quotes?.USD?.price);
      const at = Date.parse(d?.last_updated) / 1000;
      if (!(usd > 0)) throw new Error("no USD price");
      if (at && now - at > s.maxQuoteAgeSecs) throw new Error(`quote is ${Math.round(now - at)}s old`);
      out.paprikaXrd = usd;
    } catch (e) {
      out.errors.push(`coinpaprika: ${errMsg(e)}`);
    }
  };

  await Promise.all([cg(), paprika()]);
  return out;
}
