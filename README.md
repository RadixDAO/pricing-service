# RadixDAO pricing service

Token prices in USD for the Radix Wallet, run by RadixDAO as a Cloudflare Worker. The API is compatible with the retired [radixdlt/token-pricing-service](https://github.com/radixdlt/token-pricing-service).

The pricing logic comes from [linuxx5046/radix-price-minimal](https://github.com/linuxx5046/radix-price-minimal), a slimmed-down rewrite of the original service. Its Python version is kept in [reference/python](reference/python/) for comparison.

## How it works

A Cron Trigger runs a price cycle every minute:

1. It fetches XRD/USD from CoinGecko and CoinPaprika, and every other token's CoinGecko price.
2. It reads every pool in [tokens.json](tokens.json) from the Radix Gateway, in two batched transaction previews. It also reads each pool's balances to measure how deep the pool is.
3. It fetches [Astrolescent](https://api.astrolescent.com/prices)'s aggregated prices as a backup (see below).
4. It checks the prices, as described in the next section.
5. It stores the result in D1.

API requests only read the stored prices. Wallet traffic never reaches the Gateway, except for LSU lookups, which are cached for 5 minutes. A cycle makes about 5 Gateway calls, however many people are using the Wallet. If the Gateway rejects a call (for example because of rate limiting), the cycle does not retry; it falls back to Astrolescent.

**Astrolescent** is only used for its prices in XRD, which are converted to USD with our own validated XRD/USD. Its own USD prices are not used: in November 2026 they implied XRD/USD rates anywhere from $0.00016 to $0.00067, depending on the token. It backs up pool reads only while the Gateway is unreachable, and only for tokens whose pools passed our checks at the last good read. It is never used for XRD/USD or for the stablecoin reference. While the Gateway is up, any difference from our pools is logged. Entries older than 15 minutes are ignored, and only the entries we need are cut out of its ~880 KB response, to save CPU time.

## How prices are checked

The old service failed when a stablecoin lost its peg and when pools drained: it assumed every stablecoin was worth $1 and used any pool that answered. This service only publishes a price once it has been checked:

- **XRD/USD needs two sources that agree, at least one of them off-chain.** The sources are CoinGecko, CoinPaprika, and the hUSDC pool on DefiPlaza treated as $1. On-chain pools alone can never set the XRD price, because on Radix they are cheap to move. Sources agree when they are within 5% of each other (6% for the on-chain pool). If only one off-chain source is reachable, or the two disagree and nothing breaks the tie, a source is accepted only when it is within 10% of a price validated in the last hour.
- **Stablecoins are never assumed to be $1.** Each stablecoin pool's price is checked against the validated XRD price. A stablecoin is shown at its real market price, and if it is more than 10% off its peg, an alert is raised.
- **Pools must be deep enough.** A pool holding less than `MIN_POOL_DEPTH_USD` (default $100, adjustable per token with `min_depth_usd`) is not used. For DefiPlaza pools, a $10 test trade must also show a buy/sell spread under 25%. When a token has several pools, pools that disagree with the deepest one are dropped.
- **CoinGecko and pools must agree.** If a token's CoinGecko price and its pool price differ by more than 10%, the price is withdrawn. For a bridged token, CoinGecko quotes the underlying coin and can't see a broken bridge. The exception is tokens marked `coingecko_only`, which use CoinGecko.
- **Large jumps wait for confirmation.** If XRD moves more than 15% in one minute, the move is published only after the next cycle confirms it.
- **When checks fail, prices are withdrawn.** The last validated price is served for up to 15 minutes. After that the token gets no price, so the Wallet shows nothing rather than a wrong value.

Problems lasting 5 minutes open a GitHub issue labelled `price-alert`. The issue closes automatically 15 minutes after the problem has cleared.

All thresholds are in [src/settings.ts](src/settings.ts) and can be overridden with Worker variables.

## API

| Endpoint | Notes |
|---|---|
| `POST /price/tokens` (and `-legacy`) | `{"currency":"USD","tokens":[...],"lsus":[...]}` → `{"tokens":[...],"lsus":[...]}`. Up to 500 tokens and 100 LSUs per request. |
| `POST /price/historicalPrice` (and `-legacy`) | Needs the `x-api-key` header. Returns the sample closest to `timestamp` within ±1 day; 424 if any token has none. History starts at launch. |
| `POST /tokens` | Configured tokens with a current price. |
| `GET /healthz` | Returns `Ok`, `Degraded` (prices are being served but something needs attention) or `Stale`, plus the list of current issues. Returns 503 when no price has been validated in the last 5 minutes. |

## Adding or removing a token

Edit [tokens.json](tokens.json) in a pull request. CI checks that the file is valid. A maintainer reviews and merges it, and the merge redeploys the service.

```jsonc
"SYMBOL": {
  "resource_address": "resource_rdx1…",
  "coingecko_id": "optional-coingecko-id",
  "pools": [
    { "dex": "ociswap", "component": "component_rdx1…", "base": "XRD", "quote": "SYMBOL" }
  ]
}
```

- Supported DEXes are `ociswap` and `defiplaza`. C9 has shut down.
- In each pool, one side must be the token itself. A pool without XRD must have the token as its `base`. It is then priced through its `quote` token.
- Before proposing a pool, run `npm run probe` to see each pool's price, depth and spread on mainnet.

## Development

```sh
npm install
npm test            # unit and end-to-end failure scenarios, in the Workers runtime
npm run typecheck
npm run probe       # measure every pool in tokens.json against mainnet
npx wrangler d1 migrations apply pricing-service --local
npm run dev         # local Worker; trigger a cycle with /__scheduled
```

## Deployment

Deployment needs a Cloudflare account with a D1 database:

```sh
npx wrangler d1 create pricing-service       # put the database_id in wrangler.jsonc
npx wrangler d1 migrations apply pricing-service --remote
npx wrangler secret put API_KEY              # for /price/historicalPrice
npx wrangler secret put COINGECKO_API_KEY    # free CoinGecko demo key
npx wrangler secret put GITHUB_ALERT_TOKEN   # fine-grained token: Issues read/write on this repo
npx wrangler deploy
```

The custom domain `price.radixdao.org` is set under `routes` in [wrangler.jsonc](wrangler.jsonc).

## Costs

About 1,440 database writes a day for state and 8,600 for history, which fits the free plan. On the free plan, a cron run gets 10 ms of CPU time. The cycle spends most of its time waiting on the network, but if the dashboard shows it hitting that limit, the $5/month paid plan raises it to 30 seconds.
