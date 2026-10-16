# Replay and retention

Replay a recorded job's inclusive delivery sequence range:

```sh
pnpm dev inspect --store .data/reconciler.sqlite
pnpm dev replay --config job.json --from 1 --to 100 --format ndjson
```

Replay reads saved normalized snapshots and original evidence, not providers. It
requires the recorded job fingerprint, adapter versions, and normalization
version. Keep the original job definition when changing policy. Replay does not
reinterpret historical snapshots with new rules. Each replay creates a separate
audit scope and report. Its `replay` metadata names the original job and range.
Its `replay:` cursors are evidence positions, not provider resume checkpoints.
Normal checkpoints, accepted plans, and old reports remain unchanged.

A range can include at most 100,000 sequence positions. Sequence IDs are global,
so a job's IDs may contain gaps occupied by other jobs. A partial range compares
only its included observations. Missing records in that report do not establish
absence in the live systems. No plan or write is triggered by replay.

To replay repairs, use `apply` with the original accepted digest. This reuses
the original deduplication keys and skips completed effects. Expired
authorization requires a fresh comparison and acceptance, not edited history.

## Retention

Default retention is indefinite. There is no background cleanup. Reports, plans,
acceptances, current-state observations, and repair audit history are never
pruned by the delivery-evidence command:

```sh
pnpm dev backup --store .data/reconciler.sqlite --to .data/before-prune.sqlite
pnpm dev prune --store .data/reconciler.sqlite --job JOB_ID --through 100 --confirm
```

This deletes only the named job's delivery evidence through the explicit
sequence. It refuses an active claim, an out-of-range boundary, or any job with
an accepted plan. Accepted plans pin their remaining delivery evidence
indefinitely, including after expiry. Plans and reports also embed their own
required before/after snapshots. Replay refuses ranges crossing a recorded prune
boundary rather than silently producing a partial history.

Pruning is irreversible without the pre-prune backup. SQLite may retain deleted
bytes in free pages, so pruning is not secure erasure. Protect the directory,
database, WAL files, exports, and backups. New state files use owner-only Unix
permissions. On Windows configure the directory's ACL. Do not put credentials in
record evidence or identifiers. CLI diagnostics use fixed error codes/hints;
provider exception contents remain in protected state, not stderr.
