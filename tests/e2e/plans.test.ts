import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { planValue } from "../../src/core/plans.js";
import { objectValue, stringValue } from "../../src/core/validation.js";

it("reviews and accepts an exact digest through the compiled CLI without target writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "reconciler-review-"));
  const source = join(directory, "source.json");
  const target = join(directory, "target.json");
  const config = join(directory, "job.json");
  const store = join(directory, "state.sqlite");
  const cli = resolve("dist/cli.js");
  const input = JSON.stringify([
    { id: "shirt", stock: 12, time: "2026-01-02T00:00:00Z" },
  ]);
  const endpoint = (id: string, path: string) => ({
    id,
    path,
    type: "json",
    schemaVersion: "1",
    projection: {
      id: "/id",
      updatedAt: "/time",
      identity: { kind: "sku", paths: ["/id"] },
      fields: { stock: "/stock" },
    },
  });
  const run = (...args: string[]) => {
    const result = spawnSync(
      process.execPath,
      [cli, ...args, "--store", store, "--format", "json"],
      { cwd: directory, encoding: "utf8", timeout: 30000 },
    );
    expect(result.status, result.stderr).toBe(0);
    return objectValue(JSON.parse(result.stdout) as unknown);
  };
  try {
    await writeFile(source, input);
    await writeFile(target, "[]");
    await writeFile(
      config,
      JSON.stringify({
        id: "review",
        source: endpoint("source", source),
        target: endpoint("target", target),
        repair: {
          version: "1",
          direction: "source-to-target",
          sourceFields: ["stock"],
        },
      }),
    );
    const compared = run("compare", "--config", config);
    const proposed = planValue(
      run("plan", "--config", config, "--run", stringValue(compared.runId)),
    );
    expect(planValue(run("show-plan", "--digest", proposed.digest))).toEqual(
      proposed,
    );
    const acceptanceArgs = [
      "accept",
      "--config",
      config,
      "--digest",
      proposed.digest,
      "--all",
      "--fields",
      "stock",
      "--max-operations",
      "1",
      "--max-records",
      "1",
    ];
    const accepted = run(...acceptanceArgs);
    expect(accepted.digest).toBe(proposed.digest);
    expect(run(...acceptanceArgs)).toEqual(accepted);
    expect(await readFile(source, "utf8")).toBe(input);
    expect(await readFile(target, "utf8")).toBe("[]");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
