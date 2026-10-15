import type { AdapterRecord } from "../contracts/adapter.js";
import type { RecordSnapshot, Side } from "./model.js";
import { NORMALIZATION_VERSION } from "./model.js";
import type { AdapterDescriptor, JsonValue } from "../contracts/adapter.js";
import { assertJson, compareText, parseTimestamp } from "./json.js";

const CASE_INSENSITIVE_FIELDS = new Set(["customerEmail", "status"]);
const UPPERCASE_FIELDS = new Set(["currency"]);

export function normalizeRecord(
  side: Side,
  adapter: AdapterDescriptor,
  record: AdapterRecord,
): RecordSnapshot {
  const updatedAt = parseTimestamp(record.updatedAt);
  assertJson(record.comparable, `${adapter.id}/${record.recordId} comparable`);
  assertJson(
    record.evidence.payload,
    `${adapter.id}/${record.recordId} evidence`,
  );

  return {
    side,
    adapter,
    recordId: record.recordId,
    updatedAt,
    identityKey: normalizeIdentity(record.identity),
    comparable: normalizeObject(record.comparable),
    evidence: record.evidence,
    normalizationVersion: NORMALIZATION_VERSION,
  };
}

function normalizeIdentity(identity: AdapterRecord["identity"]): string | null {
  if (identity === null || identity.value.trim() === "") {
    return null;
  }

  const kind = identity.kind.normalize("NFKC").trim().toLowerCase();
  const value = identity.value.normalize("NFKC").trim();
  const normalizedValue =
    kind === "email" ? value.toLowerCase() : value.toUpperCase();
  return `${kind}:${normalizedValue}`;
}

function normalizeObject(
  value: AdapterRecord["comparable"],
): AdapterRecord["comparable"] {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareText(left, right))
      .map(([key, fieldValue]) => [key, normalizeValue(fieldValue, key)]),
  );
}

function normalizeValue(value: JsonValue, fieldName: string): JsonValue {
  if (typeof value === "string") {
    const trimmed = value.normalize("NFKC").trim();
    if (CASE_INSENSITIVE_FIELDS.has(fieldName)) {
      return trimmed.toLowerCase();
    }
    if (UPPERCASE_FIELDS.has(fieldName)) {
      return trimmed.toUpperCase();
    }
    return trimmed;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Comparable field ${fieldName} is not finite`);
    }
    return Object.is(value, -0) ? 0 : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item, fieldName));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => compareText(left, right))
        .map(([key, nested]) => [key, normalizeValue(nested, key)]),
    );
  }

  return value;
}
