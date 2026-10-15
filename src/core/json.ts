import { createHash } from "node:crypto";
import type { JsonObject, JsonValue } from "../contracts/adapter.js";

/** Validate before normalization, persistence, or hashing can discard evidence. */
export function assertJson(
  value: unknown,
  label = "value",
  ancestors = new Set<object>(),
  depth = 0,
): asserts value is JsonValue {
  if (depth > 64) throw new Error(`${label} exceeds the JSON nesting limit`);
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return;
  if (typeof value === "number") {
    if (
      !Number.isFinite(value) ||
      (Number.isInteger(value) && !Number.isSafeInteger(value))
    ) {
      throw new Error(
        `${label} must be finite and preserve safe integer precision`,
      );
    }
    return;
  }
  if (typeof value !== "object") throw new Error(`${label} is not JSON data`);
  if (ancestors.has(value)) throw new Error(`${label} contains a JSON cycle`);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    throw new Error(`${label} must be a plain JSON object`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      if (!Object.hasOwn(value, index))
        throw new Error(`${label} cannot contain sparse arrays`);
      const item: unknown = value[index];
      assertJson(item, `${label}[${index}]`, ancestors, depth + 1);
    }
  } else {
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string")
        throw new Error(`${label} cannot contain symbol keys`);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      )
        throw new Error(`${label}.${key} must be a JSON data property`);
      const nested: unknown = descriptor.value;
      assertJson(nested, `${label}.${key}`, ancestors, depth + 1);
    }
  }
  ancestors.delete(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort(compareText)
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contentHash(value: JsonValue): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function parseTimestamp(value: string): string {
  const pattern =
    /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u;
  const date = new Date(value);
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00.000Z`);
  if (
    !pattern.test(value) ||
    Number.isNaN(date.valueOf()) ||
    Number.isNaN(calendar.valueOf()) ||
    calendar.toISOString().slice(0, 10) !== day
  ) {
    throw new Error(
      `Invalid updatedAt timestamp: ${value}. Use RFC 3339 with an explicit timezone.`,
    );
  }
  return date.toISOString();
}
