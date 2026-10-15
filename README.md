# Data Reconciler

Data Reconciler finds records that disagree between two systems. It is for
developers maintaining integrations where retries and upserts still leave
missing records, stale values, or conflicting updates.

It matches identities, compares normalized fields, and produces a report with
the original evidence behind each difference. That gives you something concrete
to investigate before deciding which system should change.

The current version is a local dry-run prototype. It includes a TypeScript
library, a CLI, two commerce adapters, and SQLite checkpoints. Controlled
repairs and a stable package for integration are planned in the
[roadmap](ROADMAP.md).

## Try it locally

You need Node.js 24 or newer and pnpm 11. No accounts, services, or database
setup are required. SQLite runs locally.

```sh
git clone https://github.com/KleitonBarone/data-reconciler.git
cd data-reconciler
pnpm install --frozen-lockfile
pnpm reconcile
```

The demo compares synthetic orders stored in paged JSON and a JSONL ledger:

```text
Read 6 source and 4 target records
Results: 1 equal, 2 missing, 1 changed, 2 conflicting
```

`equal` means the comparable fields match. `missing` names the side without the
record. `changed` reports differing values and which timestamp is newer.
`conflicting` flags missing identifiers, duplicate identities, or differing
values with equal timestamps. A newer timestamp does not establish ownership.

The terminal lists differences. JSON includes field values, source evidence,
adapter versions, and checkpoints:

```sh
pnpm reconcile --format json
```

State and reports live in `.data/reconciler.sqlite`. Run the command again to
resume. Unchanged fixtures produce the same classifications with zero new
records read. To start an independent run, choose a new `--store` path.

## Use your own data

The CLI currently accepts the two included commerce formats:

```sh
pnpm reconcile --source fixtures/source-pages.json --target fixtures/target-ledger.jsonl --store .data/my-comparison.sqlite
```

These are examples of specific schemas, not arbitrary JSON importers. The
[current API and adapter guide](docs/current-behavior.md) explains the formats,
library entry point, evidence, and known limits. The package is private and has
not been published to npm. Custom adapters currently require using the library;
the CLI has no adapter configuration loader yet.

Dry run is the only mode. The adapters read files, and `--apply` fails before
creating a store. Local checkpoints and reports are written, but input records
are unchanged. Use separate stores for separate datasets because current
checkpoints do not identify the input files.

## Develop and integrate

Start with [CONTRIBUTING.md](CONTRIBUTING.md) for the watch loop and end-to-end
checks. Run `pnpm check` for formatting, linting, type checking, integration
tests, and tests of the compiled CLI.

The [completion plan](ROADMAP.md) defines the path to a stable library and CLI,
including configurable normalization, accepted repair plans, idempotent writes,
recovery, and package-consumer verification.

## License

[MIT](LICENSE)
