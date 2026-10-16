# Data Reconciler

Data Reconciler finds records that disagree between two systems, explains each
difference, and applies only the repairs you explicitly approve. It is a
TypeScript library and CLI for developers maintaining integrations where retries
and upserts still leave missing records or stale values.

You supply adapters and decide which fields each system owns. The engine handles
identity matching, normalization, checkpoints, conflict reporting, repair
review, and recovery. Every difference keeps its original source evidence. A
newer timestamp does not automatically make one system the owner.

This is the **1.0 release candidate**, tested against disposable local data. The
package is private and has not been published to npm. No account, credentials,
Docker, or external database service is needed to try it.

## Try it

Use Node.js 24 and pnpm 11:

```sh
git clone https://github.com/KleitonBarone/data-reconciler.git
cd data-reconciler
pnpm install --frozen-lockfile
pnpm dev init-demo --directory .data/demo
pnpm dev compare --config .data/demo/job.json --store .data/demo/state.sqlite
```

The demo compares inventory in a JSON file with an independent local SQLite
target. It reports one missing record, one changed record, and two conflicts.
Neither input changes. Run the comparison again to resume from saved checkpoints
with zero new records read.

Use a new demo directory if that one already exists. For JSON with all evidence,
add `--format json`; use `--format ndjson` to process results incrementally.
SQLite state and reports remain in the store you chose.

## Integrate it

Build and pack a local artifact, then install that tarball in your application:

```sh
pnpm build
pnpm pack --pack-destination .data
# In your application:
pnpm add /path/to/data-reconciler-1.0.0-rc.1.tgz
```

Use the same job configuration from a worker:

```ts
import { compare, loadJob, SqliteReconciliationStore } from "data-reconciler";

const job = await loadJob(".data/demo/job.json");
const store = new SqliteReconciliationStore(":memory:");
try {
  const report = await compare(job, { store });
  console.log(JSON.stringify(report.summary));
} finally {
  store.close();
}
```

Replace `:memory:` with a file to retain progress. The
[integration guide](docs/current-behavior.md) covers configuration and public
APIs. Use JSON/JSONL field projections for local data, or write a
[typed adapter](docs/adapters.md) for your own API.

## Approve repairs separately

Comparison is always a dry run. Review a saved plan, accept its exact digest and
bounds, then run the explicit apply command. The
[repair walkthrough](docs/repairs.md) explains ownership, approval, interrupted
execution, and repeat application without duplicate effects.

The bundled writer supports local SQLite creates and updates. External systems
remain comparison-only unless their writer can prove atomic preconditions and
durable deduplication. Automatic deletion, bidirectional writes, hosted
scheduling, and vendor account connectors are outside this release.

See [replay](docs/replay.md), [recovery](docs/recovery.md),
[processing limits](docs/performance.md), and
[compatibility](docs/compatibility.md) before using application data.

## Develop

[CONTRIBUTING.md](CONTRIBUTING.md) describes the watch loop. `pnpm check` runs
formatting, linting, types, focused tests, crash scenarios, and
installed-package verification. Release status is tracked in the
[roadmap](ROADMAP.md) and [changelog](CHANGELOG.md).

[MIT licensed](LICENSE).
