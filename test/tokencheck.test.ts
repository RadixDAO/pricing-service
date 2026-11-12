import { beforeEach, describe, expect, it } from "vitest";
import { makeGateway } from "../src/gateway";
import { settings } from "../src/settings";
import { checkAdd, checkRemove, type Deps, formSections, parseRequest, recheck, resultMarkdown, type AddRequest } from "../src/tokencheck";
import { A, addr, C, healthyMarket, type Market, marketFetch, TOKENS, withReserves } from "./market";

const NEW = addr("resource", "hydr");
const NEW_POOL = addr("component", "hydroci");

let m: Market;
let d: Deps;
beforeEach(() => {
  m = withReserves(healthyMarket());
  // HYDR: 0.5 XRD per token in a pool holding 2M XRD ($1200 deep).
  m.oci[NEW_POOL] = { raw: 0.5, xrd: 2_000_000, holds: { [NEW]: 4_000_000 } };
  m.resources[NEW] = { symbol: "HYDR" };
  const f = marketFetch(m);
  d = { gw: makeGateway("https://gateway.test", f), fetchFn: f, s: settings({ DB: undefined as any, GATEWAY_URL: "https://gateway.test" }), now: m.now };
});

const body = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `### ${k}\n\n${v || "_No response_"}`)
    .join("\n\n");

const addReq = (pools: string, extra: Partial<Record<string, string>> = {}) =>
  parseRequest(
    body({ Symbol: "HYDR", Name: "", "Resource address": NEW, Pools: "```text\n" + pools + "\n```", "CoinGecko ID": "", ...extra }),
    ["token-request", "add-token"],
  ) as AddRequest;

describe("parsing issue forms", () => {
  it("reads the fields GitHub renders, including empty optional ones", () => {
    const f = formSections("### Symbol\r\n\r\nHYDR\r\n\r\n### Name\r\n\r\n_No response_\r\n");
    expect(f.get("Symbol")).toBe("HYDR");
    expect(f.get("Name")).toBe("");
  });

  it("parses pools, one per line, ignoring blank and # lines", () => {
    const r = addReq(`# comment\nociswap ${NEW_POOL} XRD HYDR\n\n`);
    expect(r.pools).toEqual([{ dex: "ociswap", component: NEW_POOL, base: "XRD", quote: "HYDR" }]);
    expect(r.name).toBeUndefined();
  });

  it("rejects malformed pool lines and missing labels", () => {
    expect(parseRequest(body({ Symbol: "X", "Resource address": NEW, Pools: "ociswap only-two" }), ["add-token"])).toHaveProperty("error");
    expect(parseRequest(body({ Symbol: "X" }), ["token-request"])).toHaveProperty("error");
  });

  it("keeps hostile text as plain data", () => {
    const r = parseRequest(body({ Symbol: "$(rm -rf /)", "Resource address": NEW, Pools: `ociswap ${NEW_POOL} XRD HYDR` }), ["add-token"]) as AddRequest;
    expect(r.symbol).toBe("$(rm -rf /)"); // rejected later by the symbol format check, never executed
  });
});

describe("add requests", () => {
  it("passes a good pool and returns the new tokens.json", async () => {
    const r = await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`), TOKENS, d);
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.tokens?.tokens.HYDR.pools).toHaveLength(1);
    expect(r.summary).toBe("Add HYDR");
  });

  it("fails a pool below $100", async () => {
    m.oci[NEW_POOL] = { raw: 0.5, xrd: 100_000, holds: { [NEW]: 200_000 } }; // $60
    const r = await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`), TOKENS, d);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("Pool"))?.detail).toMatch(/below the \$100 minimum/);
  });

  it("catches base and quote listed the wrong way round", async () => {
    const r = await checkAdd(addReq(`ociswap ${NEW_POOL} HYDR XRD`), TOKENS, d);
    expect(r.ok).toBe(false);
    expect(r.checks.find((c) => c.name.startsWith("Pool"))?.detail).toMatch(/look swapped/);
  });

  it("catches a pool that does not hold the token", async () => {
    const r = await checkAdd(addReq(`ociswap ${C.fooOci} XRD HYDR`), TOKENS, d);
    expect(r.checks.find((c) => c.name.startsWith("Pool"))?.detail).toMatch(/does not hold both/);
  });

  it("rejects a symbol already used for another address, and a non-fungible", async () => {
    const r1 = await checkAdd({ ...addReq(`ociswap ${NEW_POOL} XRD HYDR`), symbol: "FOO" }, TOKENS, d);
    expect(r1.ok).toBe(false);
    m.resources[NEW] = { type: "NonFungibleResource" };
    const r2 = await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`), TOKENS, d);
    expect(r2.checks.find((c) => c.name === "Resource")?.ok).toBe(false);
  });

  it("checks a CoinGecko ID against the pools", async () => {
    (m.cg as Record<string, number>).hydrate = 0.00015; // 0.5 XRD * $0.0003
    expect((await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`, { "CoinGecko ID": "hydrate" }), TOKENS, d)).ok).toBe(true);
    (m.cg as Record<string, number>).hydrate = 0.0003;
    const r = await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`, { "CoinGecko ID": "hydrate" }), TOKENS, d);
    expect(r.checks.find((c) => c.name === "CoinGecko")?.ok).toBe(false);
  });

  it("refuses to change XRD or a USD reference", async () => {
    const r = await checkAdd({ ...addReq(`ociswap ${NEW_POOL} XRD HYDR`), symbol: "hUSDC", resource_address: A.hUSDC }, TOKENS, d);
    expect(r.ok).toBe(false);
  });

  it("asks to retry later when no XRD/USD reference is available", async () => {
    m.cg = "down";
    m.mexc = "down";
    const r = await checkAdd(addReq(`ociswap ${NEW_POOL} XRD HYDR`), TOKENS, d);
    expect(r.checks.at(-1)?.detail).toMatch(/retry later/);
  });

  it("renders a result table", async () => {
    const req = addReq(`ociswap ${NEW_POOL} XRD HYDR`);
    const md = resultMarkdown(await checkAdd(req, TOKENS, d), req);
    expect(md).toMatch(/All checks passed/);
    expect(md).toMatch(/\| ✅ \| Resource \|/);
  });
});

describe("pools given as just a component address", () => {
  it("detects the DEX, tokens and order (XRD as base)", async () => {
    m.blueprints[NEW_POOL] = "FlexPool";
    const r = await checkAdd(addReq(NEW_POOL), TOKENS, d);
    expect(r.ok).toBe(true);
    expect(r.tokens?.tokens.HYDR.pools).toEqual([{ dex: "ociswap", component: NEW_POOL, base: "XRD", quote: "HYDR", blueprint_name: "FlexPool" }]);
    expect(r.checks.find((c) => c.name === "Pool line 1")?.detail).toMatch(/Ociswap FlexPool, XRD \/ HYDR \(detected\)/);
  });

  it("detects the token as base when the pool quotes it that way", async () => {
    m.oci[NEW_POOL] = { raw: 2, xrd: 2_000_000, holds: { [NEW]: 4_000_000 } }; // 2 HYDR per XRD
    const r = await checkAdd(addReq(NEW_POOL), TOKENS, d);
    expect(r.tokens?.tokens.HYDR.pools[0]).toMatchObject({ base: "HYDR", quote: "XRD" });
  });

  it("detects a DefiPlaza pair from get_tokens", async () => {
    const r = await checkAdd({ ...addReq(C.husdcPlaza), symbol: "hUSDC2", resource_address: A.hUSDC }, TOKENS, d);
    expect(r.checks.find((c) => c.name === "Resource address")?.detail).toMatch(/already listed as hUSDC/);
  });

  it("explains unsupported pool types", async () => {
    m.blueprints[NEW_POOL] = "SomeOtherDex";
    const r = await checkAdd(addReq(NEW_POOL), TOKENS, d);
    expect(r.checks.find((c) => c.name === "Pool line 1")?.detail).toMatch(/unsupported pool type "SomeOtherDex"/);
  });

  it("says so when the pool does not hold the token", async () => {
    const r = await checkAdd(addReq(C.fooOci), TOKENS, d);
    expect(r.checks.find((c) => c.name === "Pool line 1")?.detail).toMatch(/does not hold HYDR/);
  });

  it("mixes detected and fully written lines", async () => {
    const r = await checkAdd(addReq(`${NEW_POOL}
ociswap ${NEW_POOL} XRD HYDR`), TOKENS, d);
    expect(r.checks.find((c) => c.name === "Format")?.detail).toMatch(/same pool already listed/);
  });
});

describe("remove requests", () => {
  it("removes a token nothing depends on", () => {
    const r = checkRemove({ kind: "remove", symbol: "BAR", reason: "x" }, TOKENS);
    expect(r.ok).toBe(true);
    expect(r.tokens?.tokens.BAR).toBeUndefined();
  });
  it("refuses XRD, a USD reference, unknown symbols", () => {
    for (const symbol of ["XRD", "hUSDC", "NOPE"]) expect(checkRemove({ kind: "remove", symbol, reason: "" }, TOKENS).ok).toBe(false);
  });
});

describe("weekly recheck", () => {
  it("reports nothing for a healthy list", async () => {
    expect((await recheck(TOKENS, d)).findings).toEqual([]);
  });

  it("reports a drained pool and whether the token is left unpriced", async () => {
    m.oci[C.barOci] = { raw: 50, xrd: 10_000, holds: { [A.BAR]: 500_000 } };
    m.oci[C.fooOci2] = { raw: 101, xrd: 10_000, holds: { [A.FOO]: 99 } };
    const { findings } = await recheck(TOKENS, d);
    expect(findings.map((f) => [f.symbol, f.unpriced])).toEqual([
      ["FOO", false],
      ["BAR", true],
    ]);
  });
});
