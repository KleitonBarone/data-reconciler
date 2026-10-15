import type { ReconciliationResult } from "../core/model.js";
import type { RunSummary } from "../core/store.js";

/** Iterate serialized rows to keep report memory independent of dataset size. */
export function* reportChunks(
  report: RunSummary,
  results: Iterable<ReconciliationResult>,
  format: "json" | "ndjson",
): Iterable<string> {
  if (format === "ndjson") {
    yield `${JSON.stringify({ type: "run", ...report })}\n`;
    for (const result of results)
      yield `${JSON.stringify({ type: "result", ...result })}\n`;
    yield `${JSON.stringify({ type: "complete", runId: report.runId, summary: report.summary })}\n`;
    return;
  }
  const metadata = JSON.stringify(report);
  yield `${metadata.slice(0, -1)},"results":[`;
  let first = true;
  for (const result of results) {
    yield `${first ? "" : ","}${JSON.stringify(result)}`;
    first = false;
  }
  yield "]}\n";
}
