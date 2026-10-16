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

Append-only inputs can resume normally. Replacement, truncation, normalization
changes, and adapter schema changes require an explicit new generation:

```sh
pnpm dev compare --config examples/inventory.json --generation rescan-2
```

This keeps the prior observations, reports, and evidence. It does not execute
repairs. Schema upgrades run transactionally. Unknown future versions and
malformed stored records fail rather than being silently reinterpreted.
