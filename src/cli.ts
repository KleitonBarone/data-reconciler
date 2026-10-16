#!/usr/bin/env node
import { mkdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
import { ReconciliationError, type ErrorCode } from "./core/errors.js";
import { reportChunks } from "./reporters/export.js";
import { once } from "node:events";
import { createPlan, acceptPlan } from "./core/plans.js";
import { applyPlan, validateAcceptedPlan } from "./core/repairs.js";
import { replay } from "./core/replay.js";
import { initializeDemo } from "./demo.js";
import { objectValue, stringValue } from "./core/validation.js";
import { schemas } from "./contracts/schemas.js";

async function main(): Promise<void> {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  const { values, positionals, tokens } = parseArgs({
    tokens: true,
    allowPositionals: true,
    strict: true,
    options: {
      apply: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      directory: { type: "string" },
      kind: { type: "string" },
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
      from: { type: "string" },
      through: { type: "string" },
      job: { type: "string" },
      confirm: { type: "boolean", default: false },
      progress: { type: "boolean", default: false },
      "dry-run": { type: "boolean" },
      format: { type: "string", default: "human" },
      help: { type: "boolean", short: "h", default: false },
      "page-size": { type: "string", default: "100" },
      source: {
        type: "string",
        default: fileURLToPath(
          new URL("../fixtures/source-pages.json", import.meta.url),
        ),
      },
      store: { type: "string", default: ".data/reconciler.sqlite" },
      target: {
        type: "string",
        default: fileURLToPath(
          new URL("../fixtures/target-ledger.jsonl", import.meta.url),
        ),
      },
    },
  });

  if (values.version) {
    const metadata = objectValue(
      JSON.parse(
        await readFile(new URL("../package.json", import.meta.url), "utf8"),
      ) as unknown,
    );
    process.stdout.write(`${stringValue(metadata.version)}\n`);
    return;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (values.apply)
    throw new ReconciliationError(
      "unsafe_write",
      "Comparison commands never apply repairs. Use the apply command with an accepted digest.",
    );
  if (positionals.length !== 1)
    throw new ReconciliationError(
      "invalid_config",
      "Expected exactly one command",
    );
  const commandOptions: Record<string, readonly string[]> = {
    "init-demo": ["directory"],
    schema: ["kind"],
    compare: [
      "config",
      "generation",
      "check",
      "dry-run",
      "progress",
      "page-size",
    ],
    reconcile: [
      "source",
      "target",
      "page-size",
      "check",
      "dry-run",
      "config",
      "generation",
      "progress",
    ],
    plan: ["config", "generation", "run"],
    "show-plan": ["digest"],
    accept: [
      "config",
      "generation",
      "digest",
      "all",
      "operations",
      "fields",
      "max-operations",
      "max-records",
    ],
    apply: ["config", "generation", "digest", "dry-run", "progress"],
    audit: ["digest"],
    replay: ["config", "generation", "from", "to"],
    prune: ["job", "through", "confirm"],
    inspect: [],
    backup: ["to"],
    export: ["run"],
  };
  const permitted = commandOptions[positionals[0] ?? ""];
  if (
    permitted === undefined ||
    tokens.some(
      (token) =>
        token.kind === "option" &&
        !["store", "format", "help", "version", ...permitted].includes(
          token.name,
        ),
    )
  )
    throw new ReconciliationError(
      "invalid_config",
      "Option does not apply to this command",
    );
  if (
    values.format !== "human" &&
    values.format !== "json" &&
    values.format !== "ndjson"
  )
    throw new ReconciliationError("invalid_config", "Unknown report format");
  if (positionals[0] === "init-demo") {
    const demo = await initializeDemo(
      required(values.directory, "--directory"),
    );
    process.stdout.write(`${JSON.stringify(demo, null, 2)}\n`);
    return;
  }
  if (positionals[0] === "schema") {
    const schema = Object.entries(schemas).find(
      ([kind]) => kind === values.kind,
    )?.[1];
    if (schema === undefined)
      throw new ReconciliationError(
        "invalid_config",
        "Choose a supported schema kind",
      );
    process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
    return;
  }
  if (positionals[0] === "replay") {
    const job = await configuredJob(
      required(values.config, "--config"),
      values.generation,
    );
    const store = new SqliteReconciliationStore(
      resolve(required(values.store, "--store")),
    );
    try {
      const report = await replay(job, {
        store,
        from: Number(required(values.from, "--from")),
        to: Number(required(values.to, "--to")),
        signal: controller.signal,
      });
      for (const chunk of reportChunks(
        report,
        store.durable.results(report.runId),
        values.format === "ndjson" ? "ndjson" : "json",
      ))
        if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
    } finally {
      store.close();
    }
    return;
  }
  if (positionals[0] === "prune") {
    if (!values.confirm)
      throw new ReconciliationError(
        "invalid_config",
        "Pruning requires --confirm and a backup",
      );
    const store = new SqliteReconciliationStore(
      resolve(required(values.store, "--store")),
    );
    try {
      const removed = store.pruneEvidence(
        required(values.job, "--job"),
        Number(required(values.through, "--through")),
      );
      process.stdout.write(
        `${JSON.stringify({ removed, recovery: "Restore a backup to recover deleted delivery evidence" })}\n`,
      );
    } finally {
      store.close();
    }
    return;
  }
  if (positionals[0] === "apply") {
    const job = await configuredJob(
      required(values.config, "--config"),
      values.generation,
    );
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
    const job =
      command === "show-plan"
        ? null
        : await configuredJob(
            required(values.config, "--config"),
            values.generation,
          );
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
  if (!["reconcile", "compare"].includes(positionals[0] ?? "")) {
    throw new ReconciliationError(
      "invalid_config",
      "Unknown command. Run --help.",
    );
  }

  const pageSize = Number(values["page-size"]);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1) {
    throw new ReconciliationError(
      "invalid_config",
      "--page-size must be a positive integer",
    );
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
    values.config === undefined
      ? null
      : await configuredJob(values.config, values.generation);
  if (
    loadedJob !== null &&
    tokens.some(
      (token) =>
        token.kind === "option" && ["source", "target"].includes(token.name),
    )
  )
    throw new ReconciliationError(
      "invalid_config",
      "Configure endpoints in the job, not command-line overrides",
    );
  const job =
    loadedJob === null ||
    !tokens.some(
      (token) => token.kind === "option" && token.name === "page-size",
    )
      ? loadedJob
      : { ...loadedJob, pageSize };
  await mkdir(dirname(storePath), { recursive: true, mode: 0o700 });

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

async function configuredJob(path: string, generation?: string) {
  const job = await loadJob(path);
  return generation === undefined
    ? job
    : { ...job, id: `${job.id}/${required(generation, "--generation")}` };
}

function usage(): string {
  return [
    "Usage: data-reconciler compare --config <job.json|job.mjs> [options]",
    "       data-reconciler init-demo --directory <new-directory>",
    "       data-reconciler schema --kind report|plan|acceptance|outcome|applySummary|ndjson",
    "       data-reconciler reconcile [options]",
    "       data-reconciler plan --config <job> --run <id>",
    "       data-reconciler show-plan --digest <sha256>",
    "       data-reconciler accept --config <job> --digest <sha256> --all --fields <names> --max-operations <n> --max-records <n>",
    "       data-reconciler apply --config <job> --digest <sha256> [--dry-run]",
    "       data-reconciler audit --digest <sha256>",
    "       data-reconciler replay --config <job> --from <sequence> --to <sequence>",
    "       data-reconciler prune --job <id> --through <sequence> --confirm",
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
  const code: ErrorCode =
    error instanceof ReconciliationError
      ? error.code
      : error instanceof Error &&
          "code" in error &&
          typeof error.code === "string" &&
          error.code.startsWith("ERR_PARSE_ARGS")
        ? "invalid_config"
        : "adapter_error";
  const hints: Record<ErrorCode, string> = {
    invalid_config: "Invalid configuration. Run --help and check the job file.",
    invalid_record:
      "Invalid record. Inspect saved failure evidence in the state store.",
    incompatible_state:
      "A checkpoint version does not match the job or dataset. Inspect state and choose an explicit generation.",
    adapter_error:
      "Adapter operation failed. Inspect saved state; diagnostic logs omit provider error contents.",
    cancelled: "Operation cancelled. Resume the same job or accepted digest.",
    busy: "Another process owns this job. Stop it before recovery.",
    stale_plan: "Plan or target changed or expired. Compare and review again.",
    unsafe_write:
      "Comparison commands never apply repairs. Use the apply command with an accepted digest and declared writer capabilities.",
    corrupt_state:
      "State failed validation. Preserve it and restore a verified backup.",
    limit_exceeded:
      "Work exceeded a configured processing bound. Narrow the scope.",
  };
  process.stderr.write(`data-reconciler: ${code}: ${hints[code]}\n`);
  process.exitCode =
    code === "invalid_config" ? 4 : code === "cancelled" ? 130 : 1;
});
