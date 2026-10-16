import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

it("does not copy provider errors or fixture secrets into diagnostic logs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-secret-"));
  const config = join(directory, "job.mjs");
  try {
    await writeFile(
      config,
      `const adapter=(id)=>({descriptor:{id,displayName:id,datasetId:id,contractVersion:1,adapterVersion:"1",schemaVersion:"1"},readPage(){throw new Error("fixture-secret-provider-token");}});export default {id:"redaction",source:adapter("source"),target:adapter("target")};`,
    );
    const result = spawnSync(
      process.execPath,
      [
        resolve("dist/cli.js"),
        "compare",
        "--config",
        config,
        "--store",
        join(directory, "state.sqlite"),
        "--progress",
        "--format",
        "json",
      ],
      { cwd: directory, encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("fixture-secret-provider-token");
    expect(result.stderr).toContain("adapter_error");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
