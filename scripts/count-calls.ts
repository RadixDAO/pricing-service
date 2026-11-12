/** Count outbound calls in one price cycle against mainnet (database reads empty, writes discarded). */
import { readFileSync } from "node:fs";
import { parseTokensFile } from "../src/config";
import { runCycle } from "../src/cycle";
import { settings } from "../src/settings";

const stmt: any = {
  bind: () => stmt,
  first: async () => null,
  all: async () => ({ results: [] }),
  run: async () => ({ meta: { changes: 0 } }),
};
const db: any = { prepare: () => stmt, batch: async (ss: unknown[]) => ss.map(() => ({ results: [] })) };

const counts = new Map<string, number>();
const counting: typeof fetch = (input, init) => {
  const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const k = `${u.host}${u.pathname.replace(/\/tickers\/.*/, "/tickers/*")}`;
  counts.set(k, (counts.get(k) ?? 0) + 1);
  return fetch(input, init);
};

const cfg = parseTokensFile(JSON.parse(readFileSync("tokens.json", "utf8")));
const t0 = Date.now();
const { log } = await runCycle(db, cfg, settings({ DB: db }), Math.floor(Date.now() / 1000), counting);
console.log(log[0]);
console.log(`wall time ${Date.now() - t0} ms`);
for (const [k, n] of [...counts].sort()) console.log(`${String(n).padStart(3)}  ${k}`);
console.log(`${String([...counts.values()].reduce((a, b) => a + b, 0)).padStart(3)}  total`);
