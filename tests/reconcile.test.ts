import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonPageCommerceAdapter } from "../src/adapters/json-page-adapter.js";
import { JsonlLedgerCommerceAdapter } from "../src/adapters/jsonl-ledger-adapter.js";
import { commercePolicy } from "../src/adapters/commerce-policy.js";
import { reconcileDryRun } from "../src/core/reconcile.js";
import { formatTerminalReport } from "../src/reporters/terminal.js";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";

const sourceFixture = resolve("fixtures/source-pages.json");
const targetFixture = resolve("fixtures/target-ledger.jsonl");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("dry-run reconciliation", () => {
  it("classifies the deterministic fixtures and retains evidence", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    try {
      const report = await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourceFixture),
        target: new JsonlLedgerCommerceAdapter(targetFixture),
        store,
        normalization: commercePolicy,
        pageSize: 2,
        now: () => new Date("2026-08-27T12:00:00.000Z"),
        createRunId: () => "fixture-run",
      });

      expect(report.mode).toBe("dry-run");
      expect(report.schemaVersion).toBe("1");
      expect(report.normalizationVersion).toBe("commerce.v1");
      expect(report.recordsRead).toEqual({ source: 6, target: 4 });
      expect(report.summary).toEqual({
        total: 6,
        equal: 1,
        missing: 2,
        changed: 1,
        conflicting: 2,
      });
      expect(result(report, "order:ORDER-100")?.classification).toBe("equal");
      expect(result(report, "order:ORDER-101")).toMatchObject({
        classification: "changed",
        newerSide: "source",
        differences: [
          {
            path: "totalMinor",
            source: { present: true, value: 4200 },
            target: { present: true, value: 4000 },
          },
        ],
      });
      expect(result(report, "order:ORDER-102")).toMatchObject({
        classification: "missing",
        missingSide: "target",
      });
      expect(result(report, "order:ORDER-104")).toMatchObject({
        classification: "missing",
        missingSide: "source",
      });
      expect(result(report, "order:ORDER-103")).toMatchObject({
        classification: "conflicting",
        reason: "ambiguous_ownership",
      });
      expect(
        report.results.find(
          (item) =>
            item.classification === "conflicting" &&
            item.reason === "missing_identifier",
        ),
      ).toBeDefined();

      for (const difference of report.results.filter(
        (item) => item.classification !== "equal",
      )) {
        const records = [...difference.source, ...difference.target];
        expect(records.length).toBeGreaterThan(0);
        expect(records.every((record) => record.evidence.locator !== "")).toBe(
          true,
        );
        expect(
          records.every((record) => record.evidence.payload !== null),
        ).toBe(true);
      }

      expect(JSON.parse(JSON.stringify(report))).toMatchObject({
        mode: "dry-run",
        summary: report.summary,
      });
      expect(formatTerminalReport(report)).toContain(
        "Results: 1 equal, 2 missing, 1 changed, 2 conflicting",
      );
      expect(formatTerminalReport(report)).toContain(
        "No external records were changed.",
      );
      expect(store.getReport("fixture-run")).toEqual(report);
    } finally {
      store.close();
    }
  });

  it("deduplicates repeated pages by stable local record ID", async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "source.json");
    const targetPath = join(directory, "target.jsonl");
    const sourceRecord = acmeRecord("acme-1", "order-1");
    await writeFile(
      sourcePath,
      JSON.stringify({
        schemaVersion: "acme-orders.v1",
        pages: [[sourceRecord], [sourceRecord]],
      }),
    );
    await writeFile(
      targetPath,
      ledger([northstarRecord(1, "north-1", "order-1")]),
    );

    const store = new SqliteReconciliationStore(":memory:");
    try {
      const report = await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourcePath),
        target: new JsonlLedgerCommerceAdapter(targetPath),
        store,
        normalization: commercePolicy,
        pageSize: 1,
      });
      expect(report.recordsRead.source).toBe(2);
      expect(report.summary).toEqual({
        total: 1,
        equal: 1,
        missing: 0,
        changed: 0,
        conflicting: 0,
      });
    } finally {
      store.close();
    }
  });

  it("reads a late record by ledger sequence rather than business timestamp", async () => {
    const directory = await createTemporaryDirectory();
    const sourcePath = join(directory, "source.json");
    const targetPath = join(directory, "target.jsonl");
    await writeFile(
      sourcePath,
      JSON.stringify({
        schemaVersion: "acme-orders.v1",
        pages: [
          [
            acmeRecord("acme-1", "order-1"),
            acmeRecord("acme-late", "order-late", "2025-01-01T00:00:00.000Z"),
          ],
        ],
      }),
    );
    const firstTarget = northstarRecord(1, "north-1", "order-1");
    await writeFile(targetPath, ledger([firstTarget]));

    const store = new SqliteReconciliationStore(
      join(directory, "state.sqlite"),
    );
    try {
      const first = await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourcePath),
        target: new JsonlLedgerCommerceAdapter(targetPath),
        store,
        normalization: commercePolicy,
      });
      expect(result(first, "order:ORDER-LATE")?.classification).toBe("missing");

      const lateTarget = northstarRecord(
        2,
        "north-late",
        "order-late",
        "2025-01-01T00:00:00.000Z",
      );
      await writeFile(targetPath, ledger([firstTarget, lateTarget]));
      const second = await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourcePath),
        target: new JsonlLedgerCommerceAdapter(targetPath),
        store,
        normalization: commercePolicy,
      });

      expect(second.recordsRead).toEqual({ source: 0, target: 1 });
      expect(result(second, "order:ORDER-LATE")?.classification).toBe("equal");
      expect(second.checkpoints.after.target.cursor).toBe("2");
    } finally {
      store.close();
    }
  });

  it("rolls observations, reports, and checkpoints back on a checkpoint crash", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    const source = new JsonPageCommerceAdapter(sourceFixture);
    const target = new JsonlLedgerCommerceAdapter(targetFixture);
    try {
      await expect(
        reconcileDryRun({
          source,
          target,
          store,
          normalization: commercePolicy,
          commitFaultHooks: {
            afterReport: () => {
              throw new Error("simulated crash");
            },
          },
        }),
      ).rejects.toThrow("simulated crash");

      expect(store.getCheckpoint(source.descriptor.id)).toBeNull();
      expect(store.getCheckpoint(target.descriptor.id)).toBeNull();
      expect(store.loadObservations(source.descriptor.id, "source")).toEqual(
        [],
      );
      expect(store.countReports()).toBe(0);

      const replay = await reconcileDryRun({
        source,
        target,
        store,
        normalization: commercePolicy,
      });
      expect(replay.recordsRead).toEqual({ source: 6, target: 4 });
    } finally {
      store.close();
    }
  });

  it("rejects checkpoint reuse across schema versions without changing old reports", async () => {
    const store = new SqliteReconciliationStore(":memory:");
    try {
      const first = await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourceFixture),
        target: new JsonlLedgerCommerceAdapter(targetFixture),
        store,
        normalization: commercePolicy,
        createRunId: () => "schema-v1-run",
      });

      await expect(
        reconcileDryRun({
          source: new JsonPageCommerceAdapter(sourceFixture, {
            schemaVersion: "acme-orders.v2",
          }),
          target: new JsonlLedgerCommerceAdapter(targetFixture),
          store,
          normalization: commercePolicy,
        }),
      ).rejects.toThrow("checkpoint version does not match");
      expect(store.getReport("schema-v1-run")).toEqual(first);
      expect(store.countReports()).toBe(1);
    } finally {
      store.close();
    }
  });

  it("does not mutate adapter files and rejects repair mode", async () => {
    const beforeSource = await readFile(sourceFixture, "utf8");
    const beforeTarget = await readFile(targetFixture, "utf8");
    const store = new SqliteReconciliationStore(":memory:");
    try {
      await reconcileDryRun({
        source: new JsonPageCommerceAdapter(sourceFixture),
        target: new JsonlLedgerCommerceAdapter(targetFixture),
        store,
        normalization: commercePolicy,
      });
    } finally {
      store.close();
    }

    expect(await readFile(sourceFixture, "utf8")).toBe(beforeSource);
    expect(await readFile(targetFixture, "utf8")).toBe(beforeTarget);

    const cli = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/cli.ts", "reconcile", "--apply"],
      { cwd: resolve("."), encoding: "utf8" },
    );
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("Comparison commands never apply repairs");
  });
});

function result(
  report: Awaited<ReturnType<typeof reconcileDryRun>>,
  identityKey: string,
) {
  return report.results.find((item) => item.identityKey === identityKey);
}

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "data-reconciler-"));
  temporaryDirectories.push(directory);
  return directory;
}

function acmeRecord(
  id: string,
  orderNumber: string,
  modifiedAt = "2026-01-01T00:00:00.000Z",
) {
  return {
    id,
    order_number: orderNumber,
    modified_at: modifiedAt,
    customer: { email: "buyer@example.com" },
    total_cents: 1000,
    currency_code: "USD",
    status: "paid",
  };
}

function northstarRecord(
  sequence: number,
  localId: string,
  externalRef: string,
  lastSeen = "2026-01-01T00:00:00.000Z",
) {
  return {
    sequence,
    event_id: `event-${sequence}`,
    order: {
      local_id: localId,
      external_ref: externalRef,
      last_seen: lastSeen,
      buyer_email: "buyer@example.com",
      amount: { minor: 1000 },
      currency: "USD",
      state: "paid",
    },
  };
}

function ledger(records: readonly object[]): string {
  return [
    JSON.stringify({
      type: "schema",
      schemaVersion: "northstar-orders.v1",
    }),
    ...records.map((record) => JSON.stringify(record)),
    "",
  ].join("\n");
}
