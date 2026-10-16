import type { DatabaseSync } from "node:sqlite";
import {
  planValue,
  acceptanceValue,
  type RepairPlan,
  type PlanAcceptance,
  type PlanStore,
} from "../core/plans.js";
import { decode } from "../core/decoders.js";
import { stringValue } from "../core/validation.js";
import { canonicalJson, compareText } from "../core/json.js";
import { jsonValue } from "../core/validation.js";
import { ReconciliationError } from "../core/errors.js";

export function migratePlans(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS repair_plans (digest TEXT PRIMARY KEY, job_id TEXT NOT NULL, run_id TEXT NOT NULL REFERENCES run_state(run_id), plan_json TEXT NOT NULL) STRICT;
    CREATE TABLE IF NOT EXISTS plan_acceptances (digest TEXT PRIMARY KEY REFERENCES repair_plans(digest), acceptance_json TEXT NOT NULL) STRICT;
    `);
}

export class SqlitePlanStore implements PlanStore {
  constructor(private readonly db: DatabaseSync) {}
  put(plan: RepairPlan): void {
    planValue(plan);
    this.db
      .prepare("INSERT OR IGNORE INTO repair_plans VALUES (?,?,?,?)")
      .run(plan.digest, plan.body.jobId, plan.body.runId, JSON.stringify(plan));
  }
  get(digest: string): RepairPlan | null {
    const row = this.db
      .prepare("SELECT plan_json FROM repair_plans WHERE digest=?")
      .get(digest);
    if (row === undefined) return null;
    const plan = decode(stringValue(row.plan_json), planValue);
    if (plan.digest !== digest)
      throw new ReconciliationError(
        "corrupt_state",
        "Plan key differs from its digest",
      );
    return plan;
  }
  accept(acceptance: PlanAcceptance): void {
    const candidate = acceptanceValue(acceptance);
    this.db
      .prepare("INSERT OR IGNORE INTO plan_acceptances VALUES (?,?)")
      .run(candidate.digest, JSON.stringify(candidate));
    const saved = this.acceptance(candidate.digest);
    if (
      saved === null ||
      authorizationContent(saved) !== authorizationContent(candidate)
    )
      throw new ReconciliationError(
        "unsafe_write",
        "Acceptance is immutable; create a new plan for a different selection",
      );
  }
  acceptance(digest: string): PlanAcceptance | null {
    const row = this.db
      .prepare("SELECT acceptance_json FROM plan_acceptances WHERE digest=?")
      .get(digest);
    return row === undefined
      ? null
      : decode(stringValue(row.acceptance_json), acceptanceValue);
  }
}

/** Approval time records the first acceptance; it does not change authorization. */
function authorizationContent(acceptance: PlanAcceptance): string {
  const { acceptedAt, ...authorization } = acceptance;
  void acceptedAt;
  return canonicalJson(
    jsonValue({
      ...authorization,
      operationIds: [...authorization.operationIds].sort(compareText),
      allowedFields: [...authorization.allowedFields].sort(compareText),
    }),
  );
}
