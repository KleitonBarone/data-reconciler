import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JsonPageCommerceAdapter } from "../src/adapters/json-page-adapter.js";
import { JsonlLedgerCommerceAdapter } from "../src/adapters/jsonl-ledger-adapter.js";
import { reconcileDryRun } from "../src/core/reconcile.js";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function temporary() {
  const path = await mkdtemp(join(tmpdir(), "adapter-contract-"));
  directories.push(path);
  return path;
}

describe("local adapter read guarantees", () => {
  it("rejects a rewritten consumed page instead of trusting its offset", async () => {
    const directory = await temporary();
    const path = join(directory, "pages.json");
    const original = await readFile(
      resolve("fixtures/source-pages.json"),
      "utf8",
    );
    await writeFile(path, original);
    const page = await new JsonPageCommerceAdapter(path).readPage({
      checkpoint: null,
      limit: 1,
    });
    await writeFile(path, original.replace("acme-100", "replacement"));
    await expect(
      new JsonPageCommerceAdapter(path).readPage({
        checkpoint: page.nextCheckpoint,
        limit: 1,
      }),
    ).rejects.toThrow(/replaced|reordered/u);
  });
  it("rejects invalid ledger ordering even when the page size is one", async () => {
    const directory = await temporary();
    const path = join(directory, "ledger.jsonl");
    await writeFile(
      path,
      '{"type":"schema","schemaVersion":"northstar-orders.v1"}\n{"sequence":2}\n{"sequence":1}\n',
    );
    await expect(
      new JsonlLedgerCommerceAdapter(path).readPage({
        checkpoint: null,
        limit: 1,
      }),
    ).rejects.toThrow(/increasing order/u);
  });
  it("durably records invalid record evidence without publishing a partial comparison", async () => {
    const directory = await temporary();
    const path = join(directory, "pages.json");
    const original = await readFile(
      resolve("fixtures/source-pages.json"),
      "utf8",
    );
    await writeFile(path, original.replace('"acme-100"', '" "'));
    const storePath = join(directory, "state.sqlite");
    let store = new SqliteReconciliationStore(storePath);
    try {
      await expect(
        reconcileDryRun({
          source: new JsonPageCommerceAdapter(path),
          target: new JsonlLedgerCommerceAdapter(
            resolve("fixtures/target-ledger.jsonl"),
          ),
          store,
        }),
      ).rejects.toThrow(/must not be empty/u);
      expect(store.getCheckpoint("local-acme-json")).toBeNull();
      expect(store.countReports()).toBe(0);
      store.close();
      store = new SqliteReconciliationStore(storePath);
      expect(store.failures()[0]).toMatchObject({ evidence: { id: " " } });
    } finally {
      store.close();
    }
  });
});
