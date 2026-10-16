import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compare,
  replay,
  jobFingerprint,
  SqliteReconciliationStore,
  JsonPageCommerceAdapter,
  JsonlLedgerCommerceAdapter,
  commercePolicy,
  createPlan,
  acceptPlan,
} from "../src/index.js";

function job() {
  return {
    id: "replay-commerce",
    source: new JsonPageCommerceAdapter(resolve("fixtures/source-pages.json")),
    target: new JsonlLedgerCommerceAdapter(
      resolve("fixtures/target-ledger.jsonl"),
    ),
    normalization: commercePolicy,
    repair: {
      version: "1",
      direction: "source-to-target",
      sourceFields: ["customerEmail", "status", "totalMinor", "currency"],
    },
  } as const;
}

describe("bounded replay and retention", () => {
  it("replays the same evidence twice without provider access or changing live checkpoints/history", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const current = job();
    try {
      const original = await compare(current, { store });
      const saved = JSON.stringify([...store.durable.results(original.runId)]);
      const scoped = store.forJob(current.id, jobFingerprint(current));
      const checkpoint = scoped.getCheckpoint(current.source.descriptor.id);
      const unavailable = {
        ...current,
        source: {
          descriptor: current.source.descriptor,
          readPage: () => Promise.reject(new Error("Do not contact source")),
        },
        target: {
          descriptor: current.target.descriptor,
          readPage: () => Promise.reject(new Error("Do not contact target")),
        },
      };
      const first = await replay(unavailable, { store, from: 1, to: 10 });
      const second = await replay(unavailable, { store, from: 1, to: 10 });
      expect(first.summary).toEqual(original.summary);
      expect([...store.durable.results(first.runId)]).toEqual([
        ...store.durable.results(second.runId),
      ]);
      expect(scoped.getCheckpoint(current.source.descriptor.id)).toEqual(
        checkpoint,
      );
      expect(JSON.stringify([...store.durable.results(original.runId)])).toBe(
        saved,
      );
      expect(store.durable.getRun(first.runId)?.replay).toEqual({
        jobId: current.id,
        from: 1,
        to: 10,
      });
      await expect(
        replay(current, { store, from: 1, to: 100001 }),
      ).rejects.toThrow("at most 100000");
      await expect(
        replay(
          { ...current, normalization: { version: "other" } },
          { store, from: 1, to: 10 },
        ),
      ).rejects.toThrow("normalization changed");
    } finally {
      store.close();
    }
  });

  it("prunes only explicit unpinned delivery evidence and refuses partial replay", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const current = job();
    try {
      const original = await compare(current, { store });
      const plan = createPlan(current, { store, runId: original.runId });
      const selected = plan.body.operations.map((operation) => operation.id);
      expect(selected.length).toBeGreaterThan(0);
      expect(() => store.pruneEvidence(current.id, 11)).toThrow("within");
      const scoped = store.forJob(current.id, jobFingerprint(current));
      scoped.durable.acquire("held");
      expect(() => store.pruneEvidence(current.id, 10)).toThrow(
        "Stop or recover",
      );
      scoped.durable.release("held");
      expect(store.pruneEvidence(current.id, 2)).toBe(2);
      await expect(replay(current, { store, from: 1, to: 10 })).rejects.toThrow(
        "pruned evidence",
      );
      expect([...store.durable.results(original.runId)]).toHaveLength(6);
      acceptPlan(current, {
        store,
        digest: plan.digest,
        operationIds: selected,
        allowedFields: ["customerEmail", "status", "totalMinor", "currency"],
        maxOperations: 10,
        maxRecords: 10,
      });
      expect(() => store.pruneEvidence(current.id, 10)).toThrow("pin this job");
      expect(store.plans.get(plan.digest)).toEqual(plan);
    } finally {
      store.close();
    }
  });
});
