import { randomUUID } from "node:crypto";
import type { ReadAdapter } from "../contracts/adapter.js";
import { ReconciliationError } from "./errors.js";
import { contentHash } from "./json.js";
import { jsonPolicy, policyJson, type NormalizationPolicy } from "./policy.js";
import { reconcileDryRun } from "./reconcile.js";
import type { ReconciliationStore } from "./store.js";

export type ReconciliationJob = {
  readonly id: string;
  readonly source: ReadAdapter;
  readonly target: ReadAdapter;
  readonly normalization?: NormalizationPolicy;
  readonly pageSize?: number;
  readonly datasets?: { readonly source: string; readonly target: string };
};
export type RunEvent = {
  readonly type: "run_started" | "page_read" | "run_completed" | "run_failed";
  readonly jobId: string;
  readonly runId: string;
  readonly side?: "source" | "target";
  readonly records?: number;
};
export type CompareOptions = {
  readonly store: ReconciliationStore;
  readonly signal?: AbortSignal;
  readonly now?: () => Date;
  readonly createRunId?: () => string;
  readonly onEvent?: (event: RunEvent) => void;
};

export function defineJob<const T extends ReconciliationJob>(job: T): T {
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
  });
}

export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw new ReconciliationError("cancelled", "Reconciliation cancelled");
}

export async function compare(job: ReconciliationJob, options: CompareOptions) {
  defineJob(job);
  checkCancelled(options.signal);
  const store = options.store.forJob(job.id, jobFingerprint(job));
  const runId = options.createRunId?.() ?? randomUUID();
  options.onEvent?.({ type: "run_started", jobId: job.id, runId });
  try {
    const report = await reconcileDryRun({
      source: job.source,
      target: job.target,
      store,
      ...(job.pageSize === undefined ? {} : { pageSize: job.pageSize }),
      normalization: job.normalization ?? jsonPolicy,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.now === undefined ? {} : { now: options.now }),
      createRunId: () => runId,
      onPage: (side, records) =>
        options.onEvent?.({
          type: "page_read",
          jobId: job.id,
          runId,
          side,
          records,
        }),
    });
    options.onEvent?.({ type: "run_completed", jobId: job.id, runId });
    return report;
  } catch (error) {
    options.onEvent?.({ type: "run_failed", jobId: job.id, runId });
    if (error instanceof ReconciliationError) throw error;
    throw new ReconciliationError(
      "adapter_error",
      error instanceof Error ? error.message : String(error),
      null,
      { cause: error },
    );
  }
}
