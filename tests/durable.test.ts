import { describe, expect, it } from "vitest";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";
import { compare, defineJob } from "../src/core/job.js";
import {
  createCheckpoint,
  type ReadAdapter,
} from "../src/contracts/adapter.js";

function barrier() {
  let signal: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    signal = resolve;
  });
  return {
    promise,
    signal: () => {
      if (signal === undefined) throw new Error("Barrier not ready");
      signal();
    },
  };
}
describe("durable comparison", () => {
  it("rejects a competing writer while the first job is reading", async () => {
    const started = barrier();
    const release = barrier();
    const descriptor = {
      id: "source",
      displayName: "source",
      datasetId: "memory:source",
      contractVersion: 1,
      adapterVersion: "1",
      schemaVersion: "1",
    } as const;
    const source: ReadAdapter = {
      descriptor,
      async readPage() {
        started.signal();
        await release.promise;
        return {
          records: [],
          hasMore: false,
          nextCheckpoint: createCheckpoint(descriptor, "0"),
        };
      },
    };
    const target: ReadAdapter = {
      descriptor: { ...descriptor, id: "target", datasetId: "memory:target" },
      readPage: () =>
        Promise.resolve({
          records: [],
          hasMore: false,
          nextCheckpoint: createCheckpoint(descriptor, "0"),
        }),
    };
    const job = defineJob({ id: "exclusive", source, target });
    const store = new SqliteReconciliationStore(":memory:");
    const running = compare(job, { store });
    await started.promise;
    try {
      await expect(compare(job, { store })).rejects.toMatchObject({
        code: "busy",
      });
      release.signal();
      expect((await running).summary.total).toBe(0);
    } finally {
      release.signal();
      await running;
      store.close();
    }
  });
});
