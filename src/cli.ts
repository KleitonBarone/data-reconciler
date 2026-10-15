#!/usr/bin/env node
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { JsonPageCommerceAdapter } from "./adapters/json-page-adapter.js";
import { JsonlLedgerCommerceAdapter } from "./adapters/jsonl-ledger-adapter.js";
import { reconcileDryRun } from "./core/reconcile.js";
import { formatTerminalReport } from "./reporters/terminal.js";
import { SqliteReconciliationStore } from "./storage/sqlite-store.js";
import { commercePolicy } from "./adapters/commerce-policy.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: true },
      format: { type: "string", default: "human" },
      help: { type: "boolean", short: "h", default: false },
      "page-size": { type: "string", default: "100" },
      source: { type: "string", default: "fixtures/source-pages.json" },
      store: { type: "string", default: ".data/reconciler.sqlite" },
      target: { type: "string", default: "fixtures/target-ledger.jsonl" },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (positionals.length !== 1 || positionals[0] !== "reconcile") {
    throw new Error(`Unknown command.\n\n${usage()}`);
  }
  if (values.apply || !values["dry-run"]) {
    throw new Error(
      "Repair writes are not implemented. This command only supports dry runs.",
    );
  }
  if (values.format !== "human" && values.format !== "json") {
    throw new Error("--format must be human or json");
  }

  const pageSize = Number(values["page-size"]);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("--page-size must be a positive integer");
  }
  const sourcePath = resolve(required(values.source, "--source"));
  const targetPath = resolve(required(values.target, "--target"));
  const storePath = resolve(required(values.store, "--store"));
  await mkdir(dirname(storePath), { recursive: true });

  const store = new SqliteReconciliationStore(storePath);
  try {
    const report = await reconcileDryRun({
      source: new JsonPageCommerceAdapter(sourcePath),
      target: new JsonlLedgerCommerceAdapter(targetPath),
      store,
      pageSize,
      normalization: commercePolicy,
    });
    const output =
      values.format === "json"
        ? JSON.stringify(report, null, 2)
        : formatTerminalReport(report);
    process.stdout.write(`${output}\n`);
  } finally {
    store.close();
  }
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${option} requires a path`);
  }
  return value;
}

function usage(): string {
  return [
    "Usage: data-reconciler reconcile [options]",
    "",
    "Options:",
    "  --source <path>     Acme JSON pages",
    "  --target <path>     Northstar JSONL ledger",
    "  --store <path>      SQLite state and report store",
    "  --page-size <count> Incremental read page size",
    "  --format <format>   human or json",
    "  --dry-run           accepted for clarity; already enforced",
    "  --apply             rejected; repair writes do not exist",
  ].join("\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`data-reconciler: ${message}\n`);
  process.exitCode = 1;
});
