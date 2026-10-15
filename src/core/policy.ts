import type { JsonObject } from "../contracts/adapter.js";
import { assertJson, isJsonObject } from "./json.js";

export type TextRule = {
  readonly trim?: boolean;
  readonly unicode?: boolean;
  readonly case?: "preserve" | "lower" | "upper";
};

export type NormalizationPolicy = {
  readonly version: string;
  readonly text?: TextRule;
  readonly identities?: Readonly<Record<string, TextRule>>;
  /** Field selectors use JSON Pointer, including escaped slash and tilde keys. */
  readonly fields?: Readonly<Record<string, TextRule>>;
  readonly ignore?: readonly string[];
  readonly unorderedArrays?: readonly string[];
};

export const jsonPolicy: NormalizationPolicy = { version: "json.v1" };

export function normalizeText(value: string, rule: TextRule = {}): string {
  let result = rule.unicode ? value.normalize("NFKC") : value;
  if (rule.trim) result = result.trim();
  if (rule.case === "lower") return result.toLowerCase();
  if (rule.case === "upper") return result.toUpperCase();
  return result;
}

export function pointerPath(parent: string, key: string): string {
  return `${parent}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
}

export function policyJson(policy: NormalizationPolicy): JsonObject {
  const value: unknown = JSON.parse(JSON.stringify(policy));
  assertJson(value, "normalization policy");
  if (!isJsonObject(value))
    throw new Error("Normalization policy must be an object");
  return value;
}
