import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadJob } from "../src/config.js";
import { compare } from "../src/core/job.js";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";
import {
  policyValue,
  checkpointValue,
  recordValue,
} from "../src/core/validation.js";

describe("configuration and projections", () => {
  it("reconciles independently shaped inventory records using config-relative paths", async () => {
    const job = await loadJob(resolve("examples/inventory.json"));
    const store = new SqliteReconciliationStore(":memory:");
    try {
      const report = await compare(job, { store });
      expect(report.summary).toEqual({
        total: 2,
        equal: 0,
        changed: 1,
        missing: 1,
        conflicting: 0,
      });
      expect([...store.durable.results(report.runId)][0]?.identityKey).toBe(
        "sku:hat",
      );
    } finally {
      store.close();
    }
  });
  it("rejects unsupported policy and checkpoint versions at runtime boundaries", () => {
    expect(() =>
      policyValue({ version: "1", text: { case: "guess" } }),
    ).toThrow();
    expect(() =>
      checkpointValue({ contractVersion: 2, cursor: null }),
    ).toThrow();
    expect(() => recordValue({ recordId: "a", updatedAt: "bad" })).toThrow();
  });
});
