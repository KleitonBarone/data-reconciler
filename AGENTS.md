# AGENTS.md

## Project orientation

Data Reconciler finds and repairs drift between two systems. Its main responsibilities are identity, normalization, checkpoints, conflict handling, replay, and auditability.

Read `README.md` and `ROADMAP.md` before changing scope. This repository is in planning, so never describe a planned capability as implemented.

## Product rules

- Dry run is the default. Applying repairs requires an explicit action.
- Never silently choose a winner when ownership or ordering is ambiguous.
- Keep source records, normalized records, differences, decisions, and applied repairs distinct.
- Checkpoints advance only after the corresponding work is durably recorded.
- Repairs must be idempotent or carry a deduplication key.
- Preserve enough source evidence to explain every proposed change.
- Schema changes and adapter version changes must not reinterpret old audit records.

## Adapter boundary

Adapters read and write external formats. The core engine owns normalization, matching, comparison, decisions, and repair plans. Do not embed provider-specific fields or pagination behavior in the core model.

The first adapters use synthetic local data. Do not connect a demo or test to a live account. The initial runtime and storage have not been selected; record those decisions before scaffolding.

## Verification

There are no build or test commands yet. Add real commands here when the toolchain exists. Do not add placeholder scripts that always pass.

Test checkpoint crashes, duplicate pages, late records, missing identifiers, conflicting updates, schema evolution, partial repair failure, replay, and dry-run immutability. Prefer generated fixtures that exercise ordering and duplication.

Any test that applies repairs must target disposable data and prove that a second identical run makes no further changes.

## Documentation boundaries

Keep human setup, adapter contracts, diff examples, and safety guarantees in `README.md`. Keep agent operating rules here. Update `ROADMAP.md` when milestone scope changes.
