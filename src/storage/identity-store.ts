import type { DatabaseSync } from "node:sqlite";
import type { RecordSnapshot } from "../core/model.js";
import { observationIdentities } from "../core/revisions.js";
import { decode, snapshotValue } from "../core/decoders.js";
import { stringValue } from "../core/validation.js";

/** Called inside the observation/checkpoint transaction. Empty keys index missing identities. */
export function identityIndexer(db: DatabaseSync) {
  const remove = db.prepare(
    "DELETE FROM observation_identities WHERE adapter_id=? AND record_id=?",
  );
  const insert = db.prepare(
    "INSERT INTO observation_identities VALUES (?,?,?)",
  );
  return (adapterId: string, snapshot: RecordSnapshot): void => {
    remove.run(adapterId, snapshot.recordId);
    for (const identity of observationIdentities(snapshot))
      insert.run(adapterId, identity ?? "", snapshot.recordId);
  };
}

/** Rebuild only derived claims; stored observations and historical artifacts stay byte-identical. */
export function migrateIdentities(db: DatabaseSync, version: number): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS observation_identities (adapter_id TEXT NOT NULL,identity_key TEXT NOT NULL,record_id TEXT NOT NULL,PRIMARY KEY(adapter_id,identity_key,record_id),FOREIGN KEY(adapter_id,record_id) REFERENCES observations(adapter_id,record_id) ON DELETE CASCADE) STRICT; CREATE INDEX IF NOT EXISTS observation_identities_record ON observation_identities(adapter_id,record_id);",
  );
  if (version >= 5) return;
  const index = identityIndexer(db);
  for (const row of db
    .prepare("SELECT adapter_id,snapshot_json FROM observations")
    .iterate())
    index(
      stringValue(row.adapter_id),
      decode(stringValue(row.snapshot_json), snapshotValue),
    );
}
