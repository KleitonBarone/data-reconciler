# Adapter authors

Implement `ReadAdapter`, or use `defineAdapter` to infer provider record types
from `readPage` and project them into canonical envelopes. The runnable
`src/examples/worker.ts` demonstrates the helper. It has no provider-specific
fields in the engine. See [the consumer example](../examples/consumer.ts) for
embedding a job.

## Read contract 1

Descriptors declare stable ID, display name, dataset identity, contract version,
implementation version, external schema version, and read mode. A checkpoint
pins versions and an opaque cursor. Keep ingestion order separate from
`updatedAt`, which orders business revisions. A late older record still has a
new ingestion position.

`readPage` takes a checkpoint, a positive page limit, and an optional abort
signal. Return canonical records, the next checkpoint, and `hasMore`. Deliver at
most the requested number of records. Advancing pages must progress and must not
loop. An ended incremental read may keep its cursor. Empty intermediate pages
are allowed only with advancing cursors.

A record declares local ID, timestamp, identity candidate or null, comparable
JSON fields, original evidence, optional tombstone, and optional opaque
`revision`. An atomic writer must check that revision, not guess ordering from
the token. Evidence includes format, locator, and the complete original payload.
Do not put access tokens or credentials in evidence or descriptors.

Reads must have no write side effects. Honor cancellation. The engine bounds
waiting for non-cooperative adapters, but cannot undo provider calls already
sent. Translate classified transient failures to `RetryableAdapterError` with an
optional retry delay. Do not wrap invalid records, schema mismatches, or
permission errors as transient failures.

Implement a stable read scope. Incremental feeds must retain updates and
explicit tombstones until consumed. Snapshot adapters need a pinned, repeatable
dataset generation. Disappearance from an unfinished snapshot is not deletion.
Create a new job generation to rebuild state for a replacement snapshot.

Run `verifyReadAdapter(() => new Adapter(...))` in your test runner. It checks
repeatability, page bounds, resume, cursor loops, and record normalization
without importing a test framework. The two independent commerce readers and the
loopback HTTP reader run through this same contract.

Local file readers verify absolute dataset paths and consumed-prefix hashes.
Replacement, reordering, or truncation requires a rescan. JSONL ledger sequence
numbers must be unique, increasing positive integers. Construct fresh file
adapters, or call `loadJob` again, for a new run after inputs may have changed.
Each file-adapter instance freezes its input for a consistent read. HTTP and
SQLite adapters obtain new pages on each call.

## Optional writer contract 1

An adapter may separately provide `writer` with explicit create/update, atomic
precondition, durable deduplication, and verification capabilities. Read-only
adapters remain valid. No write capability is inferred from an upsert API.

A `RepairWrite` contains an authorization digest, stable deduplication key,
record and identity, expected revision/checkpoint, approved comparable values,
approved field names, and a deterministic business timestamp. Apply only those
fields. Preserve raw values outside them. Do not remove ignored nested values.

`apply` atomically checks the precondition and records the effect plus its
deduplication receipt. The same key and request must return prior success
without further effects. Changed contents under an existing key must fail.
`lookup` retrieves a durable receipt; `getCurrent` supports read-back. An
external create must prove absence without racing another owner. A reader plus
an unconditional upsert cannot provide that guarantee.

A rejected precondition throws `ReconciliationError("stale_plan", ...)` only
when the adapter can prove no effect happened. Do not translate a lost
acknowledgement to a definite rejection. Unknown outcomes remain unknown until
deduplication or read-back establishes the result. Retain receipts for the full
supported resume/replay horizon. Do not claim exactly-once transport.

`verifyRepairWriter(adapter)` performs destructive conformance checks on an
empty disposable target. It checks conditional create/update, read-back,
deduplication, changed-key rejection, and stale-revision rejection. Run separate
lost-acknowledgement and process-crash tests around your provider's boundary.

The conditional-create check uses a fresh deduplication key and a completed
current checkpoint against the record created by the check. It requires
`stale_plan`, the existing record to remain unchanged, and no success receipt
for the rejected key. Repeating a successful create with its original key is
checked separately. Provider-specific race tests are still required to prove
that absence checks and writes are atomic.

The bundled `SqliteRecordAdapter` is the reference local writer. Initialize it
explicitly with `initializeSqliteTarget`; constructors and reads never create or
mutate its database. Custom external writers need their own authorized sandbox
verification before application use.
