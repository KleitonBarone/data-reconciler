import { deepStrictEqual, ok } from "node:assert/strict";
import type {
  AdapterDescriptor,
  AdapterRecord,
  ReadAdapter,
  ReadPageRequest,
  AdapterCheckpoint,
  ReadPageResult,
} from "./adapter.js";
import { normalizeRecord } from "../core/normalize.js";
import { checkCancelled } from "../core/job.js";

export type AdapterPage<T> = {
  readonly records: readonly T[];
  readonly nextCheckpoint: AdapterCheckpoint;
  readonly hasMore: boolean;
};

/** Infer provider records from readPage; keep projection and pagination in the adapter. */
export function defineAdapter<T>(options: {
  readonly descriptor: AdapterDescriptor;
  readonly readPage: (request: ReadPageRequest) => Promise<AdapterPage<T>>;
  readonly project: (record: T) => AdapterRecord;
}): ReadAdapter {
  return {
    descriptor: options.descriptor,
    async readPage(request) {
      checkCancelled(request.signal);
      const page = await options.readPage(request);
      checkCancelled(request.signal);
      if (page.records.length > request.limit)
        throw new Error("Adapter exceeded its requested page limit");
      return { ...page, records: page.records.map(options.project) };
    },
  };
}

/** Standalone conformance check, callable from any test runner without a Vitest dependency. */
export async function verifyReadAdapter(
  factory: () => ReadAdapter,
  limit = 2,
): Promise<{ pages: number; records: number }> {
  const adapter = factory();
  const first = await adapter.readPage({ checkpoint: null, limit });
  deepStrictEqual(
    first,
    await factory().readPage({ checkpoint: null, limit }),
    "Initial reads must be repeatable",
  );
  let checkpoint: AdapterCheckpoint | null = null;
  let records = 0;
  const seen = new Set<string>();
  for (let pages = 1; pages <= 10000; pages++) {
    const page: ReadPageResult =
      pages === 1 ? first : await adapter.readPage({ checkpoint, limit });
    ok(page.records.length <= limit, "Adapter exceeded page size");
    for (const record of page.records)
      normalizeRecord("source", adapter.descriptor, record);
    records += page.records.length;
    if (!page.hasMore) return { pages, records };
    const cursor = JSON.stringify(page.nextCheckpoint);
    ok(!seen.has(cursor), "Adapter cursor loop");
    seen.add(cursor);
    checkpoint = page.nextCheckpoint;
    deepStrictEqual(
      await factory().readPage({ checkpoint, limit }),
      await adapter.readPage({ checkpoint, limit }),
      "Resume must match a continuous read",
    );
  }
  throw new Error("Adapter exceeded the conformance page limit");
}
