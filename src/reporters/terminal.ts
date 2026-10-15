import type { ReconciliationReport } from "../core/model.js";

export function formatTerminalReport(
  report: Omit<ReconciliationReport, "observationsRead" | "results"> & {
    readonly results: Iterable<ReconciliationReport["results"][number]>;
  },
): string {
  const lines = [
    `Dry run ${report.runId}`,
    `${report.adapters.source.displayName} -> ${report.adapters.target.displayName}`,
    `Read ${report.recordsRead.source} source and ${report.recordsRead.target} target records`,
    `Results: ${report.summary.equal} equal, ${report.summary.missing} missing, ${report.summary.changed} changed, ${report.summary.conflicting} conflicting`,
  ];

  for (const result of report.results) {
    if (result.classification === "equal") continue;
    const identity = result.identityKey ?? recordLabel(result);
    if (result.classification === "missing") {
      lines.push(`MISSING     ${identity} on ${result.missingSide}`);
    } else if (result.classification === "changed") {
      const fields = result.differences
        .map((difference) => difference.path)
        .join(", ");
      lines.push(
        `CHANGED     ${identity} newer on ${result.newerSide}: ${fields}`,
      );
    } else {
      lines.push(`CONFLICTING ${identity}: ${result.reason}`);
    }
  }

  lines.push("No external records were changed.");
  return lines.join("\n");
}

function recordLabel(result: ReconciliationReport["results"][number]): string {
  const record = [...result.source, ...result.target].at(0);
  return record === undefined
    ? "unidentified record"
    : `${record.side}/${record.recordId}`;
}
