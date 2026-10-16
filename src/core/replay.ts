import { randomUUID } from "node:crypto";
import { setImmediate as yieldEventLoop } from "node:timers/promises";
import { createCheckpoint } from "../contracts/adapter.js";
import { compareGroups } from "./comparison.js";
import {
  checkCancelled,
  defineJob,
  jobFingerprint,
  type ReconciliationJob,
} from "./job.js";
import { contentHash } from "./json.js";
import { integerValue, jsonValue } from "./validation.js";
import type { ReconciliationStore, RunSummary } from "./store.js";
import type { RecordSnapshot } from "./model.js";
import { ReconciliationError } from "./errors.js";
import { jsonPolicy } from "./policy.js";

/** Replay recorded normalized evidence, never provider reads or normal checkpoints. */
export async function replay(
  job: ReconciliationJob,
  options: {
    readonly store: ReconciliationStore;
    readonly from: number;
    readonly to: number;
    readonly signal?: AbortSignal;
    readonly now?: () => Date;
  },
): Promise<RunSummary> {
  defineJob(job);
  checkCancelled(options.signal);
  const from = integerValue(options.from, "replay start", 1);
  const to = integerValue(options.to, "replay end", 1);
  if (to < from || to - from >= 100000)
    throw new ReconciliationError(
      "invalid_config",
      "Replay requires a range of at most 100000 sequence positions",
    );
  const fingerprint = jobFingerprint(job);
  const original = options.store.forJob(job.id, fingerprint);
  const runId = randomUUID();
  original.durable.acquire(runId);
  try {
    const jobId = `${job.id}/replay/${runId}`;
    const scoped = options.store.forJob(jobId, fingerprint);
    const durable = scoped.durable;
    durable.acquire(runId);
    try {
      durable.begin(runId, (options.now?.() ?? new Date()).toISOString());
      const counts = { source: 0, target: 0 };
      const checkpoints = {
        source: createCheckpoint(job.source.descriptor, "replay:0"),
        target: createCheckpoint(job.target.descriptor, "replay:0"),
      };
      const batches: { source: RecordSnapshot[]; target: RecordSnapshot[] } = {
        source: [],
        target: [],
      };
      const flush = (side: "source" | "target", sequence: number) => {
        const previous = scoped.getCheckpoint(job[side].descriptor.id);
        const next = createCheckpoint(
          job[side].descriptor,
          `replay:${sequence}`,
        );
        durable.page({
          runId,
          side,
          adapterId: job[side].descriptor.id,
          records: batches[side],
          previous,
          next,
        });
        checkpoints[side] = next;
        batches[side] = [];
      };
      for (const { sequence, snapshot } of original.durable.evidence(
        from,
        to,
      )) {
        checkCancelled(options.signal);
        if (
          snapshot.normalizationVersion !==
            (job.normalization ?? jsonPolicy).version ||
          contentHash(jsonValue(snapshot.adapter)) !==
            contentHash(jsonValue(job[snapshot.side].descriptor))
        )
          throw new ReconciliationError(
            "incompatible_state",
            "Replay requires the recorded adapter and normalization versions",
          );
        counts[snapshot.side]++;
        batches[snapshot.side].push(snapshot);
        if (batches[snapshot.side].length >= 250) {
          flush(snapshot.side, sequence);
          await yieldEventLoop();
        }
      }
      if (counts.source + counts.target === 0)
        throw new ReconciliationError(
          "invalid_config",
          "No evidence in the requested job range",
        );
      for (const side of ["source", "target"] as const) flush(side, to);
      const summary = await compareGroups(
        durable,
        job.source.descriptor.id,
        job.target.descriptor.id,
        runId,
        options.signal,
      );
      const report: RunSummary = {
        schemaVersion: "1",
        mode: "dry-run",
        jobId,
        fingerprint,
        runId,
        generatedAt: (options.now?.() ?? new Date()).toISOString(),
        normalizationVersion: (job.normalization ?? jsonPolicy).version,
        adapters: {
          source: job.source.descriptor,
          target: job.target.descriptor,
        },
        checkpoints: {
          before: { source: null, target: null },
          after: checkpoints,
        },
        recordsRead: counts,
        summary,
        replay: { jobId: job.id, from, to },
      };
      durable.finish(report);
      return report;
    } catch (error) {
      durable.fail(runId, "Replay failed; original evidence is unchanged");
      throw error;
    } finally {
      durable.release(runId);
    }
  } finally {
    original.durable.release(runId);
  }
}
