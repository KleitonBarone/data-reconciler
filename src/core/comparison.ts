import { setImmediate as yieldEventLoop } from "node:timers/promises";
import type { ReconciliationResult, ReportSummary } from "./model.js";
import type { DurableStore } from "./store.js";
import { classifyRecords } from "./classify.js";
import { checkCancelled } from "./job.js";

export async function compareGroups(
  store: DurableStore,
  sourceId: string,
  targetId: string,
  runId: string,
  signal?: AbortSignal,
  onDifference?: (conflict: boolean) => void,
): Promise<ReportSummary> {
  const summary = {
    total: 0,
    equal: 0,
    missing: 0,
    changed: 0,
    conflicting: 0,
  };
  let batch: ReconciliationResult[] = [];
  for (const group of store.groups(sourceId, targetId)) {
    checkCancelled(signal);
    for (const result of classifyRecords(group.source, group.target)) {
      summary.total++;
      summary[result.classification]++;
      if (result.classification !== "equal")
        onDifference?.(result.classification === "conflicting");
      batch.push(result);
    }
    if (batch.length >= 250) {
      store.appendResults(runId, batch);
      batch = [];
      await yieldEventLoop();
    }
  }
  if (batch.length > 0) store.appendResults(runId, batch);
  return summary;
}
