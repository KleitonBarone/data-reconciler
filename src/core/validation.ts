import type {
  AdapterCheckpoint,
  AdapterDescriptor,
  AdapterRecord,
  JsonObject,
  JsonValue,
  SourceEvidence,
} from "../contracts/adapter.js";
import { assertJson, isJsonObject, parseTimestamp } from "./json.js";
import { ReconciliationError } from "./errors.js";
import type { NormalizationPolicy, TextRule } from "./policy.js";

export function objectValue(
  value: unknown,
  label = "value",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new ReconciliationError(
      "invalid_config",
      `${label} must be an object`,
    );
  return value as Record<string, unknown>;
}
export function stringValue(value: unknown, label = "value"): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new ReconciliationError(
      "invalid_config",
      `${label} must be a nonempty string`,
    );
  return value;
}
export function jsonValue(value: unknown): JsonValue {
  assertJson(value);
  return value;
}
export function jsonObject(value: unknown): JsonObject {
  assertJson(value);
  if (!isJsonObject(value)) throw new Error("Expected a JSON object");
  return value;
}
export function integerValue(
  value: unknown,
  label = "value",
  minimum = 0,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum
  )
    throw new ReconciliationError(
      "invalid_config",
      `${label} must be an integer >= ${minimum}`,
    );
  return value;
}
export function descriptorValue(value: unknown): AdapterDescriptor {
  const raw = objectValue(value, "adapter descriptor");
  if (raw.contractVersion !== 1)
    throw new ReconciliationError(
      "invalid_config",
      "Unsupported adapter contract version",
    );
  const mode = raw.readMode;
  if (mode !== undefined && mode !== "snapshot" && mode !== "incremental")
    throw new Error("Unsupported adapter read mode");
  return {
    id: stringValue(raw.id),
    displayName: stringValue(raw.displayName),
    contractVersion: 1,
    adapterVersion: stringValue(raw.adapterVersion),
    schemaVersion: stringValue(raw.schemaVersion),
    ...(raw.datasetId === undefined
      ? {}
      : { datasetId: stringValue(raw.datasetId) }),
    ...(mode === undefined ? {} : { readMode: mode }),
  };
}
export function checkpointValue(value: unknown): AdapterCheckpoint {
  const raw = objectValue(value, "checkpoint");
  if (
    raw.contractVersion !== 1 ||
    !(raw.cursor === null || typeof raw.cursor === "string")
  )
    throw new Error("Unsupported or corrupt checkpoint");
  return {
    contractVersion: 1,
    adapterVersion: stringValue(raw.adapterVersion),
    schemaVersion: stringValue(raw.schemaVersion),
    cursor: raw.cursor,
    ...(raw.datasetId === undefined
      ? {}
      : { datasetId: stringValue(raw.datasetId) }),
    ...(raw.prefixHash === undefined
      ? {}
      : { prefixHash: stringValue(raw.prefixHash) }),
  };
}
export function evidenceValue(value: unknown): SourceEvidence {
  const raw = objectValue(value, "evidence");
  return {
    format: stringValue(raw.format),
    locator: stringValue(raw.locator),
    payload: jsonValue(raw.payload),
  };
}
export function recordValue(value: unknown): AdapterRecord {
  const raw = objectValue(value, "record");
  const identity =
    raw.identity === null ? null : objectValue(raw.identity, "identity");
  const parts = identity?.value;
  if (
    identity !== null &&
    typeof parts !== "string" &&
    !(Array.isArray(parts) && parts.every((part) => typeof part === "string"))
  )
    throw new Error("Identity must be a string or a string tuple");
  const identityValue =
    identity === null
      ? null
      : {
          kind: stringValue(identity.kind),
          value: typeof parts === "string" ? parts : (parts as string[]),
        };
  if (raw.deleted !== undefined && typeof raw.deleted !== "boolean")
    throw new Error("deleted must be boolean");
  return {
    recordId: stringValue(raw.recordId),
    updatedAt: parseTimestamp(stringValue(raw.updatedAt)),
    identity: identityValue,
    comparable: jsonObject(raw.comparable),
    evidence: evidenceValue(raw.evidence),
    ...(raw.deleted === undefined ? {} : { deleted: raw.deleted }),
  };
}
export function policyValue(value: unknown): NormalizationPolicy {
  const raw = objectValue(value, "normalization");
  function rule(value: unknown): TextRule {
    const raw = objectValue(value, "text rule");
    const mode = raw.case;
    if (
      mode !== undefined &&
      mode !== "preserve" &&
      mode !== "lower" &&
      mode !== "upper"
    )
      throw new Error("Invalid case rule");
    for (const key of ["trim", "unicode"])
      if (raw[key] !== undefined && typeof raw[key] !== "boolean")
        throw new Error(`Invalid ${key} rule`);
    return {
      ...(raw.trim === undefined ? {} : { trim: raw.trim === true }),
      ...(raw.unicode === undefined ? {} : { unicode: raw.unicode === true }),
      ...(mode === undefined ? {} : { case: mode }),
    };
  }
  const rules = (value: unknown) =>
    Object.fromEntries(
      Object.entries(objectValue(value)).map(([key, value]) => [
        key,
        rule(value),
      ]),
    );
  const paths = (value: unknown): string[] => {
    if (!Array.isArray(value))
      throw new Error("Field selectors must be an array");
    return value.map((value) => stringValue(value));
  };
  const policy: NormalizationPolicy = {
    version: stringValue(raw.version),
    ...(raw.text === undefined ? {} : { text: rule(raw.text) }),
    ...(raw.identities === undefined
      ? {}
      : { identities: rules(raw.identities) }),
    ...(raw.fields === undefined ? {} : { fields: rules(raw.fields) }),
    ...(raw.ignore === undefined ? {} : { ignore: paths(raw.ignore) }),
    ...(raw.unorderedArrays === undefined
      ? {}
      : { unorderedArrays: paths(raw.unorderedArrays) }),
  };
  for (const path of [
    ...Object.keys(policy.fields ?? {}),
    ...(policy.ignore ?? []),
    ...(policy.unorderedArrays ?? []),
  ])
    if (!/^\/(?:[^~]|~[01])*$/u.test(path))
      throw new Error(`Invalid JSON Pointer: ${path}`);
  return policy;
}
