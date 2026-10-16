import { describe, expect, it } from "vitest";
import { assertJson, canonicalJson, compareText } from "../src/core/json.js";

describe("JSON boundaries", () => {
  it("rejects array accessors and properties that JSON persistence would discard", () => {
    let called = false;
    const accessor = Object.defineProperty([], "0", {
      enumerable: true,
      get() {
        called = true;
        return 1;
      },
    });
    const extra = Object.assign([1], { extra: "lost" });
    const symbol = Object.assign([1], { [Symbol("hidden")]: "lost" });
    const serializer = Object.assign([1], {
      toJSON() {
        return ["replacement"];
      },
    });
    for (const value of [accessor, extra, symbol, serializer])
      expect(() => assertJson(value)).toThrow();
    expect(called).toBe(false);
  });
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
