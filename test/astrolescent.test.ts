import { describe, expect, it } from "vitest";
import { extractObject } from "../src/astrolescent";

describe("extractObject", () => {
  const text = JSON.stringify({
    a: { description: 'x } y { "z" \ end', n: 1 },
    b: { nested: { deep: [1, { c: "}" }] }, n: 2 },
  });
  it("cuts out one entry without parsing the rest, despite braces and quotes in strings", () => {
    expect(JSON.parse(extractObject(text, "a")!)).toEqual({ description: 'x } y { "z" \ end', n: 1 });
    expect(JSON.parse(extractObject(text, "b")!)).toEqual({ nested: { deep: [1, { c: "}" }] }, n: 2 });
  });
  it("returns undefined for a missing key or a non-object value", () => {
    expect(extractObject(text, "missing")).toBeUndefined();
    expect(extractObject(JSON.stringify({ a: 5 }), "a")).toBeUndefined();
  });
});
