import {
  compare,
  defineAdapter,
  createCheckpoint,
  SqliteReconciliationStore,
} from "../index.js";

// The provider owns pagination and projection. The engine sees no inventory API fields.
function inventory(id: string, available: number) {
  const descriptor = {
    id,
    displayName: id,
    datasetId: `worker:${id}`,
    contractVersion: 1,
    adapterVersion: "1",
    schemaVersion: "inventory.v1",
  } as const;
  return defineAdapter({
    descriptor,
    readPage: (request) =>
      Promise.resolve({
        records:
          request.checkpoint === null ? [{ sku: "shirt", available }] : [],
        nextCheckpoint: createCheckpoint(descriptor, "1"),
        hasMore: false,
      }),
    project: (raw) => ({
      recordId: raw.sku,
      identity: { kind: "sku", value: raw.sku },
      updatedAt: "2026-01-01T00:00:00Z",
      comparable: { stock: raw.available },
      evidence: { format: "inventory.v1", locator: raw.sku, payload: raw },
    }),
  });
}
const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await compare(
    {
      id: "embedded-worker",
      source: inventory("warehouse", 12),
      target: inventory("shop", 12),
    },
    { store },
  );
  console.log(JSON.stringify(report.summary));
} finally {
  store.close();
}
