# Data Reconciler

Data Reconciler compares records from two systems and reports drift without
changing either system. Milestones 0 and 1 are working. Repair writes do not
exist yet.

The included demo reconciles deterministic synthetic commerce data through two
separate local adapters:

- Acme paged JSON, read with an offset cursor
- Northstar JSONL ledger, read with an append-only sequence cursor

Both adapters implement the same versioned read contract. The core owns
normalization, identity matching, comparison, classification, and reporting.

## Requirements

- Node.js 24 or newer
- pnpm 11

The project uses Node's built-in SQLite module. No external database is needed.

## Run the demo

```sh
pnpm install
pnpm reconcile
```

The default human report is concise:

```text
Dry run <run-id>
Local Acme JSON pages -> Local Northstar JSONL ledger
Read 6 source and 4 target records
Results: 1 equal, 2 missing, 1 changed, 2 conflicting
CHANGED     order:ORDER-101 newer on source: totalMinor
MISSING     order:ORDER-102 on target
CONFLICTING order:ORDER-103: ambiguous_ownership
MISSING     order:ORDER-104 on source
CONFLICTING source/acme-no-identity: missing_identifier
No external records were changed.
```

Request the full machine-readable report with:

```sh
pnpm reconcile --format json
```

The default SQLite store is `.data/reconciler.sqlite`. Run the command again
with the same store and both adapters resume from their durable checkpoints. The
second report reads zero new fixture records but still compares the stored
current observations.

Useful options:

```text
--source <path>      Acme JSON pages
--target <path>      Northstar JSONL ledger
--store <path>       SQLite state and report store
--page-size <count>  Incremental read page size
--format <format>    human or json
--dry-run            accepted for clarity; already enforced
--apply              rejected; repair writes do not exist
```

## Terms

- A source and a target are the two adapter roles in one comparison. Neither
  role implies ownership.
- An identity is a normalized stable key used to match records, such as
  `order:ORDER-101`.
- A checkpoint is an adapter-owned opaque cursor plus contract, adapter, and
  schema versions.
- A source record is the read-only adapter envelope, including raw evidence.
- A normalized record has a normalized identity, comparable values, timestamp,
  adapter metadata, and the original evidence.
- A difference is a field path whose normalized source and target values do not
  match.
- A conflict is a difference for which ordering or identity is ambiguous.
- A repair will be a separate, explicit write plan. Repairs are roadmap work and
  are not represented as completed actions in the current code.

## Classification rules

| Classification | Meaning                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `equal`        | One record exists on each side and all comparable fields match.                                                             |
| `missing`      | A normalized identity exists on only one side. The report names the missing side.                                           |
| `changed`      | Comparable fields differ and the timestamps establish which observation is newer. This is information, not repair approval. |
| `conflicting`  | An identifier is missing, multiple local records claim one identity, or differing values have equal timestamps.             |

The core never treats a newer timestamp as field ownership. It reports the
ordering fact and leaves repair policy for milestone 2.

## Adapter contract

`ReadAdapter` is contract version 1. Each adapter publishes:

- a unique adapter ID
- a contract version
- an implementation version
- an external schema version
- `readPage`, which accepts a versioned checkpoint and returns records, the next
  checkpoint, and `hasMore`

Each returned record has a stable local record ID, identity candidate,
comparable fields, update timestamp, and raw source evidence with a format and
locator. The contract has no write method.

The engine rejects a stored checkpoint if its adapter or schema version differs
from the active adapter. Existing reports embed adapter metadata, normalization
version, normalized snapshots, and raw evidence, so later code cannot
reinterpret old reports in place.

The adapters translate their provider-shaped files into the shared record
envelope. Provider field names, file layout, paging, and ledger sequences do not
enter the reconciliation core.

## Incremental and durable behavior

The JSON adapter advances by flattened page offset. The ledger adapter advances
by ingestion sequence, not the record's business timestamp. A record with an old
`last_seen` value is still read when it arrives at a new sequence. This is how
the late-record test avoids a timestamp watermark gap.

Before committing a run, the engine merges new observations with the current
SQLite observation set by adapter ID and stable local record ID. Repeated pages
do not create duplicate records. Distinct local IDs that normalize to the same
identity remain separate and produce `duplicate_identity`.

SQLite commits these items in one transaction:

1. New normalized observations with source evidence
2. The complete dry-run JSON report
3. Both adapter checkpoints

If the process fails before either checkpoint update, SQLite rolls back all
three. Re-running reads the same pages and produces the comparison again.

## Report shape

JSON reports include version metadata, run metadata, before and after
checkpoints, read counts, summary counts, and every classified result. Each
non-equal result carries the source and target snapshots that explain it.

Field differences distinguish a missing value from JSON `null`:

```json
{
  "path": "totalMinor",
  "source": { "present": true, "value": 4200 },
  "target": { "present": true, "value": 4000 }
}
```

## Safety guarantees

- Every run is a dry run.
- `--apply` fails before adapters or SQLite are opened.
- The version 1 adapter contract exposes no write capability.
- The synthetic adapters only read local fixture files.
- Checkpoints advance in the same transaction that records observations and the
  report.
- Reports retain raw source evidence for every difference and conflict.
- No demo or test connects to a live system.

## Repository shape and decisions

The repository is one strict TypeScript package. A workspace or framework would
add ceremony without separating a second independently published unit.

```text
src/contracts/   versioned read-only adapter types
src/adapters/    the two local provider implementations
src/core/        normalization, matching, classification, orchestration
src/storage/     SQLite checkpoints, observations, and reports
src/reporters/   terminal output
fixtures/        deterministic synthetic commerce data
tests/           focused behavior and failure tests
```

Recorded foundation decisions:

- Runtime: Node.js 24, ESM, strict TypeScript, and pnpm 11
- Storage: built-in synchronous SQLite with strict tables and transactional
  commits
- Test runner: Vitest
- Formatting and linting: Prettier and type-aware ESLint
- CI: GitHub Actions on Node 24 with a frozen pnpm lockfile

## Development

```sh
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

The focused tests cover repeated pages, late records, missing identifiers,
ambiguous ownership, checkpoint crashes, incompatible schema versions,
machine-readable evidence, and dry-run immutability.

## What remains

Milestone 2 will introduce controlled repair as a separate capability. It still
needs accepted repair plans, field ownership rules, idempotency or deduplication
keys, disposable target writes, durable decision and result audit entries,
partial-failure recovery, and bounded replay. Nothing in milestones 0 or 1
writes repairs automatically.

See [ROADMAP.md](ROADMAP.md) for the remaining work.

## License

[MIT](LICENSE)
