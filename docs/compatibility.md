# Compatibility and release candidate

The candidate is `1.0.0-rc.1`. It targets Node.js 24 on Linux and Windows, ESM
imports, strict TypeScript, and pnpm 11 for development. Other Node major
versions and operating systems are not declared supported by this release. There
are zero runtime dependencies. SQLite comes from Node itself.

The root export is the public API. Source files ship to support relative
JavaScript and declaration maps, not as additional supported import paths. The
package export map does not expose private deep imports. TypeScript consumers
need Node type declarations and `types: ["node"]` in configurations that disable
ambient type discovery.

Read contract 1, optional writer contract 1, report/plan/acceptance/outcome
schema 1, normalization-policy versions, and SQLite state schema 4 are distinct.
Adapter implementation changes and provider schema changes require separate
version updates. Policy content also participates in the job fingerprint, so
reusing a policy label cannot silently reinterpret an existing job.

## Serialized formats

`schemas` exports JSON Schema draft 2020-12 definitions for reports, plans,
acceptances, outcomes, apply summaries, and NDJSON rows:

```sh
data-reconciler schema --kind report
data-reconciler schema --kind plan
```

Runtime decoders also enforce digest, expiry, ownership, checkpoint, and
authorization invariants that a structural JSON Schema cannot express. JSON
Schema validation alone does not authorize a write. NDJSON consumers must
require a matching final complete row. A truncated export is not a complete
report. Human difference paths are labels; use snapshots and operation field
names for machine decisions.

Backward-compatible additions may extend version 1 contracts. Incompatible
semantics require a new explicit format or adapter version. Historical snapshots
and reports remain interpreted with their recorded versions. Unknown report,
plan, and state versions are refused by runtime readers.

## Install and release

From a checkout:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm pack --pack-destination .data
```

Install the resulting tarball in another application with
`pnpm add /path/to/file.tgz`. The installed CLI bundles its fixture assets and
resolves them independently of the current working directory. The independent
consumer test compiles public imports and rehearses the complete workflow with
no runtime dev dependencies.

`private: true` remains deliberate. The provisional name `data-reconciler` is
not a claim to an npm registry name. Confirm registry ownership/name, review the
candidate, and authorize publication separately before removing that guard. This
task does not publish, tag a registry release, deploy, or connect live accounts.

## Limits

Repair scope is one source-to-target direction per job, explicit ownership of
whole top-level fields, and create/update only. No automatic deletion,
bidirectional writes, distributed workers, scheduling service, web UI, or vendor
connector catalog is included. Snapshot replacement uses an explicit generation.
The legacy in-memory API is for small fixtures; use indexed `compare` for
application datasets. See [performance](performance.md) for measured limits.
