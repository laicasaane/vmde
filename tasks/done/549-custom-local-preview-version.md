# 549 — Customize the local preview VSIX version

**Status:** done (2026-09-06)

> **Source:** Project Owner request, 2026-09-06
> **Value / Risk:** low-risk local release-tooling convenience

## Goal

Let the `Preview: package local VSIX` task present the calculated numeric preview version as an
editable terminal field before packaging, while preserving the calculated value for non-interactive
automation.

## Scope

- [x] Keep the existing committed/local-edits snapshot picker.
- [x] Focus and reveal the task terminal for the version field.
- [x] Prefill the field with the existing artifact-counter calculation.
- [x] Accept a custom numeric `X.Y.Z` value and use it consistently in the temporary manifests,
      VSIX metadata, validation, and artifact filename.
- [x] Preserve the calculated default for non-interactive callers and accept an explicit CLI value
      for deterministic automation.
- [x] Complete focused tests, formatting, coverage, task tracking, and a local commit.

## Verification

- [x] Record a failing focused contract/integration test before implementation.
- [x] Run the local-preview core and integration suites.
- [x] Run changed-file formatting/lint and changed-line coverage.
- [x] Inspect the final diff and staged paths; keep `LOCAL_AGENT_TASK.md` untouched and uncommitted.

## Evidence

- RED: the focused terminal-prefill test failed because `choosePreviewVersion` was not exported; the
  task contract also failed because the preview terminal was not focused. The first fixture-suite
  run additionally hit the managed sandbox's known `spawnSync ... EPERM` restriction, so fixture
  evidence was rerun outside the sandbox.
- GREEN: `npx vitest run test/backend/package-local-preview.test.ts
  test/backend/package-local-preview-core.test.ts` passed 45/45. This covers the editable
  calculated prefill, explicit custom numeric version, invalid-version rejection, calculated
  non-interactive fallback, VSIX metadata/filename consistency, and the existing cleanup and
  primary-state safety contracts.
- Focused instrumentation passed the same 45/45 tests and reported 82.4% line coverage for
  `package-local-preview-core.mjs`. The CLI wrapper reported 10.09% because its integration paths run
  in spawned Node processes outside Vitest instrumentation; the new interactive chooser is exercised
  directly. A narrowed invocation of the normal source-only coverage configuration predictably
  reported 0% against its unrelated global source include and failed thresholds, so it is not used
  as behavior evidence.
- Biome, both Node syntax checks, and `git diff --check` passed. The one `npm run quality` invocation
  passed lint, knip, jscpd, dependency boundaries, all three audits, 3,762-test coverage, and the
  zero-coverage ratchet. Its brand stage exposed that Task 548 had removed Task 547's historical-name
  allow-region markers from `CHANGELOG.md`; restoring those markers in separate commit `93a9283`
  made `npm run check:brand-identifiers` pass across 2,061 tracked paths. The aggregate command was
  not rerun because the local testing policy permits only one quality invocation per task.
- Chromium and real-VS-Code suites were intentionally omitted: this changes a local task and Node
  packaging helper, not extension-host or webview behavior.
