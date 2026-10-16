import { DatabaseSync } from "node:sqlite";
import { closeSync, openSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  assertCheckpointCompatible,
  createCheckpoint,
  type AdapterRecord,
  type ReadAdapter,
  type ReadPageRequest,
} from "../contracts/adapter.js";
import {
  type RepairWrite,
  type RepairWriter,
  type WriteReceipt,
  receiptValue,
} from "../contracts/writer.js";
import { contentHash } from "../core/json.js";
import {
  jsonValue,
  recordValue,
  integerValue,
  stringValue,
} from "../core/validation.js";
import { checkCancelled } from "../core/job.js";
import { ReconciliationError } from "../core/errors.js";
import { decode } from "../core/decoders.js";

const applicationId = 1380270928;
function openTarget(path: string, readOnly: boolean): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly });
  if (
    db.prepare("PRAGMA application_id").get()?.application_id !==
      applicationId ||
    db.prepare("PRAGMA user_version").get()?.user_version !== 1
  ) {
    db.close();
    throw new ReconciliationError(
      "incompatible_state",
      "Not a version 1 disposable record target",
    );
  }
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}
function readCurrent(db: DatabaseSync, id: string): AdapterRecord | null {
  const row = db
    .prepare(
      "SELECT revision,record_json FROM target_records WHERE record_id=?",
    )
    .get(id);
  if (row === undefined) return null;
  return withEvidence(
    decode(stringValue(row.record_json), recordValue),
    integerValue(row.revision, "revision", 1),
  );
}
function withEvidence(record: AdapterRecord, revision: number): AdapterRecord {
  return {
    ...record,
    revision: String(revision),
    evidence: {
      format: "sqlite-record.v1",
      locator: `records/${record.recordId}/revisions/${revision}`,
      payload: jsonValue(record),
    },
  };
}
function append(
  db: DatabaseSync,
  record: AdapterRecord,
  digest: string | null,
): number {
  const json = JSON.stringify(record);
  const result = db
    .prepare("INSERT INTO target_events(record_json,plan_digest) VALUES (?,?)")
    .run(json, digest);
  const revision = Number(result.lastInsertRowid);
  db.prepare(
    "INSERT INTO target_records VALUES (?,?,?) ON CONFLICT(record_id) DO UPDATE SET revision=excluded.revision,record_json=excluded.record_json",
  ).run(record.recordId, revision, json);
  return revision;
}

/** Explicit initialization only. Reading/constructing an adapter never creates a target. */
export function initializeSqliteTarget(
  path: string,
  records: readonly AdapterRecord[] = [],
): void {
  const validated = records.map(recordValue);
  if (
    new Set(validated.map((record) => record.recordId)).size !==
    validated.length
  )
    throw new ReconciliationError(
      "invalid_record",
      "Duplicate initial target record IDs",
    );
  closeSync(openSync(path, "wx", 0o600));
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
      CREATE TABLE target_meta (generation TEXT NOT NULL) STRICT;
      CREATE TABLE target_records (record_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,record_json TEXT NOT NULL) STRICT;
      CREATE TABLE target_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT,record_json TEXT NOT NULL,plan_digest TEXT) STRICT;
      CREATE TABLE target_dedup (deduplication_key TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result_json TEXT NOT NULL) STRICT;
      BEGIN IMMEDIATE;`);
    db.prepare("INSERT INTO target_meta VALUES (?)").run(randomUUID());
    for (const record of validated) append(db, record, null);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

export class SqliteRecordAdapter implements ReadAdapter {
  readonly descriptor;
  readonly writer: RepairWriter;
  private readonly path: string;
  constructor(path: string, options: { readonly id?: string } = {}) {
    this.path = resolve(path);
    const id = options.id ?? "local-sqlite-records";
    this.descriptor = {
      id,
      displayName: id,
      contractVersion: 1,
      adapterVersion: "sqlite-record.v1",
      schemaVersion: "canonical-record.v1",
      datasetId: this.path,
      readMode: "incremental",
    } as const;
    this.writer = {
      contractVersion: 1,
      capabilities: {
        create: true,
        update: true,
        atomicPreconditions: true,
        deduplication: true,
        verification: true,
      },
      apply: (write, signal) =>
        Promise.resolve().then(() => this.write(write, signal)),
      lookup: (key, signal) =>
        Promise.resolve().then(() => {
          checkCancelled(signal);
          const db = openTarget(this.path, true);
          try {
            const row = db
              .prepare(
                "SELECT result_json FROM target_dedup WHERE deduplication_key=?",
              )
              .get(key);
            return row === undefined
              ? null
              : {
                  ...decode(stringValue(row.result_json), receiptValue),
                  deduplicated: true,
                };
          } finally {
            db.close();
          }
        }),
      getCurrent: (id, signal) =>
        Promise.resolve().then(() => {
          checkCancelled(signal);
          const db = openTarget(this.path, true);
          try {
            return readCurrent(db, id);
          } finally {
            db.close();
          }
        }),
    };
  }
  readPage(request: ReadPageRequest) {
    return Promise.resolve().then(() => {
      checkCancelled(request.signal);
      assertCheckpointCompatible(this.descriptor, request.checkpoint);
      const db = openTarget(this.path, true);
      try {
        const generation = stringValue(
          db.prepare("SELECT generation FROM target_meta").get()?.generation,
        );
        if (
          request.checkpoint?.datasetId !== undefined &&
          request.checkpoint.datasetId !== generation
        )
          throw new ReconciliationError(
            "incompatible_state",
            "Target generation changed; use an explicit rescan",
          );
        const cursor = integerValue(
          Number(request.checkpoint?.cursor ?? 0),
          "target cursor",
        );
        const maximum = Number(
          db
            .prepare("SELECT COALESCE(MAX(sequence),0) n FROM target_events")
            .get()?.n,
        );
        if (cursor > maximum)
          throw new ReconciliationError(
            "incompatible_state",
            "Target cursor is beyond its history",
          );
        const rows = db
          .prepare(
            "SELECT sequence,record_json FROM target_events WHERE sequence>? ORDER BY sequence LIMIT ?",
          )
          .all(cursor, request.limit);
        const next = rows.at(-1)?.sequence ?? cursor;
        return {
          records: rows.map((row) =>
            withEvidence(
              decode(stringValue(row.record_json), recordValue),
              Number(row.sequence),
            ),
          ),
          nextCheckpoint: {
            ...createCheckpoint(this.descriptor, String(next)),
            datasetId: generation,
          },
          hasMore: Number(next) < maximum,
        };
      } finally {
        db.close();
      }
    });
  }
  private write(write: RepairWrite, signal?: AbortSignal): WriteReceipt {
    checkCancelled(signal);
    if (
      Reflect.get(write, "kind") !== "create" &&
      Reflect.get(write, "kind") !== "update"
    )
      throw new ReconciliationError("unsafe_write", "Unsupported operation");
    assertCheckpointCompatible(this.descriptor, write.expectedCheckpoint);
    const db = openTarget(this.path, false);
    db.exec("BEGIN IMMEDIATE");
    try {
      const { authorizationDigest: _authorizationDigest, ...request } = write;
      void _authorizationDigest;
      const hash = contentHash(jsonValue(request));
      const prior = db
        .prepare(
          "SELECT request_hash,result_json FROM target_dedup WHERE deduplication_key=?",
        )
        .get(write.deduplicationKey);
      if (prior !== undefined) {
        if (prior.request_hash !== hash)
          throw new ReconciliationError(
            "unsafe_write",
            "Deduplication key reused for different contents",
          );
        const result = {
          ...decode(stringValue(prior.result_json), receiptValue),
          deduplicated: true,
        };
        db.exec("COMMIT");
        return result;
      }
      const generation = db
        .prepare("SELECT generation FROM target_meta")
        .get()?.generation;
      if (write.expectedCheckpoint.datasetId !== generation)
        throw new ReconciliationError(
          "stale_plan",
          "Target generation changed since planning",
        );
      const current = readCurrent(db, write.recordId);
      if (
        write.kind === "update"
          ? current?.revision !== write.expectedRevision
          : current !== null || write.expectedRevision !== null
      )
        throw new ReconciliationError(
          "stale_plan",
          "Target revision changed since planning",
        );
      if (write.kind === "create") {
        const cursor = integerValue(
          Number(write.expectedCheckpoint.cursor),
          "create checkpoint",
        );
        if (
          db
            .prepare(
              "SELECT 1 FROM target_events WHERE sequence>? AND (plan_digest IS NULL OR plan_digest<>?) LIMIT 1",
            )
            .get(cursor, write.authorizationDigest) !== undefined
        )
          throw new ReconciliationError(
            "stale_plan",
            "Target changed since planning a create",
          );
      }
      const comparable = { ...current?.comparable };
      for (const field of write.fields) {
        if (Object.hasOwn(write.comparable, field))
          Object.defineProperty(comparable, field, {
            value: write.comparable[field],
            enumerable: true,
            configurable: true,
            writable: true,
          });
        else Reflect.deleteProperty(comparable, field);
      }
      const record = recordValue({
        recordId: write.recordId,
        updatedAt: write.updatedAt,
        identity: current?.identity ?? write.identity,
        comparable,
        evidence: {
          format: "repair.v1",
          locator: write.deduplicationKey,
          payload: {
            digest: write.authorizationDigest,
            key: write.deduplicationKey,
          },
        },
      });
      const revision = append(db, record, write.authorizationDigest);
      const receipt = {
        recordId: write.recordId,
        revision: String(revision),
        deduplicated: false,
      };
      db.prepare("INSERT INTO target_dedup VALUES (?,?,?)").run(
        write.deduplicationKey,
        hash,
        JSON.stringify(receipt),
      );
      db.exec("COMMIT");
      return receipt;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}
