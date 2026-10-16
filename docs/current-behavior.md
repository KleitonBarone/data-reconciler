# Integration and current behavior

The 1.0 release candidate provides an ESM TypeScript library and CLI on
Node.js 24. It has no runtime dependencies. The package is private, but local
tarballs are installable. See [compatibility](compatibility.md) for release
boundaries.

## Configure a job

Start with `data-reconciler init-demo --directory demo`. It writes a new local
JSON source, an independent writable SQLite target, and a declarative job. It
refuses an existing directory.

`loadJob(path)` accepts declarative JSON or a trusted JavaScript module's
default export. Paths inside JSON resolve relative to the config file, not the
process's working directory. JavaScript modules execute trusted application
code. Never load an untrusted module.

A job declares `id`, `source`, `target`, and optionally `normalization`,
`repair`, `runtime`, `pageSize`, and explicit `datasets`. Dataset identities and
distinct stable adapter IDs are required. `defineJob` preserves inferred types
and validates the job.

Bundled endpoint types:

| Type             | Input and purpose                                         |
| ---------------- | --------------------------------------------------------- |
| `json`, `jsonl`  | Arbitrary local records with explicit field projections   |
| `commerce-json`  | Acme paged order fixture                                  |
| `commerce-jsonl` | Separate Northstar ledger implementation                  |
| `http-json`      | Reference paginated HTTP read protocol                    |
| `sqlite-records` | Explicitly initialized disposable canonical-record target |

`examples/inventory.json` demonstrates unrelated JSON and JSONL schemas. A
projection declares JSON Pointers for local ID, timestamp, identity components,
and comparable fields. Missing fields remain absent; they do not become null.
Custom mapping belongs in an adapter, not a transformation language.

## Embed the library

The complete [consumer example](../examples/consumer.ts) is compiled and run
from the packed artifact during tests:

```ts
import { compare, loadJob, SqliteReconciliationStore } from "data-reconciler";

const job = await loadJob(process.argv[2] ?? ".data/demo/job.json");
const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await compare(job, { store });
  console.log(JSON.stringify(report.summary));
} finally {
  store.close();
}
```

Use a file-backed store for durable progress. `compare` returns metadata and
counts, not an array of all records. Iterate `store.durable.results(runId)` or
serialize with `reportChunks`. The store connection belongs to the caller and
must stay open during iteration. A completed report can be retrieved with
`store.durable.getRun(runId)` without contacting providers.

Other public entry points are `defineAdapter`, `verifyReadAdapter`,
`verifyRepairWriter`, `createPlan`, `acceptPlan`, `validateAcceptedPlan`,
`applyPlan`, `replay`, `normalizeRecord`, and `schemas`. Errors use
`ReconciliationError.code`. Optional abort signals and correlated lifecycle
callbacks support application workers. Importing the package opens no stores,
files, or network connections.

## Identity, normalization, and comparison

Local record IDs distinguish owners within one system. Business identities match
records across systems. Namespaces and scalar parts are escaped; multi-part
identities use unambiguous JSON tuples. Missing identifiers are conflicts, not
values to guess.

The default `json.v1` policy preserves string case and whitespace. Versioned
policies can declare trimming, Unicode normalization, case rules per identity
namespace, JSON Pointer field rules, ignored fields, and unordered arrays.
Booleans, nulls, numbers, strings, objects, and arrays retain their JSON types.
Non-JSON values, unsafe integers, cycles, accessors, and lossy array properties
are rejected. Timestamps require RFC 3339 with an explicit timezone and at most
millisecond precision. Original evidence is never normalized.

| Classification | Meaning                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `equal`        | One owner on each side, with equal comparable fields                                            |
| `missing`      | An observed identity has no counterpart in the completed read scope                             |
| `changed`      | Values and timestamps differ; newer side is information, not authority                          |
| `conflicting`  | Missing IDs, duplicate owners, tied divergent revisions, tombstones, or equal-time disagreement |

A field difference distinguishes absence from JSON null:

```json
{
  "path": "stock",
  "source": { "present": true, "value": 12 },
  "target": { "present": false }
}
```

`path` is a human display label using dots and array indices, not a JSON
Pointer. Use full snapshots or explicit repair-operation fields when keys
contain those characters. Normalization selectors are JSON Pointers. Ownership
names whole top-level fields.

Ingestion position and business update time are separate. Duplicate deliveries
coalesce deterministically; late older observations never replace a newer
business revision. Equal-time disagreements preserve all variants. Explicit
tombstones become conflicts. Incomplete reads cannot establish deletions.

## Persistence and commands

Each page commits immutable delivery evidence, the current-state index, and its
checkpoint together. Final results become visible only after both read scopes
complete. State is isolated by job, dataset, adapter/schema versions,
normalization, and ownership policy. A live local PID claim excludes a competing
writer; dead-process recovery never steals from a live process.

`compare --check` returns 2 for drift and 3 for conflicts. Ordinary comparison
returns 0 even when differences exist. Operational failures return 1, invalid
config 4, cancellation 130. Use `--format json` or `--format ndjson`;
diagnostics stay on stderr. Command-inapplicable options are rejected,
especially options that could misleadingly narrow or retarget an apply.

Detailed workflows:

- [Adapter contracts](adapters.md)
- [Normalization and ownership](repairs.md)
- [Plan review, writes, and recovery](repairs.md)
- [Replay and evidence retention](replay.md)
- [Backup, rescan, and upgrades](recovery.md)
- [Runtime limits and streamed reports](runtime.md)
- [Measured support envelope](performance.md)

## Runtime and repository decisions

Node.js 24 supplies SQLite without a native-addon dependency. ESM and strict
TypeScript keep the public library and CLI in one package. pnpm pins developer
tooling. SQLite's strict tables, WAL, transactional migrations, and indexed
groups provide local durability without a service. Source evidence, normalized
current state, reports, accepted plans, and write outcomes remain distinct.

The core depends on storage interfaces. SQLite implementation details stay in
storage; provider schemas, pagination, and conditional writes stay in adapters.
The CLI calls the same library functions that applications use.

The original `reconcileDryRun` API and `reconcile` commerce command remain
legacy in-memory conveniences for small fixtures. New integrations use
`compare`. They are not the bounded processing path. No built-in adapter
connects to a vendor account, and no command automatically repairs a comparison
result.
