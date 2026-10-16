import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

const cliPath = resolve("dist/cli.js");
const sourceFixture = resolve("fixtures/source-pages.json");
const targetFixture = resolve("fixtures/target-ledger.jsonl");
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("compiled CLI", () => {
  it("reports drift, persists evidence, and resumes in a new process without changing inputs", async () => {
    const scenario = await createScenario();
    const sourceBefore = await readFile(scenario.source);
    const targetBefore = await readFile(scenario.target);

    const first = runCli(scenario, "--format", "json");
    expect(first.status, first.stderr).toBe(0);
    const report: unknown = JSON.parse(first.stdout);
    expect(report).toMatchObject({
      schemaVersion: "1",
      mode: "dry-run",
      recordsRead: { source: 6, target: 4 },
      summary: { total: 6, equal: 1, missing: 2, changed: 1, conflicting: 2 },
      checkpoints: {
        before: { source: null, target: null },
        after: { source: { cursor: "6" }, target: { cursor: "4" } },
      },
      results: [
        { classification: "equal", identityKey: "order:ORDER-100" },
        {
          classification: "changed",
          identityKey: "order:ORDER-101",
          source: [
            {
              evidence: {
                format: "application/json",
                payload: {
                  id: "acme-101",
                  total_cents: 4200,
                },
              },
            },
          ],
          target: [
            {
              evidence: {
                format: "application/x-ndjson",
                payload: { sequence: 2 },
              },
            },
          ],
        },
        {
          classification: "missing",
          identityKey: "order:ORDER-102",
          source: [{ evidence: { payload: { id: "acme-102" } } }],
        },
        {
          classification: "conflicting",
          identityKey: "order:ORDER-103",
          source: [{ evidence: { payload: { id: "acme-103" } } }],
          target: [{ evidence: { payload: { sequence: 3 } } }],
        },
        {
          classification: "missing",
          identityKey: "order:ORDER-104",
          target: [{ evidence: { payload: { sequence: 4 } } }],
        },
        {
          classification: "conflicting",
          reason: "missing_identifier",
          source: [{ evidence: { payload: { id: "acme-no-identity" } } }],
        },
      ],
    });

    const firstState = readState(scenario.store);
    expect(firstState.reports).toEqual([
      { report_json: JSON.stringify(report) },
    ]);
    expect(firstState.observations).toHaveLength(9);
    expect(firstState.checkpoints).toEqual([
      { adapter_id: "local-acme-json", cursor: "6" },
      { adapter_id: "local-northstar-ledger", cursor: "4" },
    ]);

    const resumed = runCli(scenario, "--format", "human");
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(resumed.stdout).toContain("Read 0 source and 0 target records");
    expect(resumed.stdout).toContain(
      "Results: 1 equal, 2 missing, 1 changed, 2 conflicting",
    );
    expect(resumed.stdout).toContain("No external records were changed.");

    const resumedState = readState(scenario.store);
    expect(resumedState.reports).toHaveLength(2);
    expect(resumedState.observations).toEqual(firstState.observations);
    expect(resumedState.checkpoints).toEqual(firstState.checkpoints);
    expect(await readFile(scenario.source)).toEqual(sourceBefore);
    expect(await readFile(scenario.target)).toEqual(targetBefore);
  });

  it("rejects repair writes before creating a store or touching inputs", async () => {
    const scenario = await createScenario();
    const filesBefore = await readdir(scenario.directory);
    const sourceBefore = await readFile(scenario.source);
    const targetBefore = await readFile(scenario.target);

    const result = runCli(scenario, "--apply");
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Comparison commands never apply repairs");
    expect(await readdir(scenario.directory)).toEqual(filesBefore);
    expect(await readFile(scenario.source)).toEqual(sourceBefore);
    expect(await readFile(scenario.target)).toEqual(targetBefore);
  });

  it("keeps committed reports and checkpoints intact when a later read fails", async () => {
    const scenario = await createScenario();
    const initial = runCli(scenario, "--format", "json");
    expect(initial.status, initial.stderr).toBe(0);
    const committed = readState(scenario.store);
    const source = await readFile(scenario.source, "utf8");
    await writeFile(
      scenario.source,
      source.replace("acme-orders.v1", "unsupported.v2"),
    );

    const failed = runCli(scenario, "--format", "json");
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("adapter_error");
    expect(readState(scenario.store)).toEqual(committed);
  });
});

async function createScenario() {
  const directory = await mkdtemp(join(tmpdir(), "data reconciler e2e "));
  directories.push(directory);
  const source = join(directory, "source pages.json");
  const target = join(directory, "target ledger.jsonl");
  await Promise.all([
    copyFile(sourceFixture, source),
    copyFile(targetFixture, target),
  ]);
  return { directory, source, target, store: join(directory, "state.sqlite") };
}

function runCli(
  scenario: Awaited<ReturnType<typeof createScenario>>,
  ...args: string[]
) {
  const result = spawnSync(
    process.execPath,
    [
      cliPath,
      "reconcile",
      "--source",
      scenario.source,
      "--target",
      scenario.target,
      "--store",
      scenario.store,
      "--page-size",
      "2",
      ...args,
    ],
    {
      cwd: scenario.directory,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.signal, result.stderr).toBeNull();
  return result;
}

function readState(path: string) {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    return {
      checkpoints: database
        .prepare(
          "SELECT adapter_id, cursor FROM checkpoints ORDER BY adapter_id",
        )
        .all(),
      observations: database
        .prepare(
          "SELECT snapshot_json FROM observations ORDER BY adapter_id, record_id",
        )
        .all(),
      reports: database
        .prepare("SELECT report_json FROM reports ORDER BY rowid")
        .all(),
    };
  } finally {
    database.close();
  }
}
