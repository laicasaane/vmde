# Task 694 — PlantUML loads a third engine instance where at most two are allowed

**Status:** done (2026-11-02); Part 1 handoff and Part 2 fix recorded. Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec files alone (2026-11-02).
**Severity:** medium (estimated; each extra engine load costs time and memory on documents with mixed PlantUML types).
**Tech stack:** `test/vscode-e2e/plantuml-typeswitch.spec.ts`, `test/vscode-e2e/plantuml-family-matrix.spec.ts`; the PlantUML engine routing (class versus non-class engine, `renderedIsClass`) in `media-src/src/diagrams/plantuml/plantuml-render.ts`.
**Depends on:** none.

## Problem

Four cases fail alone and in the suite:

- `plantuml-typeswitch.spec.ts:17`: 3 engine instances after class and non-class type switches; at most 2 are allowed.
- `plantuml-family-matrix.spec.ts:46`: 8 of 9 diagram families rendered within the wait (2.1 min run).
- `plantuml-family-matrix.spec.ts:161`: the C4 block no longer trips the safety net from a wrapped `A` in its label (expected `true`, received `false`).
- `plantuml-family-matrix.spec.ts:273`: 3 engines where 2 are expected after keywords in note, legend or title bodies.

The cases may share one cause (an extra engine import). Not measured. The first bad commit is unknown.

## Proposed work

1. Find the first bad commit by running both spec files alone on earlier `dev` revisions.
2. Measure which block triggers the third import and why.
3. Fix with a failing test first, or update the test if the expected behavior changed on purpose (cite the task that changed it).

## Acceptance

- [x] The cause and the triggering layout are recorded (Part 1; no first bad commit exists, see the amended acceptance below).
- [x] The four cases pass in real VS Code (Part 2 run: 4 passed).
- [x] No product code changed; the build-configuration fix has a Vitest regression test (`test/backend/bundle-layout.test.ts`, 3 cases).

## Tests to write

- A Vitest case on the engine routing for the triggering block.

## Part 1 handoff (2026-11-02)

### M1 — the four cases at head (`06a2fb3e`)

`node build.mjs` exited 0. Both spec files ran alone in real VS Code (`--workers=1 --retries=0`), exit 1:

| Case | Result | Failure |
| --- | --- | --- |
| `plantuml-family-matrix.spec.ts:46` | fail (2.1 min) | 8 of 9 blocks rendered within the 120 s wait |
| `plantuml-family-matrix.spec.ts:161` | fail (7.8 s) | `records[0].engineDiscarded` is `false` |
| `plantuml-family-matrix.spec.ts:273` | fail (27.4 s) | 3 engine loads, 2 expected |
| `plantuml-typeswitch.spec.ts:17` | fail (27.5 s) | 3 engine loads, at most 2 allowed |

The timing records logged by `:161` show the decisive facts:

- The two blocks waited 3.5 ms and 6.3 ms in the queue. With one serialized queue the second block waits for the whole first render (about 600 ms).
- Both blocks paid a cold `nonClass` import (280 ms and 321 ms), but the first record has no discard.
- The records finished out of document order: the sequence block (no stdlib) came first and the C4 block (stdlib expansion 369 ms) came second. The C4 block still trips the safety net (`engineDiscarded: true`), but in the second record, so the case reads the wrong record.

These facts mean two independent render queues and two independent engine registries in one window.

### Source reading

- Engine instances are created only in `loadPlantumlEngine` (`media-src/src/diagrams/plantuml/plantuml-render.ts`). It imports `plantuml.js` once per category (`class`, `nonClass`) with a distinct URL per category and discard revision, caches the render function in the module-level `engines` record, and adds 1 to the window-global counter `__vmdePumlEngineLoads`.
- The only other way to get a new instance is the safety net in `renderPlantumlBlock`: when `renderedIsClass` disagrees with the routing, it clears that category, and the next block of that category imports again.
- All engine work runs through the module-level `renderQueue` (Task 347), so the shared engine never runs two renders at once.
- The "at most two" limit protects the dual-instance design (Tasks 178 and 350): the engine keeps diagram-type state across renders, so one warm instance per category avoids both poisoning and the 7 MB re-import on each class and non-class switch. Task 429 added the load-count coverage.

**Cause found.** The built `media/dist/main.js` contains two copies of `loadPlantumlEngine`. The esbuild metafile lists two inputs for `plantuml-render.ts`: the worktree's own copy and the main checkout's copy.

- The worktree's `media-src/node_modules` is a symbolic link to the main checkout's `media-src/node_modules`.
- `patchPlantumlRender` (`media-src/esbuild-shared.mjs`) replaces Vditor's `plantumlRender.ts` with a shim that imports `../../../../../src/diagrams/plantuml/plantuml-render`, a path relative to `node_modules/vditor/src/ts/markdown/`.
- esbuild resolves symbolic links to real paths by default, so this relative path lands in the main checkout's `media-src/src/`.
- `render-cache-client.ts` imports the worktree copy directly. Vditor's preview render, `plantuml-retheme.ts` and `preview-render.ts` reach the main-checkout copy through the shim.
- Two module instances mean two `engines` records and two `renderQueue`s. Both copies add to the same window counter. The typeswitch document therefore counts 3 loads. Two engine instances render concurrently, and one of 9 blocks can fail to draw within the wait.

A scratch bundle of `src/boot/main.ts` with the same configuration gives 2 counter copies. With `preserveSymlinks: true` it gives 1 copy and one `plantuml-render.ts` input, and the build exits 0.

The scope is wider than PlantUML. A symbolically linked build takes 20 modules from the main checkout through the six shim imports (`plantuml-render`, `graphviz-render`, `html-comment`, `svg-data-image-adapter`, `preview-raw-headings`, `math-source`) and their dependencies. Examples are `engine-registry.ts`, `load-script.ts`, `observe-coalesce.ts` and `mutation-impact.ts`. Every module with module-level state is duplicated. When the main checkout is at a different revision, the worktree build also ships that revision's code for those modules. Done Task 480 already documents this layout trap ("Do NOT symlink `media-src/node_modules`").

**Recent commits on the path (Tasks 641–696).** `6dede194` (Task 643) added `preview-render.ts` as another shim caller. Nothing else in the range touches the PlantUML render path or the two specs, which last changed on 2026-09-06. The duplicate does not depend on any product commit. It appears whenever the build runs with a symbolically linked `media-src/node_modules`. The direct import in `render-cache-client.ts` has existed since `e22e3a16` (Task 460). The gate worktree for `dc622900` used the same layout.

**Last known pass.** No pass is recorded in a worktree that uses this layout. The cases passed at their closing tasks (350 and 429), which used a normal checkout. There is no first bad commit in product history, because the trigger is the build layout.

### Ranked causes

1. Duplicate module instances from the symbolically linked `media-src/node_modules` (shim relative import resolved through the link): 0.95. Static proof: the metafile inputs and the counter copies; the `preserveSymlinks` bundle has one copy. The real-VS-Code pass after the fix is not yet measured.
2. A product regression in the engine routing or the safety net, independent of the layout: 0.03. Nothing in the range touches it, and every failure fits cause 1.
3. A test-only timing defect (for example a `:46` wait too short under load): 0.02. It could hide behind cause 1 for `:46` only.

**Classification.** Test-environment (build layout) defect. It is neither a product defect nor a test defect. The packaged extension and CI build from a real `node_modules`, so users are not affected.

Provisional decision (2026-11-02), reversible — classification: test-environment defect. Amend the acceptance: "first bad commit" becomes "triggering layout recorded", and the Vitest item applies to the build-configuration change (probability 0.98).

Provisional decision (2026-11-02), reversible — Part 2 fix: set `preserveSymlinks: true` in `vditorSourceConfig`, which the build and the e2e harness share. Also add a build guard that fails when a metafile input of `main.js` resolves outside this repository's `media-src/src` for a path that the repository itself contains. Alternatives considered: `preserveSymlinks` only (0.09), guard plus copied `node_modules` (0.03), close with no code change (0.00); chosen option 0.87. Reason: the parallel-worktree layout keeps working, a future out-of-tree input is caught at build time, and a normal checkout bundles the same inputs as before.

### Part 2 plan

Tier: medium (a mid-tier implementation route at high effort, or a top-tier route at medium effort). The contract is settled and the change touches 2 build files plus 1 test. The proof needs one real-VS-Code run.

1. RED: write a Vitest case (for example `media-src/esbuild-shared.test.ts`, or extend an existing build-config test). It bundles `src/boot/main.ts` from a temporary tree whose `node_modules` is a symbolic link and asserts that the metafile has exactly one `plantuml-render.ts` input and no input outside the tree. If a temporary tree is too heavy, assert the guard function on a constructed metafile and assert `vditorSourceConfig.preserveSymlinks === true`. Confirm it fails at head.
2. Fix: add `preserveSymlinks: true` to `vditorSourceConfig`. Add the metafile guard in `media-src/build.mjs` next to the existing metafile write. Check that the e2e harness server, which shares the configuration, still builds.
3. Closure checks: `node build.mjs`. Then confirm that `media/dist/main.meta.json` has one `plantuml-render.ts` input and zero inputs under the main checkout. Then run the four cases once in real VS Code in this worktree, with the symbolic link left in place: `plantuml-typeswitch.spec.ts plantuml-family-matrix.spec.ts --workers=1 --retries=0`. Expect 4 passes. Then the focused Vitest case and `npm run quality`.
4. Stop rule: if any of the four cases still fails with a single module copy, stop. Record the failure, then classify it again as cause 2 or 3, with the timing records from `:161` and `:46` as evidence. Do not bisect product history unless that failure also reproduces on a normal checkout.
5. Follow-up note for the orchestrator (outside this task's scope): every worktree build since the symbolic-link layout came in has bundled 20 main-checkout modules. Results from worktree real-VS-Code runs that touch those modules came from a mixed build. That matters only when the main checkout was at a different revision during the run.

## Part 2 (2026-11-02)

Provisional decision (2026-11-02), reversible — the parallel worktree layout keeps linking `media-src/node_modules` (an Owner run rule). The build fix makes that layout safe. The two Part 1 decisions stand: test-environment defect, and `preserveSymlinks: true` plus an outside-repository input guard.

Amended acceptance: "first bad commit" became "triggering layout recorded". The trigger is the linked `media-src/node_modules`, not a product commit.

### Changes

- `media-src/esbuild-shared.mjs`: `vditorSourceConfig` sets `preserveSymlinks: true` (shared by `build.mjs` and the e2e harness), with a comment on why. New export `findInputsOutsideRepo(metafile, repoRoot, cwd)` lists metafile inputs that resolve outside the repository.
- `media-src/build.mjs`: after the main bundle, the build prints the outside inputs and exits 1 if there are any.
- `test/backend/bundle-layout.test.ts` (new, 3 cases): the shared config sets `preserveSymlinks`; a small tree that mirrors the worktree layout (linked `node_modules` whose package imports the repository's shared module by a relative path) bundles two copies without the option and one with it; the guard reports an input outside the repository and accepts in-repo inputs.

### Evidence

- RED at head, before the fix: 3 of 3 cases failed: `expected undefined to be true` (config), `expected [ 'src/shared.ts', …(1) ] to have a length of 1 but got 2` (duplicate), `TypeError: findInputsOutsideRepo is not a function` (guard).
- GREEN after the fix: `Tests  3 passed (3)`.
- `node build.mjs`: exit 0, guard passed. `media/dist/main.meta.json` has exactly one input `src/diagrams/plantuml/plantuml-render.ts` and no input outside the repository; `main.js` has one `__vmdePumlEngineLoads` counter copy (two before).
- One real-VS-Code run with the link in place, `plantuml-typeswitch.spec.ts plantuml-family-matrix.spec.ts --workers=1 --retries=0`: exit 0, 4 passed (32.3 s). `family-matrix:46` 8.8 s (was 2.1 min and failing), `:161` 7.3 s, `:273` 6.5 s, `typeswitch:17` 6.3 s.
- `npm run typecheck`: exit 0. `npx biome check` on the three changed files: clean after `--write` formatting.
- `npm run quality`: lint, brand identifiers, knip, jscpd, dependency-cruiser, unit coverage and the zero-coverage ratchet (9 modules, baseline 9) pass. The `audit` stage fails; the Owner omitted it from this run, and it is not related to the change (it runs `npm audit`).

### Normal (non-linked) checkout

Not built in the main checkout. In a normal checkout `media-src/node_modules` is a real directory inside the repository, so every bundled input already resolves under the repository root and `preserveSymlinks` has no link to keep. The guard rule is "resolved path is outside the repository root", which a non-linked tree cannot trigger. The linked build here also reports zero outside inputs, and its input set is the same set of paths a normal checkout produces.

### Stop rule

Not applied: all four cases passed with a single module copy.

### Remaining risk

Earlier real-VS-Code results from linked worktrees that touched the 20 shared modules came from a mixed build (see Part 1). Rebuild before trusting them.
