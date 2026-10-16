import { objectValue, stringValue, integerValue } from "./validation.js";
import { ReconciliationError } from "./errors.js";

/** Ownership applies to entire top-level comparable fields, including nested values. */
export type RepairPolicy = {
  readonly version: string;
  readonly direction: "source-to-target";
  readonly sourceFields: readonly string[];
  readonly targetFields?: readonly string[];
  readonly maxOperations?: number;
};

export function stringList(value: unknown): string[] {
  if (!Array.isArray(value))
    throw new ReconciliationError("invalid_config", "Expected a string array");
  const list = value.map((item: unknown) => stringValue(item));
  if (new Set(list).size !== list.length)
    throw new ReconciliationError(
      "invalid_config",
      "Duplicate entries are not allowed",
    );
  return list;
}

export function repairPolicyValue(value: unknown): RepairPolicy {
  const raw = objectValue(value, "repair policy");
  if (raw.direction !== "source-to-target")
    throw new ReconciliationError(
      "invalid_config",
      "Repairs require explicit source-to-target direction",
    );
  const sourceFields = stringList(raw.sourceFields);
  const targetFields =
    raw.targetFields === undefined ? [] : stringList(raw.targetFields);
  if (
    sourceFields.length === 0 ||
    sourceFields.some((field) => targetFields.includes(field))
  )
    throw new ReconciliationError(
      "invalid_config",
      "Ownership must be nonempty and disjoint",
    );
  const maximum =
    raw.maxOperations === undefined
      ? 1000
      : integerValue(raw.maxOperations, "maxOperations", 1);
  if (maximum > 1000)
    throw new ReconciliationError(
      "invalid_config",
      "Plans support at most 1000 operations",
    );
  return {
    version: stringValue(raw.version),
    direction: "source-to-target",
    sourceFields,
    targetFields,
    maxOperations: maximum,
  };
}
