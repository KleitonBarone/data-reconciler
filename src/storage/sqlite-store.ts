import { DatabaseSync } from "node:sqlite";
import { ADAPTER_CONTRACT_VERSION } from "../contracts/adapter.js";
import type { AdapterCheckpoint } from "../contracts/adapter.js";
import type {
  ReconciliationReport,
  RecordSnapshot,
  Side,
} from "../core/model.js";
import type { ReconciliationStore } from "../core/store.js";
import { ReconciliationError } from "../core/errors.js";
import { migrateRuns, SqliteRunStore } from "./run-store.js";
import { snapshotValue, reportValue, decode } from "../core/decoders.js";
import { checkpointValue } from "../core/validation.js";
import { closeSync, openSync } from "node:fs";
import { migratePlans, SqlitePlanStore } from "./plan-store.js";
import { migrateRepairs, SqliteRepairStore } from "./repair-store.js";
import { identityIndexer, migrateIdentities } from "./identity-store.js";

export type CommitFaultHooks = {
  /** Tests use this to prove that SQLite rolls back before checkpoints advance. */
  readonly afterReport?: () => void;
};

export type CommitRunInput = {
  readonly observations: readonly RecordSnapshot[];
  readonly checkpoints: ReadonlyMap<string, AdapterCheckpoint>;
  readonly report: ReconciliationReport;
};

type CheckpointRow = {
  readonly contract_version: number;
  readonly adapter_version: string;
  readonly schema_version: string;
  readonly cursor: string | null;
  readonly checkpoint_json?: unknown;
};

type JsonRow = { readonly json: string };

export class SqliteReconciliationStore implements ReconciliationStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") {
      try {
        closeSync(openSync(path, "wx", 0o600));
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "EEXIST"
        ))
          throw error;
      }
    }
    this.database = new DatabaseSync(path);
    let migrating = false;
    try {
      const version = this.database
        .prepare("PRAGMA user_version")
        .get()?.user_version;
      const tables = this.database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all();
      if (typeof version !== "number" || version > 5)
        throw new ReconciliationError(
          "incompatible_state",
          "Unsupported SQLite schema version",
        );
      if (
        tables.length > 0 &&
        !["checkpoints", "observations", "reports"].every((name) =>
          tables.some((table) => table.name === name),
        )
      )
        throw new ReconciliationError(
          "corrupt_state",
          "Database is not a recognizable reconciliation store",
        );
      this.database.exec("PRAGMA foreign_keys = ON");
      this.database.exec("PRAGMA journal_mode = WAL");
      this.database.exec("PRAGMA busy_timeout = 5000");
      this.database.exec("BEGIN IMMEDIATE");
      migrating = true;
      this.database.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        adapter_id TEXT PRIMARY KEY,
        contract_version INTEGER NOT NULL,
        adapter_version TEXT NOT NULL,
        schema_version TEXT NOT NULL,
        cursor TEXT,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS observations (
        adapter_id TEXT NOT NULL,
        side TEXT NOT NULL CHECK (side IN ('source', 'target')),
        record_id TEXT NOT NULL,
        identity_key TEXT,
        snapshot_json TEXT NOT NULL,
        PRIMARY KEY (adapter_id, record_id)
      ) STRICT;

      CREATE INDEX IF NOT EXISTS observations_identity
        ON observations (adapter_id, identity_key);

      CREATE INDEX IF NOT EXISTS observations_match
        ON observations (adapter_id, identity_key, record_id);

      CREATE TABLE IF NOT EXISTS reports (
        run_id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode = 'dry-run'),
        report_json TEXT NOT NULL
      ) STRICT;
    `);
      const checkpointColumns = this.database
        .prepare("PRAGMA table_info(checkpoints)")
        .all();
      if (
        !checkpointColumns.some((column) => column.name === "checkpoint_json")
      )
        this.database.exec(
          "ALTER TABLE checkpoints ADD COLUMN checkpoint_json TEXT",
        );
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS failures (id INTEGER PRIMARY KEY, error_json TEXT NOT NULL) STRICT",
      );
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS jobs (job_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL) STRICT",
      );
      migrateRuns(this.database);
      migratePlans(this.database);
      migrateRepairs(this.database);
      migrateIdentities(this.database, version);
      this.database.exec(
        "CREATE TABLE IF NOT EXISTS evidence_retention (job_id TEXT PRIMARY KEY,through_sequence INTEGER NOT NULL,pruned_at TEXT NOT NULL) STRICT; PRAGMA user_version=5;",
      );
      this.database.exec("COMMIT");
      migrating = false;
    } catch (error) {
      if (migrating) this.database.exec("ROLLBACK");
      this.database.close();
      throw error;
    }
  }

  getCheckpoint(adapterId: string, namespace = ""): AdapterCheckpoint | null {
    const row: unknown = this.database
      .prepare(
        `SELECT contract_version, adapter_version, schema_version, cursor, checkpoint_json
         FROM checkpoints WHERE adapter_id = ?`,
      )
      .get(adapterKey(namespace, adapterId));
    if (row === undefined) return null;
    if (!isCheckpointRow(row)) {
      throw new Error(`Stored checkpoint for ${adapterId} is invalid`);
    }
    if (row.contract_version !== ADAPTER_CONTRACT_VERSION) {
      throw new Error(
        `Stored checkpoint for ${adapterId} uses unsupported contract version ${row.contract_version}`,
      );
    }
    const extras =
      typeof row.checkpoint_json === "string"
        ? parseStoredJson(row.checkpoint_json)
        : null;
    const base: AdapterCheckpoint = {
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapterVersion: row.adapter_version,
      schemaVersion: row.schema_version,
      cursor: row.cursor,
      ...(typeof extras === "object" &&
      extras !== null &&
      "datasetId" in extras &&
      typeof extras.datasetId === "string"
        ? { datasetId: extras.datasetId }
        : {}),
      ...(typeof extras === "object" &&
      extras !== null &&
      "prefixHash" in extras &&
      typeof extras.prefixHash === "string"
        ? { prefixHash: extras.prefixHash }
        : {}),
    };
    try {
      if (row.checkpoint_json !== null && row.checkpoint_json !== undefined) {
        if (typeof row.checkpoint_json !== "string")
          throw new Error("Checkpoint JSON is not text");
        const validated = decode(row.checkpoint_json, checkpointValue);
        if (JSON.stringify(validated) !== JSON.stringify(base))
          throw new Error("Checkpoint metadata disagrees with its cursor");
        return validated;
      }
      return checkpointValue(base);
    } catch (error) {
      throw new ReconciliationError(
        "corrupt_state",
        "Stored checkpoint failed validation",
        null,
        { cause: error },
      );
    }
  }

  loadObservations(
    adapterId: string,
    side: Side,
    namespace = "",
  ): readonly RecordSnapshot[] {
    const rows = this.database
      .prepare(
        `SELECT snapshot_json AS json FROM observations
         WHERE adapter_id = ? AND side = ? ORDER BY record_id`,
      )
      .all(adapterKey(namespace, adapterId), side);
    return rows.map((row) => {
      if (!isJsonRow(row)) {
        throw new Error(`Stored observation for ${adapterId} is invalid`);
      }
      return decode(row.json, snapshotValue);
    });
  }

  getReport(runId: string): ReconciliationReport | null {
    const row: unknown = this.database
      .prepare("SELECT report_json AS json FROM reports WHERE run_id = ?")
      .get(runId);
    if (row === undefined) return null;
    if (!isJsonRow(row)) throw new Error(`Stored report ${runId} is invalid`);
    return decode(row.json, reportValue);
  }

  countReports(): number {
    const row: unknown = this.database
      .prepare("SELECT COUNT(*) AS count FROM reports")
      .get();
    if (!isCountRow(row)) throw new Error("Could not count stored reports");
    return row.count;
  }

  recordFailure(error: unknown): void {
    const value =
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            ...("evidence" in error ? { evidence: error.evidence } : {}),
          }
        : { message: String(error) };
    this.database
      .prepare("INSERT INTO failures (error_json) VALUES (?)")
      .run(JSON.stringify(value));
  }

  failures(): readonly unknown[] {
    return this.database
      .prepare("SELECT error_json FROM failures ORDER BY id")
      .all()
      .map((row) =>
        typeof row.error_json === "string"
          ? parseStoredJson(row.error_json)
          : null,
      );
  }

  commitRun(
    input: CommitRunInput,
    hooks: CommitFaultHooks = {},
    namespace = "",
  ): void {
    const upsertObservation = this.database.prepare(`
      INSERT INTO observations (
        adapter_id, side, record_id, identity_key, snapshot_json
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(adapter_id, record_id) DO UPDATE SET
        side = excluded.side,
        identity_key = excluded.identity_key,
        snapshot_json = excluded.snapshot_json
    `);
    const insertReport = this.database.prepare(`
      INSERT INTO reports (run_id, generated_at, mode, report_json)
      VALUES (?, ?, ?, ?)
    `);
    const upsertCheckpoint = this.database.prepare(`
      INSERT INTO checkpoints (
        adapter_id, contract_version, adapter_version, schema_version, cursor, updated_at, checkpoint_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET
        contract_version = excluded.contract_version,
        adapter_version = excluded.adapter_version,
        schema_version = excluded.schema_version,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
        ,checkpoint_json = excluded.checkpoint_json
    `);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      const index = identityIndexer(this.database);
      for (const observation of input.observations) {
        upsertObservation.run(
          adapterKey(namespace, observation.adapter.id),
          observation.side,
          observation.recordId,
          observation.identityKey,
          JSON.stringify(observation),
        );
        index(adapterKey(namespace, observation.adapter.id), observation);
      }
      insertReport.run(
        input.report.runId,
        input.report.generatedAt,
        input.report.mode,
        JSON.stringify(input.report),
      );

      hooks.afterReport?.();

      for (const [adapterId, checkpoint] of input.checkpoints) {
        upsertCheckpoint.run(
          adapterKey(namespace, adapterId),
          checkpoint.contractVersion,
          checkpoint.adapterVersion,
          checkpoint.schemaVersion,
          checkpoint.cursor,
          input.report.generatedAt,
          JSON.stringify(checkpoint),
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  forJob(jobId: string, fingerprint: string): ReconciliationStore {
    this.database
      .prepare("INSERT OR IGNORE INTO jobs VALUES (?, ?)")
      .run(jobId, fingerprint);
    const row = this.database
      .prepare("SELECT fingerprint FROM jobs WHERE job_id = ?")
      .get(jobId);
    if (row?.fingerprint !== fingerprint)
      throw new ReconciliationError(
        "incompatible_state",
        "Job dataset or normalization changed. Choose a new job generation for an explicit rescan.",
      );
    return {
      durable: new SqliteRunStore(this.database, jobId),
      plans: this.plans,
      repairs: this.repairs,
      getCheckpoint: (id) => this.getCheckpoint(id, jobId),
      loadObservations: (id, side) => this.loadObservations(id, side, jobId),
      commitRun: (input, hooks) => this.commitRun(input, hooks, jobId),
      recordFailure: (error) => this.recordFailure(error),
      forJob: (id, version) => this.forJob(id, version),
    };
  }

  get durable() {
    return new SqliteRunStore(this.database, "");
  }
  get plans() {
    return new SqlitePlanStore(this.database);
  }
  get repairs() {
    return new SqliteRepairStore(this.database);
  }

  inspect() {
    const integrity = this.database.prepare("PRAGMA quick_check").all();
    if (integrity.some((row) => row.quick_check !== "ok"))
      throw new ReconciliationError(
        "corrupt_state",
        "SQLite integrity check failed",
      );
    return {
      schemaVersion: this.database.prepare("PRAGMA user_version").get()
        ?.user_version,
      jobs: this.database
        .prepare("SELECT * FROM jobs ORDER BY job_id LIMIT 100")
        .all(),
      runs: this.database
        .prepare(
          "SELECT run_id,job_id,status,started_at,error FROM run_state ORDER BY rowid DESC LIMIT 100",
        )
        .all(),
      claims: this.database
        .prepare("SELECT * FROM job_claims ORDER BY job_id LIMIT 100")
        .all(),
      evidence: this.database
        .prepare(
          "SELECT MIN(sequence) AS first, MAX(sequence) AS last, COUNT(*) AS count FROM deliveries",
        )
        .get(),
    };
  }

  backup(destination: string): void {
    closeSync(openSync(destination, "wx", 0o600));
    this.database.prepare("VACUUM INTO ?").run(destination);
  }

  pruneEvidence(jobId: string, through: number): number {
    if (!Number.isSafeInteger(through) || through < 1)
      throw new ReconciliationError(
        "invalid_config",
        "A positive evidence sequence boundary is required",
      );
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const last = this.database
        .prepare("SELECT MAX(sequence) n FROM deliveries WHERE job_id=?")
        .get(jobId)?.n;
      if (typeof last !== "number" || through > last)
        throw new ReconciliationError(
          "invalid_config",
          "Prune boundary must be within the job's recorded delivery range",
        );
      if (
        this.database
          .prepare("SELECT 1 FROM job_claims WHERE job_id=?")
          .get(jobId) !== undefined
      )
        throw new ReconciliationError(
          "busy",
          "Stop or recover the job before pruning evidence",
        );
      if (
        this.database
          .prepare(
            "SELECT 1 FROM repair_plans p JOIN plan_acceptances a ON a.digest=p.digest WHERE p.job_id=? LIMIT 1",
          )
          .get(jobId) !== undefined
      )
        throw new ReconciliationError(
          "unsafe_write",
          "Accepted plans pin this job's evidence; pruning is refused",
        );
      const result = this.database
        .prepare("DELETE FROM deliveries WHERE job_id=? AND sequence<=?")
        .run(jobId, through);
      this.database
        .prepare(
          "INSERT INTO evidence_retention VALUES (?,?,?) ON CONFLICT(job_id) DO UPDATE SET through_sequence=MAX(through_sequence,excluded.through_sequence),pruned_at=excluded.pruned_at",
        )
        .run(jobId, through, new Date().toISOString());
      this.database.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

function adapterKey(namespace: string, adapterId: string): string {
  return namespace === "" ? adapterId : JSON.stringify([namespace, adapterId]);
}

function isCheckpointRow(value: unknown): value is CheckpointRow {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.contract_version === "number" &&
    typeof row.adapter_version === "string" &&
    typeof row.schema_version === "string" &&
    (typeof row.cursor === "string" || row.cursor === null)
  );
}

function isJsonRow(value: unknown): value is JsonRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).json === "string"
  );
}

function isCountRow(value: unknown): value is { readonly count: number } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).count === "number"
  );
}

function parseStoredJson(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}
