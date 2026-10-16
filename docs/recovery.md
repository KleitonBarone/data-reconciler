# Local state recovery

State contains original records. Restrict access to its directory and treat
backups and exported reports as sensitive data.

```sh
pnpm dev inspect --store .data/reconciler.sqlite
pnpm dev backup --store .data/reconciler.sqlite --to .data/backup.sqlite
pnpm dev export --store .data/reconciler.sqlite --run RUN_ID --format ndjson
```

Backup uses SQLite's consistent snapshot operation and refuses to overwrite any
existing destination. To restore, stop the worker and point `--store` at the
backup. Keep the original file for investigation. Do not copy an open database
without its journal files.

Completed pages and their checkpoints commit together. A terminated local
process leaves a claim that the next process can reclaim after verifying that
the owner PID no longer exists. A live owner is never evicted. Stores are for
processes on one machine, not shared network filesystems or distributed workers.

Run IDs must be unique across the store, including different jobs. An injected
ID collision returns `invalid_config` before adapter reads and leaves completed
reports and unfinished runs unchanged. Retry with a fresh run ID. A late failure
cannot change a completed report into a failed run.

Append-only inputs can resume normally. Replacement, truncation, normalization
changes, and adapter schema changes require an explicit new generation:

```sh
pnpm dev compare --config examples/inventory.json --generation rescan-2
```

This keeps the prior observations, reports, and evidence. It does not execute
repairs. Schema upgrades run transactionally. Unknown future versions and
malformed stored records fail rather than being silently reinterpreted.

State schema version 5 migrates prototype databases and versions 1 through 4
inside one transaction. Historical JSON bytes are not rewritten. The provisional
job fingerprint gained explicit ownership during implementation. If an older
prototype scope cannot resume, retain its store and create a new generation.
This is a rescan, not repair re-execution. Unknown future versions are refused.

Version 5 backfills identity claims from current observations, including every
ambiguous revision, without advancing checkpoints. Keep a backup before
upgrading. Old reports and plans remain available. An old plan whose operations
touch an identity implicated in its report's conflicts cannot dispatch writes.
Compare again and review a new plan. If that operation already has recorded
intent, recovery can resolve a stored target receipt but cannot resend the
unsafe operation. Retain its audit history and deduplication receipts.

To recover after a target write with an unrecorded acknowledgement, restore the
latest state backup, keep the target's deduplication database intact, and apply
the same accepted digest. Target receipts establish prior success. Tests prove
this does not repeat target effects or change the old comparison's meaning.
Never delete target deduplication receipts to make a stale plan run again.

A receipt-lookup outage cannot turn an earlier unknown write into a failed
write. Recovery retains uncertainty for unknown outcomes and crash-left intents
until a valid receipt resolves them. Cancellation or rejection of a later retry
does not disprove an earlier effect. Restore lookup access and resume the same
accepted plan; do not clear intent or outcome rows to force a retry.

Expired or replaced cursors require a rescan into a new generation. Malformed
SQLite rows fail runtime validation. Preserve corrupt files before restoring a
backup; do not edit checkpoints or audit JSON manually. A stale PID claim is
reclaimed automatically only when that local process no longer exists.
