import type { JsonValue } from "../contracts/adapter.js";

export type ErrorCode =
  | "invalid_record"
  | "invalid_config"
  | "incompatible_state"
  | "adapter_error"
  | "cancelled"
  | "busy"
  | "stale_plan"
  | "unsafe_write"
  | "corrupt_state"
  | "limit_exceeded";

export class ReconciliationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly evidence: JsonValue = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ReconciliationError";
  }
}
