# Data Reconciler

Data Reconciler will compare records across two systems, explain their differences, and apply controlled repairs without hiding conflicts.

It is intended for integrations where retries and upserts are not enough. The project will track checkpoints, detect drift, distinguish safe changes from conflicts, and keep an audit trail of every proposed and applied repair.

> Status: planning. There is no working release yet. See the [roadmap](ROADMAP.md) for the intended build order.

## What problem does it solve?

Two systems that should agree eventually drift. Records arrive late, identifiers differ, schemas change, and partial failures leave each side with a different version of the truth. A useful reconciliation tool must expose those differences before changing data.

The first release will provide:

- Pluggable source and target adapters
- Incremental checkpoints
- Normalization and identity matching
- Dry-run diff reports
- Explicit conflict classification
- Idempotent repair and replay
- An audit history for every decision

## Design position

Dry run is the default. Repairs must be reviewable, bounded, and safe to repeat. The engine will not guess when ownership is ambiguous.

The first release will use synthetic commerce data and two local adapters. Connecting to live systems or becoming a general ETL platform is out of scope.

## License

[MIT](LICENSE)
