import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { compare, defineJob, jobFingerprint } from "../src/core/job.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { verifyReadAdapter, defineAdapter } from "../src/contracts/helpers.js";
import { createCheckpoint } from "../src/contracts/adapter.js";
import { JsonPageCommerceAdapter } from "../src/adapters/json-page-adapter.js";
import { JsonlLedgerCommerceAdapter } from "../src/adapters/jsonl-ledger-adapter.js";
import { commercePolicy } from "../src/adapters/commerce-policy.js";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";
import type { NormalizationPolicy } from "../src/core/policy.js";

function job(id = "commerce") {
  return defineJob({
    id,
    source: new JsonPageCommerceAdapter(resolve("fixtures/source-pages.json")),
    target: new JsonlLedgerCommerceAdapter(
      resolve("fixtures/target-ledger.jsonl"),
    ),
    normalization: commercePolicy,
    pageSize: 2,
  });
}

describe("application integration", () => {
  const invalidPolicies: readonly NormalizationPolicy[] = [
    { version: "" },
    { version: "custom.v1", fields: { label: { trim: true } } },
    { version: "custom.v1", ignore: ["label"] },
    { version: "custom.v1", unorderedArrays: ["/tags~2"] },
  ];
  it.each(invalidPolicies)(
    "rejects invalid normalization before empty reads: %j",
    async (normalization) => {
      const read = vi.fn();
      const endpoint = (id: string) => {
        const descriptor = {
          id,
          displayName: id,
          datasetId: "synthetic:" + id,
          contractVersion: 1,
          adapterVersion: "1",
          schemaVersion: "1",
        } as const;
        return {
          descriptor,
          readPage() {
            read();
            return Promise.resolve({
              records: [],
              hasMore: false,
              nextCheckpoint: createCheckpoint(descriptor, "0"),
            });
          },
        };
      };
      const candidate = {
        id: "invalid-policy",
        source: endpoint("source"),
        target: endpoint("target"),
        normalization,
      };
      const store = new SqliteReconciliationStore(":memory:");
      try {
        expect(() => defineJob(candidate)).toThrow(
          expect.objectContaining({ code: "invalid_config" }),
        );
        await expect(compare(candidate, { store })).rejects.toMatchObject({
          code: "invalid_config",
        });
        expect(read).not.toHaveBeenCalled();
        expect(store.inspect()).toMatchObject({
          jobs: [],
          runs: [],
          claims: [],
        });
      } finally {
        store.close();
      }
    },
  );
  it.each(["commerce", "other"])(
    "preserves completed reports and active runs when %s reuses an ID",
    async (secondJobId) => {
      const directory = mkdtempSync(
        join(tmpdir(), "reconciler-run-collision-"),
      );
      const path = join(directory, "state.sqlite");
      const store = new SqliteReconciliationStore(path);
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        const original = await compare(job(), {
          store,
          createRunId: () => "existing",
        });
        const durable = store.forJob("commerce", jobFingerprint(job())).durable;
        durable.acquire("unfinished");
        durable.begin("unfinished", "2026-01-01T00:00:00Z");
        durable.release("unfinished");
        const before = db
          .prepare("SELECT * FROM run_state ORDER BY run_id")
          .all();
        const results = JSON.stringify([
          ...store.durable.results(original.runId),
        ]);
        const checkpoints = db
          .prepare("SELECT * FROM checkpoints ORDER BY adapter_id")
          .all();
        const events: string[] = [];
        const collision = compare(job(secondJobId), {
          store,
          createRunId: () => "existing",
          onEvent: (event) => {
            events.push(event.type);
          },
        });
        await expect(collision).rejects.toThrow();
        expect(
          db.prepare("SELECT * FROM run_state ORDER BY run_id").all(),
        ).toEqual(before);
        expect(
          db.prepare("SELECT * FROM checkpoints ORDER BY adapter_id").all(),
        ).toEqual(checkpoints);
        expect(store.durable.getRun(original.runId)).toEqual(original);
        expect(JSON.stringify([...store.durable.results(original.runId)])).toBe(
          results,
        );
        expect(events).not.toContain("run_failed");
        await expect(collision).rejects.toMatchObject({
          code: "invalid_config",
        });
        const fresh = await compare(job(secondJobId), {
          store,
          createRunId: () => "fresh",
        });
        expect(fresh.summary).toEqual(original.summary);
        expect(store.durable.getRun(original.runId)).toEqual(original);
        durable.acquire("existing");
        try {
          durable.fail(
            "existing",
            "Late failure must not rewrite a completed report",
          );
        } finally {
          durable.release("existing");
        }
        expect(store.durable.getRun(original.runId)).toEqual(original);
      } finally {
        db.close();
        store.close();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );
  it("isolates jobs and rejects policy changes within an existing generation", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    try {
      const first = await compare(job(), { store });
      const second = await compare(job(), { store });
      const independent = await compare(job("other"), { store });
      expect(first.recordsRead).toEqual({ source: 6, target: 4 });
      expect(second.recordsRead).toEqual({ source: 0, target: 0 });
      expect(independent.recordsRead).toEqual(first.recordsRead);
      await expect(
        compare({ ...job(), normalization: { version: "changed" } }, { store }),
      ).rejects.toThrow(/normalization changed/u);
      expect(
        store
          .forJob("commerce", jobFingerprint(job()))
          .getCheckpoint("local-acme-json")?.cursor,
      ).toBe("6");
    } finally {
      store.close();
    }
  });
  it("cancels without publishing a partial run and emits only correlated metadata", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const abort = new AbortController();
    const events: string[] = [];
    try {
      await expect(
        compare(job(), {
          store,
          signal: abort.signal,
          createRunId: () => "cancelled-run",
          onEvent: (event) => {
            expect(event.runId).toBe("cancelled-run");
            events.push(event.type);
            if (event.type === "page_read") abort.abort();
          },
        }),
      ).rejects.toMatchObject({ code: "cancelled" });
      expect(store.countReports()).toBe(0);
      expect(events).toContain("run_failed");
    } finally {
      store.close();
    }
  });
  it("runs the same standalone contract against both separate adapters", async () => {
    expect((await verifyReadAdapter(() => job().source)).records).toBe(6);
    expect((await verifyReadAdapter(() => job().target)).records).toBe(4);
  });
  it("infers an unrelated provider record type through the adapter helper", async () => {
    const descriptor = {
      id: "inventory",
      datasetId: "memory:inventory",
      displayName: "Inventory",
      contractVersion: 1,
      adapterVersion: "1",
      schemaVersion: "1",
    } as const;
    const adapter = defineAdapter({
      descriptor,
      readPage: () =>
        Promise.resolve({
          records: [{ sku: "a", inventory: 42 }],
          nextCheckpoint: createCheckpoint(descriptor, "1"),
          hasMore: false,
        }),
      project: (raw) => ({
        recordId: raw.sku,
        identity: { kind: "sku", value: raw.sku },
        updatedAt: "2026-01-01T00:00:00Z",
        comparable: { available: raw.inventory },
        evidence: { format: "json", locator: raw.sku, payload: raw },
      }),
    });
    const page = await adapter.readPage({ checkpoint: null, limit: 2 });
    expect(page.records[0]?.comparable).toEqual({ available: 42 });
  });
});
