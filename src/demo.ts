import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { initializeSqliteTarget } from "./adapters/sqlite-record-adapter.js";

/** Create a new disposable workspace, never replace an existing directory. */
export async function initializeDemo(directory: string) {
  const path = resolve(directory);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await mkdir(path, { mode: 0o700 });
  const source = [
    {
      id: "warehouse-shirt",
      sku: "shirt",
      stock: 12,
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "warehouse-hat",
      sku: "hat",
      stock: 8,
      updatedAt: "2026-01-02T00:00:00Z",
    },
    {
      id: "warehouse-conflict",
      sku: "conflict",
      stock: 1,
      updatedAt: "2026-01-01T00:00:00Z",
    },
    { id: "warehouse-orphan", stock: 1, updatedAt: "2026-01-01T00:00:00Z" },
  ];
  await writeFile(
    join(path, "source.json"),
    `${JSON.stringify(source, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  initializeSqliteTarget(join(path, "target.sqlite"), [
    {
      recordId: "shop-shirt",
      identity: { kind: "sku", value: "shirt" },
      updatedAt: "2026-01-01T00:00:00Z",
      comparable: { stock: 10 },
      evidence: {
        format: "seed.v1",
        locator: "shop-shirt",
        payload: { stock: 10 },
      },
    },
    {
      recordId: "shop-conflict",
      identity: { kind: "sku", value: "conflict" },
      updatedAt: "2026-01-01T00:00:00Z",
      comparable: { stock: 2 },
      evidence: {
        format: "seed.v1",
        locator: "shop-conflict",
        payload: { stock: 2 },
      },
    },
  ]);
  const config = join(path, "job.json");
  await writeFile(
    config,
    `${JSON.stringify({ id: "inventory-demo", source: { id: "warehouse", type: "json", path: "source.json", schemaVersion: "warehouse.v1", projection: { id: "/id", updatedAt: "/updatedAt", identity: { kind: "sku", paths: ["/sku"] }, fields: { stock: "/stock" } } }, target: { id: "shop", type: "sqlite-records", path: "target.sqlite" }, repair: { version: "ownership.v1", direction: "source-to-target", sourceFields: ["stock"] } }, null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
  return { directory: path, config, store: join(path, "state.sqlite") };
}
