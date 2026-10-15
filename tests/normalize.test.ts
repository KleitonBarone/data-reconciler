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
