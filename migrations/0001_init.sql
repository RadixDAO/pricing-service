-- Service state: one JSON document with the latest validated prices and health.
-- Kept in one row so each price cycle costs a single row write.
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Price history for /price/historicalPrice, sampled every HISTORY_EVERY_SECS.
CREATE TABLE IF NOT EXISTS history (
  resource_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  usd_price REAL NOT NULL,
  PRIMARY KEY (resource_address, ts)
);

-- LSU redemption values (XRD per stake unit). NULL value = lookup failed, cached briefly.
CREATE TABLE IF NOT EXISTS lsu_cache (
  address TEXT PRIMARY KEY,
  xrd_redemption_value REAL,
  expires_at INTEGER NOT NULL
);

-- Alert conditions and the GitHub issue opened for each.
CREATE TABLE IF NOT EXISTS alerts (
  key TEXT PRIMARY KEY,
  message TEXT NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  bad_streak INTEGER NOT NULL DEFAULT 0,
  good_streak INTEGER NOT NULL DEFAULT 0,
  issue_number INTEGER
);
