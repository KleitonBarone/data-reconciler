import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteReconciliationStore,
  compare,
  createPlan,
  acceptPlan,
  planValue,
  createCheckpoint,
  type AdapterRecord,
  type ReadAdapter,
} from "../src/index.js";

function adapter(id: string, records: readonly AdapterRecord[]): ReadAdapter {
  const descriptor = {
    id,
    displayName: id,
    datasetId: `memory:${id}`,
    contractVersion: 1,
    adapterVersion: "1",
    schemaVersion: "1",
  } as const;
  return {
    descriptor,
    readPage(request) {
      const offset = Number(request.checkpoint?.cursor ?? 0);
      const end = Math.min(records.length, offset + request.limit);
      return Promise.resolve({
        records: records.slice(offset, end),
        hasMore: end < records.length,
        nextCheckpoint: createCheckpoint(descriptor, String(end)),
      });
    },
  };
}
function record(id: string, stock: number, target = false): AdapterRecord {
  return {
    recordId: id,
    identity: { kind: "sku", value: id },
    updatedAt: target ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
    comparable: { stock },
    evidence: { format: "memory", locator: id, payload: { id, stock } },
    ...(target ? { revision: "1" } : {}),
  };
}
function fixture() {
  return {
    id: "plans",
    source: adapter("source", [
      record("shirt", 12),
      record("hat", 8),
      { ...record("orphan", 1), identity: null },
    ]),
    target: adapter("target", [record("shirt", 10, true)]),
    repair: {
      version: "ownership.v1",
      direction: "source-to-target",
      sourceFields: ["stock"],
    },
  } as const;
}

describe("repair review", () => {
  it("returns the first acceptance across retrying connections without changing its timestamp or scope", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reconciler-approval-retry-"));
    const path = join(directory, "state.sqlite");
    const store = new SqliteReconciliationStore(path);
    const second = new SqliteReconciliationStore(path);
    const job = fixture();
    try {
      const run = await compare(job, {
        store,
        now: () => new Date("2026-01-02T00:00:00Z"),
      });
      const plan = createPlan(job, { store, runId: run.runId });
      const options = {
        store,
        digest: plan.digest,
        operationIds: plan.body.operations.map((op) => op.id),
        allowedFields: ["stock", "label"],
        maxOperations: 2,
        maxRecords: 2,
        now: () => new Date("2026-01-02T00:01:00Z"),
      };
      const first = acceptPlan(job, options);
      const later = {
        ...options,
        store: second,
        now: () => new Date("2026-01-02T01:00:00Z"),
      };
      expect(
        acceptPlan(job, {
          ...later,
          operationIds: [...options.operationIds].reverse(),
          allowedFields: [...options.allowedFields].reverse(),
        }),
      ).toEqual(first);
      expect(second.plans.acceptance(plan.digest)).toEqual(first);
      expect(() => acceptPlan(job, { ...later, maxRecords: 3 })).toThrow(
        "immutable",
      );
      expect(() => acceptPlan(job, { ...later, maxOperations: 3 })).toThrow(
        "immutable",
      );
      expect(() =>
        acceptPlan(job, { ...later, allowedFields: ["stock"] }),
      ).toThrow("immutable");
      expect(() =>
        acceptPlan(job, {
          ...later,
          operationIds: options.operationIds.slice(0, 1),
        }),
      ).toThrow("immutable");
      expect(() =>
        second.plans.accept({
          ...first,
          expiresAt: "2026-01-04T00:00:00.000Z",
        }),
      ).toThrow("immutable");
      expect(() =>
        acceptPlan(job, {
          ...later,
          now: () => new Date("2026-01-03T00:00:00Z"),
        }),
      ).toThrow("expired");
      expect(store.plans.acceptance(plan.digest)).toEqual(first);
    } finally {
      second.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("creates deterministic operations with evidence without changing either source", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const job = fixture();
    try {
      const run = await compare(job, { store });
      const plan = createPlan(job, { store, runId: run.runId });
      expect(createPlan(job, { store, runId: run.runId })).toEqual(plan);
      expect(plan.body.operations.map((op) => op.kind).sort()).toEqual([
        "create",
        "update",
      ]);
      expect(plan.body.skipped.reasons.missing_identifier).toBe(1);
      for (const operation of plan.body.operations)
        expect(operation.source.evidence.payload).toHaveProperty("stock");
      expect((await compare(job, { store })).summary).toEqual(run.summary);
      const acceptance = acceptPlan(job, {
        store,
        digest: plan.digest,
        operationIds: plan.body.operations.map((op) => op.id),
        allowedFields: ["stock"],
        maxOperations: 2,
        maxRecords: 2,
      });
      expect(store.plans.acceptance(plan.digest)).toEqual(acceptance);
      expect((await compare(job, { store })).summary).toEqual(run.summary);
      expect(() =>
        planValue({
          ...plan,
          body: { ...plan.body, expiresAt: "2099-01-01T00:00:00.000Z" },
        }),
      ).toThrow("digest verification failed");
    } finally {
      store.close();
    }
  });

  it("rejects missing ownership, expiry, bounds, unknown IDs and changed acceptance", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const job = fixture();
    try {
      const run = await compare(job, { store });
      expect(() =>
        createPlan(
          { id: "unowned", source: job.source, target: job.target },
          { store, runId: run.runId },
        ),
      ).toThrow("Declare repair direction");
      const plan = createPlan(job, { store, runId: run.runId });
      const options = {
        store,
        digest: plan.digest,
        operationIds: plan.body.operations.map((op) => op.id),
        allowedFields: ["stock"],
        maxOperations: 2,
        maxRecords: 2,
      };
      expect(() => acceptPlan(job, { ...options, maxOperations: 1 })).toThrow(
        "bounds",
      );
      expect(() => acceptPlan(job, { ...options, maxRecords: 1 })).toThrow(
        "bounds",
      );
      expect(() => acceptPlan(job, { ...options, allowedFields: [] })).toThrow(
        "field scope",
      );
      expect(() =>
        acceptPlan(job, { ...options, operationIds: ["not-an-operation"] }),
      ).toThrow("selection");
      expect(() =>
        acceptPlan(job, { ...options, now: () => new Date("2099-01-01") }),
      ).toThrow("expired");
      expect(() => acceptPlan({ ...job, id: "other" }, options)).toThrow(
        "job generation",
      );
      acceptPlan(job, options);
      expect(() => acceptPlan(job, { ...options, maxRecords: 3 })).toThrow(
        "immutable",
      );
    } finally {
      store.close();
    }
  });

  it("keeps unknown ownership and ambiguous revisions out of applicable plans", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const base = fixture();
    const job = {
      ...base,
      source: adapter("source", [
        { ...record("shirt", 12), comparable: { stock: 12, unknown: 1 } },
      ]),
    };
    try {
      const run = await compare(job, { store });
      const plan = createPlan(job, { store, runId: run.runId });
      expect(plan.body.operations).toHaveLength(0);
      expect(plan.body.skipped.reasons.unknown_ownership).toBe(1);
      expect(() =>
        acceptPlan(job, {
          store,
          digest: plan.digest,
          operationIds: [],
          allowedFields: ["stock"],
          maxOperations: 1,
          maxRecords: 1,
        }),
      ).toThrow("selection");
    } finally {
      store.close();
    }
  });
});
