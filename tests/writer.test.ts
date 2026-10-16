import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SqliteRecordAdapter,
  initializeSqliteTarget,
  verifyReadAdapter,
  verifyRepairWriter,
  ReconciliationError,
  type ReadAdapter,
} from "../src/index.js";

it.each(["overwrite", "reject-after-write"] as const)(
  "rejects a writer that handles occupied creates by %s",
  async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "reconciler-unsafe-create-"));
    const path = join(directory, "target.sqlite");
    initializeSqliteTarget(path);
    const target = new SqliteRecordAdapter(path);
    let occupiedCreates = 0;
    const broken: ReadAdapter = {
      descriptor: target.descriptor,
      readPage: target.readPage.bind(target),
      writer: {
        ...target.writer,
        async apply(write, signal) {
          if (
            write.kind === "create" &&
            (await target.writer.lookup(write.deduplicationKey, signal)) ===
              null
          ) {
            const current = await target.writer.getCurrent(
              write.recordId,
              signal,
            );
            if (current?.revision !== undefined) {
              occupiedCreates++;
              const receipt = await target.writer.apply(
                {
                  ...write,
                  kind: "update",
                  expectedRevision: current.revision,
                },
                signal,
              );
              if (mode === "reject-after-write")
                throw new ReconciliationError(
                  "stale_plan",
                  "Rejected after mutating the disposable target",
                );
              return receipt;
            }
          }
          return target.writer.apply(write, signal);
        },
      },
    };
    try {
      await expect(verifyRepairWriter(broken)).rejects.toThrow();
      expect(occupiedCreates).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("proves atomic preconditions, deduplication and verification against a disposable writer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "reconciler-writer-"));
  const path = join(directory, "target.sqlite");
  try {
    const adapter = new SqliteRecordAdapter(path);
    expect(existsSync(path)).toBe(false);
    initializeSqliteTarget(path);
    expect(() => initializeSqliteTarget(path)).toThrow();
    await verifyRepairWriter(adapter);
    const bytes = readFileSync(path);
    expect(
      (await verifyReadAdapter(() => new SqliteRecordAdapter(path), 1)).records,
    ).toBe(2);
    expect(readFileSync(path)).toEqual(bytes);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
