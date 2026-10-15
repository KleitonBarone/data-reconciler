import { describe, expect, it } from "vitest";
import { assertJson, canonicalJson, compareText } from "../src/core/json.js";

describe("JSON boundaries", () => {
  it.each([
    undefined,
    Number.NaN,
    Infinity,
    1n,
    new Date(),
    new Map(),
    { x: undefined },
    Array(1),
  ])("rejects non-JSON data %#", (value) => {
    expect(() => assertJson(value)).toThrow();
  });
  it("rejects cycles without overflowing the stack", () => {
    const value: { cycle?: unknown } = {};
    value.cycle = value;
    expect(() => assertJson(value)).toThrow(/cycle/u);
  });
  it("preserves null separately from an absent property and sorts without locale", () => {
    expect(canonicalJson({ z: null, a: [true, false] })).toBe(
      '{"a":[true,false],"z":null}',
    );
    expect(["z", "A", "ä"].sort(compareText)).toEqual(["A", "z", "ä"]);
  });
});
