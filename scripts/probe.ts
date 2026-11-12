/**
 * Measure every pool in tokens.json against mainnet: spot price, depth, DefiPlaza spread,
 * and each USD anchor's implied peg against the off-chain XRD price.
 *
 *   npx tsx scripts/probe.ts [tokens.json] [--probe-usd 1000] [--raw]
 */
import { readFileSync } from "node:fs";
import { parseTokensFile, XRD } from "../src/config";
import { poolKey, readPools } from "../src/dex";
import { batchCalls, getEpoch, holdings, makeGateway } from "../src/gateway";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--")) ?? "tokens.json";
const probeUsd = Number(args[args.indexOf("--probe-usd") + 1]) || 1000;
const showRaw = args.includes("--raw");
const GW = process.env.GATEWAY_URL ?? "https://mainnet.radixdlt.com";

const cfg = parseTokensFile(JSON.parse(readFileSync(file, "utf8")));
const gw = makeGateway(GW);

const [epoch, cg, cp] = await Promise.all([
  getEpoch(gw),
  fetch("https://api.coingecko.com/api/v3/simple/price?ids=radix&vs_currencies=usd").then((r) => r.json() as Promise<any>).catch(() => null),
  fetch("https://api.mexc.com/api/v3/ticker/bookTicker?symbol=XRDUSDT").then((r) => r.json() as Promise<any>).catch(() => null),
]);
const xrdCg: number | undefined = cg?.radix?.usd;
const xrdCp: number | undefined = cp?.bidPrice ? Math.sqrt(Number(cp.bidPrice) * Number(cp.askPrice)) : undefined;
const xrdUsd = xrdCg ?? xrdCp!;
console.log(`gateway=${GW} epoch=${epoch}`);
console.log(`XRD/USD  CoinGecko=${xrdCg}  MEXC=${xrdCp}  probe=$${probeUsd} = ${(probeUsd / xrdUsd).toFixed(0)} XRD\n`);

const pools = Object.values(cfg.tokens).flatMap((t) => t.pools);
const probeXrd = probeUsd / xrdUsd;
const t0 = Date.now();
const readings = await readPools(gw, epoch, pools, (p, spot) => {
  if (p.quote === "XRD") return probeXrd;
  const x = spot.get(p.quote);
  return x ? probeXrd / x : undefined;
});
const hold = await holdings(gw, pools.map((p) => p.component));
console.log(`pool reads + holdings: ${Date.now() - t0} ms\n`);

const addr = (s: string) => cfg.tokens[s]?.resource_address;
const xrdPer = new Map<string, number>([["XRD", 1]]);
// resolve XRD price per symbol from pools against XRD first, then via other quotes
for (let pass = 0; pass < 3; pass++) {
  for (const [sym, t] of Object.entries(cfg.tokens)) {
    const vals: number[] = [];
    for (const p of t.pools) {
      const r = readings.get(poolKey(p));
      if (!r?.raw) continue;
      if (p.base === "XRD") vals.push(r.raw);
      else if (p.quote === "XRD") vals.push(1 / r.raw);
      else if (xrdPer.has(p.quote)) vals.push((1 / r.raw) * xrdPer.get(p.quote)!);
    }
    if (vals.length) xrdPer.set(sym, vals.reduce((a, b) => a + b) / vals.length);
  }
}

const rows: string[][] = [];
for (const [sym, t] of Object.entries(cfg.tokens)) {
  for (const p of t.pools) {
    const r = readings.get(poolKey(p))!;
    let v: number | undefined;
    if (r.raw) v = p.base === "XRD" ? r.raw : p.quote === "XRD" ? 1 / r.raw : xrdPer.has(p.quote) ? (1 / r.raw) * xrdPer.get(p.quote)! : undefined;
    const srcs = [p.component, ...(hold.get(p.component)?.refs ?? [])].filter((s) => hold.has(s));
    let xrdAmt = srcs.reduce((a, s) => a + (hold.get(s)!.amounts.get(XRD) ?? 0), 0);
    if (xrdAmt === 0 && p.base !== "XRD" && p.quote !== "XRD") {
      const q = srcs.reduce((a, s) => a + (hold.get(s)!.amounts.get(addr(p.quote)!) ?? 0), 0);
      xrdAmt = q * (xrdPer.get(p.quote) ?? 0);
    }
    const depthUsd = 2 * xrdAmt * xrdUsd;
    rows.push([
      sym,
      p.dex,
      p.blueprint_name ?? "",
      v !== undefined ? v.toPrecision(8) : "FAIL",
      v !== undefined ? `$${(v * xrdUsd).toPrecision(6)}` : "",
      `$${Math.round(depthUsd).toLocaleString("en-US")}`,
      r.spread !== undefined ? `${(r.spread * 100).toFixed(2)}%` : "",
      r.error ?? "",
    ]);
  }
}
const head = ["token", "dex", "blueprint", "XRD/token", "USD", "depth~USD", "spread", "error"];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
const line = (r: string[]) => r.map((c, i) => c.padEnd(w[i])).join("  ");
console.log(line(head));
for (const r of rows.sort((a, b) => a[0].localeCompare(b[0]))) console.log(line(r));

console.log("\nUSD anchors (implied price if XRD = off-chain price):");
for (const a of cfg.usd_anchors) {
  for (const p of cfg.tokens[a].pools) {
    const r = readings.get(poolKey(p))!;
    if (!r.raw) {
      console.log(`  ${a} ${p.dex}: FAIL ${r.error}`);
      continue;
    }
    const xrdPerAnchor = p.base === "XRD" ? r.raw : 1 / r.raw;
    console.log(`  ${a} ${p.dex} ${p.component.slice(0, 24)}…  $${(xrdPerAnchor * xrdUsd).toFixed(4)}  -> implies XRD $${(1 / xrdPerAnchor).toPrecision(5)}`);
  }
}

// DefiPlaza fee check on the anchor: compare mid with and without adding the fee back.
const anchorPlaza = cfg.usd_anchors.flatMap((a) => cfg.tokens[a].pools).filter((p) => p.dex === "defiplaza");
for (const p of anchorPlaza) {
  console.log(`\nDefiPlaza fee check ${p.base}/${p.quote} ${p.component}`);
  const [st] = await batchCalls(gw, epoch, [{ component: p.component, method: "get_state" }]);
  if (!st.ok) {
    console.log("  get_state failed", st.error);
    continue;
  }
  const f = st.value.fields;
  const p0 = Number(f.find((x: any) => x.field_name === "p0")?.value ?? f[0].value);
  const shortage = f.find((x: any) => x.field_name === "shortage");
  console.log(`  p0=${p0} shortage=${JSON.stringify(shortage?.variant_name ?? shortage)}`);
  for (const usd of [10, 1000, 10000]) {
    const qIn = usd / xrdUsd;
    const bIn = qIn / p0;
    const res = await batchCalls(gw, epoch, [
      { component: p.component, method: "quote", args: [`Decimal("${bIn.toFixed(18)}")`, "false"] },
      { component: p.component, method: "quote", args: [`Decimal("${qIn.toFixed(18)}")`, "true"] },
    ]);
    if (!res[0].ok || !res[1].ok) {
      console.log(`  $${usd}: quote failed`, res);
      continue;
    }
    const s = res[0].value.fields.map((x: any) => x.value);
    const b = res[1].value.fields.map((x: any) => x.value);
    if (showRaw) console.log("  sell", JSON.stringify(res[0].value).slice(0, 600), "\n  buy", JSON.stringify(res[1].value).slice(0, 600));
    const [sOut, sRem, sFee] = s.map(Number);
    const [bOut, bRem, bFee] = b.map(Number);
    const bidG = (sOut + sFee) / (bIn - sRem), askG = (qIn - bRem) / (bOut + bFee);
    const bidN = sOut / (bIn - sRem), askN = (qIn - bRem) / bOut;
    console.log(
      `  $${usd}: fee/output sell=${(sFee / (sOut + sFee) * 100).toFixed(3)}% buy=${(bFee / (bOut + bFee) * 100).toFixed(3)}%` +
        ` | gross bid=${bidG.toPrecision(7)} ask=${askG.toPrecision(7)} mid/p0=${(Math.sqrt(bidG * askG) / p0).toFixed(5)}` +
        ` | net bid=${bidN.toPrecision(7)} ask=${askN.toPrecision(7)} mid/p0=${(Math.sqrt(bidN * askN) / p0).toFixed(5)}`,
    );
  }
}
