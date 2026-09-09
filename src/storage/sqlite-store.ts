import { DatabaseSync } from "node:sqlite";
import { ADAPTER_CONTRACT_VERSION } from "../contracts/adapter.js";
import type { AdapterCheckpoint } from "../contracts/adapter.js";
import type {
  ReconciliationReport,
  RecordSnapshot,
  Side,
} from "../core/model.js";

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
};

type JsonRow = { readonly json: string };

export class SqliteReconciliationStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA journal_mode = WAL");
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

      CREATE TABLE IF NOT EXISTS reports (
        run_id TEXT PRIMARY KEY,
        generated_at TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode = 'dry-run'),
        report_json TEXT NOT NULL
      ) STRICT;
    `);
  }

  getCheckpoint(adapterId: string): AdapterCheckpoint | null {
    const row: unknown = this.database
      .prepare(
        `SELECT contract_version, adapter_version, schema_version, cursor
         FROM checkpoints WHERE adapter_id = ?`,
      )
      .get(adapterId);
    if (row === undefined) return null;
    if (!isCheckpointRow(row)) {
      throw new Error(`Stored checkpoint for ${adapterId} is invalid`);
    }
    if (row.contract_version !== ADAPTER_CONTRACT_VERSION) {
      throw new Error(
        `Stored checkpoint for ${adapterId} uses unsupported contract version ${row.contract_version}`,
      );
    }
    return {
      contractVersion: ADAPTER_CONTRACT_VERSION,
      adapterVersion: row.adapter_version,
      schemaVersion: row.schema_version,
      cursor: row.cursor,
    };
  }

  loadObservations(adapterId: string, side: Side): readonly RecordSnapshot[] {
    const rows = this.database
      .prepare(
        `SELECT snapshot_json AS json FROM observations
         WHERE adapter_id = ? AND side = ? ORDER BY record_id`,
      )
      .all(adapterId, side);
    return rows.map((row) => {
      if (!isJsonRow(row)) {
        throw new Error(`Stored observation for ${adapterId} is invalid`);
      }
      return parseStoredJson(row.json) as RecordSnapshot;
    });
  }

  getReport(runId: string): ReconciliationReport | null {
    const row: unknown = this.database
      .prepare("SELECT report_json AS json FROM reports WHERE run_id = ?")
      .get(runId);
    if (row === undefined) return null;
    if (!isJsonRow(row)) throw new Error(`Stored report ${runId} is invalid`);
    return parseStoredJson(row.json) as ReconciliationReport;
  }

  countReports(): number {
    const row: unknown = this.database
      .prepare("SELECT COUNT(*) AS count FROM reports")
      .get();
    if (!isCountRow(row)) throw new Error("Could not count stored reports");
    return row.count;
  }

  commitRun(input: CommitRunInput, hooks: CommitFaultHooks = {}): void {
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
        adapter_id, contract_version, adapter_version, schema_version, cursor, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(adapter_id) DO UPDATE SET
        contract_version = excluded.contract_version,
        adapter_version = excluded.adapter_version,
        schema_version = excluded.schema_version,
        cursor = excluded.cursor,
        updated_at = excluded.updated_at
    `);

    this.database.exec("BEGIN IMMEDIATE");
    try {
      for (const observation of input.observations) {
        upsertObservation.run(
          observation.adapter.id,
          observation.side,
          observation.recordId,
          observation.identityKey,
          JSON.stringify(observation),
        );
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
          adapterId,
          checkpoint.contractVersion,
          checkpoint.adapterVersion,
          checkpoint.schemaVersion,
          checkpoint.cursor,
          input.report.generatedAt,
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
