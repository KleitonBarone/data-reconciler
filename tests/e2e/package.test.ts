import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

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
    `${result.stdout}\n${result.stderr}\n${String(result.error ?? "")}`,
  ).toBe(0);
  return result;
}

it("packs and installs into an independent TypeScript consumer", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-consumer-"));
  const consumer = join(directory, "consumer");
  await mkdir(consumer);
  try {
    pnpm(["pack", "--pack-destination", directory], resolve("."));
    const tarball = (await readdir(directory)).find((file) =>
      file.endsWith(".tgz"),
    );
    if (!tarball) throw new Error("No packed artifact");
    await writeFile(
      join(consumer, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        dependencies: { "data-reconciler": `file:../${tarball}` },
        devDependencies: { typescript: "6.0.3", "@types/node": "24.13.3" },
      }),
    );
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
        include: ["consumer.ts"],
      }),
    );
    await writeFile(
      join(consumer, "consumer.ts"),
      `import { compare, defineAdapter, createCheckpoint, SqliteReconciliationStore } from "data-reconciler";
      const descriptor = {id:"source",displayName:"source",datasetId:"consumer:source",contractVersion:1,adapterVersion:"1",schemaVersion:"1"} as const;
      const source = defineAdapter({descriptor, readPage: () => Promise.resolve({records:[{sku:"a",stock:12}],hasMore:false,nextCheckpoint:createCheckpoint(descriptor,"1")}),project:(raw) => ({recordId:raw.sku,identity:{kind:"sku",value:raw.sku},updatedAt:"2026-01-01T00:00:00Z",comparable:{stock:raw.stock},evidence:{format:"consumer",locator:raw.sku,payload:raw}})});
      const target = {...source,descriptor:{...descriptor,id:"target",datasetId:"consumer:target"}};
      const store = new SqliteReconciliationStore(":memory:");
      try { const run = await compare({id:"consumer",source,target},{store}); if(run.summary.equal!==1) throw new Error("Consumer comparison failed"); } finally {store.close();}
    `,
    );
    pnpm(["install", "--ignore-scripts", "--offline"], consumer);
    pnpm(["exec", "tsc", "-p", "tsconfig.json"], consumer);
    const result = spawnSync(
      process.execPath,
      [join(consumer, "out/consumer.js")],
      { cwd: consumer, encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const help = pnpm(["exec", "data-reconciler", "--help"], consumer);
    expect(help.stdout).toContain("Usage:");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
