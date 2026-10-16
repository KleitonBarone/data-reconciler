import type {
  RecordSnapshot,
  ReconciliationResult,
  FieldDifference,
  ReconciliationReport,
} from "./model.js";
import { assertJson, parseTimestamp } from "./json.js";
import {
  descriptorValue,
  evidenceValue,
  integerValue,
  jsonObject,
  jsonValue,
  objectValue,
  stringValue,
} from "./validation.js";
import type { RunSummary } from "./store.js";
import { checkpointValue } from "./validation.js";

export function snapshotValue(value: unknown): RecordSnapshot {
  const raw = objectValue(value, "stored snapshot");
  if (raw.side !== "source" && raw.side !== "target")
    throw new Error("Invalid snapshot side");
  if (raw.identityKey !== null && typeof raw.identityKey !== "string")
    throw new Error("Invalid normalized identity");
  const conflicts = raw.revisionConflicts;
  if (conflicts !== undefined && !Array.isArray(conflicts))
    throw new Error("Invalid stored revisions");
  return {
    side: raw.side,
    adapter: descriptorValue(raw.adapter),
    recordId: stringValue(raw.recordId),
    updatedAt: parseTimestamp(stringValue(raw.updatedAt)),
    identityKey: raw.identityKey,
    comparable: jsonObject(raw.comparable),
    evidence: evidenceValue(raw.evidence),
    normalizationVersion: stringValue(raw.normalizationVersion),
    ...(raw.revision === undefined
      ? {}
      : { revision: stringValue(raw.revision) }),
    ...(raw.deleted === true ? { deleted: true } : {}),
    ...(conflicts === undefined
      ? {}
      : { revisionConflicts: conflicts.map(snapshotValue) }),
  };
}

export function resultValue(value: unknown): ReconciliationResult {
  const raw = objectValue(value, "stored result");
  if (!Array.isArray(raw.source) || !Array.isArray(raw.target))
    throw new Error("Result evidence is missing");
  const source = raw.source.map(snapshotValue);
  const target = raw.target.map(snapshotValue);
  const identityKey = raw.identityKey;
  const differences: FieldDifference[] = [];
  if (raw.differences !== undefined) {
    if (!Array.isArray(raw.differences))
      throw new Error("Invalid field differences");
    for (const item of raw.differences) {
      const difference = objectValue(item);
      const part = (value: unknown) => {
        const raw = objectValue(value);
        if (typeof raw.present !== "boolean")
          throw new Error("Invalid compared value");
        return raw.present
          ? { present: true as const, value: jsonValue(raw.value) }
          : { present: false as const };
      };
      differences.push({
        path: stringValue(difference.path),
        source: part(difference.source),
        target: part(difference.target),
      });
    }
  }
  if (raw.classification === "conflicting") {
    if (identityKey !== null && typeof identityKey !== "string")
      throw new Error("Invalid conflict identity");
    const reason = raw.reason;
    if (
      reason !== "missing_identifier" &&
      reason !== "duplicate_identity" &&
      reason !== "ambiguous_ownership" &&
      reason !== "conflicting_revision" &&
      reason !== "deleted_record"
    )
      throw new Error("Unknown conflict reason");
    return {
      classification: "conflicting",
      identityKey,
      reason,
      source,
      target,
      differences,
    };
  }
  const identity = stringValue(identityKey);
  if (raw.classification === "missing") {
    if (raw.missingSide !== "source" && raw.missingSide !== "target")
      throw new Error("Invalid missing side");
    return {
      classification: "missing",
      identityKey: identity,
      missingSide: raw.missingSide,
      source,
      target,
    };
  }
  const left = source[0];
  const right = target[0];
  if (
    source.length !== 1 ||
    target.length !== 1 ||
    left === undefined ||
    right === undefined
  )
    throw new Error("Invalid matched records");
  if (raw.classification === "equal")
    return {
      classification: "equal",
      identityKey: identity,
      source: [left],
      target: [right],
    };
  if (
    raw.classification === "changed" &&
    (raw.newerSide === "source" || raw.newerSide === "target")
  )
    return {
      classification: "changed",
      identityKey: identity,
      newerSide: raw.newerSide,
      source: [left],
      target: [right],
      differences,
    };
  throw new Error("Unsupported classification");
}

export function runValue(value: unknown): RunSummary {
  const raw = objectValue(value, "run metadata");
  if (raw.schemaVersion !== "1" || raw.mode !== "dry-run")
    throw new Error("Unsupported report version");
  const adapters = objectValue(raw.adapters);
  const cp = objectValue(raw.checkpoints);
  const before = objectValue(cp.before);
  const after = objectValue(cp.after);
  const read = objectValue(raw.recordsRead);
  const summary = objectValue(raw.summary);
  const replay = raw.replay === undefined ? undefined : objectValue(raw.replay);
  return {
    schemaVersion: "1",
    mode: "dry-run",
    jobId: stringValue(raw.jobId),
    fingerprint: stringValue(raw.fingerprint),
    ...(replay === undefined
      ? {}
      : {
          replay: {
            jobId: stringValue(replay.jobId),
            from: integerValue(replay.from, "replay start", 1),
            to: integerValue(replay.to, "replay end", 1),
          },
        }),
    runId: stringValue(raw.runId),
    generatedAt: stringValue(raw.generatedAt),
    normalizationVersion: stringValue(raw.normalizationVersion),
    adapters: {
      source: descriptorValue(adapters.source),
      target: descriptorValue(adapters.target),
    },
    checkpoints: {
      before: {
        source: before.source === null ? null : checkpointValue(before.source),
        target: before.target === null ? null : checkpointValue(before.target),
      },
      after: {
        source: checkpointValue(after.source),
        target: checkpointValue(after.target),
      },
    },
    recordsRead: {
      source: integerValue(read.source),
      target: integerValue(read.target),
    },
    summary: {
      total: integerValue(summary.total),
      equal: integerValue(summary.equal),
      missing: integerValue(summary.missing),
      changed: integerValue(summary.changed),
      conflicting: integerValue(summary.conflicting),
    },
  };
}

export function decode<T>(text: string, validate: (value: unknown) => T): T {
  const value: unknown = JSON.parse(text);
  assertJson(value);
  return validate(value);
}

export function reportValue(value: unknown): ReconciliationReport {
  const raw = objectValue(value, "legacy report");
  const metadata = runValue({ ...raw, jobId: "legacy", fingerprint: "legacy" });
  if (!Array.isArray(raw.results) || !Array.isArray(raw.observationsRead))
    throw new Error("Report evidence is missing");
  const { jobId: _jobId, fingerprint: _fingerprint, ...report } = metadata;
  void _jobId;
  void _fingerprint;
  return {
    ...report,
    results: raw.results.map(resultValue),
    observationsRead: raw.observationsRead.map(snapshotValue),
  };
}
