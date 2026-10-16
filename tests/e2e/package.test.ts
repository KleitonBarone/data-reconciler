import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  readdir,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { expect, it } from "vitest";
import { objectValue, stringValue } from "../../src/core/validation.js";

function pnpm(args: readonly string[], cwd: string) {
  const manager = process.env.npm_execpath;
  if (!manager) throw new Error("Run package verification through pnpm");
  const js = /\.(?:c?js|mjs)$/u.test(manager);
  const result = spawnSync(
    js ? process.execPath : manager,
    [...(js ? [manager] : []), ...args],
    { cwd, encoding: "utf8", timeout: 120000 },
  );
  expect(
    result.status,
    result.stdout + "\n" + result.stderr + "\n" + String(result.error ?? ""),
  ).toBe(0);
  return result;
}

async function verifyMaps(
  directory: string,
  packageRoot: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verifyMaps(path, packageRoot);
    else if (entry.name.endsWith(".map")) {
      const map = objectValue(
        JSON.parse(await readFile(path, "utf8")) as unknown,
      );
      if (!Array.isArray(map.sources))
        throw new Error("Invalid shipped source map");
      for (const source of map.sources) {
        const target = resolve(dirname(path), stringValue(source));
        expect(target.startsWith(packageRoot)).toBe(true);
        await readFile(target);
      }
    }
  }
}

async function verifyDocumentationLinks(
  directory: string,
  packageRoot: string,
): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await verifyDocumentationLinks(path, packageRoot);
    else if (entry.name.endsWith(".md")) {
      const markdown = await readFile(path, "utf8");
      for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
        const link = match[1]?.split("#")[0];
        if (!link || /^[a-z]+:/iu.test(link)) continue;
        const target = resolve(dirname(path), decodeURIComponent(link));
        const local = relative(packageRoot, target);
        expect(
          !local.startsWith("..") && !isAbsolute(local),
          "Documentation link leaves the package: " + link,
        ).toBe(true);
        await expect(
          access(target),
          "Broken installed link in " +
            relative(packageRoot, path) +
            ": " +
            link,
        ).resolves.toBeUndefined();
      }
    }
  }
}

it("installs a release candidate and rehearses the complete workflow without repository or runtime dev dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-consumer-"));
  const consumer = join(directory, "typescript");
  const runtime = join(directory, "runtime");
  await mkdir(consumer);
  await mkdir(runtime);
  try {
    // Windows runners keep the checkout and temporary consumers on different drives.
    const storeDirectory = dirname(
      pnpm(["store", "path"], resolve(".")).stdout.trim(),
    );
    pnpm(["pack", "--pack-destination", directory], resolve("."));
    const tarball = (await readdir(directory)).find((file) =>
      file.endsWith(".tgz"),
    );
    if (!tarball) throw new Error("No packed artifact");
    const metadata = {
      private: true,
      type: "module",
      dependencies: { "data-reconciler": "file:../" + tarball },
    };
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        ...metadata,
        devDependencies: { typescript: "6.0.3", "@types/node": "24.13.3" },
      }),
    );
    await writeFile(join(runtime, "package.json"), JSON.stringify(metadata));
    await writeFile(
      join(consumer, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          types: ["node"],
          strict: true,
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2023",
          outDir: "out",
        },
        include: ["*.ts"],
      }),
    );
    await writeFile(
      join(consumer, "consumer.ts"),
      [
        'import { compare, defineAdapter, createCheckpoint, SqliteReconciliationStore, SqliteRecordAdapter, loadJob, applyPlan } from "data-reconciler";',
        'function required(value: string | undefined): string { if(value === undefined) throw new Error("Missing consumer argument");return value; }',
        'if(process.argv[2] === "drift"){',
        " const target = new SqliteRecordAdapter(required(process.argv[3]));",
        ' const current = await target.writer.getCurrent("shop-shirt");',
        ' if(current === null || current.identity === null || current.revision === undefined) throw new Error("Missing fixture record");',
        " const page = await target.readPage({checkpoint:null,limit:10});",
        ' await target.writer.apply({authorizationDigest:"concurrent",deduplicationKey:"concurrent",kind:"update",recordId:current.recordId,identity:current.identity,identityKey:"sku:shirt",expectedRevision:current.revision,expectedCheckpoint:page.nextCheckpoint,comparable:{stock:99},fields:["stock"],updatedAt:"2026-02-01T00:00:00Z"});',
        '} else if(process.argv[2] === "crash"){',
        " const job = await loadJob(required(process.argv[3]));",
        " const store = new SqliteReconciliationStore(required(process.argv[4]));",
        ' try { await applyPlan(job,{store,digest:required(process.argv[5]),onEvent(event){if(event.type==="repair_intent")process.kill(process.pid,"SIGKILL");}}); } finally {store.close();}',
        "} else {",
        ' const descriptor = {id:"source",displayName:"source",datasetId:"consumer:source",contractVersion:1,adapterVersion:"1",schemaVersion:"1"} as const;',
        ' const source = defineAdapter({descriptor,readPage:()=>Promise.resolve({records:[{sku:"a",stock:12}],hasMore:false,nextCheckpoint:createCheckpoint(descriptor,"1")}),project:(raw)=>({recordId:raw.sku,identity:{kind:"sku",value:raw.sku},updatedAt:"2026-01-01T00:00:00Z",comparable:{stock:raw.stock},evidence:{format:"consumer",locator:raw.sku,payload:raw}})});',
        ' const target = {...source,descriptor:{...descriptor,id:"target",datasetId:"consumer:target"}};',
        ' const store = new SqliteReconciliationStore(":memory:");',
        ' try {const report = await compare({id:"consumer",source,target},{store});if(report.summary.equal!==1)throw new Error("Consumer comparison failed");}finally{store.close();}',
        "}",
      ].join("\n"),
    );
    pnpm(
      [
        "install",
        "--ignore-scripts",
        "--offline",
        "--store-dir",
        storeDirectory,
      ],
      consumer,
    );
    pnpm(
      [
        "install",
        "--prod",
        "--ignore-scripts",
        "--offline",
        "--store-dir",
        storeDirectory,
      ],
      runtime,
    );
    const packageRoot = join(runtime, "node_modules/data-reconciler");
    await copyFile(
      join(packageRoot, "examples/consumer.ts"),
      join(consumer, "documented.ts"),
    );
    pnpm(["exec", "tsc", "-p", "tsconfig.json"], consumer);
    for (const file of ["consumer.js", "documented.js"])
      await copyFile(join(consumer, "out", file), join(runtime, file));
    expect(await readdir(join(runtime, "node_modules"))).not.toContain(
      "typescript",
    );
    expect(await readdir(join(runtime, "node_modules"))).not.toContain(
      "vitest",
    );
    const shipped = await readdir(packageRoot);
    expect(shipped).not.toContain("tests");
    expect(shipped).not.toContain(".github");
    await verifyDocumentationLinks(packageRoot, packageRoot);
    await verifyMaps(join(packageRoot, "dist"), packageRoot);
    expect(
      pnpm(["exec", "data-reconciler", "--help"], runtime).stdout,
    ).toContain("Usage:");

    const node = (args: readonly string[], expected = 0) => {
      const result = spawnSync(process.execPath, args, {
        cwd: runtime,
        encoding: "utf8",
        timeout: 30000,
      });
      expect(result.status, result.stdout + "\n" + result.stderr).toBe(
        expected,
      );
      return result;
    };
    node([join(runtime, "consumer.js")]);
    const cliPath = join(packageRoot, "dist/cli.js");
    const cli = (args: readonly string[], expected = 0) =>
      node([cliPath, ...args], expected);
    const json = (args: readonly string[], expected = 0) =>
      objectValue(
        JSON.parse(
          cli([...args, "--format", "json"], expected).stdout,
        ) as unknown,
      );
    const normalizationConfig = join(
      packageRoot,
      "examples/normalization.json",
    );
    const normalizedSummary = {
      total: 1,
      equal: 1,
      missing: 0,
      changed: 0,
      conflicting: 0,
    };
    expect(
      JSON.parse(
        node([join(runtime, "documented.js"), normalizationConfig]).stdout,
      ) as unknown,
    ).toEqual(normalizedSummary);
    const normalized = json([
      "compare",
      "--config",
      normalizationConfig,
      "--store",
      join(runtime, "normalization.sqlite"),
    ]);
    expect(normalized.summary).toEqual(normalizedSummary);
    const comparable = {
      name: "Blue Shirt",
      stock: 12,
      tags: ["blue", "sale"],
    };
    expect(normalized.results).toEqual([
      expect.objectContaining({
        classification: "equal",
        identityKey: "sku:SHIRT-01",
        source: [
          expect.objectContaining({
            comparable,
            evidence: {
              format: "application/json",
              locator: "record:0",
              payload: {
                id: "warehouse-1",
                changedAt: "2026-01-02T00:00:00Z",
                sku: " shirt-01 ",
                product: {
                  name: "  Ｂｌｕｅ Shirt  ",
                  tags: [" sale ", "blue"],
                  stock: 12,
                },
                trace: "source-only note",
              },
            },
          }),
        ],
        target: [
          expect.objectContaining({
            comparable,
            evidence: {
              format: "application/json",
              locator: "record:0",
              payload: {
                key: "shop-1",
                modified: "2026-01-01T00:00:00Z",
                code: "SHIRT-01",
                title: "Blue Shirt",
                labels: ["blue", "sale"],
                quantity: 12,
                trace: "target-only note",
              },
            },
          }),
        ],
      }),
    ]);
    expect(cli(["--version"]).stdout.trim()).toBe("1.0.0-rc.1");
    expect(json(["schema", "--kind", "report"]).$schema).toBe(
      "https://json-schema.org/draft/2020-12/schema",
    );
    const bundled = json([
      "reconcile",
      "--store",
      join(runtime, "bundled.sqlite"),
    ]);
    expect(bundled.summary).toMatchObject({
      equal: 1,
      missing: 2,
      changed: 1,
      conflicting: 2,
    });
    node([join(packageRoot, "dist/examples/worker.js")]);
    node([join(packageRoot, "dist/examples/http.js")]);

    const demo = json(["init-demo", "--directory", "demo data"]);
    const config = stringValue(demo.config);
    const store = stringValue(demo.store);
    const common = ["--config", config, "--store", store];
    node([join(runtime, "documented.js"), config]);
    const first = json(["compare", ...common]);
    expect(first.summary).toMatchObject({
      changed: 1,
      missing: 1,
      conflicting: 2,
    });
    expect(json(["compare", ...common]).recordsRead).toEqual({
      source: 0,
      target: 0,
    });
    const source = join(stringValue(demo.directory), "source.json");
    const target = join(stringValue(demo.directory), "target.sqlite");
    const sourceBefore = await readFile(source);
    const review = (runId: string) => {
      const plan = json(["plan", ...common, "--run", runId]);
      const digest = stringValue(plan.digest);
      expect(json(["show-plan", "--store", store, "--digest", digest])).toEqual(
        plan,
      );
      json([
        "accept",
        ...common,
        "--digest",
        digest,
        "--all",
        "--fields",
        "stock",
        "--max-operations",
        "2",
        "--max-records",
        "2",
      ]);
      return digest;
    };
    const stale = review(stringValue(first.runId));
    node([join(runtime, "consumer.js"), "drift", target]);
    const concurrentlyChanged = await readFile(target);
    cli(
      [
        "apply",
        ...common,
        "--digest",
        stale,
        "--operations",
        "ignored-selection",
      ],
      4,
    );
    expect(await readFile(target)).toEqual(concurrentlyChanged);
    expect(json(["apply", ...common, "--digest", stale], 1).failed).toBe(1);
    expect(await readFile(target)).toEqual(concurrentlyChanged);

    const fresh = json(["compare", ...common]);
    const digest = review(stringValue(fresh.runId));
    json(["apply", ...common, "--digest", digest, "--dry-run"]);
    expect(await readFile(target)).toEqual(concurrentlyChanged);
    const interrupted = spawnSync(
      process.execPath,
      [join(runtime, "consumer.js"), "crash", config, store, digest],
      { cwd: runtime, encoding: "utf8", timeout: 30000 },
    );
    expect(interrupted.status).not.toBe(0);
    expect(json(["apply", ...common, "--digest", digest])).toMatchObject({
      succeeded: 2,
      failed: 0,
      unknown: 0,
    });
    const applied = await readFile(target);
    expect(json(["apply", ...common, "--digest", digest])).toMatchObject({
      succeeded: 0,
      skipped: 2,
    });
    expect(await readFile(target)).toEqual(applied);
    expect(await readFile(source)).toEqual(sourceBefore);
    expect(json(["compare", ...common]).summary).toMatchObject({
      equal: 2,
      missing: 0,
      changed: 0,
      conflicting: 2,
    });

    const replayArgs = ["replay", ...common, "--from", "1", "--to", "6"];
    const replayed = json(replayArgs);
    expect(json(replayArgs).results).toEqual(replayed.results);
    expect(json(["compare", ...common]).recordsRead).toEqual({
      source: 0,
      target: 0,
    });
    expect(
      json(["audit", "--store", store, "--digest", digest]).verifications,
    ).toHaveLength(2);
    json(["backup", "--store", store, "--to", join(runtime, "backup.sqlite")]);
    expect(
      json(["inspect", "--store", join(runtime, "backup.sqlite")])
        .schemaVersion,
    ).toBe(5);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
