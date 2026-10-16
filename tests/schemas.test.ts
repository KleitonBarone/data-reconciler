import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { expect, it } from "vitest";
import {
  schemas,
  initializeDemo,
  loadJob,
  compare,
  createPlan,
  acceptPlan,
  applyPlan,
  reportChunks,
  SqliteReconciliationStore,
} from "../src/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("validates every serialized workflow contract with an independent JSON Schema implementation", async () => {
  const ajv = new Ajv2020({ allErrors: true });
  addFormats.default(ajv);
  const validators = Object.fromEntries(
    Object.entries(schemas).map(([key, schema]) => [key, ajv.compile(schema)]),
  );
  const validate = (kind: keyof typeof schemas, value: unknown) => {
    const validator = validators[kind];
    if (validator === undefined) throw new Error("Missing schema");
    expect(validator(value), JSON.stringify(validator.errors)).toBe(true);
  };
  const directory = mkdtempSync(join(tmpdir(), "reconciler-schemas-"));
  const store = new SqliteReconciliationStore(":memory:");
  try {
    const demo = await initializeDemo(join(directory, "demo"));
    const job = await loadJob(demo.config);
    const run = await compare(job, { store });
    validate(
      "report",
      JSON.parse(
        [...reportChunks(run, store.durable.results(run.runId), "json")].join(
          "",
        ),
      ) as unknown,
    );
    const plan = createPlan(job, { store, runId: run.runId });
    validate("plan", plan);
    const accepted = acceptPlan(job, {
      store,
      digest: plan.digest,
      operationIds: plan.body.operations.map((op) => op.id),
      allowedFields: ["stock"],
      maxOperations: 2,
      maxRecords: 2,
    });
    validate("acceptance", accepted);
    validate(
      "applySummary",
      await applyPlan(job, { store, digest: plan.digest }),
    );
    for (const outcome of store.repairs.history(plan.digest))
      validate("outcome", outcome);
    for (const chunk of reportChunks(
      run,
      store.durable.results(run.runId),
      "ndjson",
    ))
      validate("ndjson", JSON.parse(chunk) as unknown);
    expect(validators.plan?.({ ...plan, digest: "edited" })).toBe(false);
    expect(
      validators.report?.({ ...run, schemaVersion: "999", results: [] }),
    ).toBe(false);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
