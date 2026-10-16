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
import { loadJob } from "./config.js";
import { compare } from "./core/job.js";
import { ReconciliationError } from "./core/errors.js";
import { reportChunks } from "./reporters/export.js";
import { once } from "node:events";
import { createPlan, acceptPlan } from "./core/plans.js";
import { applyPlan, validateAcceptedPlan } from "./core/repairs.js";

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: "boolean", default: false },
      config: { type: "string" },
      check: { type: "boolean", default: false },
      to: { type: "string" },
      run: { type: "string" },
      generation: { type: "string" },
      digest: { type: "string" },
      operations: { type: "string" },
      all: { type: "boolean", default: false },
      fields: { type: "string" },
      "max-operations": { type: "string" },
      "max-records": { type: "string" },
      progress: { type: "boolean", default: false },
      "dry-run": { type: "boolean" },
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
  if (values.apply)
    throw new ReconciliationError(
      "unsafe_write",
      "Comparison commands never apply repairs. Use the apply command with an accepted digest.",
    );
  if (positionals[0] === "apply") {
    const job = await loadJob(required(values.config, "--config"));
    const digest = required(values.digest, "--digest");
    const store = new SqliteReconciliationStore(
      resolve(required(values.store, "--store")),
    );
    try {
      if (values["dry-run"]) {
        const { acceptance } = validateAcceptedPlan(job, store, digest);
        process.stdout.write(
          `${JSON.stringify({ mode: "dry-run", digest, operations: acceptance.operationIds.length })}\n`,
        );
      } else {
        const summary = await applyPlan(job, {
          store,
          digest,
          signal: controller.signal,
          ...(values.progress
            ? {
                onEvent: (event: import("./core/job.js").RunEvent) =>
                  process.stderr.write(`${JSON.stringify(event)}\n`),
              }
            : {}),
        });
        process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
        if (summary.cancelled) process.exitCode = 130;
        else if (summary.failed + summary.unknown + summary.pending > 0)
          process.exitCode = 1;
      }
    } finally {
      store.close();
    }
    return;
  }
  if (["plan", "show-plan", "accept"].includes(positionals[0] ?? "")) {
    const command = positionals[0];
    if (positionals.length !== 1)
      throw new ReconciliationError("invalid_config", "Expected one command");
    const job =
      command === "show-plan"
        ? null
        : await loadJob(required(values.config, "--config"));
    const store = new SqliteReconciliationStore(
      resolve(required(values.store, "--store")),
    );
    try {
      if (command === "show-plan") {
        const plan = store.plans.get(required(values.digest, "--digest"));
        if (plan === null)
          throw new ReconciliationError("stale_plan", "Plan not found");
        process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
      } else if (job !== null && command === "plan") {
        const plan = createPlan(job, {
          store,
          runId: required(values.run, "--run"),
        });
        process.stdout.write(
          values.format === "human"
            ? `Plan ${plan.digest}\n${plan.body.operations.length} operations, ${plan.body.skipped.count} skipped. No target writes.\n`
            : `${JSON.stringify(plan, null, 2)}\n`,
        );
      } else if (job !== null) {
        const digest = required(values.digest, "--digest");
        const plan = store.plans.get(digest);
        if (plan === null)
          throw new ReconciliationError("stale_plan", "Plan not found");
        if (values.all && values.operations !== undefined)
          throw new ReconciliationError(
            "invalid_config",
            "Choose --all or --operations, not both",
          );
        const accepted = acceptPlan(job, {
          store,
          digest,
          operationIds: values.all
            ? plan.body.operations.map((op) => op.id)
            : required(values.operations, "--operations or --all").split(","),
          allowedFields: required(values.fields, "--fields").split(","),
          maxOperations: Number(
            required(values["max-operations"], "--max-operations"),
          ),
          maxRecords: Number(required(values["max-records"], "--max-records")),
        });
        process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
      }
    } finally {
      store.close();
    }
    return;
  }
  if (["inspect", "backup", "export", "audit"].includes(positionals[0] ?? "")) {
    if (positionals.length !== 1)
      throw new ReconciliationError("invalid_config", "Expected one command");
    const store = new SqliteReconciliationStore(
      resolve(required(values.store, "--store")),
    );
    try {
      if (positionals[0] === "audit") {
        const digest = required(values.digest, "--digest");
        process.stdout.write(
          `${JSON.stringify({ digest, verifications: store.repairs.verifications(digest), attempts: store.repairs.summaries(digest) }).slice(0, -1)},"history":[`,
        );
        let first = true;
        for (const outcome of store.repairs.history(digest)) {
          if (
            !process.stdout.write(
              `${first ? "" : ","}${JSON.stringify(outcome)}`,
            )
          )
            await once(process.stdout, "drain");
          first = false;
        }
        process.stdout.write("]}\n");
      } else if (positionals[0] === "inspect")
        process.stdout.write(`${JSON.stringify(store.inspect(), null, 2)}\n`);
      else if (positionals[0] === "backup") {
        const destination = resolve(required(values.to, "--to"));
        await mkdir(dirname(destination), { recursive: true });
        store.backup(destination);
        process.stdout.write(`${JSON.stringify({ backup: destination })}\n`);
      } else {
        const report = store.durable.getRun(required(values.run, "--run"));
        if (report === null) throw new Error("No completed run with that ID");
        for (const chunk of reportChunks(
          report,
          store.durable.results(report.runId),
          values.format === "ndjson" ? "ndjson" : "json",
        ))
          if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
      }
    } finally {
      store.close();
    }
    return;
  }
  if (
    positionals.length !== 1 ||
    !["reconcile", "compare"].includes(positionals[0] ?? "")
  ) {
    throw new Error(`Unknown command.\n\n${usage()}`);
  }
  if (
    values.format !== "human" &&
    values.format !== "json" &&
    values.format !== "ndjson"
  ) {
    throw new Error("--format must be human, json, or ndjson");
  }

  const pageSize = Number(values["page-size"]);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new Error("--page-size must be a positive integer");
  }
  const sourcePath = resolve(required(values.source, "--source"));
  const targetPath = resolve(required(values.target, "--target"));
  const storePath = resolve(required(values.store, "--store"));
  if (positionals[0] === "compare" && values.config === undefined)
    throw new ReconciliationError(
      "invalid_config",
      "compare requires --config <path>",
    );
  const loadedJob =
    values.config === undefined ? null : await loadJob(values.config);
  const job =
    loadedJob === null
      ? null
      : values.generation === undefined
        ? loadedJob
        : { ...loadedJob, id: `${loadedJob.id}/${values.generation}` };
  await mkdir(dirname(storePath), { recursive: true });

  const store = new SqliteReconciliationStore(storePath);
  try {
    if (job !== null) {
      const report = await compare(job, {
        store,
        signal: controller.signal,
        ...(values.progress
          ? {
              onEvent: (event: import("./core/job.js").RunEvent) =>
                process.stderr.write(`${JSON.stringify(event)}\n`),
            }
          : {}),
      });
      if (values.format === "human")
        process.stdout.write(
          `${formatTerminalReport({ ...report, results: store.durable.results(report.runId) })}\n`,
        );
      else
        for (const chunk of reportChunks(
          report,
          store.durable.results(report.runId),
          values.format,
        ))
          if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
      if (values.check)
        process.exitCode =
          report.summary.conflicting > 0
            ? 3
            : report.summary.changed + report.summary.missing > 0
              ? 2
              : 0;
      return;
    }
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
    if (values.check)
      process.exitCode =
        report.summary.conflicting > 0
          ? 3
          : report.summary.changed + report.summary.missing > 0
            ? 2
            : 0;
  } finally {
    store.close();
  }
}

function required(value: string | undefined, option: string): string {
  if (value === undefined || value === "") {
    throw new ReconciliationError("invalid_config", `${option} is required`);
  }
  return value;
}

function usage(): string {
  return [
    "Usage: data-reconciler compare --config <job.json|job.mjs> [options]",
    "       data-reconciler reconcile [options]",
    "       data-reconciler plan --config <job> --run <id>",
    "       data-reconciler show-plan --digest <sha256>",
    "       data-reconciler accept --config <job> --digest <sha256> --all --fields <names> --max-operations <n> --max-records <n>",
    "       data-reconciler apply --config <job> --digest <sha256> [--dry-run]",
    "       data-reconciler audit --digest <sha256>",
    "       data-reconciler inspect|backup|export --store <path> [--to <backup>] [--run <id>]",
    "",
    "Options:",
    "  --source <path>     Acme JSON pages",
    "  --config <path>     Validated job configuration",
    "  --check             Exit 2 for drift or 3 for conflicts",
    "  --generation <id>   Compare into a new explicit state generation",
    "  --target <path>     Northstar JSONL ledger",
    "  --store <path>      SQLite state and report store",
    "  --page-size <count> Incremental read page size",
    "  --format <format>   human, json, or ndjson",
    "  --dry-run           compare is always dry; apply only validates when set",
    "  --progress          correlated JSON diagnostics on stderr",
    "  --apply             rejected; use the explicit apply command",
  ].join("\n");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`data-reconciler: ${message}\n`);
  process.exitCode =
    error instanceof ReconciliationError && error.code === "invalid_config"
      ? 4
      : error instanceof ReconciliationError && error.code === "cancelled"
        ? 130
        : 1;
});
