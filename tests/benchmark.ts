import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
  compare,
  defineAdapter,
  createCheckpoint,
  SqliteReconciliationStore,
} from "../src/index.js";

const count = Number(process.env.RECONCILER_BENCH_RECORDS ?? 100000);
if (!Number.isSafeInteger(count) || count < 1 || count > 400000)
  throw new Error("Invalid benchmark size");
function adapter(id: string) {
  const descriptor = {
    id,
    displayName: id,
    datasetId: `seed:42:${id}:${count}`,
    contractVersion: 1,
    adapterVersion: "1",
    schemaVersion: "1",
  } as const;
  return defineAdapter({
    descriptor,
    readPage(request) {
      const start = Number(request.checkpoint?.cursor ?? 0);
      const end = Math.min(count, start + request.limit);
      return Promise.resolve({
        records: Array.from({ length: end - start }, (_, i) => {
          const n = start + i;
          return { n, stock: (n * 1664525 + 1013904223) % 97 };
        }),
        nextCheckpoint: createCheckpoint(descriptor, String(end)),
        hasMore: end < count,
      });
    },
    project(raw) {
      return {
        recordId: String(raw.n),
        updatedAt: "2026-01-01T00:00:00.000Z",
        identity: { kind: "sku", value: String(raw.n) },
        comparable: { stock: raw.stock },
        evidence: { format: "seed.v1", locator: String(raw.n), payload: raw },
      };
    },
  });
}
const directory = mkdtempSync(join(tmpdir(), "reconciler-bench-"));
const path = join(directory, "state.sqlite");
const store = new SqliteReconciliationStore(path);
const started = performance.now();
try {
  const report = await compare(
    {
      id: "benchmark",
      source: adapter("source"),
      target: adapter("target"),
      pageSize: 1000,
    },
    { store },
  );
  const seconds = (performance.now() - started) / 1000;
  const peakMiB = process.resourceUsage().maxRSS / 1024;
  if (report.summary.equal !== count)
    throw new Error("Benchmark results diverged");
  console.log(
    JSON.stringify(
      {
        seed: 42,
        platform: process.platform,
        node: process.version,
        recordsPerSide: count,
        seconds,
        recordsPerSecond: (count * 2) / seconds,
        peakMiB,
        databaseBytes: statSync(path).size,
      },
      null,
      2,
    ),
  );
  if (seconds > 180 || peakMiB > 512)
    throw new Error("Benchmark exceeds release budget: 180s / 512 MiB");
} finally {
  store.close();
  rmSync(directory, { recursive: true, force: true });
}
