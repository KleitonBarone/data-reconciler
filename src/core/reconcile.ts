import { randomUUID } from "node:crypto";
import type {
  AdapterCheckpoint,
  AdapterRecord,
  ReadAdapter,
} from "../contracts/adapter.js";
import type { CommitFaultHooks } from "../storage/sqlite-store.js";
import { SqliteReconciliationStore } from "../storage/sqlite-store.js";
import { classifyRecords, summarize } from "./classify.js";
import type { ReconciliationReport, RecordSnapshot } from "./model.js";
import { NORMALIZATION_VERSION, REPORT_SCHEMA_VERSION } from "./model.js";
import { normalizeRecord } from "./normalize.js";
import { compareText } from "./json.js";

export type ReconcileOptions = {
  readonly source: ReadAdapter;
  readonly target: ReadAdapter;
  readonly store: SqliteReconciliationStore;
  readonly pageSize?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly commitFaultHooks?: CommitFaultHooks;
};

export async function reconcileDryRun(
  options: ReconcileOptions,
): Promise<ReconciliationReport> {
  if (options.source.descriptor.id === options.target.descriptor.id) {
    throw new Error("Source and target adapters must have different IDs");
  }
  const pageSize = options.pageSize ?? 100;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("Page size must be a positive integer");
  }

  const beforeSource = options.store.getCheckpoint(
    options.source.descriptor.id,
  );
  const beforeTarget = options.store.getCheckpoint(
    options.target.descriptor.id,
  );
  const [sourceRead, targetRead] = await Promise.all([
    readIncremental(options.source, beforeSource, pageSize),
    readIncremental(options.target, beforeTarget, pageSize),
  ]);

  const sourceNew = sourceRead.records.map((record) =>
    normalizeRecord("source", options.source.descriptor, record),
  );
  const targetNew = targetRead.records.map((record) =>
    normalizeRecord("target", options.target.descriptor, record),
  );
  const sourceCurrent = mergeObservations(
    options.store.loadObservations(options.source.descriptor.id, "source"),
    sourceNew,
  );
  const targetCurrent = mergeObservations(
    options.store.loadObservations(options.target.descriptor.id, "target"),
    targetNew,
  );
  const results = classifyRecords(sourceCurrent, targetCurrent);
  const report: ReconciliationReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    runId: options.createRunId?.() ?? randomUUID(),
    generatedAt: (options.now?.() ?? new Date()).toISOString(),
    mode: "dry-run",
    normalizationVersion: NORMALIZATION_VERSION,
    adapters: {
      source: options.source.descriptor,
      target: options.target.descriptor,
    },
    checkpoints: {
      before: { source: beforeSource, target: beforeTarget },
      after: {
        source: sourceRead.checkpoint,
        target: targetRead.checkpoint,
      },
    },
    recordsRead: {
      source: sourceRead.records.length,
      target: targetRead.records.length,
    },
    summary: summarize(results),
    results,
  };

  options.store.commitRun(
    {
      observations: [...sourceNew, ...targetNew],
      checkpoints: new Map([
        [options.source.descriptor.id, sourceRead.checkpoint],
        [options.target.descriptor.id, targetRead.checkpoint],
      ]),
      report,
    },
    options.commitFaultHooks,
  );

  return report;
}

type IncrementalRead = {
  readonly records: readonly AdapterRecord[];
  readonly checkpoint: AdapterCheckpoint;
};

async function readIncremental(
  adapter: ReadAdapter,
  initialCheckpoint: AdapterCheckpoint | null,
  pageSize: number,
): Promise<IncrementalRead> {
  const records: AdapterRecord[] = [];
  let checkpoint = initialCheckpoint;

  for (;;) {
    const page = await adapter.readPage({ checkpoint, limit: pageSize });
    records.push(...page.records);
    if (!page.hasMore) {
      return { records, checkpoint: page.nextCheckpoint };
    }
    if (page.nextCheckpoint.cursor === checkpoint?.cursor) {
      throw new Error(
        `${adapter.descriptor.id} returned hasMore without advancing its cursor`,
      );
    }
    checkpoint = page.nextCheckpoint;
  }
}

function mergeObservations(
  stored: readonly RecordSnapshot[],
  incoming: readonly RecordSnapshot[],
): readonly RecordSnapshot[] {
  const records = new Map<string, RecordSnapshot>();
  for (const record of [...stored, ...incoming]) {
    records.set(record.recordId, record);
  }
  return [...records.values()].sort((left, right) =>
    compareText(left.recordId, right.recordId),
  );
}
