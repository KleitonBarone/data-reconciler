# Roadmap to 1.0

This is the implementation plan from the current prototype to a complete first
release. Unchecked items are planned work. The implementation order is A through
H, with a working demonstration and automated acceptance checks at each step.
The commit schedule below covers every work item. Complete and verify each
slice, commit it locally, then continue to the next slice.

The implemented candidate is `1.0.0-rc.1`. Local gates cover the complete
installed workflow, including a concurrent target change, process termination,
resume, repeat apply, replay, backup, and unresolved conflicts. The Linux and
Windows [CI matrix](.github/workflows/ci.yml) and separate
[performance gate](.github/workflows/performance.yml) must pass on the pushed
commit before accepting it. Registry-name confirmation and publication remain
separate release actions; the package stays private.

## Release review follow-up

The readiness review reproduced four defects despite the original green gates.
Release readiness is pending these fixes and fresh CI on their final commit.
Each slice includes a failing reproduction, focused checks, and `pnpm check`,
then a local Conventional Commit and a push to `origin/main` as authorized for
this follow-up. Verify both CI workflows on the final pushed revision.

- [x] Protect all identities in ambiguous current revisions, migrate the derived
      index, and reject unsafe operations from old reports and accepted plans.
      Commit and push `fix(core): block repairs for every ambiguous identity`.
- [x] Preserve unknown writes through lookup failures and crash recovery. Commit
      and push `fix(repairs): preserve uncertainty across recovery attempts`.
- [x] Reject run-ID collisions without changing existing runs or reports. Commit
      and push `fix(storage): preserve runs when IDs collide`.
- [x] Give multi-process scenarios an explicit bounded timeout after Windows CI
      measured six to eight seconds against Vitest's five-second default. Commit
      and push `test(e2e): allow bounded Windows process workflows`.
- [ ] Return the original immutable acceptance for identical approval retries.
      Commit and push `fix(plans): make identical approval retries idempotent`.
- [ ] Repeat seeded, performance, and installed-workflow verification; record
      results and verify Linux/Windows CI and performance CI on the final push.
      Commit and push `docs: record release review fixes and verification`.

## Product and finish line

Data Reconciler helps integration developers find and explain drift, then apply
an explicitly accepted set of repairs. The primary deliverable is a TypeScript
library that fits inside an existing application or worker. A CLI exposes the
same workflow for development, scheduled jobs, and investigation.

Version 1.0 is complete when a developer outside this repository can install the
package, configure two systems, compare their records, inspect evidence, accept
a bounded repair plan, apply it, recover after interruption, and verify that a
second apply makes no further changes. Every step must run against disposable
data in CI without credentials or live accounts.

The supported repair scope is one direction per job, create and update only,
with declared field ownership. Read-only adapters remain useful on their own.
Records that imply deletion are reported; automatic deletion is outside 1.0.
External APIs that cannot support safe preconditions or deduplication remain
comparison-only until an adapter can prove the required guarantees.

## Current baseline

The original milestones 0 and 1 delivered a local comparison prototype:

- [x] Node.js 24, strict TypeScript, pnpm, and one ESM package
- [x] SQLite checkpoints, observations, and complete dry-run reports
- [x] Versioned read contract and separate JSON page and JSONL ledger adapters
- [x] Commerce normalization, identity matching, and four classifications
- [x] Human and JSON output with original evidence
- [x] Six integration tests covering the existing scenarios

Those milestones do not establish general adapter correctness or readiness for
repair writes. Source review identified the following work that the old roadmap
did not account for:

| Prototype behavior                                                                                      | Work addressed by the implementation phases                                                    |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Booleans normalize to objects, and normalization rules are fixed commerce fields.                       | Preserve every JSON type and make normalization an explicit versioned job policy.              |
| The latest delivered record overwrites a prior observation with the same local ID.                      | Distinguish duplicates, ordered revisions, stale arrivals, and conflicting revisions.          |
| Checkpoints use adapter ID alone.                                                                       | Scope state to job, side, dataset generation, adapter version, and normalization policy.       |
| JSON reads trust an offset into mutable files; ledger reads trust sequence order.                       | Define and enforce snapshot and append-only guarantees, cursor validation, and reset behavior. |
| All pages and current observations stay in memory until a final transaction.                            | Persist resumable read progress and compare through indexed, bounded batches.                  |
| Stored snapshots are cast from JSON, and SQLite has no explicit schema migration version.               | Validate stored data, version migrations, and keep old report interpretations intact.          |
| The core accepts a concrete SQLite class, the CLI knows two fixed adapters, and the package is private. | Add an integration API, configuration, external consumer examples, and package verification.   |
| A thrown transaction hook tests rollback.                                                               | Add actual process termination and uncertain external-write recovery tests.                    |

These entries describe the original starting implementation, not the candidate.
Their fixes and focused behavioral tests are implemented in the checked phases.
The original in-memory API remains a documented legacy convenience; the new job
API provides the bounded processing path.

## Decisions that constrain the implementation

- Keep Node.js 24, ESM, strict TypeScript, pnpm, and SQLite as the initial
  supported runtime and default store. Verify the minimum patch versions before
  publishing them as compatibility promises.
- Keep one package with explicit public exports. Split packages only if a
  dependency or independent release actually requires it.
- Adapters own external formats, pagination, credentials, and provider errors.
  The core owns job policy, normalization, identity, comparison, decisions, and
  repair planning. An optional writer translates an accepted operation back to
  its provider format.
- Use explicit job IDs, typed configuration, inferred adapter record types, and
  runtime validation at file, network, configuration, and persistence
  boundaries. Third-party adapters must not require imports from private source
  paths.
- Keep comparison results separate from decisions, accepted plans, and applied
  outcomes. Timestamps describe ordering; they never grant write ownership.
- Default commands compare. Planning and applying are separate explicit actions.
  No import, timer, retry loop, or background process starts a repair
  implicitly.
- Prefer local fixtures, actual SQLite files, child processes, and a loopback
  HTTP fixture server for verification. External credentials are unnecessary.

## A. Establish the development loop first

This phase gates product development. The initial loop is implemented with this
plan; later phases extend it as their behavior becomes available.

- [x] Keep frozen installs and one complete `pnpm check` command.
- [x] Add `pnpm test:watch` for the integration suite.
- [x] Add `pnpm test:e2e`, which builds and executes `dist/cli.js` in fresh
      child processes from a temporary directory outside the repository.
- [x] Test JSON output, terminal output, durable evidence, resume across
      processes, input immutability, rejected writes, and failed-read rollback.
- [x] Configure the same checks on Linux and Windows in CI.
- [x] Document the short edit, test, build, and end-to-end loop in
      [CONTRIBUTING.md](CONTRIBUTING.md).

Acceptance gate: a frozen install and `pnpm check` succeed locally; CI must pass
on both configured operating systems before merging. Tests use unique temporary
directories, bound subprocess duration, close SQLite handles, and clean up their
own files. A test failure must include the command output that explains it.

For every subsequent slice, first select its observable acceptance scenario. Add
the smallest useful unit, contract, integration, or process test, then implement
and run the focused check. Run the complete check before handoff. Keep property
tests seeded and retain the seed on failure. Do not use arbitrary sleeps or
retry failing assertions to make CI green.

## B. Make comparison correct beyond the fixture happy path

Depends on A. Start here when product development resumes.

- [x] B1. Preserve booleans, null, absent values, numbers, strings, arrays, and
      nested objects. Reject non-JSON values and invalid timestamps. Specify
      safe numeric handling for money and large identifiers. Use deterministic
      key and result ordering independent of host locale.
- [x] B2. Move the commerce rules into an example normalization policy. Make
      identity namespaces, case rules, whitespace, array semantics, field
      mappings, and ignored fields explicit. Do not uppercase every arbitrary
      identifier. Support stable compound keys without ambiguous string
      concatenation.
- [x] B3. Validate nonempty local IDs, identity kinds, and normalized keys.
      Preserve malformed-record evidence in a failed run without advancing past
      an unrecorded page. Distinct local IDs claiming one key stay conflicting.
- [x] B4. Specify record revision semantics. Collapse identical deliveries,
      ignore a proven older revision for current-state purposes while retaining
      its evidence, and report different values at an indistinguishable revision
      as a conflict. Arrival order alone cannot select a winner.
- [x] B5. Define snapshot, incremental-update, and tombstone semantics. An
      absent incremental event is not a deleted record. Missing classifications
      require a completed comparable read scope; an outage cannot make records
      look missing.
- [x] B6. Validate cursors and ledger sequence uniqueness and ordering. Detect
      loops, backward progress, rewritten files, truncated files, and mismatched
      dataset generations. Make a full rescan an explicit operation.

Acceptance gate: seeded fixtures permute page sizes, ordering, duplicates, and
late revisions while producing equivalent normalized results. Focused tests
cover every JSON type, empty IDs, compound-key collisions, duplicate identities,
conflicting revisions, timestamp ambiguity, file replacement, and incomplete
reads. A terminal and JSON CLI test proves the intended outcomes survive the
whole workflow.

## C. Make it usable from another application

Depends on B. Keep the API provisional until the final package gate in H.

- [x] C1. Define a small typed job configuration with a stable job ID, source,
      target, dataset identities, normalization version, and comparison policy.
      Keep raw records, normalized snapshots, reports, and errors distinct.
      Infer adapter record types without `any` or consumer casting wrappers.
- [x] C2. Introduce a storage interface defined by core needs and a default
      SQLite implementation. Inject clock, run IDs, and cancellation where
      needed for reproducibility. Keep store setup and connection ownership
      obvious.
- [x] C3. Expose documented compare and report APIs from public exports. Add
      typed errors and lifecycle events that applications can observe without
      parsing terminal text. Importing the library must have no file or network
      side effects.
- [x] C4. Add a typed adapter helper and reusable contract test suite. Describe
      pagination consistency, revision ordering, evidence, optional write
      capabilities, cancellation, and error translation. Adapter versions and
      external schema versions have separate meanings.
- [x] C5. Load a validated local job configuration in the CLI so a custom
      adapter can run without editing the CLI. Resolve config-relative paths
      predictably. Support declarative field projections for the included
      formats and callbacks for application-specific mapping, without creating
      an ETL language.
- [x] C6. Add runnable examples for local files, embedding the library in a
      worker, and writing a custom adapter. Include a loopback HTTP adapter
      example to exercise pagination, 429 responses, timeouts, and outages
      without accounts.
- [x] C7. Define CLI help, JSON schema versions, output destinations, and stable
      exit codes for success, drift under an explicit check mode, invalid
      config, conflicts, and operational failure. Keep JSON on stdout and
      diagnostics on stderr. Define a streamed report format here; implement
      bounded streaming in D4.

Acceptance gate: an example consumer compares its own schema through public
exports and a custom adapter. The same job works through the CLI from another
working directory. Invalid config fails before data access. Contract tests run
against both built-in adapters and the HTTP example. Errors and cancellation
remain machine-readable.

## D. Make checkpoints and history durable at realistic sizes

Depends on C. Finish this before adding a write capability.

- [x] D1. Version the SQLite schema and validate persisted rows. Add tested,
      transactional migrations from the prototype database. Store report,
      normalization, policy, contract, and adapter versions explicitly.
      Historical reports retain the interpretation and evidence they were
      created with.
- [x] D2. Key state by job, side, dataset generation, and relevant versions.
      Changing an input file, tenant, adapter, normalization, or policy must
      reject incompatible resume or use an explicitly created state generation.
- [x] D3. Persist immutable observations and each completed page's checkpoint
      together. Track run states such as reading, comparing, complete, and
      failed. A final report references a consistent completed read scope.
      Restarting an interrupted run resumes durable work without publishing a
      partial result.
- [x] D4. Replace whole-dataset maps and giant transactions with indexed batches
      and stable iteration. Keep a current-state index separate from immutable
      evidence. Export reports without loading the entire report into memory.
- [x] D5. Serialize writers for the same job with a durable claim or transaction
      plus expected checkpoint checks. Reject a stale concurrent commit. Define
      expiry, recovery, and behavior when another process still owns the job.
- [x] D6. Detect corruption and incompatible state before advancing checkpoints.
      Add inspect, backup, and explicit rebuild procedures that preserve the
      original store. Rebuilding comparisons cannot erase prior repair
      decisions.

Acceptance gate: terminate child processes at controlled points before and after
page commits and report finalization, restart them, and compare with an
uninterrupted run. Two simultaneous jobs do not mix evidence; two processes for
one job cannot regress state. Migration fixtures preserve historical JSON.
Benchmark at least 100,000 records per side, record peak memory and throughput,
and set measured release budgets and documented limits before H.

## E. Produce reviewable repair plans

Depends on D. This phase proposes changes and performs zero adapter writes.

- [x] E1. Define field ownership and job direction explicitly. Unknown
      ownership, missing identities, duplicate identities, ambiguous revisions,
      and incomplete reads cannot generate an applicable repair. Classifications
      remain evidence, not authorization.
- [x] E2. Build deterministic create and update operations from accepted
      differences. Each operation contains job and dataset identities, record
      ID, before/after values, source evidence references, target precondition,
      deduplication key, and all relevant policy and schema versions.
- [x] E3. Store immutable plans with a content digest. Acceptance identifies the
      exact digest and selected operation IDs. Define expiration, allowed
      fields, maximum operations, and maximum affected records. An empty or
      modified plan cannot be mistaken for an accepted plan.
- [x] E4. Add library and CLI paths to create, inspect, export, and accept a
      plan. Acceptance is durable and separate from execution. Reject
      incompatible, stale, or changed plans with actionable errors.

Acceptance gate: repeated planning over the same evidence produces the same
operations and keys. Tests reject edits after acceptance, missing ownership,
unsupported operations, expired plans, exceeded bounds, and mismatched jobs. An
end-to-end plan-and-review scenario proves all target bytes remain unchanged.

## F. Apply bounded repairs and recover from partial failure

Depends on E. Test only against disposable writable targets.

- [x] F1. Add a separate optional writer contract. Advertise supported
      create/update, atomic precondition, deduplication, and result-verification
      capabilities. Read-only adapters stay valid. Implement a writable local
      target that can prove these guarantees before supporting any external
      writer.
- [x] F2. Require explicit apply of an accepted plan digest. Re-read or check
      the target revision atomically with the write. Drift since planning
      invalidates the operation; never silently overwrite it. Recheck bounds and
      versions.
- [x] F3. Durably record intent before sending a write, then record the outcome.
      Use per-operation deduplication keys at the target boundary. Distinguish
      pending, succeeded, skipped, failed, and unknown outcomes.
- [x] F4. Handle a write that succeeds before its acknowledgement or local audit
      commit. Recover by adapter deduplication or verifiable read-back. If
      neither can prove the result, stop that operation for review; do not claim
      exactly-once delivery or retry an unsafe write.
- [x] F5. Resume unfinished plans without repeating completed effects. Support
      cancellation between operations, bounded retry of classified transient
      failures, and a durable summary of partial success. Never advance past an
      operation whose intent or outcome has not been recorded.
- [x] F6. Compare again after apply and link the verification run to the plan.
      Report unresolved conflicts and target-side changes without resolving them
      implicitly.

Acceptance gate: compare, plan, accept, apply, compare, and apply again through
the compiled CLI against disposable data. The second identical apply causes zero
target changes. Kill the process before a write, after target success, and
before result recording. Restart and prove convergence, complete audit history,
and no duplicate effects. Also test target revision changes and failure midway
through a multi-record plan.

## G. Prove replay, recovery, and operational behavior

Depends on F and extends its failure scenarios.

- [x] G1. Replay explicit job and sequence ranges using recorded versions and
      evidence. Replay cannot advance the normal read checkpoint or rewrite old
      reports. Replaying repair operations reuses their original deduplication
      keys and still requires the original valid authorization or fresh
      acceptance.
- [x] G2. Add bounded timeouts, retry budgets, page/record limits, cancellation,
      and backoff that honors provider retry hints. Keep provider-specific rate
      limits in adapters. Use controlled time and synchronization in tests.
- [x] G3. Emit run, page, difference, conflict, checkpoint, repair, and retry
      events with job/run/operation IDs. Provide an application logging hook and
      concise CLI progress on stderr. Redact secrets and avoid copying raw
      records into diagnostic logs.
- [x] G4. Document and test backup/restore, interrupted runs, lost claims,
      schema upgrades, expired cursors, stale checkpoints, and corruption.
      Recovery must distinguish rescan of observations from re-execution of
      repairs.
- [x] G5. Define evidence retention and explicit pruning so accepted plans
      retain their dependencies. Document local access permissions and the
      sensitivity of raw evidence. Keep credentials outside reports and exported
      configuration.
- [x] G6. Publish repeatable scenarios and the measured support envelope. Keep
      small deterministic checks in regular CI and run larger seeded/performance
      suites separately with failure artifacts and seeds.

Acceptance gate: HTTP fixture scenarios cover duplicate delivery, late updates,
rate limits, outages, cancellation, and lost acknowledgements. Replay a bounded
range twice and prove unchanged live checkpoints and zero duplicate repair
effects. Restore a backup, run its recovery procedure, and preserve prior audit
interpretations. Run logs contain no fixture secrets.

## H. Ship a package people can integrate

Depends on B through G. Packaging checks begin during C, then become a required
release gate here.

- [x] H1. Finalize public exports, generic types, error codes, JSON schemas,
      compatibility policy, and semantic versioning. Validate package metadata,
      license, runtime requirements, source-map paths, and shipped file
      contents. Choose and confirm a registry package name before removing
      `private`.
- [x] H2. Pack a tarball, install it into a separate temporary TypeScript
      project, compile a consumer, import the public API, and execute the
      installed CLI. The consumer cannot access repository files, undeclared
      dependencies, or dev tooling. Test bundled demo asset resolution from an
      unrelated directory.
- [x] H3. Keep a short README with the install command, one working example,
      status, and documentation links. Ship detailed guides for adapter authors,
      normalization, ownership, plans, writes, replay, upgrades, and recovery.
      Run documentation examples as consumer tests.
- [x] H4. Require `pnpm check`, adapter contracts, compiled workflow scenarios,
      migration tests, and the package-consumer test on Linux and Windows. Add
      macOS or additional Node versions only when declaring support and testing
      them. Make performance budgets measurable on a named runner.
- [x] H5. Produce a release candidate with changelog, compatibility notes, and
      documented limitations. Rehearse the entire acceptance scenario below from
      a clean install. Publishing a package is a separate explicit release
      action.

Acceptance gate: a person using only the README and the installed tarball can
complete the 1.0 workflow against disposable data. No undocumented repository
setup or manual database edit is needed. Publishing follows only after all gates
pass and the release is explicitly authorized.

## Required end-to-end scenarios by completion

| Scenario                                          | Observable proof                                                                             | First required phase |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------- |
| Fresh comparison and restart                      | Valid JSON, useful terminal output, saved evidence, zero rereads of committed unchanged data | A                    |
| Failed read or rejected apply                     | Inputs unchanged, no new committed result or advanced checkpoint                             | A                    |
| Scalar/nested values and identity collisions      | Correct diff or explicit conflict, never a silent match                                      | B                    |
| Duplicate/stale/late revisions and shuffled pages | Results independent of page size and legitimate delivery variation                           | B                    |
| Incomplete snapshot or tombstone                  | No deletion inferred from an incomplete read                                                 | B                    |
| Application and custom adapter                    | Public imports and the same configuration work outside the repository                        | C                    |
| Actual process crash and concurrent writers       | Resume equals an uninterrupted result, no stale checkpoint overwrite                         | D                    |
| Schema, policy, or dataset change                 | Explicit rejection or migration, historical reports unchanged                                | D                    |
| Plan review and target drift                      | Exact accepted digest, unchanged target until apply, stale writes rejected                   | E/F                  |
| Partial repair and lost acknowledgement           | Durable outcome, safe restart, second apply has no further effects                           | F                    |
| Replay, outage, cancellation, and restore         | Bounded work, unchanged normal checkpoints, complete evidence and recovery                   | G                    |
| Installed package and documented examples         | Consumer compiles and runs the workflow without source-tree imports                          | H                    |

The final rehearsal is install, configure two independent adapters, compare,
inspect evidence, plan, accept selected operations, apply, interrupt, resume,
compare again, apply again, replay a range, and inspect the audit history. It
must include an unresolved conflict and a concurrent target update so success
does not depend on silently resolving either.

## Delivery discipline and definition of done

### Execution and commit loop

1. Start from the latest local checkpoint. Inspect the worktree and preserve
   unrelated changes. Select the next slice in the schedule and its acceptance
   scenario from the corresponding phase above.
2. Add a focused behavioral test when the slice introduces or fixes behavior.
   Confirm the failure is the intended one before implementing a bug fix. Keep
   tests and implementation together in the completed commit.
3. Implement the smallest complete behavior, update its documentation, and run
   the focused tests while editing. Use the watch loop for rapid feedback.
4. Run `pnpm check` before each implementation commit. Extend that command as
   contract, migration, recovery, and package-consumer checks become available.
   For a documentation-only commit, formatting and link/example verification are
   sufficient when the implementation is already verified and unchanged.
5. Inspect the complete diff, stage only the paths for that slice, and create a
   local Conventional Commit. Record completed roadmap items and current limits
   in that same commit. Do not commit failing tests, bypass hooks, or label an
   incomplete feature as done.
6. Continue to the next slice after committing. A commit is a recovery point,
   not a request for permission or a reason to stop execution. Report the latest
   checkpoint and remaining work when handing off.

Commit after each completed slice rather than waiting for an entire phase or
committing on a timer. If a slice grows beyond one independently testable
behavior, split it into smaller passing commits and update the schedule before
continuing. Keep coupled migrations, implementation, tests, and docs together.
An interrupted slice stays uncommitted with a clear status; do not manufacture a
passing checkpoint by skipping verification.

At each phase boundary, run its full acceptance scenario in addition to the
standard checks. Complete any missing acceptance coverage in a separate tested
commit before entering the next phase. Checkpoints are local commits; pushing,
publishing, deployment, and live-system access are separate actions.

### Commit schedule

Suggested subjects describe the intended completed behavior. Adjust wording or
split a row when implementation reveals a better boundary. The roadmap item IDs
remain the coverage checklist even when one item needs several commits.

| Work item                              | Local commit checkpoint                                                     |
| -------------------------------------- | --------------------------------------------------------------------------- |
| A, current baseline                    | `chore: establish verified implementation workflow`                         |
| B1, JSON type preservation             | `fix(core): preserve JSON values during normalization`                      |
| B1, validation and numeric rules       | `fix(core): reject invalid values and ambiguous timestamps`                 |
| B1, stable ordering                    | `fix(core): make comparison ordering independent of locale`                 |
| B2, versioned policies                 | `feat(core): configure versioned normalization policies`                    |
| B2, identity and field rules           | `feat(core): support explicit matching and comparison rules`                |
| B3                                     | `fix(core): preserve evidence for invalid and duplicate identities`         |
| B4                                     | `feat(core): distinguish duplicate stale and conflicting revisions`         |
| B5                                     | `feat(core): distinguish complete snapshots from incremental updates`       |
| B6, cursor behavior                    | `fix(adapters): validate cursor progress and ledger ordering`               |
| B6, dataset changes                    | `feat(adapters): detect replaced inputs and require explicit rescans`       |
| C1                                     | `feat(core): define typed reconciliation jobs`                              |
| C2                                     | `refactor(storage): expose the reconciliation store contract`               |
| C3                                     | `feat(api): expose comparison errors events and cancellation`               |
| C4                                     | `feat(adapters): provide typed helpers and shared contract tests`           |
| C5                                     | `feat(cli): load validated job configurations and custom adapters`          |
| C6, application examples               | `docs(examples): demonstrate embedded reconciliation and custom adapters`   |
| C6, HTTP fixture                       | `feat(examples): exercise HTTP reconciliation without external services`    |
| C7                                     | `feat(cli): define report formats and stable exit codes`                    |
| C acceptance, early H2 check           | `test(package): verify public imports from a packed consumer`               |
| D1                                     | `feat(storage): migrate and validate versioned reconciliation state`        |
| D2                                     | `fix(storage): isolate checkpoints by job dataset and policy`               |
| D3, durable page progress              | `feat(storage): commit observations with page checkpoints`                  |
| D3, restart and finalization           | `feat(core): resume interrupted runs before publishing results`             |
| D4, bounded comparison                 | `perf(core): compare indexed observations in bounded batches`               |
| D4, report streaming and C7 completion | `feat(reports): stream results without loading complete reports`            |
| D5                                     | `fix(storage): reject stale concurrent reconciliation writers`              |
| D6                                     | `feat(cli): inspect back up and rebuild comparison state`                   |
| D acceptance and G6 baseline           | `test(storage): prove crash recovery migrations and processing limits`      |
| E1                                     | `feat(plans): require explicit direction and field ownership`               |
| E2                                     | `feat(plans): generate deterministic bounded repair operations`             |
| E3                                     | `feat(plans): bind acceptance to immutable plan contents`                   |
| E4                                     | `feat(cli): create inspect export and accept repair plans`                  |
| F1                                     | `feat(adapters): add a capability-checked disposable repair target`         |
| F2, apply validation only              | `feat(repairs): validate accepted plans and target preconditions`           |
| F3, durable operation state            | `feat(storage): record repair intent and operation outcomes`                |
| F2/F3, execution                       | `feat(repairs): apply accepted operations with durable audit records`       |
| F4                                     | `fix(repairs): recover safely from uncertain write outcomes`                |
| F5                                     | `feat(repairs): resume partial plans with bounded retries`                  |
| F6                                     | `feat(repairs): verify target convergence after applying a plan`            |
| F acceptance                           | `test(repairs): prove crash recovery and repeated apply idempotency`        |
| G1                                     | `feat(replay): replay bounded ranges without advancing normal checkpoints`  |
| G2                                     | `feat(runtime): bound timeouts retries and cancellation`                    |
| G3                                     | `feat(observability): emit correlated events and redact diagnostics`        |
| G4                                     | `feat(recovery): restore backups and recover stale state safely`            |
| G5                                     | `feat(storage): prune evidence while preserving accepted plan dependencies` |
| G6                                     | `test(scenarios): publish reproducible fault and performance checks`        |
| H1                                     | `chore(package): finalize public contracts and release metadata`            |
| H2                                     | `test(package): verify installed CLI types exports and demo assets`         |
| H3                                     | `docs: document the complete integration and recovery workflow`             |
| H4                                     | `ci: enforce consumer migration and workflow acceptance checks`             |
| H5                                     | `chore(release): prepare the verified 1.0 release candidate`                |

The early package check uses a local tarball and the provisional read API. H2
expands it to the complete installed workflow after repair and replay exist. F2
validation performs no writes; actual execution begins only once F1 writer
capabilities, F2 preconditions, and F3 durable intent are implemented and
tested. Add fault tests alongside those behaviors rather than postponing them
until the phase acceptance commit.

### Completion gate

Keep each slice to one observable behavior and include its tests, relevant docs,
migration impact, and a way to reproduce it from a clean checkout. Do not mark a
phase complete because its API exists; its acceptance gate must pass.

Mark 1.0 implemented only after all A through H implementation items and local
acceptance gates pass, supported CI jobs are green, and the release candidate
can repeat the complete workflow. Package publication is tracked separately from
implementation completion. Do not estimate progress as a percentage of checked
boxes or add dates before the next slices are understood.

The original implementation items have local acceptance evidence. The release
review follow-up above must also pass before declaring the candidate ready.
`pnpm check` covers source and schema tests plus compiled CLI and
installed-consumer scenarios. `pnpm benchmark` covers 100,000 records per side;
the performance workflow adds 256 generated delivery/page seeds. See
`docs/performance.md` for measurements. Registry-name confirmation and explicit
publication approval remain separate from verification of the review fixes and
the candidate's supported CI jobs.

## Outside the bounded 1.0 release

Hosted scheduling, dashboards, an approval web UI, automatic deletion,
bidirectional writes within a job, a catalog of vendor connectors, distributed
workers, additional database backends, and general ETL transformations are
separate proposals. Existing schedulers can invoke the CLI; applications can
call the library. A real provider adapter can follow the contract in an
explicitly authorized sandbox after the local workflow is proven.
