import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { initializeSqliteTarget, planValue } from "../../src/index.js";
import { objectValue, stringValue } from "../../src/core/validation.js";

it("keeps every ambiguous identity out of compiled repair dispatch", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "reconciler-identity-repairs-"),
  );
  const source = join(directory, "source.json");
  const target = join(directory, "target.sqlite");
  const state = join(directory, "state.sqlite");
  const config = join(directory, "job.json");
  const cli = resolve("dist/cli.js");
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, "--config", config, "--store", state, "--format", "json"],
      { cwd: directory, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return objectValue(JSON.parse(result.stdout) as unknown);
  };
  const owner = {
    recordId: "owner",
    identity: { kind: "sku", value: "B" },
    updatedAt: "2026-01-01T00:00:00Z",
    comparable: { stock: 1 },
    evidence: { format: "fixture", locator: "owner", payload: {} },
  };
  try {
    initializeSqliteTarget(target, [owner]);
    // Simulate a provider changing identity at an indistinguishable revision time.
    const db = new DatabaseSync(target);
    const alternate = JSON.stringify({
      ...owner,
      identity: { kind: "sku", value: "A" },
    });
    db.prepare(
      "INSERT INTO target_events(record_json,plan_digest) VALUES (?,NULL)",
    ).run(alternate);
    db.prepare(
      "UPDATE target_records SET revision=2,record_json=? WHERE record_id='owner'",
    ).run(alternate);
    db.close();
    await writeFile(
      source,
      JSON.stringify(
        ["A", "B", "safe"].map((sku) => ({
          id: sku,
          sku,
          stock: 2,
          time: "2026-01-02T00:00:00Z",
        })),
      ),
    );
    await writeFile(
      config,
      JSON.stringify({
        id: "ambiguous-repairs",
        pageSize: 1,
        source: {
          id: "source",
          type: "json",
          path: source,
          schemaVersion: "1",
          projection: {
            id: "/id",
            updatedAt: "/time",
            identity: { kind: "sku", paths: ["/sku"] },
            fields: { stock: "/stock" },
          },
        },
        target: { id: "target", type: "sqlite-records", path: target },
        repair: {
          version: "1",
          direction: "source-to-target",
          sourceFields: ["stock"],
        },
      }),
    );
    const targetBefore = await readFile(target);
    const report = run("compare");
    expect(report.summary).toMatchObject({ conflicting: 2, missing: 1 });
    const plan = planValue(run("plan", "--run", stringValue(report.runId)));
    expect(plan.body.operations.map((op) => op.identityKey)).toEqual([
      "sku:safe",
    ]);
    run(
      "accept",
      "--digest",
      plan.digest,
      "--all",
      "--fields",
      "stock",
      "--max-operations",
      "1",
      "--max-records",
      "1",
    );
    expect(await readFile(target)).toEqual(targetBefore);
    expect(run("apply", "--digest", plan.digest)).toMatchObject({
      succeeded: 1,
      unknown: 0,
      failed: 0,
    });
    const after = await readFile(target);
    expect(run("apply", "--digest", plan.digest)).toMatchObject({
      succeeded: 0,
      skipped: 1,
    });
    expect(await readFile(target)).toEqual(after);
    const read = new DatabaseSync(target, { readOnly: true });
    try {
      expect(
        read.prepare("SELECT COUNT(*) n FROM target_records").get()?.n,
      ).toBe(2);
      expect(
        read.prepare("SELECT COUNT(*) n FROM target_events").get()?.n,
      ).toBe(3);
    } finally {
      read.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);

it.each(["before", "after"] as const)(
  "recovers a forced %s-write process termination with no duplicate effects",
  async (phase) => {
    const directory = await mkdtemp(join(tmpdir(), "reconciler-write-crash-"));
    const source = join(directory, "source.json");
    const target = join(directory, "target.sqlite");
    const store = join(directory, "state.sqlite");
    const config = join(directory, "job.mjs");
    const marker = join(directory, "resumed");
    const lookupOutage = join(directory, "lookup-unavailable");
    const cli = resolve("dist/cli.js");
    const run = (...args: string[]) =>
      spawnSync(
        process.execPath,
        [
          cli,
          ...args,
          ...(args[0] === "audit" ? [] : ["--config", config]),
          "--store",
          store,
          "--format",
          "json",
        ],
        { cwd: directory, encoding: "utf8", timeout: 30000 },
      );
    const success = (...args: string[]) => {
      const result = run(...args);
      expect(result.status, result.stderr).toBe(0);
      return objectValue(JSON.parse(result.stdout) as unknown);
    };
    try {
      await writeFile(
        source,
        JSON.stringify([
          {
            id: "shirt",
            sku: "shirt",
            stock: 12,
            time: "2026-01-02T00:00:00Z",
          },
          { id: "hat", sku: "hat", stock: 8, time: "2026-01-02T00:00:00Z" },
          { id: "orphan", stock: 1, time: "2026-01-02T00:00:00Z" },
        ]),
      );
      initializeSqliteTarget(target, [
        {
          recordId: "shirt",
          identity: { kind: "sku", value: "shirt" },
          updatedAt: "2026-01-01T00:00:00Z",
          comparable: { stock: 10 },
          evidence: {
            format: "fixture",
            locator: "shirt",
            payload: { stock: 10 },
          },
        },
      ]);
      await writeFile(
        config,
        `import { JsonFileAdapter, SqliteRecordAdapter } from ${JSON.stringify(pathToFileURL(resolve("dist/index.js")).href)};
      import { existsSync } from "node:fs";
      const target = new SqliteRecordAdapter(${JSON.stringify(target)},{id:"target"});
      export default {id:"crash-repairs",source:new JsonFileAdapter({id:"source",path:${JSON.stringify(source)},format:"json",schemaVersion:"1",projection:{id:"/id",updatedAt:"/time",identity:{kind:"sku",paths:["/sku"]},fields:{stock:"/stock"}}}),
        target:{descriptor:target.descriptor,readPage:target.readPage.bind(target),writer:{...target.writer,lookup(key,signal){
          if(existsSync(${JSON.stringify(lookupOutage)})) throw new Error("receipt lookup unavailable");
          return target.writer.lookup(key,signal);
        },async apply(write,signal){
          if(!existsSync(${JSON.stringify(marker)}) && ${JSON.stringify(phase)} === "before") process.kill(process.pid,"SIGKILL");
          const receipt = await target.writer.apply(write,signal);
          if(!existsSync(${JSON.stringify(marker)}) && ${JSON.stringify(phase)} === "after") process.kill(process.pid,"SIGKILL");
          return receipt;
        }}},repair:{version:"1",direction:"source-to-target",sourceFields:["stock"]}};
    `,
      );
      const sourceBefore = await readFile(source);
      const compared = success("compare");
      const plan = planValue(
        success("plan", "--run", stringValue(compared.runId)),
      );
      success(
        "accept",
        "--digest",
        plan.digest,
        "--all",
        "--fields",
        "stock",
        "--max-operations",
        "2",
        "--max-records",
        "2",
      );
      const targetBefore = await readFile(target);
      expect(success("apply", "--digest", plan.digest, "--dry-run").mode).toBe(
        "dry-run",
      );
      expect(await readFile(target)).toEqual(targetBefore);
      const crashed = run("apply", "--digest", plan.digest);
      expect(crashed.status).not.toBe(0);
      const state = new DatabaseSync(store, { readOnly: true });
      try {
        expect(
          state.prepare("SELECT COUNT(*) n FROM repair_history").get()?.n,
        ).toBe(1);
        expect(
          state.prepare("SELECT outcome_json FROM operation_state").get()
            ?.outcome_json,
        ).toContain('"state":"pending"');
      } finally {
        state.close();
      }
      await writeFile(marker, "resume");
      const beforeLookupFailure = await readFile(target);
      await writeFile(lookupOutage, "outage");
      const unavailable = run("apply", "--digest", plan.digest);
      expect(unavailable.status, unavailable.stderr).toBe(1);
      expect(JSON.parse(unavailable.stdout) as unknown).toMatchObject({
        unknown: 1,
        failed: 0,
      });
      expect(await readFile(target)).toEqual(beforeLookupFailure);
      await rm(lookupOutage);
      expect(success("apply", "--digest", plan.digest)).toMatchObject({
        succeeded: 2,
        failed: 0,
        unknown: 0,
        pending: 0,
      });
      const after = await readFile(target);
      expect(success("apply", "--digest", plan.digest)).toMatchObject({
        succeeded: 0,
        skipped: 2,
      });
      expect(await readFile(target)).toEqual(after);
      expect(await readFile(source)).toEqual(sourceBefore);
      const verified = success("compare");
      expect(verified.summary).toMatchObject({
        equal: 2,
        missing: 0,
        changed: 0,
        conflicting: 1,
      });
      const db = new DatabaseSync(target, { readOnly: true });
      try {
        expect(
          db.prepare("SELECT COUNT(*) n FROM target_events").get()?.n,
        ).toBe(3);
      } finally {
        db.close();
      }
      const audit = success("audit", "--digest", plan.digest);
      expect(audit.verifications).toHaveLength(3);
      expect(audit.attempts).toHaveLength(3);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
