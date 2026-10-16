import type { AdapterCheckpoint } from "../contracts/adapter.js";
import type { PlanStore } from "./plans.js";
import type {
  ReconciliationReport,
  RecordSnapshot,
  Side,
  ReconciliationResult,
} from "./model.js";

export type RunSummary = Omit<
  ReconciliationReport,
  "results" | "observationsRead"
> & { readonly jobId: string; readonly fingerprint: string };
export type DurableStore = {
  acquire(owner: string): void;
  release(owner: string): void;
  begin(runId: string, at: string): void;
  page(input: {
    readonly runId: string;
    readonly side: Side;
    readonly adapterId: string;
    readonly records: readonly RecordSnapshot[];
    readonly previous: AdapterCheckpoint | null;
    readonly next: AdapterCheckpoint;
  }): void;
  groups(
    sourceId: string,
    targetId: string,
  ): Iterable<{
    readonly source: readonly RecordSnapshot[];
    readonly target: readonly RecordSnapshot[];
  }>;
  appendResults(runId: string, results: readonly ReconciliationResult[]): void;
  finish(report: RunSummary): void;
  fail(runId: string, message: string): void;
  getRun(runId: string): RunSummary | null;
  results(runId: string): Iterable<ReconciliationResult>;
  evidence(
    from: number,
    to: number,
  ): Iterable<{ readonly sequence: number; readonly snapshot: RecordSnapshot }>;
};

export type CommitFaultHooks = { readonly afterReport?: () => void };
export type CommitRunInput = {
  readonly observations: readonly RecordSnapshot[];
  readonly checkpoints: ReadonlyMap<string, AdapterCheckpoint>;
  readonly report: ReconciliationReport;
};

/** Persistence operations required by comparison; no SQLite types cross this boundary. */
export type ReconciliationStore = {
  readonly durable: DurableStore;
  readonly plans: PlanStore;
  getCheckpoint(adapterId: string): AdapterCheckpoint | null;
  loadObservations(adapterId: string, side: Side): readonly RecordSnapshot[];
  commitRun(input: CommitRunInput, hooks?: CommitFaultHooks): void;
  recordFailure(error: unknown): void;
  forJob(jobId: string, fingerprint: string): ReconciliationStore;
};
