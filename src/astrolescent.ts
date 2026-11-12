/**
 * Astrolescent's aggregated DEX prices (https://api.astrolescent.com/prices).
 *
 * Only `tokenPriceXRD` is used: its USD prices are computed at inconsistent XRD/USD rates
 * (Nov 2026: implied rates from $0.00016 to $0.00067 across tokens), so USD always comes from
 * our own validated XRD/USD. Entries not updated recently are ignored; many are years old.
 */
import { errMsg, type FetchFn } from "./gateway";

export interface AstroPrice {
  xrdPerToken: number;
  updatedAt: number; // unix seconds
}

/**
 * The endpoint returns ~880 KB for ~880 tokens and has no filter. Parsing all of it costs
 * ~5 ms of CPU, half the free plan's budget per cron run, so only the entries for the
 * requested addresses are cut out and parsed.
 */
export async function fetchAstrolescent(
  url: string,
  addresses: string[],
  now: number,
  maxAgeSecs: number,
  timeoutMs: number,
  fetchFn: FetchFn = fetch,
): Promise<{ prices: Map<string, AstroPrice>; error?: string }> {
  const prices = new Map<string, AstroPrice>();
  if (!url) return { prices };
  try {
    const r = await fetchFn(url, {
      headers: { Accept: "application/json", "User-Agent": "radixdao-pricing-service" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const text = await r.text();
    for (const a of addresses) {
      const obj = extractObject(text, a);
      if (!obj) continue;
      let e: any;
      try {
        e = JSON.parse(obj);
      } catch {
        continue;
      }
      const xrdPerToken = Number(e.tokenPriceXRD);
      const updatedAt = Date.parse(e.updatedAt) / 1000;
      if (!(xrdPerToken > 0) || !Number.isFinite(xrdPerToken) || !(updatedAt > 0)) continue;
      if (now - updatedAt > maxAgeSecs) continue;
      prices.set(a, { xrdPerToken, updatedAt });
    }
    return { prices };
  } catch (e) {
    return { prices, error: `astrolescent: ${errMsg(e)}` };
  }
}

/** The JSON object value for `"key":{…}` in a top-level object, found without parsing the rest. */
export function extractObject(text: string, key: string): string | undefined {
  const marker = `${JSON.stringify(key)}:`;
  let i = text.indexOf(marker);
  if (i < 0) return undefined;
  i += marker.length;
  while (text[i] === " " || text[i] === "\n" || text[i] === "\r" || text[i] === "\t") i++;
  if (text[i] !== "{") return undefined;
  let depth = 0;
  let inStr = false;
  for (let j = i; j < text.length; j++) {
    const c = text.charCodeAt(j);
    if (inStr) {
      if (c === 92 /* \ */) j++;
      else if (c === 34 /* " */) inStr = false;
    } else if (c === 34) inStr = true;
    else if (c === 123 /* { */) depth++;
    else if (c === 125 /* } */ && --depth === 0) return text.slice(i, j + 1);
  }
  return undefined;
}
