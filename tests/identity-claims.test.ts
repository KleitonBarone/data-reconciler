import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  compare,
  createPlan,
  acceptPlan,
  applyPlan,
  createCheckpoint,
  SqliteReconciliationStore,
  type AdapterRecord,
  type ReadAdapter,
} from "../src/index.js";

function record(id: string, identity: string | null): AdapterRecord {
  return {
    recordId: id,
    identity: identity === null ? null : { kind: "sku", value: identity },
    updatedAt: "2026-01-02T00:00:00Z",
    comparable: { stock: 1 },
    evidence: { format: "fixture", locator: id, payload: { id, identity } },
  };
}
function adapter(id: string, records: readonly AdapterRecord[]): ReadAdapter {
  const descriptor = {
    id,
    displayName: id,
    datasetId: "memory:" + id,
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
function job(
  source: readonly AdapterRecord[],
  target: readonly AdapterRecord[],
) {
  return {
    id: "claims",
    source: adapter("source", source),
    target: adapter("target", target),
    pageSize: 1,
    repair: {
      version: "1",
      direction: "source-to-target",
      sourceFields: ["stock"],
    },
  } as const;
}

describe("ambiguous identity ownership", () => {
  it("indexes a missing identity variant without freeing its identified owner", async () => {
    const currentJob = job(
      [record("b", "B")],
      [record("owner", "B"), record("owner", null)],
    );
    const store = new SqliteReconciliationStore(":memory:");
    try {
      const run = await compare(currentJob, { store });
      expect(
        [...store.durable.results(run.runId)].map(
          (result) => result.identityKey,
        ),
      ).toEqual(["sku:B", null]);
      expect(run.summary).toMatchObject({ conflicting: 2, missing: 0 });
      expect(
        createPlan(currentJob, { store, runId: run.runId }).body.operations,
      ).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("rolls back a failed claims backfill without upgrading or rewriting old state", () => {
    const directory = mkdtempSync(
      join(tmpdir(), "reconciler-claims-rollback-"),
    );
    const path = join(directory, "state.sqlite");
    new SqliteReconciliationStore(path).close();
    const db = new DatabaseSync(path);
    try {
      db.exec(
        "DROP TABLE observation_identities; PRAGMA user_version=4; INSERT INTO observations VALUES ('broken','source','owner','sku:A','{}');",
      );
      expect(() => new SqliteReconciliationStore(path)).toThrow();
      expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
      expect(
        db.prepare("SELECT snapshot_json FROM observations").get()
          ?.snapshot_json,
      ).toBe("{}");
      expect(
        db
          .prepare(
            "SELECT name FROM sqlite_master WHERE name='observation_identities'",
          )
          .get(),
      ).toBeUndefined();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.each(["source", "target"] as const)(
    "blocks all claims on the %s side across pages and runs",
    async (side) => {
      const variants = [record("owner", "A"), record("owner", "B")];
      const other = [record("a", "A"), record("b", "B")];
      const currentJob = job(
        side === "source" ? variants : other,
        side === "target" ? variants : other,
      );
      const store = new SqliteReconciliationStore(":memory:");
      try {
        const first = await compare(currentJob, { store });
        expect(first.summary).toMatchObject({ conflicting: 2, missing: 0 });
        expect(
          createPlan(currentJob, { store, runId: first.runId }).body.operations,
        ).toHaveLength(0);
        expect((await compare(currentJob, { store })).summary).toEqual(
          first.summary,
        );
        variants.push({
          ...record("owner", "A"),
          updatedAt: "2026-01-03T00:00:00Z",
        });
        const newer = await compare(currentJob, { store });
        expect(newer.summary).toMatchObject({
          equal: 1,
          missing: 1,
          conflicting: 0,
        });
      } finally {
        store.close();
      }
    },
  );

  it("backfills all claims from schema 4 without changing historical evidence", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reconciler-claims-"));
    const path = join(directory, "state.sqlite");
    const currentJob = job(
      [record("b", "B")],
      [record("owner", "A"), record("owner", "B")],
    );
    let store = new SqliteReconciliationStore(path);
    try {
      const first = await compare(currentJob, { store });
      const original = JSON.stringify([...store.durable.results(first.runId)]);
      store.close();
      const old = new DatabaseSync(path);
      old.exec(
        "DROP TABLE IF EXISTS observation_identities; PRAGMA user_version=4;",
      );
      old.close();
      store = new SqliteReconciliationStore(path);
      expect(store.inspect().schemaVersion).toBe(5);
      expect(JSON.stringify([...store.durable.results(first.runId)])).toBe(
        original,
      );
      const resumed = await compare(currentJob, { store });
      expect(resumed.recordsRead).toEqual({ source: 0, target: 0 });
      expect(resumed.summary).toMatchObject({ conflicting: 2, missing: 0 });
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses unsafe operations in legacy reports and already accepted plans", async () => {
    const directory = mkdtempSync(join(tmpdir(), "reconciler-legacy-claims-"));
    const path = join(directory, "state.sqlite");
    const base = job([record("b", "B")], [record("owner", "A")]);
    const targetIo = vi.fn(() =>
      Promise.reject(new Error("Unexpected target I/O")),
    );
    const currentJob = {
      ...base,
      target: {
        ...base.target,
        writer: {
          contractVersion: 1,
          capabilities: {
            create: true,
            update: true,
            atomicPreconditions: true,
            deduplication: true,
            verification: true,
          },
          apply: targetIo,
          lookup: targetIo,
          getCurrent: targetIo,
        },
      },
    } as const;
    let store = new SqliteReconciliationStore(path);
    try {
      const run = await compare(currentJob, { store });
      const legacy = createPlan(currentJob, { store, runId: run.runId });
      acceptPlan(currentJob, {
        store,
        digest: legacy.digest,
        operationIds: legacy.body.operations.map((op) => op.id),
        allowedFields: ["stock"],
        maxOperations: 1,
        maxRecords: 1,
      });
      const conflict = [...store.durable.results(run.runId)].find(
        (result) => result.identityKey === "sku:A",
      );
      const owner = conflict?.target[0];
      if (owner === undefined) throw new Error("Missing fixture owner");
      store.close();
      const db = new DatabaseSync(path);
      db.prepare(
        "UPDATE run_results SET result_json=? WHERE run_id=? AND position=0",
      ).run(
        JSON.stringify({
          classification: "conflicting",
          identityKey: "sku:A",
          reason: "conflicting_revision",
          differences: [],
          source: [],
          target: [
            {
              ...owner,
              revisionConflicts: [{ ...owner, identityKey: "sku:B" }],
            },
          ],
        }),
        run.runId,
      );
      db.close();
      store = new SqliteReconciliationStore(path);
      expect(
        createPlan(currentJob, { store, runId: run.runId }).body.operations,
      ).toHaveLength(0);
      await expect(
        applyPlan(currentJob, { store, digest: legacy.digest }),
      ).rejects.toThrow("ambiguous identity");
      expect(targetIo).not.toHaveBeenCalled();
      expect(store.plans.acceptance(legacy.digest)?.digest).toBe(legacy.digest);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
