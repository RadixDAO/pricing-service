/**
 * Off-chain prices: CoinGecko for every mapped token, plus XRD/USD from exchange order books.
 *
 * Tested from Cloudflare's network (Nov 2026): keyless CoinGecko is rate limited (429, a free
 * demo key fixes it), CoinPaprika's free tier is used up per shared IP (402), KuCoin is often
 * rate limited (429), MEXC answers. Every source is optional: whichever answers gets a vote,
 * and the consensus rules decide. Gate.io is deliberately absent: its XRD market quoted 31%
 * away from every other source on ~$600 of daily volume.
 */
import { errMsg, type FetchFn } from "./gateway";

export interface XrdQuote {
  source: string;
  usd: number;
}

export interface OffchainPrices {
  /** coingecko_id -> USD */
  coingecko: Map<string, number>;
  /** XRD/USD from sources other than CoinGecko */
  xrd: XrdQuote[];
  errors: string[];
}

export interface OffchainSettings {
  coingeckoUrl: string; // "" disables
  coingeckoApiKey?: string;
  /** Names from XRD_SOURCES below. */
  xrdSources: string[];
  /** Order-book mid prices are rejected when bid/ask are further apart than this. */
  maxBookSpread: number;
  /** Quotes older than this are ignored. */
  maxQuoteAgeSecs: number;
  timeoutMs: number;
}

type Parsed = { usd: number; at?: number; bid?: number; ask?: number };

/** XRD/USD sources. USDT pairs are taken as USD; a USDT depeg would show as disagreement with CoinGecko. */
export const XRD_SOURCES: Record<string, { url: string; parse: (d: any) => Parsed }> = {
  mexc: {
    url: "https://api.mexc.com/api/v3/ticker/bookTicker?symbol=XRDUSDT",
    parse: (d) => book(Number(d?.bidPrice), Number(d?.askPrice)),
  },
  kucoin: {
    url: "https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=XRD-USDT",
    parse: (d) => ({ ...book(Number(d?.data?.bestBid), Number(d?.data?.bestAsk)), at: Number(d?.data?.time) / 1000 }),
  },
  coinpaprika: {
    url: "https://api.coinpaprika.com/v1/tickers/radix-dlt",
    parse: (d) => ({ usd: Number(d?.quotes?.USD?.price), at: Date.parse(d?.last_updated) / 1000 }),
  },
};

function book(bid: number, ask: number): Parsed {
  return { usd: Math.sqrt(bid * ask), bid, ask };
}

export async function fetchOffchain(ids: string[], s: OffchainSettings, now: number, fetchFn: FetchFn = fetch): Promise<OffchainPrices> {
  const out: OffchainPrices = { coingecko: new Map(), xrd: [], errors: [] };
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

  const xrdSource = async (name: string) => {
    const src = XRD_SOURCES[name];
    if (!src) return void out.errors.push(`${name}: unknown XRD source`);
    try {
      const p = src.parse(await getJson(src.url));
      if (!(p.usd > 0) || !Number.isFinite(p.usd)) throw new Error("no price");
      if (p.bid !== undefined && p.ask !== undefined && !(p.ask / p.bid - 1 <= s.maxBookSpread)) {
        throw new Error(`order book too wide (bid ${p.bid}, ask ${p.ask})`);
      }
      if (p.at && now - p.at > s.maxQuoteAgeSecs) throw new Error(`quote is ${Math.round(now - p.at)}s old`);
      out.xrd.push({ source: name, usd: p.usd });
    } catch (e) {
      out.errors.push(`${name}: ${errMsg(e)}`);
    }
  };

  await Promise.all([cg(), ...s.xrdSources.map(xrdSource)]);
  return out;
}
