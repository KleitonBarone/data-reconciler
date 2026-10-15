import type { AdapterCheckpoint } from "../contracts/adapter.js";
import type { ReconciliationReport, RecordSnapshot, Side } from "./model.js";

export type CommitFaultHooks = { readonly afterReport?: () => void };
export type CommitRunInput = {
  readonly observations: readonly RecordSnapshot[];
  readonly checkpoints: ReadonlyMap<string, AdapterCheckpoint>;
  readonly report: ReconciliationReport;
};

/** Persistence operations required by comparison; no SQLite types cross this boundary. */
export type ReconciliationStore = {
  getCheckpoint(adapterId: string): AdapterCheckpoint | null;
  loadObservations(adapterId: string, side: Side): readonly RecordSnapshot[];
  commitRun(input: CommitRunInput, hooks?: CommitFaultHooks): void;
  recordFailure(error: unknown): void;
  forJob(jobId: string, fingerprint: string): ReconciliationStore;
};
