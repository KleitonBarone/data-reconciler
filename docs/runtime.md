# Runtime and reports

`pnpm example:worker` runs an embedded job with a typed custom inventory
adapter. `pnpm example:http` starts its own loopback server, handles a rate
limit, compares records, and closes the server. Neither command needs accounts
or credentials. `examples/inventory.json` demonstrates declarative JSON and
JSONL projections.

Jobs can set `runtime` with `timeoutMs`, `maxAttempts`, `backoffMs`, `maxPages`,
and `maxRecords`. Defaults are 30 seconds per attempt, three attempts, 100 ms
exponential backoff, 10,000 pages, and one million delivered records per run.
Only `RetryableAdapterError` triggers retries. Adapters translate provider rate
limits into that error with a retry hint. Other errors stop immediately. The
engine caps individual waits at 60 seconds and attempts at ten. Aborting a run
stops waiting even if an adapter ignores cancellation. Read adapters must not
perform writes, including after a timeout.

The reference HTTP adapter reads canonical adapter records from
`{records, cursor, hasMore}`. It limits each response to 8 MiB. Credentials must
not appear in dataset identifiers, evidence, or URLs. Authentication belongs in
an application's custom adapter, outside the report model.

`compare --format json` streams a version 1 JSON report. `--format ndjson`
streams a `run` row, `result` rows, and a final `complete` row. Consumers must
require the final row before treating an NDJSON export as complete. Terminal
output lists at most 100 differences. `export --run ID` reads a completed report
without contacting either adapter. Redirect stdout to save an export.

CLI exit codes are 0 for success, 1 for operational failure, 2 for drift with
`--check`, 3 for conflicts with `--check`, 4 for invalid configuration, and 130
for cancellation. JSON is on stdout; diagnostics belong on stderr. Lifecycle
hooks receive identifiers, counters, and event types, never raw records.
Observer exceptions cannot invalidate committed work.
