import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("resumes durable page progress after actual process termination", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-crash-"));
  directories.push(directory);
  const marker = join(directory, "resume");
  const config = join(directory, "job.mjs");
  const store = join(directory, "state.sqlite");
  await writeFile(
    config,
    `
    import { existsSync } from 'node:fs';
    import { defineJob, JsonPageCommerceAdapter, JsonlLedgerCommerceAdapter, commercePolicy } from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)};
    const source = new JsonPageCommerceAdapter(${JSON.stringify(resolve("fixtures/source-pages.json"))});
    export default defineJob({ id:'crash-test', pageSize:2, normalization:commercePolicy,
      source:{descriptor:source.descriptor, async readPage(request){
        if(request.checkpoint?.cursor==='2' && !existsSync(${JSON.stringify(marker)})) process.kill(process.pid,'SIGKILL');
        return source.readPage(request);
      }}, target:new JsonlLedgerCommerceAdapter(${JSON.stringify(resolve("fixtures/target-ledger.jsonl"))}) });
  `,
  );
  const args = [
    resolve("dist/cli.js"),
    "compare",
    "--config",
    config,
    "--store",
    store,
    "--format",
    "json",
  ];
  const crashed = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 10000,
    cwd: directory,
  });
  expect(crashed.status).not.toBe(0);
  expect(crashed.stdout).toBe("");
  const db = new DatabaseSync(store);
  try {
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM deliveries").get(),
    ).toMatchObject({ count: 2 });
    expect(db.prepare("SELECT status FROM run_state").get()).toMatchObject({
      status: "reading",
    });
  } finally {
    db.close();
  }
  await writeFile(marker, "resume");
  const resumed = spawnSync(process.execPath, args, {
    encoding: "utf8",
    timeout: 10000,
    cwd: directory,
  });
  expect(resumed.status, resumed.stderr).toBe(0);
  const report: unknown = JSON.parse(resumed.stdout);
  expect(report).toMatchObject({
    jobId: "crash-test",
    recordsRead: { source: 4, target: 4 },
    summary: { equal: 1, missing: 2, changed: 1, conflicting: 2 },
  });
});
