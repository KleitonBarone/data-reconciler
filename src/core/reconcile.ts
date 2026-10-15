import { randomUUID } from "node:crypto";
import type {
  AdapterCheckpoint,
  AdapterRecord,
  ReadAdapter,
} from "../contracts/adapter.js";
import type { CommitFaultHooks } from "../storage/sqlite-store.js";
import { SqliteReconciliationStore } from "../storage/sqlite-store.js";
import { classifyRecords, summarize } from "./classify.js";
import type { ReconciliationReport } from "./model.js";
import { REPORT_SCHEMA_VERSION } from "./model.js";
import { normalizeRecord } from "./normalize.js";
import { mergeObservations } from "./revisions.js";
import { jsonPolicy, type NormalizationPolicy } from "./policy.js";

export type ReconcileOptions = {
  readonly source: ReadAdapter;
  readonly target: ReadAdapter;
  readonly store: SqliteReconciliationStore;
  readonly pageSize?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly commitFaultHooks?: CommitFaultHooks;
  readonly normalization?: NormalizationPolicy;
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
    normalizeRecord(
      "source",
      options.source.descriptor,
      record,
      options.normalization,
    ),
  );
  const targetNew = targetRead.records.map((record) =>
    normalizeRecord(
      "target",
      options.target.descriptor,
      record,
      options.normalization,
    ),
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
    normalizationVersion: (options.normalization ?? jsonPolicy).version,
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
    observationsRead: [...sourceNew, ...targetNew],
  };

  options.store.commitRun(
    {
      observations: [...sourceCurrent, ...targetCurrent],
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
