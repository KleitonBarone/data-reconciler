import type { JsonObject, JsonValue } from "../contracts/adapter.js";
import { compareText } from "./json.js";
import type {
  ComparedValue,
  FieldDifference,
  ReconciliationResult,
  RecordSnapshot,
  ReportSummary,
} from "./model.js";

export function classifyRecords(
  sourceRecords: readonly RecordSnapshot[],
  targetRecords: readonly RecordSnapshot[],
): readonly ReconciliationResult[] {
  const missingIdentity = [...sourceRecords, ...targetRecords]
    .filter((record) => record.identityKey === null)
    .map<ReconciliationResult>((record) => ({
      classification: "conflicting",
      identityKey: null,
      reason: "missing_identifier",
      differences: [],
      source: record.side === "source" ? [record] : [],
      target: record.side === "target" ? [record] : [],
    }));

  const sourceByIdentity = groupByIdentity(sourceRecords);
  const targetByIdentity = groupByIdentity(targetRecords);
  const identities = [
    ...new Set([...sourceByIdentity.keys(), ...targetByIdentity.keys()]),
  ].sort();

  const matched = identities.map((identityKey) =>
    classifyIdentity(
      identityKey,
      sourceByIdentity.get(identityKey) ?? [],
      targetByIdentity.get(identityKey) ?? [],
    ),
  );

  return [...matched, ...missingIdentity].sort(compareResults);
}

export function summarize(
  results: readonly ReconciliationResult[],
): ReportSummary {
  const summary = {
    total: results.length,
    equal: 0,
    missing: 0,
    changed: 0,
    conflicting: 0,
  };

  for (const result of results) {
    summary[result.classification] += 1;
  }
  return summary;
}

function groupByIdentity(
  records: readonly RecordSnapshot[],
): Map<string, RecordSnapshot[]> {
  const groups = new Map<string, RecordSnapshot[]>();
  for (const record of records) {
    if (record.identityKey === null) continue;
    const group = groups.get(record.identityKey) ?? [];
    group.push(record);
    groups.set(record.identityKey, group);
  }
  return groups;
}

function classifyIdentity(
  identityKey: string,
  source: readonly RecordSnapshot[],
  target: readonly RecordSnapshot[],
): ReconciliationResult {
  if (source.length > 1 || target.length > 1) {
    return {
      classification: "conflicting",
      identityKey,
      reason: "duplicate_identity",
      differences: [],
      source,
      target,
    };
  }

  if (source.length === 0 || target.length === 0) {
    return {
      classification: "missing",
      identityKey,
      missingSide: source.length === 0 ? "source" : "target",
      source,
      target,
    };
  }

  const sourceRecord = source[0];
  const targetRecord = target[0];
  if (sourceRecord === undefined || targetRecord === undefined) {
    throw new Error("Matched records disappeared during classification");
  }

  const differences = compareObjects(
    sourceRecord.comparable,
    targetRecord.comparable,
  );
  if (differences.length === 0) {
    return {
      classification: "equal",
      identityKey,
      source: [sourceRecord],
      target: [targetRecord],
    };
  }

  const sourceTime = Date.parse(sourceRecord.updatedAt);
  const targetTime = Date.parse(targetRecord.updatedAt);
  if (sourceTime === targetTime) {
    return {
      classification: "conflicting",
      identityKey,
      reason: "ambiguous_ownership",
      differences,
      source: [sourceRecord],
      target: [targetRecord],
    };
  }

  return {
    classification: "changed",
    identityKey,
    newerSide: sourceTime > targetTime ? "source" : "target",
    differences,
    source: [sourceRecord],
    target: [targetRecord],
  };
}

function compareObjects(
  source: JsonObject,
  target: JsonObject,
): FieldDifference[] {
  return compareValues(source, target, "");
}

function compareValues(
  source: JsonValue | undefined,
  target: JsonValue | undefined,
  path: string,
): FieldDifference[] {
  if (source === target) return [];

  if (isJsonObject(source) && isJsonObject(target)) {
    const keys = [
      ...new Set([...Object.keys(source), ...Object.keys(target)]),
    ].sort();
    return keys.flatMap((key) =>
      compareValues(
        source[key],
        target[key],
        path === "" ? key : `${path}.${key}`,
      ),
    );
  }

  if (Array.isArray(source) && Array.isArray(target)) {
    const length = Math.max(source.length, target.length);
    return Array.from({ length }, (_, index) =>
      compareValues(source[index], target[index], `${path}[${index}]`),
    ).flat();
  }

  return [
    { path, source: comparedValue(source), target: comparedValue(target) },
  ];
}

function comparedValue(value: JsonValue | undefined): ComparedValue {
  return value === undefined ? { present: false } : { present: true, value };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareResults(
  left: ReconciliationResult,
  right: ReconciliationResult,
): number {
  if (left.identityKey === null && right.identityKey !== null) return 1;
  if (left.identityKey !== null && right.identityKey === null) return -1;
  const identityOrder = compareText(
    left.identityKey ?? "",
    right.identityKey ?? "",
  );
  if (identityOrder !== 0) return identityOrder;
  return compareText(firstRecordId(left), firstRecordId(right));
}

function firstRecordId(result: ReconciliationResult): string {
  return [...result.source, ...result.target].at(0)?.recordId ?? "";
}
