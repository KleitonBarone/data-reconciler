import type { AdapterRecord } from "../contracts/adapter.js";
import type { RecordSnapshot, Side } from "./model.js";
import type { AdapterDescriptor, JsonValue } from "../contracts/adapter.js";
import {
  assertJson,
  canonicalJson,
  compareText,
  parseTimestamp,
} from "./json.js";
import {
  jsonPolicy,
  normalizeText,
  pointerPath,
  type NormalizationPolicy,
} from "./policy.js";
import { ReconciliationError } from "./errors.js";

export function normalizeRecord(
  side: Side,
  adapter: AdapterDescriptor,
  record: AdapterRecord,
  policy: NormalizationPolicy = jsonPolicy,
): RecordSnapshot {
  const updatedAt = parseTimestamp(record.updatedAt);
  assertJson(record.comparable, `${adapter.id}/${record.recordId} comparable`);
  assertJson(
    record.evidence.payload,
    `${adapter.id}/${record.recordId} evidence`,
  );
  if (
    record.recordId.trim() === "" ||
    (record.identity !== null && record.identity.kind.trim() === "")
  ) {
    throw new ReconciliationError(
      "invalid_record",
      "Record IDs and identity namespaces must not be empty",
      record.evidence.payload,
    );
  }
  if (policy.version.trim() === "")
    throw new Error("Normalization policy requires a version");

  return {
    side,
    adapter,
    recordId: record.recordId,
    updatedAt,
    identityKey: normalizeIdentity(record.identity, policy),
    comparable: normalizeObject(record.comparable, policy, ""),
    evidence: record.evidence,
    normalizationVersion: policy.version,
    ...(record.deleted ? { deleted: true } : {}),
  };
}

function normalizeIdentity(
  identity: AdapterRecord["identity"],
  policy: NormalizationPolicy,
): string | null {
  if (identity === null) return null;
  const values =
    typeof identity.value === "string" ? [identity.value] : identity.value;
  if (values.length === 0 || values.some((value) => value.trim() === ""))
    return null;
  const normalized = values.map((value) =>
    normalizeText(value, policy.identities?.[identity.kind]),
  );
  if (normalized.some((value) => value.trim() === "")) return null;
  // Scalars are escaped; compound keys use an unambiguous JSON tuple.
  return `${encodeURIComponent(identity.kind)}:${normalized.length === 1 ? encodeURIComponent(normalized[0] ?? "") : JSON.stringify(normalized)}`;
}

function normalizeObject(
  value: AdapterRecord["comparable"],
  policy: NormalizationPolicy,
  path: string,
): AdapterRecord["comparable"] {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !policy.ignore?.includes(pointerPath(path, key)))
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, fieldValue]) => [
        key,
        normalizeValue(fieldValue, policy, pointerPath(path, key)),
      ]),
  );
}

function normalizeValue(
  value: JsonValue,
  policy: NormalizationPolicy,
  path: string,
): JsonValue {
  if (typeof value === "string") {
    return normalizeText(value, policy.fields?.[path] ?? policy.text);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Comparable field ${path} is not finite`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    const normalized = value.map((item, index) =>
      normalizeValue(item, policy, pointerPath(path, String(index))),
    );
    return policy.unorderedArrays?.includes(path)
      ? normalized.sort((left, right) =>
          compareText(canonicalJson(left), canonicalJson(right)),
        )
      : normalized;
  }

  if (typeof value === "object" && value !== null) {
    return normalizeObject(value, policy, path);
  }

  return value;
}
