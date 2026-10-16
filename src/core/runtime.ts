import { ReconciliationError } from "./errors.js";

export type RuntimePolicy = {
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly backoffMs?: number;
  readonly maxPages?: number;
  readonly maxRecords?: number;
};

/** Adapters classify transient failures. Ordinary errors are never retried. */
export class RetryableAdapterError extends Error {
  constructor(readonly retryAfterMs = 0) {
    super("Adapter temporarily unavailable");
    this.name = "RetryableAdapterError";
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new ReconciliationError("cancelled", "Operation cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export function validateRuntime(policy: RuntimePolicy = {}): void {
  for (const [key, value] of Object.entries(policy)) {
    if (
      ![
        "backoffMs",
        "timeoutMs",
        "maxAttempts",
        "maxPages",
        "maxRecords",
      ].includes(key)
    )
      throw new ReconciliationError(
        "invalid_config",
        `Unknown runtime option ${key}`,
      );
    const minimum = key === "backoffMs" ? 0 : 1;
    const maximum =
      key === "maxAttempts"
        ? 10
        : key === "maxRecords"
          ? 1000000
          : key === "maxPages"
            ? 10000
            : 60000;
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
      throw new ReconciliationError("invalid_config", `Invalid runtime ${key}`);
  }
}

/** Timeouts bound waiting even if a broken adapter ignores its abort signal. */
export async function withRetry<T>(
  work: (signal: AbortSignal) => Promise<T>,
  options: {
    readonly policy?: RuntimePolicy;
    readonly signal?: AbortSignal;
    readonly onRetry?: (attempt: number) => void;
  },
): Promise<T> {
  const policy = options.policy ?? {};
  validateRuntime(policy);
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted)
      throw new ReconciliationError("cancelled", "Operation cancelled");
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () =>
          reject(new ReconciliationError("cancelled", "Operation cancelled"));
        options.signal?.addEventListener("abort", onAbort, { once: true });
        timer = setTimeout(() => {
          controller.abort();
          reject(new RetryableAdapterError());
        }, policy.timeoutMs ?? 30000);
      });
      return await Promise.race([work(controller.signal), interrupted]);
    } catch (error) {
      if (options.signal?.aborted)
        throw new ReconciliationError("cancelled", "Operation cancelled");
      if (
        !(error instanceof RetryableAdapterError) ||
        attempt >= (policy.maxAttempts ?? 3)
      )
        throw error;
      options.onRetry?.(attempt);
      const wait = Math.min(
        60000,
        Math.max(
          error.retryAfterMs,
          (policy.backoffMs ?? 100) * 2 ** (attempt - 1),
        ),
      );
      try {
        await delay(wait, options.signal);
      } catch {
        throw new ReconciliationError("cancelled", "Operation cancelled");
      }
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (onAbort !== undefined)
        options.signal?.removeEventListener("abort", onAbort);
    }
  }
}
