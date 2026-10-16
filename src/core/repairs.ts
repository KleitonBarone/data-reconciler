import { randomUUID } from "node:crypto";
import {
  type RepairWrite,
  type WriteReceipt,
  writerValue,
  receiptValue,
} from "../contracts/writer.js";
import type { RepairPlan, PlanAcceptance } from "./plans.js";
import {
  compare,
  checkCancelled,
  defineJob,
  jobFingerprint,
  type ReconciliationJob,
  type RunEvent,
} from "./job.js";
import type { ReconciliationStore } from "./store.js";
import { ReconciliationError } from "./errors.js";
import { withRetry } from "./runtime.js";
import { objectValue, stringValue, integerValue } from "./validation.js";
import { parseTimestamp } from "./json.js";

export type RepairOutcome = {
  readonly schemaVersion: "1";
  readonly digest: string;
  readonly operationId: string;
  readonly state: "pending" | "succeeded" | "skipped" | "failed" | "unknown";
  readonly at: string;
  readonly receipt: WriteReceipt | null;
  readonly errorCode: string | null;
};
export type RepairAuditStore = {
  record(outcome: RepairOutcome): void;
  state(digest: string, operationId: string): RepairOutcome | null;
  history(digest: string): Iterable<RepairOutcome>;
  verified(digest: string, runId: string): void;
  verifications(digest: string): readonly string[];
  saveSummary(summary: ApplySummary): void;
  summaries(digest: string): readonly ApplySummary[];
};
export type ApplySummary = {
  readonly schemaVersion: "1";
  readonly digest: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly succeeded: number;
  readonly skipped: number;
  readonly failed: number;
  readonly unknown: number;
  readonly pending: number;
  readonly cancelled: boolean;
  readonly verificationRunId: string | null;
};

export function validateAcceptedPlan(
  job: ReconciliationJob,
  store: ReconciliationStore,
  digest: string,
  now = new Date(),
): { plan: RepairPlan; acceptance: PlanAcceptance } {
  defineJob(job);
  const plan = store.plans.get(digest);
  const acceptance = store.plans.acceptance(digest);
  if (
    plan?.body.jobId !== job.id ||
    plan.body.fingerprint !== jobFingerprint(job) ||
    acceptance?.digest !== digest
  )
    throw new ReconciliationError(
      "unsafe_write",
      "Apply requires an accepted digest of this exact job generation",
    );
  if (
    acceptance.expiresAt !== plan.body.expiresAt ||
    now.getTime() >= Date.parse(acceptance.expiresAt)
  )
    throw new ReconciliationError("stale_plan", "Plan authorization expired");
  const selected = plan.body.operations.filter((op) =>
    acceptance.operationIds.includes(op.id),
  );
  if (
    selected.length === 0 ||
    selected.length !== acceptance.operationIds.length ||
    selected.length > acceptance.maxOperations ||
    new Set(selected.map((op) => op.recordId)).size > acceptance.maxRecords ||
    selected.some((op) =>
      op.fields.some(
        (field) =>
          !acceptance.allowedFields.includes(field) ||
          !plan.body.policy.sourceFields.includes(field),
      ),
    )
  )
    throw new ReconciliationError(
      "unsafe_write",
      "Accepted operation bounds or ownership changed",
    );
  writerValue(job.target.writer);
  return { plan, acceptance };
}

/** Intent commits before I/O. Unknown results only retry through a deduplicating writer. */
export async function applyPlan(
  job: ReconciliationJob,
  options: {
    readonly store: ReconciliationStore;
    readonly digest: string;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
    readonly onEvent?: (event: RunEvent) => void;
  },
): Promise<ApplySummary> {
  const now = () => options.now?.() ?? new Date();
  const { plan, acceptance } = validateAcceptedPlan(
    job,
    options.store,
    options.digest,
    now(),
  );
  const writer = writerValue(job.target.writer);
  const scoped = options.store.forJob(job.id, plan.body.fingerprint);
  const attemptId = randomUUID();
  const summary = {
    schemaVersion: "1" as const,
    digest: plan.digest,
    jobId: job.id,
    attemptId,
    succeeded: 0,
    skipped: 0,
    failed: 0,
    unknown: 0,
    pending: acceptance.operationIds.length,
    cancelled: false,
    verificationRunId: null as string | null,
  };
  const emit = (
    type: "repair_intent" | "repair_outcome" | "retry",
    operationId: string,
    attempt?: number,
  ) => {
    try {
      options.onEvent?.({
        type,
        jobId: job.id,
        runId: attemptId,
        operationId,
        ...(attempt === undefined ? {} : { attempt }),
      });
    } catch {
      /* Audit state does not depend on log handlers. */
    }
  };
  const retryOptions = (operationId: string) => ({
    ...(job.runtime === undefined ? {} : { policy: job.runtime }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onRetry: (attempt: number) => emit("retry", operationId, attempt),
  });
  scoped.durable.acquire(attemptId);
  try {
    for (const operation of plan.body.operations) {
      if (!acceptance.operationIds.includes(operation.id)) continue;
      if (options.signal?.aborted) {
        summary.cancelled = true;
        break;
      }
      validateAcceptedPlan(job, options.store, options.digest, now());
      const previous = options.store.repairs.state(plan.digest, operation.id);
      if (previous?.state === "succeeded") {
        summary.skipped++;
        summary.pending--;
        continue;
      }
      const record = (
        state: RepairOutcome["state"],
        receipt: WriteReceipt | null,
        errorCode: string | null,
      ) =>
        options.store.repairs.record({
          schemaVersion: "1",
          digest: plan.digest,
          operationId: operation.id,
          state,
          at: now().toISOString(),
          receipt,
          errorCode,
        });
      record("pending", null, null);
      emit("repair_intent", operation.id);
      let sent = false;
      try {
        checkCancelled(options.signal);
        let receipt = await withRetry(
          (signal) => writer.lookup(operation.deduplicationKey, signal),
          retryOptions(operation.id),
        );
        if (receipt === null) {
          const updatedAt = new Date(
            Math.max(
              Date.parse(operation.source.updatedAt),
              Date.parse(
                operation.before?.updatedAt ?? operation.source.updatedAt,
              ),
            ) + 1,
          ).toISOString();
          const write: RepairWrite = {
            authorizationDigest: plan.digest,
            deduplicationKey: operation.deduplicationKey,
            kind: operation.kind,
            recordId: operation.recordId,
            identityKey: operation.identityKey,
            identity: operation.identity,
            expectedRevision: operation.expectedRevision,
            expectedCheckpoint: operation.expectedCheckpoint,
            comparable: operation.after,
            fields: operation.fields,
            updatedAt,
          };
          sent = true;
          receipt = await withRetry((signal) => {
            validateAcceptedPlan(job, options.store, options.digest, now());
            return writer.apply(write, signal);
          }, retryOptions(operation.id));
        }
        if (receipt.recordId !== operation.recordId)
          throw new ReconciliationError(
            "adapter_error",
            "Writer returned the wrong record ID",
          );
        record("succeeded", receipt, null);
        summary.succeeded++;
        summary.pending--;
        emit("repair_outcome", operation.id);
      } catch (error) {
        const code =
          error instanceof ReconciliationError ? error.code : "adapter_error";
        // A rejected precondition proves no write. Other post-send failures are uncertain.
        const uncertain =
          sent && code !== "stale_plan" && code !== "unsafe_write";
        record(uncertain ? "unknown" : "failed", null, code);
        if (uncertain) summary.unknown++;
        else summary.failed++;
        summary.pending--;
        summary.cancelled = options.signal?.aborted ?? false;
        emit("repair_outcome", operation.id);
        break;
      }
    }
  } finally {
    scoped.durable.release(attemptId);
    options.store.repairs.saveSummary(summary);
  }
  if (!summary.cancelled) {
    const verification = await compare(job, {
      store: options.store,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
    });
    options.store.repairs.verified(plan.digest, verification.runId);
    summary.verificationRunId = verification.runId;
    options.store.repairs.saveSummary(summary);
  }
  return summary;
}

export function outcomeValue(value: unknown): RepairOutcome {
  const raw = objectValue(value, "repair outcome");
  const state = raw.state;
  if (
    raw.schemaVersion !== "1" ||
    (state !== "pending" &&
      state !== "succeeded" &&
      state !== "skipped" &&
      state !== "failed" &&
      state !== "unknown")
  )
    throw new ReconciliationError(
      "corrupt_state",
      "Unsupported repair outcome",
    );
  return {
    schemaVersion: "1",
    digest: stringValue(raw.digest),
    operationId: stringValue(raw.operationId),
    state,
    at: parseTimestamp(stringValue(raw.at)),
    receipt: raw.receipt === null ? null : receiptValue(raw.receipt),
    errorCode: raw.errorCode === null ? null : stringValue(raw.errorCode),
  };
}

export function applySummaryValue(value: unknown): ApplySummary {
  const raw = objectValue(value, "apply summary");
  if (raw.schemaVersion !== "1" || typeof raw.cancelled !== "boolean")
    throw new ReconciliationError("corrupt_state", "Unsupported apply summary");
  return {
    schemaVersion: "1",
    digest: stringValue(raw.digest),
    jobId: stringValue(raw.jobId),
    attemptId: stringValue(raw.attemptId),
    succeeded: integerValue(raw.succeeded),
    skipped: integerValue(raw.skipped),
    failed: integerValue(raw.failed),
    unknown: integerValue(raw.unknown),
    pending: integerValue(raw.pending),
    cancelled: raw.cancelled,
    verificationRunId:
      raw.verificationRunId === null
        ? null
        : stringValue(raw.verificationRunId),
  };
}
