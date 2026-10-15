# Development

Use Node.js 24 or newer and pnpm 11. The repository is one strict TypeScript ESM
package. Tests use synthetic data and actual SQLite; no accounts or services are
required.

## Start the loop

```sh
pnpm install --frozen-lockfile
pnpm test:watch
```

The watcher runs the integration suite as files change. Keep it running while
working on an adapter, normalization, comparison, or persistence. To run that
suite once, use `pnpm test`.

Select a focused behavior when investigating a failure:

```sh
pnpm exec vitest run tests/reconcile.test.ts -t "late record"
```

For a manual CLI run from the repository root:

```sh
pnpm dev reconcile --format json --store .data/development.sqlite
```

That store persists between runs. Use a new store filename for a new dataset or
an independent scenario. The current adapters cannot distinguish changed input
paths from an existing dataset. Do not point them at production data.

## Verify the user workflow

```sh
pnpm test:e2e
```

This builds the library and CLI, then runs `dist/cli.js` through Node in child
processes. Each scenario copies fixture inputs into a unique temporary directory
with spaces in its name and runs outside the repository's working directory. It
uses a real SQLite file and closes the process before inspecting durable state.

The scenarios prove that JSON parses without terminal text mixed into stdout,
differences retain evidence, another process resumes checkpoints, input bytes
are unchanged, rejected apply creates no store, and a failed read leaves the
previous committed state intact. Failures report subprocess diagnostics;
subprocesses have a ten-second timeout. Cleanup removes only scenario-owned
temporary files.

`pnpm test` and `pnpm test:watch` exclude these tests so the short loop does not
depend on a possibly stale build. Always use `pnpm test:e2e` to build before
running them. Existing integration tests exercise library behavior and
transaction rollback; process termination and external writer recovery are
future [roadmap](ROADMAP.md) gates.

## Before handing off a change

```sh
pnpm check
```

This runs Prettier checks, type-aware ESLint, strict type checking, the
integration suite, a build, and the compiled CLI scenarios. CI runs this same
command on Linux and Windows with a frozen lockfile. A local pass does not
replace the other operating system's CI result.

Use `pnpm format` to write formatting changes. Individual static checks are
`pnpm format:check`, `pnpm lint`, and `pnpm typecheck`. `pnpm build` creates the
ESM output and type declarations in `dist/`.

## How to take the next slice

Follow [ROADMAP.md](ROADMAP.md) in dependency order. The immediate next product
slice is B1, correcting JSON value preservation and deterministic normalization.
The current implementation is documented in
[docs/current-behavior.md](docs/current-behavior.md).

Pick the smallest observable result before editing code. Use a unit test for a
pure transformation, a shared contract test for adapter guarantees, an
integration test for SQLite boundaries, and a subprocess test for CLI or crash
behavior. Add each kind when it proves a distinct failure, rather than testing
the same implementation detail at every layer.

Seed generated fixtures and print the seed on failure. Synchronize crash tests
at named durable boundaries rather than sleeping for a guessed duration. Repair
tests must use disposable targets and prove a second identical apply has no
further effects. Keep the README aimed at people discovering the tool; put
detailed implementation and recovery instructions in focused guides.

## Commit as you progress

Follow the commit schedule in [ROADMAP.md](ROADMAP.md). After each complete
implementation slice, run `pnpm check`, inspect the diff, stage only its
intended paths, and create a focused local Conventional Commit. Include tests
and docs with the behavior they describe. Split a growing task into smaller
passing slices rather than waiting for a whole phase to finish.

Continue with the next slice after committing. At phase boundaries, also run the
phase's acceptance scenario. A commit should be a verified recovery point, not a
snapshot of broken work. Pushing and publishing are separate actions.
