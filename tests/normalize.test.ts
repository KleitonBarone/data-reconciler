import { describe, expect, it } from "vitest";
import type { AdapterRecord } from "../src/contracts/adapter.js";
import { normalizeRecord } from "../src/core/normalize.js";
import { classifyRecords } from "../src/core/classify.js";

const adapter = {
  id: "test",
  displayName: "Test",
  contractVersion: 1,
  adapterVersion: "1",
  schemaVersion: "1",
} as const;

function record(comparable: AdapterRecord["comparable"]): AdapterRecord {
  return {
    recordId: "one",
    identity: { kind: "order", value: "one" },
    updatedAt: "2026-01-01T00:00:00.000Z",
    comparable,
    evidence: { format: "json", locator: "one", payload: comparable },
  };
}

describe("normalization", () => {
  it("does not treat prototype properties as present fields", () => {
    const source = normalizeRecord(
      "source",
      adapter,
      record({ constructor: "a", toString: "b" }),
    );
    const target = normalizeRecord("target", adapter, record({}));
    const result = classifyRecords([source], [target])[0];
    if (result?.classification !== "conflicting")
      throw new Error("Expected a conflict with field evidence");
    expect(result.differences.map((diff) => diff.target)).toEqual([
      { present: false },
      { present: false },
    ]);
  });
  it("keeps arbitrary identifiers case-sensitive and escapes compound keys", () => {
    const first = normalizeRecord(
      "source",
      adapter,
      record({ name: " Alice " }),
    );
    expect(first.identityKey).toBe("order:one");
    expect(first.comparable.name).toBe(" Alice ");
    const compound = {
      ...record({}),
      identity: { kind: "tenant", value: ["a:b", "c"] },
    };
    const other = {
      ...record({}),
      identity: { kind: "tenant", value: ["a", "b:c"] },
    };
    expect(normalizeRecord("source", adapter, compound).identityKey).not.toBe(
      normalizeRecord("source", adapter, other).identityKey,
    );
  });

  it("applies explicit field rules ignored fields and unordered arrays", () => {
    const result = normalizeRecord(
      "source",
      adapter,
      record({ email: " TEST@EXAMPLE.COM ", ignored: 1, tags: ["b", "a"] }),
      {
        version: "custom.v1",
        fields: { "/email": { trim: true, case: "lower" } },
        ignore: ["/ignored"],
        unorderedArrays: ["/tags"],
      },
    );
    expect(result.comparable).toEqual({
      email: "test@example.com",
      tags: ["a", "b"],
    });
    expect(result.normalizationVersion).toBe("custom.v1");
  });

  it("retains the original evidence when local identity metadata is invalid", () => {
    const source = { ...record({}), recordId: " " };
    expect(() => normalizeRecord("source", adapter, source)).toThrow(
      expect.objectContaining({
        code: "invalid_record",
        evidence: source.evidence.payload,
      }),
    );
  });
  it.each([
    "2026-01-01",
    "2026-02-30T00:00:00Z",
    "2026-01-01T12:00:00",
    "yesterday",
  ])("rejects an invalid or timezone-ambiguous timestamp: %s", (updatedAt) => {
    expect(() =>
      normalizeRecord("source", adapter, { ...record({}), updatedAt }),
    ).toThrow(/timestamp|updatedAt/u);
  });

  it("rejects integer values that have lost precision", () => {
    expect(() =>
      normalizeRecord(
        "source",
        adapter,
        record({ total: Number.MAX_SAFE_INTEGER + 1 }),
      ),
    ).toThrow(/safe|precision/u);
  });

  it("preserves JSON scalar types inside objects and arrays", () => {
    const comparable = {
      enabled: true,
      disabled: false,
      nested: { enabled: true, nothing: null },
      list: [true, false, null, 123, " text "],
    };
    expect(
      normalizeRecord("source", adapter, record(comparable), {
        version: "trim.v1",
        text: { trim: true },
      }).comparable,
    ).toEqual({
      ...comparable,
      list: [true, false, null, 123, "text"],
    });
  });
});
