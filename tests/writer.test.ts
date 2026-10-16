import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SqliteRecordAdapter,
  initializeSqliteTarget,
  verifyReadAdapter,
  verifyRepairWriter,
} from "../src/index.js";

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
