import { describe, expect, it } from "vitest";
import type { AdapterRecord } from "../src/contracts/adapter.js";
import { normalizeRecord } from "../src/core/normalize.js";

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
      normalizeRecord("source", adapter, record(comparable)).comparable,
    ).toEqual({
      ...comparable,
      list: [true, false, null, 123, "text"],
    });
  });
});
