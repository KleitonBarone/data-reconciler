import type {
  AdapterCheckpoint,
  IdentityCandidate,
  JsonObject,
} from "../contracts/adapter.js";
import type { RecordSnapshot } from "./model.js";
import { jobFingerprint, defineJob, type ReconciliationJob } from "./job.js";
import {
  contentHash,
  canonicalJson,
  compareText,
  parseTimestamp,
} from "./json.js";
import {
  jsonValue,
  objectValue,
  stringValue,
  integerValue,
  jsonObject,
  checkpointValue,
} from "./validation.js";
import { snapshotValue } from "./decoders.js";
import {
  repairPolicyValue,
  stringList,
  type RepairPolicy,
} from "./ownership.js";
import { ReconciliationError } from "./errors.js";
import type { ReconciliationStore } from "./store.js";

export type RepairOperation = {
  readonly id: string;
  readonly kind: "create" | "update";
  readonly recordId: string;
  readonly identityKey: string;
  readonly identity: IdentityCandidate;
  readonly expectedRevision: string | null;
  readonly expectedCheckpoint: AdapterCheckpoint;
  readonly source: RecordSnapshot;
  readonly before: RecordSnapshot | null;
  readonly after: JsonObject;
  readonly fields: readonly string[];
  readonly deduplicationKey: string;
};
export type PlanBody = {
  readonly schemaVersion: "1";
  readonly jobId: string;
  readonly fingerprint: string;
  readonly runId: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly policy: RepairPolicy;
  readonly operations: readonly RepairOperation[];
  readonly skipped: {
    readonly count: number;
    readonly reasons: Readonly<Record<string, number>>;
  };
};
export type RepairPlan = { readonly digest: string; readonly body: PlanBody };
export type PlanAcceptance = {
  readonly schemaVersion: "1";
  readonly digest: string;
  readonly operationIds: readonly string[];
  readonly acceptedAt: string;
  readonly expiresAt: string;
  readonly allowedFields: readonly string[];
  readonly maxOperations: number;
  readonly maxRecords: number;
};
export type PlanStore = {
  put(plan: RepairPlan): void;
  get(digest: string): RepairPlan | null;
  accept(acceptance: PlanAcceptance): void;
  acceptance(digest: string): PlanAcceptance | null;
};

export function planDigest(body: PlanBody): string {
  return contentHash(jsonValue(body));
}

function identityFromKey(key: string): IdentityCandidate {
  const split = key.indexOf(":");
  if (split < 1)
    throw new ReconciliationError(
      "corrupt_state",
      "Invalid normalized identity",
    );
  const encoded = key.slice(split + 1);
  const parsed: unknown = encoded.startsWith("[")
    ? JSON.parse(encoded)
    : decodeURIComponent(encoded);
  const value = Array.isArray(parsed)
    ? parsed.map((part: unknown) => stringValue(part))
    : stringValue(parsed);
  return { kind: decodeURIComponent(key.slice(0, split)), value };
}

export function createPlan(
  job: ReconciliationJob,
  options: {
    readonly store: ReconciliationStore;
    readonly runId: string;
    readonly expiresInMs?: number;
  },
): RepairPlan {
  defineJob(job);
  if (job.repair === undefined)
    throw new ReconciliationError(
      "invalid_config",
      "Declare repair direction and field ownership before planning",
    );
  const policy = repairPolicyValue(job.repair);
  const fingerprint = jobFingerprint(job);
  const scoped = options.store.forJob(job.id, fingerprint);
  const run = scoped.durable.getRun(options.runId);
  if (run?.fingerprint !== fingerprint)
    throw new ReconciliationError(
      "stale_plan",
      "Use a completed comparison of this exact job generation",
    );
  const ttl = options.expiresInMs ?? 86400000;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 604800000)
    throw new ReconciliationError(
      "invalid_config",
      "Plan lifetime must be between 1 ms and seven days",
    );
  const operations: RepairOperation[] = [];
  const reasons: Record<string, number> = {};
  const skip = (reason: string) => {
    reasons[reason] = (reasons[reason] ?? 0) + 1;
  };
  for (const result of scoped.durable.results(run.runId)) {
    if (result.classification === "equal") continue;
    if (result.classification === "conflicting") {
      skip(result.reason);
      continue;
    }
    if (
      result.classification === "missing" &&
      result.missingSide === "source"
    ) {
      skip("target_only");
      continue;
    }
    const source = result.source.at(0);
    const before = result.target.at(0) ?? null;
    if (source?.identityKey === undefined || source.identityKey === null) {
      skip("missing_identifier");
      continue;
    }
    if (before !== null && before.revision === undefined) {
      skip("no_atomic_revision");
      continue;
    }
    const fields = [
      ...new Set([
        ...Object.keys(source.comparable),
        ...Object.keys(before?.comparable ?? {}),
      ]),
    ].sort(compareText);
    const differing = fields.filter(
      (field) =>
        canonicalJson(
          Object.hasOwn(source.comparable, field)
            ? { value: source.comparable[field] ?? null }
            : {},
        ) !==
        canonicalJson(
          before !== null && Object.hasOwn(before.comparable, field)
            ? { value: before.comparable[field] ?? null }
            : {},
        ),
    );
    if (
      differing.some(
        (field) =>
          !policy.sourceFields.includes(field) &&
          !policy.targetFields?.includes(field),
      )
    ) {
      skip("unknown_ownership");
      continue;
    }
    const owned = differing.filter((field) =>
      policy.sourceFields.includes(field),
    );
    if (owned.length === 0) {
      skip("target_owned");
      continue;
    }
    const after: Record<string, import("../contracts/adapter.js").JsonValue> = {
      ...before?.comparable,
    };
    for (const field of owned) {
      if (Object.hasOwn(source.comparable, field))
        Object.defineProperty(after, field, {
          value: source.comparable[field],
          enumerable: true,
          configurable: true,
          writable: true,
        });
      else Reflect.deleteProperty(after, field);
    }
    const seed = {
      kind: before === null ? ("create" as const) : ("update" as const),
      recordId:
        before?.recordId ??
        `recon-${contentHash(source.identityKey).slice(0, 32)}`,
      identityKey: source.identityKey,
      identity: identityFromKey(source.identityKey),
      expectedRevision: before?.revision ?? null,
      expectedCheckpoint: run.checkpoints.after.target,
      source,
      before,
      after,
      fields: owned,
    };
    const id = contentHash(jsonValue({ fingerprint, ...seed }));
    operations.push({ ...seed, id, deduplicationKey: `${job.id}:${id}` });
    if (operations.length > (policy.maxOperations ?? 1000))
      throw new ReconciliationError(
        "limit_exceeded",
        "Plan exceeds its operation limit; narrow the comparison scope",
      );
  }
  operations.sort((a, b) => compareText(a.id, b.id));
  const body: PlanBody = {
    schemaVersion: "1",
    jobId: job.id,
    fingerprint,
    runId: run.runId,
    createdAt: run.generatedAt,
    expiresAt: new Date(Date.parse(run.generatedAt) + ttl).toISOString(),
    policy,
    operations,
    skipped: {
      count: Object.values(reasons).reduce((sum, n) => sum + n, 0),
      reasons,
    },
  };
  const plan = { digest: planDigest(body), body };
  options.store.plans.put(plan);
  return plan;
}

export function acceptPlan(
  job: ReconciliationJob,
  options: {
    readonly store: ReconciliationStore;
    readonly digest: string;
    readonly operationIds: readonly string[];
    readonly allowedFields: readonly string[];
    readonly maxOperations: number;
    readonly maxRecords: number;
    readonly now?: () => Date;
  },
): PlanAcceptance {
  const plan = options.store.plans.get(options.digest);
  if (
    plan?.body.jobId !== job.id ||
    plan.body.fingerprint !== jobFingerprint(job)
  )
    throw new ReconciliationError(
      "stale_plan",
      "Plan does not match this job generation",
    );
  const now = (options.now?.() ?? new Date()).toISOString();
  const operationIds = stringList(options.operationIds).sort(compareText);
  const allowedFields = stringList(options.allowedFields).sort(compareText);
  const selected = plan.body.operations.filter((operation) =>
    operationIds.includes(operation.id),
  );
  if (Date.parse(now) >= Date.parse(plan.body.expiresAt))
    throw new ReconciliationError(
      "stale_plan",
      "Plan expired; compare and plan again",
    );
  if (
    selected.length === 0 ||
    selected.length !== operationIds.length ||
    selected.length > integerValue(options.maxOperations, "maxOperations", 1) ||
    new Set(selected.map((op) => op.recordId)).size >
      integerValue(options.maxRecords, "maxRecords", 1) ||
    selected.some((op) =>
      op.fields.some((field) => !allowedFields.includes(field)),
    )
  )
    throw new ReconciliationError(
      "unsafe_write",
      "Acceptance selection, field scope, or bounds do not cover this plan",
    );
  const acceptance: PlanAcceptance = {
    schemaVersion: "1",
    digest: plan.digest,
    operationIds,
    acceptedAt: now,
    expiresAt: plan.body.expiresAt,
    allowedFields,
    maxOperations: options.maxOperations,
    maxRecords: options.maxRecords,
  };
  options.store.plans.accept(acceptance);
  return acceptance;
}

export function planValue(value: unknown): RepairPlan {
  const raw = objectValue(value, "plan");
  const body = objectValue(raw.body, "plan body");
  if (body.schemaVersion !== "1" || !Array.isArray(body.operations))
    throw new ReconciliationError(
      "incompatible_state",
      "Unsupported plan version",
    );
  const skipped = objectValue(body.skipped);
  const operations = body.operations.map((value: unknown): RepairOperation => {
    const op = objectValue(value);
    if (op.kind !== "create" && op.kind !== "update")
      throw new ReconciliationError(
        "unsafe_write",
        "Unsupported repair operation",
      );
    const identityKey = stringValue(op.identityKey);
    return {
      id: stringValue(op.id),
      kind: op.kind,
      recordId: stringValue(op.recordId),
      identityKey,
      identity: identityFromKey(identityKey),
      expectedRevision:
        op.expectedRevision === null ? null : stringValue(op.expectedRevision),
      expectedCheckpoint: checkpointValue(op.expectedCheckpoint),
      source: snapshotValue(op.source),
      before: op.before === null ? null : snapshotValue(op.before),
      after: jsonObject(op.after),
      fields: stringList(op.fields),
      deduplicationKey: stringValue(op.deduplicationKey),
    };
  });
  const plan: RepairPlan = {
    digest: stringValue(raw.digest),
    body: {
      schemaVersion: "1",
      jobId: stringValue(body.jobId),
      fingerprint: stringValue(body.fingerprint),
      runId: stringValue(body.runId),
      createdAt: parseTimestamp(stringValue(body.createdAt)),
      expiresAt: parseTimestamp(stringValue(body.expiresAt)),
      policy: repairPolicyValue(body.policy),
      operations,
      skipped: {
        count: integerValue(skipped.count),
        reasons: Object.fromEntries(
          Object.entries(objectValue(skipped.reasons)).map(([key, value]) => [
            key,
            integerValue(value),
          ]),
        ),
      },
    },
  };
  if (plan.digest !== planDigest(plan.body))
    throw new ReconciliationError(
      "corrupt_state",
      "Plan digest verification failed",
    );
  return plan;
}

export function acceptanceValue(value: unknown): PlanAcceptance {
  const raw = objectValue(value);
  if (raw.schemaVersion !== "1")
    throw new ReconciliationError(
      "incompatible_state",
      "Unsupported acceptance version",
    );
  return {
    schemaVersion: "1",
    digest: stringValue(raw.digest),
    operationIds: stringList(raw.operationIds),
    acceptedAt: parseTimestamp(stringValue(raw.acceptedAt)),
    expiresAt: parseTimestamp(stringValue(raw.expiresAt)),
    allowedFields: stringList(raw.allowedFields),
    maxOperations: integerValue(raw.maxOperations, "maxOperations", 1),
    maxRecords: integerValue(raw.maxRecords, "maxRecords", 1),
  };
}
