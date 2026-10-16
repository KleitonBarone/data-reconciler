# Development

Use Node.js 24 and pnpm 11. The repository is one strict TypeScript ESM package
with real SQLite tests and synthetic data. No services or credentials are
needed.

## Short loop

```sh
pnpm install --frozen-lockfile
pnpm test:watch
```

The watcher excludes compiled-process tests, so it never uses a stale build.
Choose a focused test while editing:

```sh
pnpm exec vitest run tests/repairs.test.ts -t "lost acknowledgements"
pnpm exec vitest run tests/revisions.test.ts
```

Run a fresh disposable scenario manually:

```sh
pnpm dev init-demo --directory .data/development
pnpm dev compare --config .data/development/job.json --store .data/development/state.sqlite
```

The initializer refuses existing directories. Pick a new name for an independent
scenario. Dataset, adapter, normalization, and ownership changes reject resume
within an existing job generation. Use `--generation ID` explicitly to rescan
while retaining old history.

Other runnable examples are `pnpm example:worker` and `pnpm example:http`. The
latter owns its loopback HTTP server and closes it after the example.

## Full verification

```sh
pnpm check
```

This runs `pnpm format:check`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and
`pnpm test:e2e`. Use `pnpm format` to write formatting.

The end-to-end command builds before spawning the compiled CLI. It verifies
restart, source immutability, digest review, target drift, real process
termination, lost acknowledgements, and repeated apply without further effects.
A packed consumer compiles independently, then runs without runtime development
dependencies from an unrelated directory. It checks bundled assets, source maps,
the documented example, backup, replay, and audit.

Multi-process comparison and repair scenarios allow 60 seconds in total, with
individual subprocesses still limited to 10 or 30 seconds. Windows CI measured
six to eight seconds for valid workflows, exceeding Vitest's five-second
default. The packed-install rehearsal has a separate 180-second budget.

CI runs this command on Linux and Windows. A local Windows pass is not evidence
of a Linux pass. The root TypeScript self-import alias checks bundled examples
before a build; the external consumer has no alias or access to repository
sources. Ajv and its format plugin are development-only independent checks of
serialized JSON schemas, not runtime dependencies.

## Performance and generated checks

```sh
pnpm benchmark
```

The benchmark uses 100,000 records per side and seed 42. Processing budgets and
measurements are in [docs/performance.md](docs/performance.md). The separate
performance workflow runs on `ubuntu-latest` with Node.js 24, exercises 256
revision/permutation seeds, and saves JSON artifacts even on failure.
`RECONCILER_TEST_SEEDS` selects up to 1,000 seeds locally. Small deterministic
scenarios remain in ordinary checks.

Prefer a unit test for a transformation, reusable conformance checks for an
adapter contract, real SQLite integration tests for persistence, and child
processes for crash behavior. Do not repeat the same implementation-detail
assertion at every layer. Synchronize failures at a named durable boundary,
never a guessed sleep. Any writer test must use a disposable target and check a
second identical apply.

## Packaging and changes

`pnpm build` creates ESM JavaScript, declarations, and source maps in `dist/`.
`pnpm pack --pack-destination .data` creates an installable release-candidate
tarball. The package remains private; publishing needs a confirmed registry name
and separate authorization.

Follow [ROADMAP.md](ROADMAP.md). After each complete slice, run the relevant
acceptance scenario and `pnpm check`, inspect the diff, stage only intended
paths, and make a focused Conventional Commit. Include migrations, tests, and
docs with their behavior. Keep changes recoverable and continue to the next
slice. Do not bypass failures to create a commit.

Keep the README for new users. Put contracts, tradeoffs, and recovery details in
[docs/current-behavior.md](docs/current-behavior.md) and its linked guides.
