# Processing limits and benchmark

Run `pnpm benchmark` for 100,000 records per side. The generator uses seed 42,
1,000-record pages, separate adapter datasets, and a disposable SQLite database.
`RECONCILER_BENCH_RECORDS` can select smaller runs up to 400,000 per side.

Measured on this Windows development machine with Node.js 24.20.0:

| Records per side | Elapsed | Delivered records/second | Peak RSS   | Database          |
| ---------------- | ------- | ------------------------ | ---------- | ----------------- |
| 100,000          | 14.93 s | 13,397                   | 268.16 MiB | 323,084,288 bytes |

The benchmark fails above 180 seconds or 512 MiB peak RSS. CI's named
performance runner is `ubuntu-latest`, Node.js 24. These are acceptance budgets,
not promised throughput for arbitrary providers. Keep the JSON measurement
artifact when running the performance workflow. A complete result includes all
100,000 equal classifications, not just reading the inputs.

The first measurement exposed SQLite choosing the record-ID index for identity
lookups. It had classified only 1,500 identities after several minutes. A
composite identity/record-ID index removed that scan. The published measurement
includes that correction.

Comparison stores current records, immutable deliveries, and immutable report
evidence separately. Disk usage grows accordingly. Ordinary runs allow at most
one million delivered records, 10,000 pages, 1,000 owners per identity, and
1,000 conflicting revisions per record. JSON nesting is limited to 64 levels.
Local input files are limited to 32 MiB, HTTP pages to 8 MiB. Terminal output
shows at most 100 differences; JSON and NDJSON exports stream complete results.
These limits reject excess work rather than silently dropping evidence.

Regular checks exercise 16 seeded delivery/page permutations. The separate
performance workflow runs 256 seeds and saves its JSON test report alongside the
benchmark measurement, including on failure. Reproduce a failing seed from its
test title, or set `RECONCILER_TEST_SEEDS` up to 1,000 and run
`pnpm exec vitest run tests/revisions.test.ts`. Fault scenarios for HTTP rate
limits, outages, cancellation, lost acknowledgements, replay, and backup restore
run in `pnpm check`; none use external services.
