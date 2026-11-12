/** Runtime settings from Worker vars/secrets, with defaults tuned on mainnet in Nov 2026. */

export interface Env {
  DB: D1Database;
  GATEWAY_URL?: string;
  COINGECKO_URL?: string;
  COINGECKO_API_KEY?: string;
  COINPAPRIKA_URL?: string;
  COINPAPRIKA_XRD_ID?: string;
  /** Enables /price/historicalPrice. */
  API_KEY?: string;
  /** Fine-grained token with Issues read/write on ALERT_REPO. Alerts are only logged without it. */
  GITHUB_ALERT_TOKEN?: string;
  ALERT_REPO?: string;
  [k: string]: unknown;
}

export interface Settings {
  gatewayUrl: string;
  coingeckoUrl: string;
  coingeckoApiKey?: string;
  paprikaUrl: string;
  paprikaXrdId: string;
  apiKey?: string;
  githubToken?: string;
  alertRepo: string;

  httpTimeoutMs: number;
  /** Prices older than this are not served (the "last good price" window). */
  maxPriceAgeSecs: number;
  historyEverySecs: number;
  retentionDays: number;

  /** XRD/USD: off-chain sources must agree within this. */
  offchainAgreeTol: number;
  /** XRD/USD: an on-chain stablecoin pool counts as agreeing within this (thin pools drift). */
  onchainAgreeTol: number;
  singleSourceMaxAgeSecs: number;
  singleSourceMaxMove: number;
  jumpMaxMove: number;
  /** A stablecoin further than this from $1 is reported as depegged. */
  pegAlertTol: number;

  /** Pools shallower than this (both sides, USD) are not used. Per-token override: min_depth_usd. */
  minPoolDepthUsd: number;
  /** DefiPlaza probe trade size in USD, and the widest bid/ask spread accepted at that size. */
  plazaProbeUsd: number;
  plazaMaxSpread: number;
  /** Pools of one token that disagree with the deepest by more than this are dropped. */
  poolAgreeTol: number;

  coingeckoDefaultWeight: number;
  /** CoinGecko is ignored for a token when it differs from the pools by more than this. */
  coingeckoMaxDivergence: number;
  offchainMaxQuoteAgeSecs: number;

  lsuCacheSecs: number;
  maxAddresses: number;
  maxLsus: number;

  /** Consecutive bad cycles before an alert issue is opened, and good cycles before it is closed. */
  alertOpenAfter: number;
  alertCloseAfter: number;
}

export function settings(env: Env): Settings {
  const str = (k: string, d: string) => (typeof env[k] === "string" ? (env[k] as string) : d);
  const num = (k: string, d: number) => {
    const v = env[k];
    const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
    return Number.isFinite(n) ? n : d;
  };
  const apiKey = str("API_KEY", "");
  return {
    gatewayUrl: str("GATEWAY_URL", "https://mainnet.radixdlt.com"),
    coingeckoUrl: str("COINGECKO_URL", "https://api.coingecko.com/api/v3"),
    coingeckoApiKey: str("COINGECKO_API_KEY", "") || undefined,
    paprikaUrl: str("COINPAPRIKA_URL", "https://api.coinpaprika.com/v1"),
    paprikaXrdId: str("COINPAPRIKA_XRD_ID", "radix-dlt"),
    // A placeholder key would be an open door; treat it as unset.
    apiKey: apiKey && apiKey !== "change-me" && apiKey.length >= 16 ? apiKey : undefined,
    githubToken: str("GITHUB_ALERT_TOKEN", "") || undefined,
    alertRepo: str("ALERT_REPO", "RadixDAO/pricing-service"),

    httpTimeoutMs: num("HTTP_TIMEOUT_MS", 10_000),
    maxPriceAgeSecs: num("MAX_PRICE_AGE_SECS", 900),
    historyEverySecs: num("HISTORY_EVERY_SECS", 300),
    retentionDays: num("RETENTION_DAYS", 400),

    offchainAgreeTol: num("OFFCHAIN_AGREE_TOL", 0.03),
    onchainAgreeTol: num("ONCHAIN_AGREE_TOL", 0.06),
    singleSourceMaxAgeSecs: num("SINGLE_SOURCE_MAX_AGE_SECS", 3600),
    singleSourceMaxMove: num("SINGLE_SOURCE_MAX_MOVE", 0.1),
    jumpMaxMove: num("JUMP_MAX_MOVE", 0.15),
    pegAlertTol: num("PEG_ALERT_TOL", 0.1),

    minPoolDepthUsd: num("MIN_POOL_DEPTH_USD", 100),
    plazaProbeUsd: num("PLAZA_PROBE_USD", 10),
    plazaMaxSpread: num("PLAZA_MAX_SPREAD", 0.25),
    poolAgreeTol: num("POOL_AGREE_TOL", 0.1),

    coingeckoDefaultWeight: num("COINGECKO_DEFAULT_WEIGHT", 0.8),
    coingeckoMaxDivergence: num("COINGECKO_MAX_DIVERGENCE", 0.1),
    offchainMaxQuoteAgeSecs: num("OFFCHAIN_MAX_QUOTE_AGE_SECS", 900),

    lsuCacheSecs: num("LSU_CACHE_SECS", 300),
    maxAddresses: num("MAX_ADDRESSES", 500),
    maxLsus: num("MAX_LSUS", 100),

    alertOpenAfter: num("ALERT_OPEN_AFTER", 5),
    alertCloseAfter: num("ALERT_CLOSE_AFTER", 15),
  };
}
