import { describe, expect, it } from "vitest";
import tokensJson from "../tokens.json";
import { validateTokensFile } from "../src/config";
import { TOKENS } from "./market";

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

describe("tokens.json", () => {
  it("the shipped file is valid", () => {
    expect(validateTokensFile(tokensJson)).toEqual([]);
  });

  it("the test config is valid", () => {
    expect(validateTokensFile(TOKENS)).toEqual([]);
  });

  it("rejects pools on unsupported DEXes (C9 has shut down)", () => {
    const d: any = clone(TOKENS);
    d.tokens.FOO.pools[0].dex = "c9";
    expect(validateTokensFile(d).join()).toMatch(/dex: must be one of/);
  });

  it("rejects a malformed address, duplicate tokens and unknown symbols", () => {
    const d: any = clone(TOKENS);
    d.tokens.FOO.resource_address = "resource_rdx1short";
    d.tokens.BAR.resource_address = d.tokens.hETH.resource_address;
    d.tokens.hETH.pools[0].quote = "NOPE";
    const errs = validateTokensFile(d).join("\n");
    expect(errs).toMatch(/FOO.resource_address/);
    expect(errs).toMatch(/same address as hETH|same address as BAR/);
    expect(errs).toMatch(/quote: must be a symbol listed/);
  });

  it("requires a USD anchor with a pool against XRD", () => {
    const d: any = clone(TOKENS);
    d.usd_anchors = ["FOO", "MISSING"];
    d.tokens.FOO.pools = [];
    expect(validateTokensFile(d).join()).toMatch(/MISSING is not a listed token/);
  });

  it("requires coingecko_only tokens to have a CoinGecko ID", () => {
    const d: any = clone(TOKENS);
    delete d.tokens.hBNB.coingecko_id;
    expect(validateTokensFile(d).join()).toMatch(/coingecko_only needs a coingecko_id/);
  });

  it("requires the token to be the base of a pool without XRD", () => {
    const d: any = clone(TOKENS);
    d.tokens.FOO.pools.push({ dex: "ociswap", component: d.tokens.BAR.pools[0].component, base: "BAR", quote: "FOO" });
    expect(validateTokensFile(d).join()).toMatch(/must have FOO as its base/);
  });
});
