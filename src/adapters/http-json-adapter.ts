import {
  assertCheckpointCompatible,
  createCheckpoint,
  type ReadAdapter,
  type ReadPageRequest,
} from "../contracts/adapter.js";
import { recordValue, objectValue, stringValue } from "../core/validation.js";
import { RetryableAdapterError } from "../core/runtime.js";
import { ReconciliationError } from "../core/errors.js";

/** Reference HTTP protocol: {records: AdapterRecord[], cursor: string, hasMore: boolean}. */
export class HttpJsonAdapter implements ReadAdapter {
  readonly descriptor;
  private readonly url: URL;
  constructor(options: {
    readonly id: string;
    readonly url: string;
    readonly datasetId: string;
    readonly schemaVersion: string;
  }) {
    this.url = new URL(options.url);
    if (
      this.url.username ||
      this.url.password ||
      !["http:", "https:"].includes(this.url.protocol)
    )
      throw new ReconciliationError(
        "invalid_config",
        "Use an HTTP URL without embedded credentials",
      );
    this.descriptor = {
      id: options.id,
      displayName: options.id,
      datasetId: options.datasetId,
      schemaVersion: options.schemaVersion,
      adapterVersion: "http-json.v1",
      contractVersion: 1,
      readMode: "incremental",
    } as const;
  }
  async readPage(request: ReadPageRequest) {
    assertCheckpointCompatible(this.descriptor, request.checkpoint);
    const url = new URL(this.url);
    url.searchParams.set("cursor", request.checkpoint?.cursor ?? "0");
    url.searchParams.set("limit", String(request.limit));
    let response: Response;
    try {
      response = await fetch(url, {
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        redirect: "error",
      });
    } catch {
      throw new RetryableAdapterError();
    }
    if (response.status === 429 || response.status >= 500) {
      const seconds = Number(response.headers.get("retry-after") ?? "0");
      await response.body?.cancel();
      throw new RetryableAdapterError(
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ReconciliationError(
        "adapter_error",
        `HTTP adapter status ${response.status}`,
      );
    }
    const reader = response.body?.getReader();
    if (reader === undefined)
      throw new ReconciliationError(
        "adapter_error",
        "HTTP response has no body",
      );
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8 * 1024 * 1024)
          throw new ReconciliationError(
            "limit_exceeded",
            "HTTP page exceeds 8 MiB",
          );
        chunks.push(chunk.value);
      }
    } finally {
      await reader.cancel();
    }
    const raw = objectValue(
      JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    );
    if (!Array.isArray(raw.records) || typeof raw.hasMore !== "boolean")
      throw new ReconciliationError("adapter_error", "Invalid HTTP page");
    return {
      records: raw.records.map(recordValue),
      hasMore: raw.hasMore,
      nextCheckpoint: createCheckpoint(
        this.descriptor,
        stringValue(raw.cursor),
      ),
    };
  }
}
