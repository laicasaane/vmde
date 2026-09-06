# Task 547 — Propagate the canonical Marketplace publisher casing

**Status:** done — 2026-09-06 · **Impact:** 🟡 release identity / tooling compatibility · **Origin:** Azure preview run 38 and Project Owner report

## Problem

Commit `1b3dbc3504d96a064177cf72966ef6daccf22250` correctly changed the manifest publisher from
`laicasaane` to the Marketplace publisher's canonical `Laicasaane` casing. The rest of the
repository still encodes the former casing in runtime identity lookups, real-VS-Code tests,
documentation, and archive verification. Azure preview run 38 therefore stopped in **Run unit
tests** before version derivation, packaging, artifact publication, or Marketplace publication:
`test/backend/manifest.test.ts` expected the stale lowercase publisher.

## Scope

- Make `Laicasaane.vmde` the current extension identity in runtime code, active tests, skills, and
  user/developer documentation while preserving lowercase GitHub repository URLs and historical
  completed-task evidence.
- Keep stale saved Vditor resource paths from either publisher casing removable after an upgrade.
- Make Azure preview/release archive verification and the local **Preview: package local VSIX**
  workflow reject a VSIX whose embedded package or VSIX identity drifts from the selected manifest.
- Preserve pipeline triggers, audits, package-once behavior, artifact paths, Entra-only credential
  scope, and all GitHub workflows.

## Acceptance

- [x] The focused manifest/product/command/sanitizer tests pass with the canonical casing, after
      failing against the stale identity authority.
- [x] The local preview core and end-to-end helper validate name, publisher, version, and prerelease
      metadata and reject publisher drift before copying an artifact.
- [x] Both Azure pipelines verify `Laicasaane` and `vmde` in both embedded manifests before artifact
      publication; their parsed-YAML contract test passes.
- [x] A fresh build and the no-retry real-VS-Code identity contract prove VS Code reports
      `Laicasaane.vmde` exactly.
- [x] Applicable static, coverage, packaging, and quality gates pass; the task record and index are
      closed in one focused local commit without touching `LOCAL_AGENT_TASK.md` or pushing.

## Verification evidence

- Azure preview run 38 checked out `1b3dbc3` and first failed in **Run unit tests**. The exact result
  was one stale manifest expectation failure, 254 passing files / 3,558 passing tests; version
  derivation, packaging, artifact publication, and Marketplace publication did not run.
- RED: focused manifest/product/command tests failed on the lowercase runtime authority; the
  sanitizer test retained a canonical-cased installed-extension path; the parsed Azure contract
  failed for both pipelines; the local preview core failed its missing publisher and identity
  checks; and real VS Code reported `canonicalInstalled: false` for the stale lowercase exact ID.
- GREEN: the focused runtime suite passes 168/168. The focused local core/shared-validator/Azure
  suite passes 42/42. The guarded local preview integration suite passes 26/26 outside the
  restricted sandbox, including independent package-publisher, VSIX Identity Publisher, and VSIX
  Identity Id rejection. Focused core coverage passes 16/16 and exercises the archive identity
  branches.
- The exact VS Code **Preview: package local VSIX** command completed from **Include local edits**.
  `artifacts/vmde-1.5.11-preview-1b3dbc3.vsix` embeds package publisher `Laicasaane`, VSIX Identity
  Publisher `Laicasaane`, Id `vmde`, prerelease `true`, and excludes `LOCAL_AGENT_TASK.md`.
- Both changed Azure verification scripts pass `bash -n`; the parsed-YAML contract passes. They use
  the same bounded ZIP/manifest validator as the local preview task, with separate prerelease and
  production modes. Pipeline triggers, audit stages, package-once behavior, artifact/publish paths,
  Entra credential scope, and all hashed GitHub workflows remain unchanged.
- A fresh `node build.mjs` passes. Webview, strict-subset, and VS-Code-e2e typechecks pass; bundle
  size remains 608/608 KB and startup cost remains 294/294 modules.
- Real VS Code 1.129.0: `identifier-contract.spec.ts --retries=0` passes 1/1 after its pre-fix exact
  identity failure. The smoke tier passes 10/10 in one attempt with the canonical ID across direct
  activation call sites.
- Final implementation-candidate `npm run quality` passes brand checks, lint, knip, jscpd,
  dependency boundaries, all three audits, full coverage (260 files / 3,759 tests), and the
  13-module zero-coverage ratchet.
- Independent staged-diff review initially found that separate whole-document Azure greps could
  false-pass and that XML identity mismatch branches lacked negative coverage. The shared validator
  and independent fixtures resolve both findings; re-review reports no Critical or Important issue.
