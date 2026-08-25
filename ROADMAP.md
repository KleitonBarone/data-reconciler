# Roadmap

This roadmap proves safe comparison and dry-run reporting before any repair writes.

## 0. Foundation

- [ ] Define source, target, identity, checkpoint, diff, conflict, and repair terminology
- [ ] Record the runtime, storage, and repository-shape decisions
- [ ] Add formatting, static checks, focused tests, and CI
- [ ] Create deterministic synthetic commerce datasets

## 1. Compare without changing data

- [ ] Define a versioned adapter contract
- [ ] Implement two local adapters
- [ ] Read records incrementally through checkpoints
- [ ] Normalize identities and comparable fields
- [ ] Classify missing, changed, equal, and conflicting records
- [ ] Produce machine-readable and human-readable dry-run reports

## 2. Controlled repair

- [ ] Build explicit repair plans from accepted differences
- [ ] Apply idempotent repairs to disposable target data
- [ ] Record every decision and result in an audit log
- [ ] Resume safely after partial failure
- [ ] Replay a bounded range without duplicating changes

## 3. Operational proof

- [ ] Add adapter and reconciliation telemetry
- [ ] Add schema and adapter versioning
- [ ] Simulate late data, duplicates, rate limits, and target outages
- [ ] Publish repeatable reconciliation scenarios
- [ ] Document recovery from a corrupted or stale checkpoint

## Later, if justified

- [ ] Scheduled reconciliation runs
- [ ] A real external adapter using a test account
- [ ] Review and approval workflow
- [ ] Field-level ownership policies

## Explicitly out of scope for the first release

- Live production data
- A general ETL or data warehouse platform
- Automatic conflict resolution without a declared rule
- Bidirectional repair in the same run
