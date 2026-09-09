# Roadmap

The project proves comparison and dry-run reporting before it adds any repair
writes.

## 0. Foundation

- [x] Define source, target, identity, checkpoint, diff, conflict, and repair
      terminology
- [x] Record the runtime, storage, and repository-shape decisions
- [x] Add formatting, static checks, focused tests, and CI
- [x] Create deterministic synthetic commerce datasets

## 1. Compare without changing data

- [x] Define a versioned, read-only adapter contract
- [x] Implement separate paged JSON and JSONL ledger adapters
- [x] Read records incrementally through durable checkpoints
- [x] Normalize identities and comparable fields
- [x] Classify missing, changed, equal, and conflicting records
- [x] Produce machine-readable and human-readable dry-run reports
- [x] Preserve source evidence for every reported difference
- [x] Reject incompatible adapter and schema checkpoints

Milestones 0 and 1 are complete. The CLI and core library are working. Dry run
is the only supported mode.

## 2. Controlled repair

- [ ] Define field ownership and acceptance rules
- [ ] Build explicit repair plans from accepted differences
- [ ] Apply idempotent repairs to disposable target data
- [ ] Record every decision and result in an audit log
- [ ] Resume safely after partial failure
- [ ] Replay a bounded range without duplicating changes

## 3. Operational proof

- [ ] Add adapter and reconciliation telemetry
- [ ] Prove adapter and schema upgrade procedures
- [ ] Simulate rate limits and target outages
- [ ] Publish repeatable reconciliation scenarios
- [ ] Document recovery from a corrupted or stale checkpoint

Late arrivals and duplicate delivery already have focused tests. Operational
fault simulation remains here.

## Later, if justified

- [ ] Scheduled reconciliation runs
- [ ] A real external adapter using a test account
- [ ] Review and approval workflow
- [ ] Bidirectional repair

## Explicitly out of scope

- Live production data
- A general ETL or data warehouse platform
- Automatic conflict resolution without a declared rule
- Repair writes in the current release
