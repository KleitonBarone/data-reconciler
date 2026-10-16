import type {
  AdapterCheckpoint,
  AdapterRecord,
  IdentityCandidate,
  JsonObject,
} from "./adapter.js";
import { objectValue, stringValue, recordValue } from "../core/validation.js";
import { ReconciliationError } from "../core/errors.js";

export const WRITER_CONTRACT_VERSION = 1 as const;
export type RepairWrite = {
  readonly authorizationDigest: string;
  readonly deduplicationKey: string;
  readonly kind: "create" | "update";
  readonly recordId: string;
  readonly identity: IdentityCandidate;
  readonly identityKey: string;
  readonly expectedRevision: string | null;
  readonly expectedCheckpoint: AdapterCheckpoint;
  readonly comparable: JsonObject;
  readonly fields: readonly string[];
  readonly updatedAt: string;
};
export type WriteReceipt = {
  readonly recordId: string;
  readonly revision: string;
  readonly deduplicated: boolean;
};
export type RepairWriter = {
  readonly contractVersion: typeof WRITER_CONTRACT_VERSION;
  readonly capabilities: {
    readonly create: true;
    readonly update: true;
    readonly atomicPreconditions: true;
    readonly deduplication: true;
    readonly verification: true;
  };
  apply(write: RepairWrite, signal?: AbortSignal): Promise<WriteReceipt>;
  lookup(
    deduplicationKey: string,
    signal?: AbortSignal,
  ): Promise<WriteReceipt | null>;
  getCurrent(
    recordId: string,
    signal?: AbortSignal,
  ): Promise<AdapterRecord | null>;
};

export function receiptValue(value: unknown): WriteReceipt {
  const raw = objectValue(value);
  if (typeof raw.deduplicated !== "boolean")
    throw new ReconciliationError("adapter_error", "Invalid write receipt");
  return {
    recordId: stringValue(raw.recordId),
    revision: stringValue(raw.revision),
    deduplicated: raw.deduplicated,
  };
}

/** Runtime boundary for trusted JavaScript job modules. No writer is inferred. */
export function writerValue(value: unknown): RepairWriter {
  if (typeof value !== "object" || value === null)
    throw new ReconciliationError(
      "unsafe_write",
      "Target is comparison-only; an explicit writer is required",
    );
  const raw = objectValue(value, "writer");
  const capabilities = objectValue(raw.capabilities, "writer capabilities");
  if (
    raw.contractVersion !== 1 ||
    [
      "create",
      "update",
      "atomicPreconditions",
      "deduplication",
      "verification",
    ].some((key) => capabilities[key] !== true)
  )
    throw new ReconciliationError(
      "unsafe_write",
      "Writer cannot prove the required safety capabilities",
    );
  const call = async (
    name: string,
    args: readonly unknown[],
  ): Promise<unknown> => {
    const fn = raw[name];
    if (typeof fn !== "function")
      throw new ReconciliationError(
        "unsafe_write",
        `Writer must implement ${name}`,
      );
    return await Reflect.apply(fn, value, args);
  };
  return {
    contractVersion: 1,
    capabilities: {
      create: true,
      update: true,
      atomicPreconditions: true,
      deduplication: true,
      verification: true,
    },
    async apply(write, signal) {
      return receiptValue(await call("apply", [write, signal]));
    },
    async lookup(key, signal) {
      const result = await call("lookup", [key, signal]);
      return result === null ? null : receiptValue(result);
    },
    async getCurrent(id, signal) {
      const result = await call("getCurrent", [id, signal]);
      return result === null ? null : recordValue(result);
    },
  };
}
