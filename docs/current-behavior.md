# Current API and behavior

This guide describes the local dry-run prototype. The [roadmap](../ROADMAP.md)
describes planned behavior. The package is private, its API is provisional, and
the current adapters support only the supplied commerce schemas.

## Use the library from this checkout

Save this as `example.mjs` in the repository root. Run `pnpm build`, then
`node example.mjs`:

```js
import {
  JsonPageCommerceAdapter,
  JsonlLedgerCommerceAdapter,
  SqliteReconciliationStore,
  reconcileDryRun,
  commercePolicy,
} from "data-reconciler";

const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await reconcileDryRun({
    source: new JsonPageCommerceAdapter("fixtures/source-pages.json"),
    target: new JsonlLedgerCommerceAdapter("fixtures/target-ledger.jsonl"),
    store,
    pageSize: 2,
    normalization: commercePolicy,
  });
  console.log(report.summary);
} finally {
  store.close();
}
```

Use a filename instead of `:memory:` to retain checkpoints and reports. The
import resolves the package's own public exports inside this checkout. There is
no published npm installation path yet. `src/index.ts` exports the read
contract, report types, reconciliation function, local adapters, SQLite store,
and terminal formatter. A custom `ReadAdapter` can be passed to the library, but
the CLI instantiates the two bundled adapters directly.

Keep adapter IDs stable and distinct. Use a separate store for each dataset
pair. Changing a path while reusing a store does not invalidate its current
checkpoints. A new adapter ID is also a new checkpoint namespace, not a
migration of its existing observations.

## CLI

Run commands from the repository root:

```sh
pnpm reconcile
pnpm reconcile --format json
pnpm dev --help
```

Options currently accepted by `reconcile`:

| Option                | Default                        | Meaning                                              |
| --------------------- | ------------------------------ | ---------------------------------------------------- |
| `--source <path>`     | `fixtures/source-pages.json`   | Acme schema input                                    |
| `--target <path>`     | `fixtures/target-ledger.jsonl` | Northstar schema input                               |
| `--store <path>`      | `.data/reconciler.sqlite`      | SQLite observations, reports, and checkpoints        |
| `--page-size <count>` | `100`                          | Positive integer limiting each adapter page          |
| `--format <format>`   | `human`                        | `human` or `json`                                    |
| `--dry-run`           | enabled                        | Explicit spelling of the only supported mode         |
| `--apply`             | disabled                       | Rejected before creating a store or opening adapters |

Exit code 0 means comparison succeeded, including when drift or conflicts are
present. Exit code 1 indicates an error. Reports go to stdout and error messages
to stderr. For pipelines that need only the built program's output, run
`node dist/cli.js reconcile --format json` after building.

## Terms and classifications

A source and target are comparison roles, not ownership declarations. An
identity is a normalized matching key such as `order:ORDER-101`. A local record
ID distinguishes records within one adapter. A checkpoint contains an opaque
adapter cursor and contract, adapter, and external schema versions.

An adapter record contains projected comparable fields and original evidence. A
normalized snapshot stores those fields after normalization, its identity,
timestamp, adapter metadata, normalization version, and the original evidence.
Differences, repair decisions, accepted plans, and applied outcomes are separate
concepts. Only differences and dry-run reports are implemented.

| Classification | Current rule                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------- |
| `equal`        | Exactly one record exists on each side and normalized comparable fields match.                                      |
| `missing`      | An identity exists on only one side. The report names the missing side.                                             |
| `changed`      | Comparable fields differ and update timestamps differ. The report names the newer side without authorizing a write. |
| `conflicting`  | An identity is missing, multiple local IDs claim an identity, or differing values have equal timestamps.            |

Field differences distinguish an absent value from JSON `null`:

```json
{
  "path": "totalMinor",
  "source": { "present": true, "value": 4200 },
  "target": { "present": true, "value": 4000 }
}
```

The default `json.v1` normalization preserves string values and identity case.
An explicit versioned policy configures whitespace, Unicode normalization,
identity case, per-field rules, ignored fields, and unordered arrays. Field
selectors use JSON Pointer. Compound identity values are escaped JSON tuples.
The demo passes `commercePolicy`, which trims strings, uppercases order keys and
currency, and lowercases email and status. Arrays are positional unless the
policy declares otherwise.

## Adapter contract and fixtures

The [read contract](../src/contracts/adapter.ts) is version 1. Each adapter
publishes a unique ID, display name, contract version, implementation version,
and external schema version. `readPage` accepts a checkpoint and page limit,
then returns record envelopes, the next checkpoint, and `hasMore`.

Each record has a stable local ID, update timestamp, identity candidate,
comparable fields, and evidence containing a format, locator, and original JSON
payload. The contract exposes no write method. Adapters translate provider field
names and pagination; the core owns normalization, matching, and classification.

The two implementations are separate:

- [Acme JSON pages](../fixtures/source-pages.json) declares `acme-orders.v1`.
  Records use `id`, `order_number`, `modified_at`, `customer.email`,
  `total_cents`, `currency_code`, and `status`. The adapter flattens pages and
  resumes by offset. Evidence names the page and item index.
- [Northstar JSONL ledger](../fixtures/target-ledger.jsonl) starts with a
  `northstar-orders.v1` schema header. Events have a `sequence` and nested
  `order` containing `local_id`, `external_ref`, `last_seen`, `buyer_email`,
  `amount.minor`, `currency`, and `state`. The adapter resumes by sequence and
  preserves the whole event with a line locator.

Both project to `customerEmail`, `totalMinor`, `currency`, and `status` before
the core normalizes those values. The fixture has one equal identity, two
missing identities, one changed identity, and two conflicts. A repeated source
record is intentional. The late-arrival integration test appends an event with
an old business timestamp at a newer ingestion sequence.

## Durability and evidence

The engine reads all new pages, normalizes records, and merges stored and new
observations by adapter ID and local record ID. Identical repeated pages do not
create duplicate current records. Distinct local IDs claiming one identity
remain separate and produce `duplicate_identity`.

SQLite commits current observations, the complete report, and both checkpoints
in one transaction. A thrown failure inside that transaction rolls it back. A
second run uses stored observations and reads only records after the saved
cursor. With unchanged fixtures, it reads zero new records and still reports the
existing differences.

The report includes schema and normalization versions, run ID, timestamp,
adapter metadata, before/after checkpoints, read counts, summary counts, and all
classified results. Every difference retains the relevant normalized snapshots
and original payloads. Existing reports embed their evidence and are not
rewritten when later observations replace the current index.

Checkpoints reject an incompatible adapter or schema version. That does not yet
cover normalization-policy changes or dataset replacement. There is no current
database migration command or historical repair audit.

## Known limits

- Boolean comparable values retain their JSON type, including in nested objects
  and arrays. Other validation and configurable normalization work is tracked in
  phase B.
- Newer timestamps supersede older observations with the same local ID.
  Equal-time disagreements retain both versions as `conflicting_revision`.
  Tombstones produce `deleted_record` conflicts. Reports retain all deliveries
  read during a run, including stale evidence.
- JSON offsets assume earlier records do not change; ledger reads assume
  sequences are valid and increasing. Rewritten, reordered, or truncated inputs
  are not handled as dataset changes.
- The engine loads all observations and new pages into memory. Checkpoints are
  committed after the complete run, not after individual pages.
- Adapter IDs alone key state. Jobs, tenants, input generations, and concurrent
  writers are not isolated by an explicit job model.
- SQLite rows are parsed without full runtime validation. Schema migration,
  corruption recovery, cancellation, bounded network retries, and streaming
  reports remain planned work.
- There are no repair writes, accepted plans, replay commands, vendor
  integrations, or installable public package.

## Runtime and repository decisions

Node.js 24 supplies built-in SQLite. The project uses ESM, strict TypeScript,
pnpm 11, Vitest, Prettier, and type-aware ESLint. SQLite uses strict tables and
WAL mode. The library is one package with contracts, adapters, core, storage,
and reporters under `src/`.

Keep human discovery and the shortest working trial in the
[README](../README.md). See [CONTRIBUTING.md](../CONTRIBUTING.md) for the
verified development commands and [ROADMAP.md](../ROADMAP.md) for the
implementation plan.
