# AGENTS.md

## Orientation

Data Reconciler finds drift, records evidence, and applies explicitly accepted
create/update plans. The library and CLI share the same job, plan, and execution
APIs. Read `README.md` and `ROADMAP.md` before changing scope. The 1.0 release
candidate implements the local workflow; the roadmap records release gates. Do
not describe a pending gate as verified.

## Safety and data boundaries

- Comparison never dispatches writes. Apply requires an accepted digest,
  selected operations, field ownership, expiry, and bounded authorization.
- Never infer a winner for missing identities, duplicate owners, equal-time
  disagreements, tombstones, or ambiguous revisions.
- Checkpoints commit with page evidence. Partial reads cannot publish a report.
- Intent commits before target I/O. Retry writes only with durable deduplication
  and atomic target preconditions. Preserve unknown outcomes for recovery.
- Preserve historical reports, plans, acceptances, and repair history. Schema or
  policy changes cannot reinterpret them.
- Tests, demos, conformance checks, and benchmarks use disposable synthetic
  data. Never connect them to live accounts. Writer conformance intentionally
  mutates its empty disposable target.
- Do not erase state, target receipts, or claims to bypass a stale plan. Keep a
  backup, then use the documented recovery procedure or a new generation.
- Publishing, deployment, production access, and pushing require user authority.
  Local commits do not authorize any of them.

## Architecture

Node.js 24, strict TypeScript ESM, pnpm 11, one package, zero runtime
dependencies. SQLite stores page evidence, current observations, reports, plans,
and outcomes.

Adapters own provider formats, pagination, revision tokens, and conditional
writes. Core owns normalization, matching, classification, ownership, plans, and
execution. Core imports storage contracts, not SQLite implementations. Keep
source evidence, normalized snapshots, differences, accepted decisions, and
write outcomes separate. Do not move provider fields into the core.

The legacy `reconcileDryRun` API is in-memory. New work uses `compare`, indexed
groups, and streamed results. Preserve ownership-group and plan byte budgets.
Use declared public exports; packed consumer tests must not use source aliases.

## Verify

- `pnpm test:watch` is the short source-test loop.
- `pnpm exec vitest run tests/repairs.test.ts` selects a focused behavior.
- `pnpm test:e2e` builds first, then tests compiled processes and a packed
  consumer.
- `pnpm check` runs formatting, lint, types, source tests, build, and end-to-end
  tests. Run it before an implementation commit.
- `pnpm format` writes formatting. Static commands are `pnpm format:check`,
  `pnpm lint`, and `pnpm typecheck`.
- `pnpm benchmark` measures 100,000 records per side. Run it for storage/query
  or bounded-memory changes. Larger seeded checks are in the performance
  workflow.

Use real SQLite and named synchronization points for process-crash tests. Repair
tests must prove a second identical apply has zero further effects. Test data
ordering, duplicate delivery, and late revisions with reproducible seeds. Use
one focused local Conventional Commit per verified slice.

## Documentation

Keep discovery and the shortest trial in `README.md`. Contracts and limitations
belong under `docs/`; development commands belong in `CONTRIBUTING.md`. Update
the roadmap when acceptance gates change. Keep registry publication separate
from implementation completion and retain `private` until the package name and
release are explicitly confirmed.
