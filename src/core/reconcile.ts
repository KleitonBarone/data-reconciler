import { randomUUID } from "node:crypto";
import type {
  AdapterCheckpoint,
  AdapterRecord,
  ReadAdapter,
} from "../contracts/adapter.js";
import type { CommitFaultHooks, ReconciliationStore } from "./store.js";
import { checkCancelled } from "./job.js";
import { classifyRecords, summarize } from "./classify.js";
import type { ReconciliationReport } from "./model.js";
import { REPORT_SCHEMA_VERSION } from "./model.js";
import { normalizeRecord } from "./normalize.js";
import { mergeObservations } from "./revisions.js";
import { jsonPolicy, type NormalizationPolicy } from "./policy.js";

export type ReconcileOptions = {
  readonly source: ReadAdapter;
  readonly target: ReadAdapter;
  readonly store: ReconciliationStore;
  readonly pageSize?: number;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly commitFaultHooks?: CommitFaultHooks;
  readonly normalization?: NormalizationPolicy;
  readonly signal?: AbortSignal;
  readonly onPage?: (side: "source" | "target", records: number) => void;
};

export async function reconcileDryRun(
  options: ReconcileOptions,
): Promise<ReconciliationReport> {
  try {
    return await executeDryRun(options);
  } catch (error) {
    options.store.recordFailure(error);
    throw error;
  }
}

async function executeDryRun(
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
    readIncremental(
      options.source,
      beforeSource,
      pageSize,
      options.signal,
      (records) => options.onPage?.("source", records),
    ),
    readIncremental(
      options.target,
      beforeTarget,
      pageSize,
      options.signal,
      (records) => options.onPage?.("target", records),
    ),
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

  checkCancelled(options.signal);
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
  signal?: AbortSignal,
  onPage?: (records: number) => void,
): Promise<IncrementalRead> {
  const records: AdapterRecord[] = [];
  let checkpoint = initialCheckpoint;
  const seen = new Set<string>();

  for (;;) {
    checkCancelled(signal);
    const page = await adapter.readPage({
      checkpoint,
      limit: pageSize,
      ...(signal === undefined ? {} : { signal }),
    });
    checkCancelled(signal);
    onPage?.(page.records.length);
    records.push(...page.records);
    if (!page.hasMore) {
      return { records, checkpoint: page.nextCheckpoint };
    }
    const key = page.nextCheckpoint.cursor ?? "";
    if (key === checkpoint?.cursor || seen.has(key)) {
      throw new Error(
        `${adapter.descriptor.id} returned hasMore without advancing its cursor`,
      );
    }
    seen.add(key);
    checkpoint = page.nextCheckpoint;
  }
}
