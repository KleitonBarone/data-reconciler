import { describe, expect, it } from "vitest";
import { mergeObservations } from "../src/core/revisions.js";
import { classifyRecords } from "../src/core/classify.js";
import { normalizeRecord } from "../src/core/normalize.js";

const descriptor = {
  id: "test",
  displayName: "Test",
  contractVersion: 1,
  adapterVersion: "1",
  schemaVersion: "1",
} as const;
function snapshot(
  value: number,
  updatedAt = "2026-01-02T00:00:00Z",
  recordId = "one",
) {
  return normalizeRecord("source", descriptor, {
    recordId,
    updatedAt,
    identity: { kind: "item", value: "one" },
    comparable: { value },
    evidence: { format: "json", locator: recordId, payload: { value } },
  });
}
describe("record revisions", () => {
  it("ignores a late stale update and collapses repeated delivery", () => {
    const current = snapshot(2);
    expect(
      mergeObservations(
        [current],
        [snapshot(1, "2026-01-01T00:00:00Z"), current],
      ),
    ).toEqual([current]);
  });
  it("preserves a conflicting revision across subsequent runs", () => {
    const first = mergeObservations([], [snapshot(1), snapshot(2)]);
    const resumed = mergeObservations(first, [snapshot(1)]);
    const result = classifyRecords(resumed, []);
    expect(result[0]).toMatchObject({
      classification: "conflicting",
      reason: "conflicting_revision",
    });
    expect(result[0]?.source).toHaveLength(2);
    expect(mergeObservations([], [snapshot(2), snapshot(1)])).toEqual(first);
  });
  it("distinguishes duplicate ownership from repeated delivery", () => {
    expect(
      classifyRecords(
        mergeObservations([], [snapshot(1), snapshot(1, undefined, "two")]),
        [],
      )[0],
    ).toMatchObject({
      classification: "conflicting",
      reason: "duplicate_identity",
    });
  });
  it("reports tombstones instead of proposing resurrection or deletion", () => {
    expect(
      classifyRecords([{ ...snapshot(1), deleted: true }], [])[0],
    ).toMatchObject({
      classification: "conflicting",
      reason: "deleted_record",
    });
  });
});
