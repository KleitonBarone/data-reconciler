import type {
  AdapterDescriptor,
  AdapterRecord,
  JsonValue,
  ReadAdapter,
  ReadPageRequest,
} from "../contracts/adapter.js";
import {
  createCheckpoint,
  assertCheckpointCompatible,
} from "../contracts/adapter.js";
import {
  InputSnapshot,
  prefixHashes,
  validatePrefix,
} from "./input-snapshot.js";
import {
  integerValue,
  jsonValue,
  objectValue,
  stringValue,
} from "../core/validation.js";
import { isJsonObject } from "../core/json.js";

export type RecordProjection = {
  readonly id: string;
  readonly updatedAt: string;
  readonly identity: {
    readonly kind: string;
    readonly paths: readonly string[];
  };
  readonly fields: Readonly<Record<string, string>>;
  readonly deleted?: string;
};

export function atPointer(
  value: JsonValue,
  path: string,
): JsonValue | undefined {
  if (path === "") return value;
  if (!path.startsWith("/")) throw new Error(`Invalid JSON Pointer: ${path}`);
  let current: JsonValue | undefined = value;
  for (const token of path.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isJsonObject(current) && Object.hasOwn(current, key))
      current = current[key];
    else return undefined;
  }
  return current;
}

export class JsonFileAdapter implements ReadAdapter {
  readonly descriptor: AdapterDescriptor;
  private readonly input: InputSnapshot;
  private records: readonly JsonValue[] | undefined;
  private hashes: readonly string[] | undefined;
  constructor(
    readonly options: {
      readonly id: string;
      readonly path: string;
      readonly format?: "json" | "jsonl";
      readonly schemaVersion: string;
      readonly projection: RecordProjection;
    },
  ) {
    this.input = new InputSnapshot(options.path);
    this.descriptor = {
      id: options.id,
      displayName: options.id,
      contractVersion: 1,
      adapterVersion: "json-file.v1",
      schemaVersion: options.schemaVersion,
      datasetId: this.input.datasetId,
      readMode: "incremental",
    };
  }
  async readPage(request: ReadPageRequest) {
    assertCheckpointCompatible(this.descriptor, request.checkpoint);
    integerValue(request.limit, "limit", 1);
    const text = await this.input.text();
    if (this.records === undefined) {
      const raw: unknown =
        this.options.format === "jsonl"
          ? text
              .split(/\r?\n/u)
              .filter((line) => line.trim())
              .map((line) => JSON.parse(line) as unknown)
          : JSON.parse(text);
      if (!Array.isArray(raw)) throw new Error("JSON input must be an array");
      this.records = raw.map((value) => jsonValue(value));
      this.hashes = prefixHashes(this.records);
    }
    const offset = integerValue(
      Number(request.checkpoint?.cursor ?? 0),
      "cursor",
    );
    validatePrefix(
      request.checkpoint,
      this.input.datasetId,
      this.hashes?.[offset],
    );
    const selected = this.records.slice(offset, offset + request.limit);
    const position = offset + selected.length;
    return {
      records: selected.map((raw, index) => this.project(raw, offset + index)),
      hasMore: position < this.records.length,
      nextCheckpoint: {
        ...createCheckpoint(this.descriptor, String(position)),
        datasetId: this.input.datasetId,
        prefixHash: this.hashes?.[position] ?? "",
      },
    };
  }
  private project(raw: JsonValue, index: number): AdapterRecord {
    const p = this.options.projection;
    const parts = p.identity.paths.map((path) => atPointer(raw, path));
    const identity = parts.some(
      (part) => part === undefined || part === null || part === "",
    )
      ? null
      : {
          kind: p.identity.kind,
          value: parts.map((part) => stringValue(part, "identity value")),
        };
    const fields = Object.fromEntries(
      Object.entries(p.fields).flatMap(([key, path]) => {
        const value = atPointer(raw, path);
        return value === undefined ? [] : [[key, value]];
      }),
    );
    const deleted = p.deleted === undefined ? false : atPointer(raw, p.deleted);
    if (typeof deleted !== "boolean")
      throw new Error("Deletion marker must be boolean");
    return {
      recordId: stringValue(atPointer(raw, p.id), "record ID"),
      updatedAt: stringValue(atPointer(raw, p.updatedAt), "update timestamp"),
      identity,
      comparable: fields,
      evidence: {
        format:
          this.options.format === "jsonl"
            ? "application/x-ndjson"
            : "application/json",
        locator: `record:${index}`,
        payload: raw,
      },
      ...(deleted ? { deleted: true } : {}),
    };
  }
}

export function projectionValue(value: unknown): RecordProjection {
  const raw = objectValue(value, "projection");
  const identity = objectValue(raw.identity, "identity projection");
  if (!Array.isArray(identity.paths) || identity.paths.length === 0)
    throw new Error("Identity paths are required");
  return {
    id: stringValue(raw.id),
    updatedAt: stringValue(raw.updatedAt),
    identity: {
      kind: stringValue(identity.kind),
      paths: identity.paths.map((path) => stringValue(path)),
    },
    fields: Object.fromEntries(
      Object.entries(objectValue(raw.fields)).map(([key, path]) => [
        key,
        stringValue(path),
      ]),
    ),
    ...(raw.deleted === undefined ? {} : { deleted: stringValue(raw.deleted) }),
  };
}
