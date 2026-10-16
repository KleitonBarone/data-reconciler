# Review repair plans

Comparison is always a dry run. A classification is not permission to write.
Jobs must declare `repair` before planning:

```json
{
  "version": "ownership.v1",
  "direction": "source-to-target",
  "sourceFields": ["stock"],
  "targetFields": ["price"],
  "maxOperations": 1000
}
```

Ownership names entire top-level comparable fields. Nested values belong to
their top-level field. A source-owned field can be replaced or removed. A
target-owned field stays unchanged. Unknown ownership skips the whole record.
Missing identities, duplicate owners, tombstones, and ambiguous revisions remain
conflicts. No automatic deletion or bidirectional writes are supported. An
update requires an opaque target revision for a future atomic precondition.

```sh
pnpm dev compare --config job.json --format json
pnpm dev plan --config job.json --run RUN_ID --format json
pnpm dev show-plan --digest DIGEST
pnpm dev accept --config job.json --digest DIGEST --all --fields stock --max-operations 10 --max-records 10
```

Replace `--all` with `--operations ID1,ID2` to select a subset. Acceptance binds
the exact content digest, selected IDs, allowed fields, and record/operation
bounds. A plan expires 24 hours after its comparison by default. Library callers
can request up to seven days when creating a plan. Expired plans require a new
comparison and review. Acceptances are immutable. Review a new plan to change
the selection.

Plans preserve before/after values, source evidence, target revisions and
checkpoints, and job, dataset, schema, adapter, normalization, and policy
versions. Planning and accepting do not call an adapter writer. Read-only
adapters remain valid for comparison. The accepted plan is separate from any
execution record.

The optional writer contract separately declares create, update, atomic
preconditions, durable deduplication, and result verification. The bundled
`SqliteRecordAdapter` targets an explicitly initialized local database. Use
`initializeSqliteTarget(path, records)` once; it refuses existing files.
Constructing or reading this adapter never creates or changes the target.
Declarative config uses
`{ "id": "target", "type": "sqlite-records", "path": "target.sqlite" }`.

`verifyRepairWriter(adapter)` is a reusable destructive conformance check for an
empty disposable target. Never point it at application data. It checks
create/update, stale revisions, changed deduplication requests, read-back, and
repeat application without further effects.
