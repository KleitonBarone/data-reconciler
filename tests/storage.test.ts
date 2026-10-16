import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { SqliteReconciliationStore } from "../src/storage/sqlite-store.js";

const directories: string[] = [];
function temporary() {
  const path = mkdtempSync(join(tmpdir(), "reconciler-storage-"));
  directories.push(path);
  return path;
}
afterEach(() => {
  for (const path of directories.splice(0))
    rmSync(path, { recursive: true, force: true });
});

it("migrates original state without rewriting historical report bytes", () => {
  const path = join(temporary(), "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE checkpoints (adapter_id TEXT PRIMARY KEY, contract_version INTEGER, adapter_version TEXT, schema_version TEXT, cursor TEXT, updated_at TEXT);
    CREATE TABLE observations (adapter_id TEXT, side TEXT, record_id TEXT, identity_key TEXT, snapshot_json TEXT, PRIMARY KEY(adapter_id,record_id));
    CREATE TABLE reports (run_id TEXT PRIMARY KEY, generated_at TEXT, mode TEXT, report_json TEXT);
    INSERT INTO checkpoints VALUES ('old', 1, 'old.v1', 'schema.v1', '12', '2026-01-01T00:00:00Z');
    INSERT INTO reports VALUES ('old', '2026-01-01T00:00:00Z', 'dry-run', '{ "historical": true }');
  `);
  db.close();
  const store = new SqliteReconciliationStore(path);
  try {
    expect(store.getCheckpoint("old")?.cursor).toBe("12");
    expect(store.inspect().schemaVersion).toBe(5);
    expect(() => store.getReport("old")).toThrow("Unsupported report version");
  } finally {
    store.close();
  }
  const reader = new DatabaseSync(path, { readOnly: true });
  expect(
    reader.prepare("SELECT report_json FROM reports").get()?.report_json,
  ).toBe('{ "historical": true }');
  reader.close();
});

it("rejects unknown versions without migration and validates corrupted checkpoints", () => {
  const path = join(temporary(), "state.sqlite");
  let store = new SqliteReconciliationStore(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA user_version=999");
  expect(() => new SqliteReconciliationStore(path)).toThrow(
    "Unsupported SQLite schema",
  );
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(999);
  db.exec(`PRAGMA user_version=1;
    INSERT INTO checkpoints VALUES ('bad',1,'1','1','2','now','{"contractVersion":1,"adapterVersion":"1","schemaVersion":"1","cursor":"3"}');`);
  db.close();
  store = new SqliteReconciliationStore(path);
  try {
    expect(() => store.getCheckpoint("bad")).toThrow(
      "Stored checkpoint failed validation",
    );
  } finally {
    store.close();
  }
});

it("creates a consistent restorable backup and never replaces an existing file", () => {
  const directory = temporary();
  const store = new SqliteReconciliationStore(join(directory, "state.sqlite"));
  const backup = join(directory, "backup.sqlite");
  try {
    store.forJob("orders", "fingerprint");
    store.backup(backup);
    expect(() => store.backup(backup)).toThrow();
    const restored = new SqliteReconciliationStore(backup);
    try {
      expect(restored.inspect().jobs).toEqual(store.inspect().jobs);
    } finally {
      restored.close();
    }
  } finally {
    store.close();
  }
});
