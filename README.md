# RadixDAO pricing service

Token prices in USD for the Radix Wallet, run by RadixDAO as a Cloudflare Worker. The API is compatible with the retired [radixdlt/token-pricing-service](https://github.com/radixdlt/token-pricing-service).

The pricing logic comes from [linuxx5046/radix-price-minimal](https://github.com/linuxx5046/radix-price-minimal), a slimmed-down rewrite of the original service. Its Python version is kept in [reference/python](reference/python/) for comparison.

## How it works

A Cron Trigger runs a price cycle every minute:

1. It fetches XRD/USD from CoinGecko and from the MEXC and KuCoin order books, and every other token's CoinGecko price.
2. It reads every pool in [tokens.json](tokens.json) from the Radix Gateway, in two batched transaction previews. It also reads each pool's balances to measure how deep the pool is.
3. It fetches [Astrolescent](https://api.astrolescent.com/prices)'s aggregated prices as a backup (see below).
4. It checks the prices, as described in the next section.
5. It stores the result in D1.

API requests only read the stored prices. Wallet traffic never reaches the Gateway, except for LSU lookups, which are cached for 5 minutes. A cycle makes about 5 Gateway calls, however many people are using the Wallet. If the Gateway rejects a call (for example because of rate limiting), the cycle does not retry; it falls back to Astrolescent.

**Astrolescent** is only used for its prices in XRD, which are converted to USD with our own validated XRD/USD. Its own USD prices are not used: in November 2026 they implied XRD/USD rates anywhere from $0.00016 to $0.00067, depending on the token. It backs up pool reads only while the Gateway is unreachable, and only for tokens whose pools passed our checks at the last good read. It is never used for XRD/USD or for the stablecoin reference. While the Gateway is up, any difference from our pools is logged. Entries older than 15 minutes are ignored, and only the entries we need are cut out of its ~880 KB response, to save CPU time.

## How prices are checked

The old service failed when a stablecoin lost its peg and when pools drained: it assumed every stablecoin was worth $1 and used any pool that answered. This service only publishes a price once it has been checked:

- **XRD/USD needs two sources that agree, at least one of them off-chain.** The sources are CoinGecko, the MEXC and KuCoin order books (mid price, ignored if bid and ask are more than 5% apart), and the hUSDC pool on DefiPlaza treated as $1. Every source that answers gets a vote. As seen from Cloudflare, keyless CoinGecko and KuCoin are often rate limited and CoinPaprika's free tier is unusable, so several sources are needed; Gate.io is left out because its thin XRD market quoted 31% away from the others. On-chain pools alone can never set the XRD price, because on Radix they are cheap to move. Sources agree when they are within 5% of each other (6% for the on-chain pool). If only one off-chain source is reachable, or they disagree and nothing breaks the tie, a source is accepted only when it is within 10% of a price validated in the last hour.
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

Anyone can ask through an issue: **[Add or update a token](../../issues/new?template=add-token.yml)** or **[Remove a token](../../issues/new?template=remove-token.yml)**.

1. A workflow reads the request (never in a shell) and checks it against Radix mainnet with the same rules the service uses:
   - the address is a fungible resource, and its symbol is compared with the one requested
   - each pool answers, holds both tokens, and lists base and quote in the right order
   - each pool holds at least $100 (or the token's `min_depth_usd`), and a DefiPlaza pair's spread is acceptable
   - several pools agree within 10%, and a CoinGecko ID, if given, agrees within 10%
   - removals: the token is listed, and it isn't XRD, a USD reference, or the quote token for another token's pool
2. The result is posted on the issue. A failing request gets the `needs-changes` label; editing the issue runs the checks again.
3. A passing request gets a pull request that changes `tokens.json`. The workflow runs the full test suite against the new file first. Changing an existing token's pools uses the add form with the same symbol.
4. **A repository admin reviews and merges the PR.** Merging deploys the change. The merge is the approval step, because thin pools can be manipulated to push false prices into the Wallet.

Every Monday the **weekly recheck** re-reads all listed pools and opens a `token-recheck` issue for each token with problems: no usable pool (the token is shown without a price), or some pools failing.

Requests can't change XRD or the USD references (`usd_anchors`), set `coingecko_only` or `min_depth_usd`, or use DEXes other than Ociswap and DefiPlaza. Those changes go through a normal pull request.

To check pools by hand: `npm run probe` measures every pool in `tokens.json` against mainnet.

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

The custom domain `prices.radixdao.org` is set under `routes` in [wrangler.jsonc](wrangler.jsonc).

## Costs

About 1,440 database writes a day for state and 8,600 for history, which fits the free plan. On the free plan, a cron run gets 10 ms of CPU time. The cycle spends most of its time waiting on the network, but if the dashboard shows it hitting that limit, the $5/month paid plan raises it to 30 seconds.
