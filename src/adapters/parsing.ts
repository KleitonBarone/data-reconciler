import type { JsonObject, JsonValue } from "../contracts/adapter.js";
import { assertJson } from "../core/json.js";

export function parseJson(text: string, description: string): JsonValue {
  const value: unknown = JSON.parse(text);
  assertJson(value, description);
  return value;
}

export function expectObject(
  value: JsonValue,
  description: string,
): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

export function expectArray(
  value: JsonValue | undefined,
  description: string,
): JsonValue[] {
  if (!Array.isArray(value)) {
    throw new Error(`${description} must be an array`);
  }
  return value;
}

export function expectString(
  value: JsonValue | undefined,
  description: string,
): string {
  if (typeof value !== "string") {
    throw new Error(`${description} must be a string`);
  }
  return value;
}

export function expectNumber(
  value: JsonValue | undefined,
  description: string,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${description} must be a finite number`);
  }
  return value;
}

export function optionalString(
  value: JsonValue | undefined,
  description: string,
): string | null {
  if (value === null || value === undefined) return null;
  return expectString(value, description);
}
