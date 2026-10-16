import { randomUUID } from "node:crypto";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { assertCheckpointCompatible } from "../contracts/adapter.js";
import type { ReadAdapter } from "../contracts/adapter.js";
import { ReconciliationError } from "./errors.js";
import { contentHash } from "./json.js";
import { jsonPolicy, policyJson, type NormalizationPolicy } from "./policy.js";
import type { ReconciliationStore, RunSummary } from "./store.js";
import type { ReconciliationResult } from "./model.js";
import { classifyRecords } from "./classify.js";
import { normalizeRecord } from "./normalize.js";
import { checkpointValue, recordValue, jsonValue } from "./validation.js";
import { validateRuntime, withRetry, type RuntimePolicy } from "./runtime.js";
import { repairPolicyValue, type RepairPolicy } from "./ownership.js";

export type ReconciliationJob = {
  readonly id: string;
  readonly source: ReadAdapter;
  readonly target: ReadAdapter;
  readonly normalization?: NormalizationPolicy;
  readonly pageSize?: number;
  readonly datasets?: { readonly source: string; readonly target: string };
  readonly runtime?: RuntimePolicy;
  readonly repair?: RepairPolicy;
};
export type RunEvent = {
  readonly type:
    | "run_started"
    | "page_read"
    | "checkpoint"
    | "difference"
    | "conflict"
    | "retry"
    | "repair_intent"
    | "repair_outcome"
    | "run_completed"
    | "run_failed";
  readonly jobId: string;
  readonly runId: string;
  readonly side?: "source" | "target";
  readonly records?: number;
  readonly attempt?: number;
  readonly operationId?: string;
};
export type CompareOptions = {
  readonly store: ReconciliationStore;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly onEvent?: (event: RunEvent) => void;
};

export function defineJob<const T extends ReconciliationJob>(job: T): T {
  validateRuntime(job.runtime);
  if (job.repair !== undefined) repairPolicyValue(job.repair);
  if (job.id.trim() === "")
    throw new ReconciliationError("invalid_config", "Job ID is required");
  if (job.source.descriptor.id === job.target.descriptor.id)
    throw new ReconciliationError(
      "invalid_config",
      "Source and target adapter IDs must differ",
    );
  for (const side of ["source", "target"] as const) {
    const descriptor = job[side].descriptor;
    if (
      descriptor.id.trim() === "" ||
      descriptor.adapterVersion.trim() === "" ||
      descriptor.schemaVersion.trim() === ""
    )
      throw new ReconciliationError(
        "invalid_config",
        "Adapter identity and versions are required",
      );
    if (!(job.datasets?.[side] ?? descriptor.datasetId)?.trim())
      throw new ReconciliationError(
        "invalid_config",
        `Declare the ${side} dataset identity`,
      );
  }
  if (
    job.pageSize !== undefined &&
    (!Number.isSafeInteger(job.pageSize) ||
      job.pageSize < 1 ||
      job.pageSize > 10000)
  )
    throw new ReconciliationError(
      "invalid_config",
      "Page size must be between 1 and 10000",
    );
  return job;
}

export function jobFingerprint(job: ReconciliationJob): string {
  return contentHash({
    source: {
      ...job.source.descriptor,
      datasetId: job.datasets?.source ?? job.source.descriptor.datasetId ?? "",
    },
    target: {
      ...job.target.descriptor,
      datasetId: job.datasets?.target ?? job.target.descriptor.datasetId ?? "",
    },
    normalization: policyJson(job.normalization ?? jsonPolicy),
    repair:
      job.repair === undefined
        ? null
        : jsonValue(repairPolicyValue(job.repair)),
  });
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ReconciliationError("cancelled", "Reconciliation cancelled");
}

export async function compare(
  job: ReconciliationJob,
  options: CompareOptions,
): Promise<RunSummary> {
  defineJob(job);
  checkCancelled(options.signal);
  const fingerprint = jobFingerprint(job);
  const store = options.store.forJob(job.id, fingerprint);
  const runId = options.createRunId?.() ?? randomUUID();
  const durable = store.durable;
  const emit = (event: RunEvent) => {
    // Diagnostic hooks cannot invalidate already committed work.
    try {
      options.onEvent?.(event);
    } catch {
      /* Observer failures are isolated. */
    }
  };
  durable.acquire(runId);
  try {
    const before = {
      source: store.getCheckpoint(job.source.descriptor.id),
      target: store.getCheckpoint(job.target.descriptor.id),
    };
    const after = { ...before };
    const recordsRead = { source: 0, target: 0 };
    let pages = 0;
    durable.begin(runId, (options.now?.() ?? new Date()).toISOString());
    emit({ type: "run_started", jobId: job.id, runId });
    for (const side of ["source", "target"] as const) {
      const adapter = job[side];
      let checkpoint = before[side];
      const seen = new Set<string>();
      for (;;) {
        checkCancelled(options.signal);
        if (++pages > (job.runtime?.maxPages ?? 10000))
          throw new ReconciliationError(
            "limit_exceeded",
            "Run exceeded its page limit",
          );
        const page = await withRetry(
          (signal) =>
            adapter.readPage({
              checkpoint,
              limit: job.pageSize ?? 100,
              signal,
            }),
          {
            ...(job.runtime === undefined ? {} : { policy: job.runtime }),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            onRetry: (attempt) =>
              emit({ type: "retry", jobId: job.id, runId, side, attempt }),
          },
        );
        checkCancelled(options.signal);
        if (
          typeof page.hasMore !== "boolean" ||
          page.records.length > (job.pageSize ?? 100)
        )
          throw new ReconciliationError(
            "adapter_error",
            "Adapter violated its page contract",
          );
        const next = checkpointValue(page.nextCheckpoint);
        assertCheckpointCompatible(adapter.descriptor, next);
        const records = page.records.map((record) => {
          try {
            return normalizeRecord(
              side,
              adapter.descriptor,
              recordValue(record),
              job.normalization,
            );
          } catch (error) {
            throw new ReconciliationError(
              "invalid_record",
              error instanceof Error ? error.message : String(error),
              jsonValue(record),
            );
          }
        });
        recordsRead[side] += records.length;
        if (
          recordsRead.source + recordsRead.target >
          (job.runtime?.maxRecords ?? 1000000)
        )
          throw new ReconciliationError(
            "limit_exceeded",
            "Run exceeded its record limit",
          );
        if (
          page.hasMore &&
          (next.cursor === checkpoint?.cursor || seen.has(next.cursor ?? ""))
        )
          throw new ReconciliationError(
            "adapter_error",
            "Adapter cursor did not advance",
          );
        seen.add(next.cursor ?? "");
        durable.page({
          runId,
          side,
          adapterId: adapter.descriptor.id,
          records,
          previous: checkpoint,
          next,
        });
        checkpoint = next;
        after[side] = next;
        emit({ type: "checkpoint", jobId: job.id, runId, side });
        emit({
          type: "page_read",
          jobId: job.id,
          runId,
          side,
          records: records.length,
        });
        if (!page.hasMore) break;
      }
    }
    const summary = {
      total: 0,
      equal: 0,
      missing: 0,
      changed: 0,
      conflicting: 0,
    };
    let batch: ReconciliationResult[] = [];
    for (const group of durable.groups(
      job.source.descriptor.id,
      job.target.descriptor.id,
    )) {
      checkCancelled(options.signal);
      for (const result of classifyRecords(group.source, group.target)) {
        summary.total++;
        summary[result.classification]++;
        if (result.classification !== "equal")
          emit({
            type:
              result.classification === "conflicting"
                ? "conflict"
                : "difference",
            jobId: job.id,
            runId,
          });
        batch.push(result);
      }
      if (batch.length >= 250) {
        durable.appendResults(runId, batch);
        batch = [];
        await yieldEventLoop();
      }
    }
    if (batch.length > 0) durable.appendResults(runId, batch);
    if (after.source === null || after.target === null)
      throw new Error("Both read scopes must complete");
    const report: RunSummary = {
      schemaVersion: "1",
      mode: "dry-run",
      runId,
      jobId: job.id,
      fingerprint,
      generatedAt: (options.now?.() ?? new Date()).toISOString(),
      normalizationVersion: (job.normalization ?? jsonPolicy).version,
      adapters: {
        source: job.source.descriptor,
        target: job.target.descriptor,
      },
      checkpoints: {
        before,
        after: { source: after.source, target: after.target },
      },
      recordsRead,
      summary,
    };
    checkCancelled(options.signal);
    durable.finish(report);
    emit({ type: "run_completed", jobId: job.id, runId });
    return report;
  } catch (error) {
    durable.fail(runId, error instanceof Error ? error.message : String(error));
    store.recordFailure(error);
    emit({ type: "run_failed", jobId: job.id, runId });
    if (error instanceof ReconciliationError) throw error;
    throw new ReconciliationError(
      "adapter_error",
      error instanceof Error ? error.message : String(error),
      null,
      { cause: error },
    );
  } finally {
    durable.release(runId);
  }
}
