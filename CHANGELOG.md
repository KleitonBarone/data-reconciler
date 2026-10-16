# Changelog

## Unreleased

- Block repairs for every identity claimed by ambiguous current revisions,
  including operations in reports and accepted plans saved before the fix.
- Migrate SQLite state to schema 5 with a derived identity-claims index.
  Preserve checkpoints and historical report, plan, acceptance, and audit JSON.

## 1.0.0-rc.1

The first complete local workflow is ready for release-candidate verification.
The package remains private pending registry-name confirmation and an explicit
publication decision.

- Typed jobs, JSON/module configuration, projections, and custom adapter
  helpers.
- Versioned normalization, identity matching, revision conflicts, and evidence.
- Durable per-page SQLite checkpoints, isolated jobs, streaming JSON/NDJSON,
  migration, concurrent-writer claims, backup, replay, and explicit retention.
- Immutable, bounded create/update plans with digest-bound acceptance and field
  ownership. Explicit application only, with atomic preconditions, durable
  intent/outcomes, deduplication, partial recovery, and verification runs.
- Separate paged-commerce and ledger adapters, generic local files, a reference
  HTTP reader with loopback examples, and a disposable SQLite writer.
- Process-termination tests, external packed-consumer tests, seeded scenarios,
  cross-platform CI, and measured 100,000-record-per-side processing limits.

Compatibility: Node.js 24, ESM, read contract 1, writer contract 1, report/plan
schema 1, SQLite state schema 4. The provisional prototype fingerprint changed;
retain old stores and use an explicit new generation when resume is rejected.
Historical report bytes are not rewritten. `reconcileDryRun` remains a legacy
in-memory convenience; new integrations should use `compare` and streamed
results.

Not included: automatic deletion, bidirectional writes, distributed workers,
hosted scheduling, a web UI, vendor account connectors, or package publication.
