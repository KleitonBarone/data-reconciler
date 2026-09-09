# AGENTS.md

## Project orientation

Data Reconciler finds and repairs drift between two systems. Its main
responsibilities are identity, normalization, checkpoints, conflict handling,
replay, and auditability.

Read `README.md` and `ROADMAP.md` before changing scope. Milestones 0 and 1 are
implemented. Never describe roadmap work as implemented.

## Product rules

- Dry run is the default. Applying repairs requires an explicit action.
- Never silently choose a winner when ownership or ordering is ambiguous.
- Keep source records, normalized records, differences, decisions, and applied
  repairs distinct.
- Checkpoints advance only after the corresponding work is durably recorded.
- Repairs must be idempotent or carry a deduplication key.
- Preserve enough source evidence to explain every proposed change.
- Schema changes and adapter version changes must not reinterpret old audit
  records.

## Adapter boundary

Adapters read and write external formats. The core engine owns normalization,
matching, comparison, decisions, and repair plans. Do not embed
provider-specific fields or pagination behavior in the core model.

The first adapters use synthetic local data. Do not connect a demo or test to a
live account. The runtime is Node.js 24 with strict TypeScript and pnpm. SQLite
stores checkpoints, observations, and dry-run reports.

## Verification

Run the full local check with `pnpm check`. Its individual commands are
`pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`pnpm build`. Use `pnpm format` to write formatting changes.

Current tests cover checkpoint crashes, duplicate pages, late records, missing
identifiers, conflicting updates, incompatible schema versions, evidence
retention, and dry-run immutability. Add partial repair failure, replay, and
repair idempotency tests when milestone 2 introduces writes. Prefer generated
fixtures that exercise ordering and duplication.

Any test that applies repairs must target disposable data and prove that a
second identical run makes no further changes.

## Documentation boundaries

Keep human setup, adapter contracts, diff examples, and safety guarantees in
`README.md`. Keep agent operating rules here. Update `ROADMAP.md` when milestone
scope changes.
