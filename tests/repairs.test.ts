import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  SqliteReconciliationStore,
  SqliteRecordAdapter,
  initializeSqliteTarget,
  compare,
  createPlan,
  acceptPlan,
  applyPlan,
  validateAcceptedPlan,
  createCheckpoint,
  RetryableAdapterError,
  ReconciliationError,
  type AdapterRecord,
  type ReconciliationJob,
} from "../src/index.js";

function record(id: string, stock: number, target = false): AdapterRecord {
  return {
    recordId: id,
    identity: { kind: "sku", value: id },
    updatedAt: target ? "2026-01-01T00:00:00Z" : "2026-01-02T00:00:00Z",
    comparable: { stock, label: target ? " keep me " : "source label" },
    evidence: { format: "fixture", locator: id, payload: { id, stock } },
  };
}
async function fixture(
  run: (
    job: ReconciliationJob,
    store: SqliteReconciliationStore,
    target: SqliteRecordAdapter,
    path: string,
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "reconciler-apply-"));
  const path = join(directory, "target.sqlite");
  initializeSqliteTarget(path, [record("shirt", 10, true)]);
  const target = new SqliteRecordAdapter(path, { id: "target" });
  const descriptor = {
    id: "source",
    displayName: "source",
    datasetId: "memory:source",
    contractVersion: 1,
    adapterVersion: "1",
    schemaVersion: "1",
  } as const;
  const records = [
    record("shirt", 12),
    { ...record("hat", 8), comparable: { stock: 8 } },
    { ...record("orphan", 1), identity: null },
  ];
  const job: ReconciliationJob = {
    id: "apply",
    source: {
      descriptor,
      readPage(request) {
        return Promise.resolve({
          records: request.checkpoint === null ? records : [],
          hasMore: false,
          nextCheckpoint: createCheckpoint(descriptor, "3"),
        });
      },
    },
    target,
    repair: {
      version: "1",
      direction: "source-to-target",
      sourceFields: ["stock"],
      targetFields: ["label"],
    },
    runtime: { backoffMs: 0 },
    normalization: { version: "trim.v1", text: { trim: true } },
  };
  const store = new SqliteReconciliationStore(":memory:");
  try {
    await run(job, store, target, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
async function review(
  job: ReconciliationJob,
  store: SqliteReconciliationStore,
) {
  const report = await compare(job, { store });
  const plan = createPlan(job, { store, runId: report.runId });
  acceptPlan(job, {
    store,
    digest: plan.digest,
    operationIds: plan.body.operations.map((op) => op.id),
    allowedFields: ["stock"],
    maxOperations: 2,
    maxRecords: 2,
  });
  return plan;
}

describe("accepted repairs", () => {
  it("keeps a committed write unknown through lookup failure, cancellation, and a rejected retry", async () =>
    fixture(async (job, store, target, path) => {
      let lookupsUnavailable = false;
      let writes = 0;
      let hideReceipt = false;
      const wrapped: ReconciliationJob = {
        ...job,
        target: {
          descriptor: target.descriptor,
          readPage: target.readPage.bind(target),
          writer: {
            ...target.writer,
            lookup(key, signal) {
              if (lookupsUnavailable)
                return Promise.reject(new Error("receipt lookup unavailable"));
              return hideReceipt
                ? Promise.resolve(null)
                : target.writer.lookup(key, signal);
            },
            async apply(write, signal) {
              writes++;
              if (hideReceipt)
                throw new ReconciliationError(
                  "stale_plan",
                  "Rejected retry cannot disprove an earlier effect",
                );
              const receipt = await target.writer.apply(write, signal);
              if (writes === 1)
                throw new Error("lost acknowledgement after commit");
              return receipt;
            },
          },
        },
      };
      const plan = await review(wrapped, store);
      expect(
        await applyPlan(wrapped, { store, digest: plan.digest }),
      ).toMatchObject({ unknown: 1, failed: 0 });
      const committed = readFileSync(path);
      lookupsUnavailable = true;
      expect(
        await applyPlan(wrapped, { store, digest: plan.digest }),
      ).toMatchObject({ unknown: 1, failed: 0 });
      expect(writes).toBe(1);
      expect(readFileSync(path)).toEqual(committed);
      const controller = new AbortController();
      expect(
        await applyPlan(wrapped, {
          store,
          digest: plan.digest,
          signal: controller.signal,
          onEvent(event) {
            if (event.type === "repair_intent") controller.abort();
          },
        }),
      ).toMatchObject({ unknown: 1, failed: 0, cancelled: true });
      lookupsUnavailable = false;
      hideReceipt = true;
      expect(
        await applyPlan(wrapped, { store, digest: plan.digest }),
      ).toMatchObject({ unknown: 1, failed: 0 });
      hideReceipt = false;
      expect(
        await applyPlan(wrapped, { store, digest: plan.digest }),
      ).toMatchObject({ succeeded: 2, unknown: 0, failed: 0 });
      const completed = readFileSync(path);
      expect(
        await applyPlan(wrapped, { store, digest: plan.digest }),
      ).toMatchObject({ skipped: 2, succeeded: 0 });
      expect(readFileSync(path)).toEqual(completed);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT COUNT(*) n FROM target_events").get()?.n,
        ).toBe(3);
      } finally {
        db.close();
      }
      const firstId = plan.body.operations[0]?.id;
      const states = [...store.repairs.history(plan.digest)]
        .filter((outcome) => outcome.operationId === firstId)
        .map((outcome) => outcome.state);
      expect(states).not.toContain("failed");
      expect(states.slice(states.indexOf("unknown"))).not.toContain("pending");
      expect(states.at(-1)).toBe("succeeded");
    }));
  it("restores an accepted backup without duplicating effects already present at the target", async () =>
    fixture(async (job, store, _target, path) => {
      const plan = await review(job, store);
      const backup = join(dirname(path), "backup.sqlite");
      const original = JSON.stringify([
        ...store.durable.results(plan.body.runId),
      ]);
      store.backup(backup);
      await applyPlan(job, { store, digest: plan.digest });
      const bytes = readFileSync(path);
      const restored = new SqliteReconciliationStore(backup);
      try {
        const recovered = await applyPlan(job, {
          store: restored,
          digest: plan.digest,
        });
        expect(recovered.succeeded).toBe(2);
        expect(readFileSync(path)).toEqual(bytes);
        expect(
          JSON.stringify([...restored.durable.results(plan.body.runId)]),
        ).toBe(original);
        expect(
          [...restored.repairs.history(plan.digest)]
            .filter((row) => row.state === "succeeded")
            .every((row) => row.receipt?.deduplicated),
        ).toBe(true);
      } finally {
        restored.close();
      }
    }));
  it("defaults to no writes, preserves target-owned raw values and repeats with zero effects", async () =>
    fixture(async (job, store, target, path) => {
      const original = readFileSync(path);
      const run = await compare(job, { store });
      const plan = createPlan(job, { store, runId: run.runId });
      await expect(
        applyPlan(job, { store, digest: plan.digest }),
      ).rejects.toMatchObject({ code: "unsafe_write" });
      expect(readFileSync(path)).toEqual(original);
      acceptPlan(job, {
        store,
        digest: plan.digest,
        operationIds: plan.body.operations.map((op) => op.id),
        allowedFields: ["stock"],
        maxOperations: 2,
        maxRecords: 2,
      });
      validateAcceptedPlan(job, store, plan.digest);
      expect(readFileSync(path)).toEqual(original);
      const first = await applyPlan(job, { store, digest: plan.digest });
      expect(first).toMatchObject({
        succeeded: 2,
        failed: 0,
        unknown: 0,
        pending: 0,
      });
      expect((await target.writer.getCurrent("shirt"))?.comparable).toEqual({
        stock: 12,
        label: " keep me ",
      });
      const verification = store.durable.getRun(first.verificationRunId ?? "");
      expect(verification?.summary).toEqual({
        total: 3,
        equal: 1,
        changed: 1,
        missing: 0,
        conflicting: 1,
      });
      const after = readFileSync(path);
      const repeated = await applyPlan(job, { store, digest: plan.digest });
      expect(repeated).toMatchObject({ succeeded: 0, skipped: 2 });
      expect(readFileSync(path)).toEqual(after);
      expect(store.repairs.verifications(plan.digest)).toHaveLength(2);
    }));

  it("recovers lost acknowledgements through target deduplication", async () =>
    fixture(async (job, store, target, path) => {
      let lost = true;
      const wrapped: ReconciliationJob = {
        ...job,
        target: {
          descriptor: target.descriptor,
          readPage: target.readPage.bind(target),
          writer: {
            ...target.writer,
            async apply(write, signal) {
              const receipt = await target.writer.apply(write, signal);
              if (lost) {
                lost = false;
                throw new RetryableAdapterError();
              }
              return receipt;
            },
          },
        },
      };
      const plan = await review(wrapped, store);
      const result = await applyPlan(wrapped, { store, digest: plan.digest });
      expect(result.succeeded).toBe(2);
      expect(
        [...store.repairs.history(plan.digest)].some(
          (row) => row.receipt?.deduplicated,
        ),
      ).toBe(true);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT COUNT(*) n FROM target_events").get()?.n,
        ).toBe(3);
      } finally {
        db.close();
      }
    }));

  it("resumes unknown outcomes without repeating completed effects", async () =>
    fixture(async (job, store, target, path) => {
      let calls = 0;
      const wrapped: ReconciliationJob = {
        ...job,
        target: {
          descriptor: target.descriptor,
          readPage: target.readPage.bind(target),
          writer: {
            ...target.writer,
            apply(write, signal) {
              if (++calls === 2)
                return Promise.reject(new Error("unclassified outage"));
              return target.writer.apply(write, signal);
            },
          },
        },
      };
      const plan = await review(wrapped, store);
      const partial = await applyPlan(wrapped, { store, digest: plan.digest });
      expect(partial).toMatchObject({ succeeded: 1, unknown: 1 });
      const resumed = await applyPlan(wrapped, { store, digest: plan.digest });
      expect(resumed).toMatchObject({ succeeded: 1, skipped: 1, unknown: 0 });
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT COUNT(*) n FROM target_events").get()?.n,
        ).toBe(3);
      } finally {
        db.close();
      }
      expect(
        [...store.repairs.history(plan.digest)].map((row) => row.state),
      ).toContain("unknown");
    }));

  it("stops for concurrent target drift and cancellation before sending a write", async () =>
    fixture(async (job, store, target, path) => {
      const plan = await review(job, store);
      const controller = new AbortController();
      const before = readFileSync(path);
      const cancelled = await applyPlan(job, {
        store,
        digest: plan.digest,
        signal: controller.signal,
        onEvent(event) {
          if (event.type === "repair_intent") controller.abort();
        },
      });
      expect(cancelled.cancelled).toBe(true);
      expect(readFileSync(path)).toEqual(before);
      const update = plan.body.operations.find((op) => op.kind === "update");
      if (update === undefined) throw new Error("No update fixture");
      await target.writer.apply({
        authorizationDigest: "external",
        deduplicationKey: "external",
        kind: "update",
        recordId: "shirt",
        identityKey: update.identityKey,
        identity: update.identity,
        expectedRevision: update.expectedRevision,
        expectedCheckpoint: update.expectedCheckpoint,
        comparable: { stock: 99 },
        fields: ["stock"],
        updatedAt: "2026-02-01T00:00:00Z",
      });
      const stale = await applyPlan(job, { store, digest: plan.digest });
      expect(stale.failed).toBe(1);
      expect((await target.writer.getCurrent("shirt"))?.comparable.stock).toBe(
        99,
      );
    }));
});
