import type { DatabaseSync } from "node:sqlite";
import {
  outcomeValue,
  applySummaryValue,
  type ApplySummary,
  type RepairAuditStore,
  type RepairOutcome,
} from "../core/repairs.js";
import { decode } from "../core/decoders.js";
import { stringValue } from "../core/validation.js";
import { ReconciliationError } from "../core/errors.js";

export function migrateRepairs(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS operation_state (digest TEXT NOT NULL REFERENCES repair_plans(digest),operation_id TEXT NOT NULL,outcome_json TEXT NOT NULL,PRIMARY KEY(digest,operation_id)) STRICT;
    CREATE TABLE IF NOT EXISTS repair_history (sequence INTEGER PRIMARY KEY AUTOINCREMENT,digest TEXT NOT NULL REFERENCES repair_plans(digest),outcome_json TEXT NOT NULL) STRICT;
    CREATE INDEX IF NOT EXISTS repair_history_plan ON repair_history(digest,sequence);
    CREATE TABLE IF NOT EXISTS plan_verifications (digest TEXT NOT NULL REFERENCES repair_plans(digest),run_id TEXT NOT NULL REFERENCES run_state(run_id),PRIMARY KEY(digest,run_id)) STRICT;
    CREATE TABLE IF NOT EXISTS apply_summaries (attempt_id TEXT PRIMARY KEY,digest TEXT NOT NULL REFERENCES repair_plans(digest),summary_json TEXT NOT NULL) STRICT;
    `);
}
export class SqliteRepairStore implements RepairAuditStore {
  constructor(private readonly db: DatabaseSync) {}
  saveSummary(summary: ApplySummary): void {
    applySummaryValue(summary);
    this.db
      .prepare(
        "INSERT INTO apply_summaries VALUES (?,?,?) ON CONFLICT(attempt_id) DO UPDATE SET summary_json=excluded.summary_json",
      )
      .run(summary.attemptId, summary.digest, JSON.stringify(summary));
  }
  summaries(digest: string): readonly ApplySummary[] {
    return this.db
      .prepare(
        "SELECT summary_json FROM apply_summaries WHERE digest=? ORDER BY rowid DESC LIMIT 100",
      )
      .all(digest)
      .map((row) => decode(stringValue(row.summary_json), applySummaryValue));
  }
  record(outcome: RepairOutcome): void {
    outcomeValue(outcome);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        this.state(outcome.digest, outcome.operationId)?.state === "succeeded"
      )
        throw new ReconciliationError(
          "unsafe_write",
          "A successful repair outcome is immutable",
        );
      const json = JSON.stringify(outcome);
      this.db
        .prepare(
          "INSERT INTO operation_state VALUES (?,?,?) ON CONFLICT(digest,operation_id) DO UPDATE SET outcome_json=excluded.outcome_json",
        )
        .run(outcome.digest, outcome.operationId, json);
      this.db
        .prepare("INSERT INTO repair_history(digest,outcome_json) VALUES (?,?)")
        .run(outcome.digest, json);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  state(digest: string, operationId: string): RepairOutcome | null {
    const row = this.db
      .prepare(
        "SELECT outcome_json FROM operation_state WHERE digest=? AND operation_id=?",
      )
      .get(digest, operationId);
    return row === undefined
      ? null
      : decode(stringValue(row.outcome_json), outcomeValue);
  }
  *history(digest: string): Iterable<RepairOutcome> {
    for (const row of this.db
      .prepare(
        "SELECT outcome_json FROM repair_history WHERE digest=? ORDER BY sequence",
      )
      .iterate(digest))
      yield decode(stringValue(row.outcome_json), outcomeValue);
  }
  verified(digest: string, runId: string): void {
    this.db
      .prepare("INSERT OR IGNORE INTO plan_verifications VALUES (?,?)")
      .run(digest, runId);
  }
  verifications(digest: string): readonly string[] {
    return this.db
      .prepare(
        "SELECT run_id FROM plan_verifications WHERE digest=? ORDER BY rowid",
      )
      .all(digest)
      .map((row) => stringValue(row.run_id));
  }
}
