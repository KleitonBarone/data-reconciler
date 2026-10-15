import type { DatabaseSync } from "node:sqlite";
import type { DurableStore, RunSummary } from "../core/store.js";
import type { ReconciliationResult, RecordSnapshot } from "../core/model.js";
import {
  decode,
  snapshotValue,
  resultValue,
  runValue,
} from "../core/decoders.js";
import { checkpointValue, stringValue } from "../core/validation.js";
import { ReconciliationError } from "../core/errors.js";
import { mergeObservations } from "../core/revisions.js";

export function migrateRuns(db: DatabaseSync): void {
  const version = db.prepare("PRAGMA user_version").get()?.user_version;
  if (typeof version !== "number" || version > 1)
    throw new ReconciliationError(
      "incompatible_state",
      "Unsupported SQLite schema version",
    );
  db.exec(`
    CREATE TABLE IF NOT EXISTS run_state (run_id TEXT PRIMARY KEY, job_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, metadata_json TEXT, error TEXT) STRICT;
    CREATE TABLE IF NOT EXISTS run_results (run_id TEXT NOT NULL REFERENCES run_state(run_id), position INTEGER NOT NULL, result_json TEXT NOT NULL, PRIMARY KEY(run_id, position)) STRICT;
    CREATE TABLE IF NOT EXISTS deliveries (sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES run_state(run_id), job_id TEXT NOT NULL, snapshot_json TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS deliveries_job ON deliveries(job_id, sequence);
    CREATE TABLE IF NOT EXISTS job_claims (job_id TEXT PRIMARY KEY, owner TEXT NOT NULL, pid INTEGER NOT NULL) STRICT;
    PRAGMA user_version = 1;
  `);
}

export class SqliteRunStore implements DurableStore {
  constructor(
    private readonly db: DatabaseSync,
    private readonly jobId: string,
  ) {}
  private key(id: string) {
    return JSON.stringify([this.jobId, id]);
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private assertOwner(owner: string): void {
    if (
      this.db
        .prepare("SELECT owner FROM job_claims WHERE job_id = ?")
        .get(this.jobId)?.owner !== owner
    )
      throw new ReconciliationError("busy", "Job claim changed");
  }
  acquire(owner: string): void {
    this.transaction(() => {
      const claim = this.db
        .prepare("SELECT pid FROM job_claims WHERE job_id = ?")
        .get(this.jobId);
      if (claim !== undefined) {
        let alive = true;
        try {
          process.kill(Number(claim.pid), 0);
        } catch (error) {
          alive = !(
            error instanceof Error &&
            "code" in error &&
            error.code === "ESRCH"
          );
        }
        if (alive)
          throw new ReconciliationError(
            "busy",
            "Another process owns this job; stop it before recovery",
          );
      }
      this.db
        .prepare(
          "INSERT INTO job_claims VALUES (?, ?, ?) ON CONFLICT(job_id) DO UPDATE SET owner=excluded.owner, pid=excluded.pid",
        )
        .run(this.jobId, owner, process.pid);
    });
  }
  release(owner: string): void {
    this.db
      .prepare("DELETE FROM job_claims WHERE job_id=? AND owner=?")
      .run(this.jobId, owner);
  }
  begin(runId: string, at: string): void {
    this.assertOwner(runId);
    this.db
      .prepare(
        "UPDATE run_state SET status='interrupted' WHERE job_id=? AND status IN ('reading','comparing')",
      )
      .run(this.jobId);
    this.db
      .prepare(
        "INSERT INTO run_state(run_id, job_id, status, started_at) VALUES (?, ?, 'reading', ?)",
      )
      .run(runId, this.jobId, at);
  }
  page(input: Parameters<DurableStore["page"]>[0]): void {
    this.transaction(() => {
      this.assertOwner(input.runId);
      const key = this.key(input.adapterId);
      const row = this.db
        .prepare("SELECT checkpoint_json FROM checkpoints WHERE adapter_id=?")
        .get(key);
      const current =
        row === undefined
          ? null
          : decode(stringValue(row.checkpoint_json), checkpointValue);
      if (JSON.stringify(current) !== JSON.stringify(input.previous))
        throw new ReconciliationError(
          "busy",
          "Checkpoint changed during an incremental read",
        );
      const get = this.db.prepare(
        "SELECT snapshot_json FROM observations WHERE adapter_id=? AND record_id=?",
      );
      const put = this.db.prepare(
        "INSERT INTO observations VALUES (?, ?, ?, ?, ?) ON CONFLICT(adapter_id,record_id) DO UPDATE SET side=excluded.side, identity_key=excluded.identity_key, snapshot_json=excluded.snapshot_json",
      );
      const delivery = this.db.prepare(
        "INSERT INTO deliveries(run_id,job_id,snapshot_json) VALUES (?, ?, ?)",
      );
      for (const snapshot of input.records) {
        delivery.run(input.runId, this.jobId, JSON.stringify(snapshot));
        const previous = get.get(key, snapshot.recordId);
        const stored =
          previous === undefined
            ? []
            : [decode(stringValue(previous.snapshot_json), snapshotValue)];
        const merged = mergeObservations(stored, [snapshot])[0];
        if (merged === undefined) throw new Error("Missing merged record");
        put.run(
          key,
          input.side,
          merged.recordId,
          merged.identityKey,
          JSON.stringify(merged),
        );
      }
      const cp = input.next;
      this.db
        .prepare(
          "INSERT INTO checkpoints VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(adapter_id) DO UPDATE SET contract_version=excluded.contract_version,adapter_version=excluded.adapter_version,schema_version=excluded.schema_version,cursor=excluded.cursor,updated_at=excluded.updated_at,checkpoint_json=excluded.checkpoint_json",
        )
        .run(
          key,
          cp.contractVersion,
          cp.adapterVersion,
          cp.schemaVersion,
          cp.cursor,
          new Date().toISOString(),
          JSON.stringify(cp),
        );
    });
  }
  *groups(sourceId: string, targetId: string) {
    const keys = [this.key(sourceId), this.key(targetId)];
    const identities = this.db.prepare(
      "SELECT DISTINCT identity_key FROM observations WHERE adapter_id IN (?, ?) AND identity_key IS NOT NULL ORDER BY identity_key COLLATE BINARY",
    );
    const query = this.db.prepare(
      "SELECT snapshot_json FROM observations WHERE adapter_id=? AND identity_key=? ORDER BY record_id LIMIT 1001",
    );
    for (const row of identities.iterate(...keys)) {
      const source = query
        .all(keys[0] ?? "", row.identity_key ?? null)
        .map((row) => decode(stringValue(row.snapshot_json), snapshotValue));
      const target = query
        .all(keys[1] ?? "", row.identity_key ?? null)
        .map((row) => decode(stringValue(row.snapshot_json), snapshotValue));
      if (source.length > 1000 || target.length > 1000)
        throw new ReconciliationError(
          "limit_exceeded",
          "An identity exceeds the 1000-record ownership limit",
        );
      yield { source, target };
    }
    for (const row of this.db
      .prepare(
        "SELECT snapshot_json FROM observations WHERE adapter_id IN (?, ?) AND identity_key IS NULL ORDER BY adapter_id,record_id",
      )
      .iterate(...keys)) {
      const record = decode(stringValue(row.snapshot_json), snapshotValue);
      yield {
        source: record.side === "source" ? [record] : [],
        target: record.side === "target" ? [record] : [],
      };
    }
  }
  appendResults(runId: string, results: readonly ReconciliationResult[]): void {
    this.transaction(() => {
      this.assertOwner(runId);
      this.db
        .prepare("UPDATE run_state SET status='comparing' WHERE run_id=?")
        .run(runId);
      const count = this.db
        .prepare("SELECT COUNT(*) AS count FROM run_results WHERE run_id=?")
        .get(runId)?.count;
      let position = Number(count);
      const insert = this.db.prepare(
        "INSERT INTO run_results VALUES (?, ?, ?)",
      );
      for (const result of results)
        insert.run(runId, position++, JSON.stringify(result));
    });
  }
  finish(report: RunSummary): void {
    this.transaction(() => {
      this.assertOwner(report.runId);
      this.db
        .prepare(
          "UPDATE run_state SET status='complete', metadata_json=? WHERE run_id=? AND job_id=?",
        )
        .run(JSON.stringify(report), report.runId, this.jobId);
    });
  }
  fail(runId: string, message: string): void {
    this.db
      .prepare(
        "UPDATE run_state SET status='failed', error=? WHERE run_id=? AND job_id=?",
      )
      .run(message, runId, this.jobId);
  }
  getRun(runId: string): RunSummary | null {
    const row = this.db
      .prepare(
        "SELECT metadata_json,job_id FROM run_state WHERE run_id=? AND status='complete'",
      )
      .get(runId);
    if (row === undefined) return null;
    if (this.jobId !== "" && row.job_id !== this.jobId)
      throw new Error("Run belongs to another job");
    return decode(stringValue(row.metadata_json), runValue);
  }
  *results(runId: string): Iterable<ReconciliationResult> {
    if (this.getRun(runId) === null)
      throw new Error("Report is incomplete or missing");
    for (const row of this.db
      .prepare(
        "SELECT result_json FROM run_results WHERE run_id=? ORDER BY position",
      )
      .iterate(runId))
      yield decode(stringValue(row.result_json), resultValue);
  }
  *evidence(
    from: number,
    to: number,
  ): Iterable<{ sequence: number; snapshot: RecordSnapshot }> {
    for (const row of this.db
      .prepare(
        "SELECT sequence,snapshot_json FROM deliveries WHERE job_id=? AND sequence BETWEEN ? AND ? ORDER BY sequence",
      )
      .iterate(this.jobId, from, to))
      yield {
        sequence: Number(row.sequence),
        snapshot: decode(stringValue(row.snapshot_json), snapshotValue),
      };
  }
}
