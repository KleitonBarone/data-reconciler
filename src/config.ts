import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ReadAdapter, ReadPageResult } from "./contracts/adapter.js";
import { JsonPageCommerceAdapter } from "./adapters/json-page-adapter.js";
import { JsonlLedgerCommerceAdapter } from "./adapters/jsonl-ledger-adapter.js";
import {
  JsonFileAdapter,
  projectionValue,
} from "./adapters/json-file-adapter.js";
import { defineJob, type ReconciliationJob } from "./core/job.js";
import {
  checkpointValue,
  descriptorValue,
  integerValue,
  objectValue,
  policyValue,
  recordValue,
  stringValue,
} from "./core/validation.js";
import { ReconciliationError } from "./core/errors.js";
import { HttpJsonAdapter } from "./adapters/http-json-adapter.js";
import { type RuntimePolicy, validateRuntime } from "./core/runtime.js";
import { repairPolicyValue } from "./core/ownership.js";

export async function loadJob(path: string): Promise<ReconciliationJob> {
  const absolute = resolve(path);
  try {
    const loaded: unknown = path.endsWith(".json")
      ? JSON.parse(await readFile(absolute, "utf8"))
      : await import(pathToFileURL(absolute).href);
    const module = objectValue(loaded);
    const raw = path.endsWith(".json")
      ? module
      : objectValue(module.default, "default job export");
    const adapter = (value: unknown): ReadAdapter => {
      const endpoint = objectValue(value, "adapter");
      if (endpoint.descriptor !== undefined) {
        const descriptor = descriptorValue(endpoint.descriptor);
        const fn = endpoint.readPage;
        if (typeof fn !== "function")
          throw new Error("Adapter must implement readPage");
        return {
          descriptor,
          async readPage(request): Promise<ReadPageResult> {
            const result: unknown = await Reflect.apply(fn, value, [request]);
            const page = objectValue(result, "adapter page");
            if (
              !Array.isArray(page.records) ||
              typeof page.hasMore !== "boolean"
            )
              throw new Error("Invalid adapter page");
            return {
              records: page.records.map(recordValue),
              hasMore: page.hasMore,
              nextCheckpoint: checkpointValue(page.nextCheckpoint),
            };
          },
        };
      }
      if (endpoint.type === "http-json")
        return new HttpJsonAdapter({
          id: stringValue(endpoint.id),
          url: stringValue(endpoint.url),
          datasetId: stringValue(endpoint.datasetId),
          schemaVersion: stringValue(endpoint.schemaVersion),
        });
      const input = resolve(
        dirname(absolute),
        stringValue(endpoint.path, "adapter path"),
      );
      const id = stringValue(endpoint.id, "adapter id");
      if (endpoint.type === "commerce-json")
        return new JsonPageCommerceAdapter(input, { id });
      if (endpoint.type === "commerce-jsonl")
        return new JsonlLedgerCommerceAdapter(input, { id });
      if (endpoint.type !== "json" && endpoint.type !== "jsonl")
        throw new Error("Unsupported adapter type");
      return new JsonFileAdapter({
        id,
        path: input,
        format: endpoint.type,
        schemaVersion: stringValue(endpoint.schemaVersion),
        projection: projectionValue(endpoint.projection),
      });
    };
    const datasets =
      raw.datasets === undefined ? undefined : objectValue(raw.datasets);
    return defineJob({
      id: stringValue(raw.id, "job id"),
      source: adapter(raw.source),
      target: adapter(raw.target),
      ...(raw.normalization === undefined
        ? {}
        : { normalization: policyValue(raw.normalization) }),
      ...(raw.pageSize === undefined
        ? {}
        : { pageSize: integerValue(raw.pageSize, "page size", 1) }),
      ...(raw.runtime === undefined
        ? {}
        : { runtime: runtimeValue(raw.runtime) }),
      ...(raw.repair === undefined
        ? {}
        : { repair: repairPolicyValue(raw.repair) }),
      ...(datasets === undefined
        ? {}
        : {
            datasets: {
              source: stringValue(datasets.source),
              target: stringValue(datasets.target),
            },
          }),
    });
  } catch (error) {
    throw new ReconciliationError(
      "invalid_config",
      error instanceof Error ? error.message : String(error),
      null,
      { cause: error },
    );
  }
}

function runtimeValue(value: unknown): RuntimePolicy {
  const raw = objectValue(value, "runtime policy");
  const values = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, integerValue(value, key)]),
  );
  validateRuntime(values);
  return values;
}
