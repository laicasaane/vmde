# Task 641 — Open a Markdown file to ready in about one second

**Status:** planned (2026-10-15).
**Origin:** Project Owner request (chat, 2026-10-15).
**Severity:** performance (every file open).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/webview-host/html-builder.ts`, host prerender), webview boot (`media-src/src/boot/`), Vditor/Lute initialization, bundle size (`media/dist/main.js`, about 0.96 MB).
**Related:** [Task 636](done/636-slow-open-real-profile.md) (slow open on the real profile; wiki scan no longer blocks `init`), [Task 638](done/638-persistent-wiki-page-cache.md) (stored wiki page list), [Task 573](done/573-large-document-open-scroll-performance.md) (large-document open and scroll).

## Problem

Opening a Markdown file still takes noticeably long before the editor is ready. Example (Project Owner): `LOCAL_AGENT_TASK.md` in this repository (about 150 KB) takes more than 3 seconds. Task 636 measured, on the real profile, a cold open median of about 3.3 s after its fix, with the webview created at about 0.5 s and the first paint (prerender) at about 1 s.

## Requested behavior (Project Owner, verbatim)

"Currently the file open and be ready still take significant amount of time, for example the `LOCAL_AGENT_TASK.md` in this repo take more than 3 seconds. Can we reduce this significantly down, up to 1 second for every files?"

## Constraints

- No change to document bytes, dirty state, Undo or editing behaviour.
- Keep Task 573's visible-only work and Task 636/638's wiki behaviour.
- Measure before changing anything; every claim of a saving needs a before/after number from the same setup.

## Acceptance

- [ ] Open-to-ready split into phases (click/command, extension activation, editor resolution, host read and prerender, webview creation, script load and parse, Vditor/Lute init, first content paint, ready, post-ready work) for a small file, a mid-size file and `LOCAL_AGENT_TASK.md`, cold and warm, in a clean profile; the real-profile numbers if the Owner allows that run.
- [ ] A target per file size agreed with the Project Owner after the measurement (the request is about 1 s for every file; what "ready" means — editable, or content visible — is to be confirmed).
- [ ] Changes reach the agreed target, with before/after numbers from the same setup, and no regression in Task 573's gates.
- [ ] Focused real-VS-Code timing spec written and run; network-free gates pass.


## Execution progress — 2026-10-15 (S1, open-to-ready by phase; measurement only)

No product file was changed. Scratch scripts, raw probes, host marks, screenshots and CPU profiles are under the ignored `tmp/641/` (scripts in `tmp/641/scripts/`).

### Setup

- **Profile.** Clean profile per launch (fresh user-data and extensions folders; only the built-in extensions; settings written by the harness: associate `*.md` with the VMDE editor, no startup editor, no telemetry, no workspace trust prompt, no auto-save). VS Code 1.129.0 (Chromium 148) from the test cache, 1600x1000 virtual display, 8 cores. Development build of this checkout (`node build.mjs`, `media/dist/main.js` 1,010,450 B on disk, 987 KB transferred), commit 57ac4e4f.
- **Files.** `small-2k.md` 1,954 B, `mid-30k.md` 30,148 B (both cut at a line boundary from repository documentation), `large-150k.md` 152,252 B (a copy of `LOCAL_AGENT_TASK.md`; its text was never printed or stored in a report). Workspace folder: a scratch folder holding only these three files (wiki links on; no Git repository).
- **Open gesture and t0.** OS-level keys: open Quick Open, type the file name, wait for the row, press Enter. t0 is the trusted Enter keydown timestamp read in the workbench (not the Explorer click; both end in the same editor-open path). "Cold" = the first open after a new launch, taken after the window is idle (workbench rendered, more than 3 s since launch, no long task for 2 s; 6-8 s after launch). "Warm" = the second open of the same file in the same window after the tab was closed (3 launches give 3 cold + 3 `warm1` per size; `warm2`/`warm3` were also taken and are 100-250 ms faster than `warm1` for the 150 KB file).
- **Instruments (no product edit).** (1) Host phase marks from a scratch copy of the development build whose `dist/extension.js` was patched with `performance`-clock appends at: module load, `activate`, Lute load, `resolveCustomTextEditor`, `EditorSession.start`, `renderForMode`, `buildWebviewHtml`, `webview.html` assignment, incremental seed, `onReady`, `postUpdate`, webview message arrival. (2) Webview and workbench probe injected over the debugger protocol in every frame: paint, long-task, long-animation-frame and event-timing observers, resource timing, a 20 ms state poll (prerender teaser, Vditor instance, editor content, teaser removal), host-to-webview message arrival times, trusted pointer and key events. (3) The extension trace-level log channel and a screenshot at ready. (4) CPU profiles over the debugger protocol (1 ms sampling) of the extension host and of the webview, one cold open of the 150 KB file, two launches; function names mapped to source with the build's source maps.
- **"Ready" definitions used.** `first content` = first contentful paint of the host prerender teaser (the first 10,000 characters, not editable). `ready message` = the host receives the webview `ready` command. `editor ready` = the Vditor IR content is built and the teaser is gone (this is when the editor takes input). `quiet` = end of the long-task chain that starts at editor ready (gaps under 500 ms join). `first input accepted` = one OS click sent right after editor ready (about 30-60 ms harness latency) produces a caret inside the editable surface; measured on separate cold launches (clicks sent only after ready, so the cold phases are not disturbed) and on the third warm reopen.
- **Overhead checks.** Instrumented copy against the plain development build, 150 KB cold: 3496 ms (3414-3526) against 3416 ms (3293-3595), 3 launches each, ranges overlap. Profiled launches (1 ms sampling): editor ready 4106 and 4400 ms, so profiling adds about 0.6-0.9 s; profile numbers are used for attribution and ranking, not for absolute time.

### Result — milestones, medians of 3 launches (ms after t0)

| Milestone (ms after the open request) | 2 KB cold | 2 KB warm | 30 KB cold | 30 KB warm | 150 KB cold | 150 KB warm |
|---|---:|---:|---:|---:|---:|---:|
| editor tab visible | 32 | 24 | 31 | 21 | 29 | 19 |
| webview element created (workbench) | 384 | 69 | 402 | 109 | 454 | 126 |
| host: extension bundle load begins | 42 | - | 41 | - | 42 | - |
| host: activate() returned | 67 | - | 66 | - | 69 | - |
| host: Lute prewarm done (async load) | 269 | - | 258 | - | 263 | - |
| host: resolveCustomTextEditor entered | 276 | 34 | 271 | 39 | 286 | 41 |
| host: webview.html assigned | 281 | 36 | 278 | 41 | 295 | 45 |
| host: EditorSession.start() returned | 308 | 48 | 358 | 88 | 404 | 101 |
| webview: document start | 487 | 128 | 518 | 167 | 588 | 183 |
| webview: main.js fetched | 629 | 183 | 777 | 231 | 779 | 243 |
| webview: first contentful paint (teaser) | 696 | 225 | 779 | 352 | 888 | 360 |
| host: `ready` received | 652 | 203 | 842 | 324 | 869 | 323 |
| host: `init` posted | 671 | 205 | 863 | 328 | 1921 | 1114 |
| webview: `init` received | 685 | 215 | 865 | 355 | 1928 | 1123 |
| webview: Vditor instance exists | 703 | 238 | 895 | 377 | 1959 | 1150 |
| webview: lute.min.js fetched | 800 | 334 | 986 | 471 | 2044 | 1221 |
| EDITOR READY (content built, teaser gone) | 1022 | 476 | 1513 | 905 | 3496 | 2468 |
| main thread quiet after ready | 1022 | 476 | 1513 | 905 | 4068 | 3051 |
| first click accepted (caret in editor) (one click at ready; warm = third reopen) | 1022 | 420 | 1603 | 862 | 3470 | 2230 |

| Ready range (min-max over 3 launches) | 2 KB | 30 KB | 150 KB |
|---|---:|---:|---:|
| editor ready, cold | 1022 (978-1326) | 1513 (1501-1629) | 3496 (3414-3526) |
| editor ready, warm1 | 476 (468-755) | 905 (884-974) | 2468 (2455-2665) |

| Duration (ms) | 2 KB cold | 2 KB warm | 30 KB cold | 30 KB warm | 150 KB cold | 150 KB warm |
|---|---:|---:|---:|---:|---:|---:|
| host prerender (Lute teaser) | 23 | 10 | 75 | 42 | 101 | 54 |
| host HTML build | 1 | 0 | 1 | 0 | 1 | 0 |
| host EditorSession.start() | 32 | 14 | 86 | 47 | 117 | 59 |
| host Lute load (vm, 3.7 MB) | 201 | - | 192 | - | 196 | - |
| host incremental seed (full-doc Lute canonicalize) | 1 | 0 | 1 | 0 | 966 | 770 |
| host onReady (until init posted) | 20 | 3 | 21 | 3 | 988 | 780 |
| webview long-task ms in 3 s after ready | 0 | 0 | 131 | 107 | 295 | 281 |
| webview long-task count in 3 s after ready | 0 | 0 | 1 | 1 | 1 | 1 |
| workbench long-task ms in 3 s after ready | 0 | 0 | 0 | 0 | 0 | 0 |

- Host document read is not separable: VS Code reads the file before `resolveCustomTextEditor`; the whole warm span from t0 to that call is 34 / 39 / 41 ms for 2 / 30 / 150 KB (about 7 ms of size-dependent cost over a 75x size range), so file read and model creation are not a contributor.
- Content shows early in every case: first contentful paint of the teaser is at 696 / 779 / 888 ms cold and 225 / 352 / 360 ms warm (2 / 30 / 150 KB). The teaser is the first 10,000 characters (`MAX_PRERENDER_CHARS`, `src/lute/lute-host.ts`), about 7% of the 150 KB file.
- Inline init applies up to 100,000 characters (`InlineInitMax`, `src/session/editor-session.ts:102`); the 150 KB file uses the `ready` then `init` round trip, and `init` is held by the host incremental seed (next section).
- Post-ready work over 3 s: extension host busy 20-28 ms of 3,000 ms (idle); workbench no long task; webview one long task of 107-131 ms (30 KB) and 281-295 ms (150 KB), none for 2 KB. Messages after ready (150 KB cold): `diff-info` at ready +24 ms and `code-refs-resolved` at ready +32 ms; `wiki-update` reaches the webview 31-37 ms after `init` on cold opens (a warm open carries the keys in `init`, no separate message). The syntax-highlight script (1 MB) is requested at document start for a document with a code fence (150 KB: requested at 563 ms, fetched by 793 ms cold) and lazily for the 2 KB file (requested at 987 ms, fetched by 1052 ms cold, about when the editor becomes ready).

### Reference floor — plain text editor, same files (ms after t0, median of 3 launches, range)

| File | cold, text visible | warm1, text visible | all warm (9) |
|---|---:|---:|---:|
| 2 KB | 146 (140-156) | 101 (90-111) | 88 (74-111) |
| 30 KB | 150 (141-153) | 99 (97-103) | 99 (81-105) |
| 150 KB | 158 (153-182) | 124 (102-135) | 106 (86-135) |

The text editor takes about 0.15 s cold and 0.1 s warm for every size. VMDE editor-ready is 7x (2 KB), 10x (30 KB) and 22x (150 KB) the cold floor.

### Where the 150 KB cold time goes (3496 ms, unprofiled medians)

| Span (sequential, from milestones above) | ms | Share |
|---|---:|---:|
| t0 to `resolveCustomTextEditor` entered (extension bundle load 42, `activate` returned 69, host Lute load of 196 ms queued right after `activate` blocks the host before the provider runs) | 286 | 8% |
| provider entered to webview document start (`start()` 118 incl. teaser prerender 101 and HTML build 1; webview element created 454; document start 588) | 302 | 9% |
| document start to `ready` message received by the host (main.js fetch 191, evaluation about 65 ms, a second 65 ms task, teaser painted at 888) | 281 | 8% |
| `ready` received to `init` received by the webview (host incremental seed 966, then post) | 1,059 | 30% |
| `init` received to editor ready (Vditor construction, first render, section-fold glyph alignment, Lute script fetch about 95 ms and evaluation) | 1,568 | 45% |
| editor ready to quiet (history-base serialization, see below) | 572 | after ready |

### The three biggest contributors for the 150 KB file (file:line; from the two profiled cold launches, inclusive ms profiled)

1. **Webview editor construction and first render, init to ready 1,568 ms cold (1,345 warm).** The Vditor constructor (`media-src/node_modules/vditor/src/index.ts:526`) runs 1,440-1,650 ms in the profile, (unprofiled this is one 1.39-1.40 s long task that starts right after the Lute script is fetched). Inside it: the initial Markdown-to-IR render through Lute and the wrapper passes (`src/shared/lute-gap-repair.ts:276` `md` 760-850, `media-src/src/editing/live-line-breaks.ts:124` 800-900, `media-src/src/editing/html-subscript.ts:199` and `media-src/src/links/wiki-serialize.ts:116` html passes); and `runFinishInit` (`media-src/src/boot/finish-init.ts:157`) 548-630, of which `alignListFoldGlyph` (`media-src/src/nav/section-fold.ts:377`, called through `installSectionFold`, `section-fold.ts:1018`) is 467-557 of self time in `getBoundingClientRect` (forced layout, one call per foldable list item). The webview's own top self-time functions are `getBoundingClientRect` (460-490), then GopherJS runtime and Lute parse/render functions (`prelude.js`, `jsmapping.js`, `lute/ast/walk.go:34`, `lute/render/renderer.go:369`), each under 100.
2. **Host full-document Lute canonicalization before `init`, 966 ms cold (770 warm), measured with a host mark; 1,150-1,190 ms in the profile.** `canonicalIrMarkdown` (`src/lute/lute-host.ts:177`) called from `buildIncrementalSeedPayload` (`src/shared/incremental-admission.ts:97`) from `incrementalSeed` (`src/session/editor-session.ts:290`) inside `onReady` (`src/session/editor-session.ts:309`, awaited before `init` is posted, `doc-sync.ts:56` `postUpdate`). The seed reason is `source-structure`; for the 2 KB and 30 KB files the same call returns in 1 ms with no seed. The host is otherwise idle: `ready` arrives at 869 ms and `init` is posted at 1,921 ms.
3. **Cold-only startup chain before the webview exists, 588 ms (document start) of which about 290 ms is host work.** `loadLute` (`src/lute/lute-host.ts:82`) 196-207 ms (reads and runs the 3.7 MB Lute script in the host, queued by `prewarmLute` right after `activate`, so `resolveCustomTextEditor` waits for it), extension bundle evaluation 75-83 ms (`wrapSafe`), `renderForMode` (`src/lute/lute-host.ts:252`) 101 ms for the teaser; then webview element creation and document start 293 ms. It is the same 270-290 ms for all three sizes and is the largest single block of the 2 KB cold open (276 of 1,022 ms).

Next in rank, after ready: the history-base capture. Vditor's IR `process` run (`media-src/node_modules/vditor/src/ts/ir/process.ts:43`) records the first undo entry, the wrapper in `media-src/src/editing/undo-keybind.ts:78` reports it, and `undo-keybind.ts:65` reads the whole document through `historyText` (`media-src/src/boot/vditor-init.ts:430`, `media-src/src/bridge/edit-sync.ts:1379`) to Vditor `getValue` (`media-src/node_modules/vditor/src/index.ts:133`, `ts/markdown/getMarkdown.ts:3`) and the Lute IR-to-Markdown wrapper passes (`wiki-serialize.ts:116`, `html-subscript.ts:199`, `live-line-breaks.ts:131`): 429 ms profiled; unprofiled it is the third webview long task (277-340 ms) that starts about 250 ms after editor ready, and the host receives `history-base` at 4,072 ms. It does not delay editor ready, but it is why quiet comes at 4,068 ms (3,051 warm).

For the 2 KB and 30 KB files the same fixed costs dominate (cold ready 1,022 and 1,513 ms): host startup 276, webview create/boot to the Lute fetch 524-715, Lute evaluation, Vditor construction and render after the Lute fetch 222 (2 KB) and 527 (30 KB) ms.

### Other variants (150 KB, cold / warm1 editor ready, median and range of 3 launches)

| Variant | cold | warm1 |
|---|---:|---:|
| scratch workspace (main matrix) | 3496 (3414-3526) | 2468 (2455-2665) |
| plain development build, no host marks | 3416 (3293-3595) | 2542 (2535-2573) |
| repository folder as workspace (wiki on, Git extension active) | 3928 (3594-4011) | 2635 (2607-2695) |

### Commands and results

- `node build.mjs` in the worktree: exit 0.
- Scratch harness runs, each in its own virtual display with a key-binding-free window manager and XTEST input, one VS Code launch per run, quit by key, leftover check at the end of every run: 9 main-matrix launches (3 per size, cold + 3 reopens), 9 text-editor launches, 9 cold+click launches, 3 plain-build launches, 3 repository-workspace launches, 2 profiled launches (plus one profiled launch at 0.2 ms sampling, discarded as too intrusive). Every launch finished with 0 harness errors. Six text-editor launches first aborted at the start because helper processes of the previous launch (language servers) outlive the main process by about 30 s; the harness now waits for them and those six launches were repeated (all passed).
- Leftover-process check at the end: no VS Code, virtual display, window manager, browser-driver or `sleep` process remained.

### Open

- **Real-profile numbers (acceptance 1)** need the Owner's permission to run on the real profile; this step used clean profiles only. The repository-folder variant adds about 0.4 s cold (3928 against 3496; the ranges do not overlap) and 0.17 s warm; that difference is measured but not attributed (the Git extension, folder indexing and the wiki scan share the host and the workbench there).
- **Target (acceptance 2)** is not yet agreed. Facts for the decision: text is visible (teaser) by 0.7-0.9 s cold and 0.23-0.36 s warm for every size; editor ready is 1.0 / 1.5 / 3.5 s cold; the plain text editor is 0.15 s cold. The editable state for 150 KB depends on the three items above.
- The measurement is n = 3 launches per cell; ranges are shown. Quick Open was used as the open gesture; the Explorer-click path was not repeated here (Task 636 harness measured it on the real profile).

## Owner decisions (2026-10-15, chat, verbatim)

1. "counts as \"ready\" for the 1-second target: content visible; editable (can click and type)"
2. "Fixes 2–5: approve to include in this"
3. "Large files to 1 s: 1. to help this release first: cut it down to roughly 1.5 to 2 s is acceptable 2. defer to after this release: render only what's on screen first and the rest in the background"
4. "My own profile: measure there too"

Orchestrator reading: the 1 s target applies to content visible and editable (first click and typing accepted); this task delivers fixes 2–5 from S1 (send `init` before the host incremental seed; defer the section-fold glyph alignment off the startup path; start the host Lute load earlier, in parallel with activation; move the post-ready history-base capture to idle time), with large files at roughly 1.5–2 s; rendering only what is on screen first is deferred to a later task; the S3 re-measurement includes the Owner's real profile under Task 636's rules (read-only by launch flags, safe backup first, debug-port flags, VS Code closed per batch).


## Execution progress — 2026-10-15 (S2a host)

Scope: fix 2 (post `init` before the incremental seed) and fix 4 (host Lute load at activation). No real-VS-Code run in this step (S3 measures).

### Contract (fix 2)

- The host posts `init` without `incrementalSeed`. On a later timer turn, after the extension host has flushed the `init` post, it computes the seed for the bytes of that `init` and posts it in its own message, `{ command: 'incremental-seed', content, seed }`, where `content` is the normalized `init` content.
- The host drops the seed (no computation, or no post) when the document text no longer equals the `init` bytes, or when any newer `update` was posted after the `init` (even if the text came back), or when the panel was disposed. External updates keep the seed inline as before (Task 537).
- The inline first-paint init (Task 38, documents up to 100,000 characters) no longer carries a seed either. Before, it ran the full-document host Lute pass, and a first Lute load if Lute was not warm yet, inside the editor resolve. The seed follows the `init` echo instead.
- The webview applies a deferred seed only if the editor was built without a seed, no seed came from another route, nothing changed the document or its authority since `init` (no scheduled edit, trusted or untrusted input, Undo-engine change, exact post, reseed or invalidation), no edit is pending, and the editor's host bytes equal the seed's `content`. Otherwise it drops the seed. Then the editor stays on the unseeded path: full serialization below the incremental block gate, or the existing unseeded incremental path (full rebaseline first) at 700 blocks or more.
- Before the seed lands, edits are posted as plain edits with the full serialization. No exact edit is tied to the seed, and the seed never changes `hostBase`, `ownedBase` or the exact pair.
- An accepted seed puts the editor in the same state as an `init` that carried it. Seeding starts at once if the mount already asked for it, or else when the mount asks.

### Fix 4 finding (host Lute load)

- The load already starts at activation and does not block it: `activate` calls `prewarmLute`, which runs the load on a `setTimeout(0)` turn (`src/app/extension.ts`, `src/lute/lute-host.ts` `prewarmLute`). The teaser prerender already uses Lute when it is warm and never loads it itself (`renderForMode` returns no teaser and asks for the load when Lute is cold).
- The extension host has one thread, so the 196 ms synchronous load (`vm` compile plus GopherJS init) runs before the resolve that VS Code sends right after activation. Starting the load earlier or later in the same thread cannot shorten that chain without dropping the first-open teaser (Task 432), and the teaser is the 0.7-0.9 s content-visible milestone.
- Changed in this step: the editor resolve never runs a full-document Lute pass, so it never pays a fresh Lute load (the inline-init seed above). Activation behaviour is unchanged. It stays eager because every activation event in the manifest is a VMDE editor or command event, so there is no activation without Markdown context to keep lazy.
- Measured in a scratch script with plain Node 24, outside VS Code, three to four runs each: read 8-10 ms, compile 66-82 ms, run plus `Lute.New` plus warm-up 115-144 ms. With a V8 code cache (`vm.Script` `cachedData`, produced after the first run, 2.7 MB) the compile was 8-10 ms and the run 69-71 ms, so about 226 ms dropped to about 80 ms. A code cache stored in the extension's global storage would be a new persistent cache file, and posting the teaser after the HTML would be a webview change. Neither is in this step; both are open for a decision.

### Files changed

- `src/writeback/doc-sync.ts`: `deferIncrementalSeed` on `postUpdate`, the deferred seed post, its staleness checks, and the timer cancel on dispose.
- `src/session/editor-session.ts`: the `init` after `ready` defers the seed, and the inline init carries none.
- `src/shared/protocol.ts`: the `incremental-seed` host message.
- `media-src/src/bridge/message-router.ts`: the handler and its required-field entry.
- `media-src/src/bridge/edit-sync.ts`: `receiveDeferredSeed` and the open-window state, which closes on any change.
- Tests: `test/backend/doc-sync.test.ts`, `test/backend/editor-session.test.ts` (the Task 537 test that expected the seed inside `init` now expects it in its own message after `init`), `media-src/src/bridge/edit-sync.test.ts`.

### Tests mapped to acceptance and edge cases

| Test | Proves |
|---|---|
| doc-sync: posts init before the seed is computed, then the seed in its own message | `init` first, then the seed message, with normalized content |
| doc-sync: drops the seed when the document changed before it was computed | stale seed after a document change |
| doc-sync: drops the seed when a newer update was posted, even if the text came back | stale seed after a newer update |
| doc-sync: posts nothing when not eligible, and nothing after dispose | no message without a seed, and none after dispose |
| editor-session: posts init before computing the seed and sends the seed in its own message after it | ordering through the real session (`ready`, then `init`, then compute, then seed) |
| editor-session: drops the deferred seed when the document changes before it is computed | stale seed through the session |
| editor-session: starts the Lute load at activation and resolves an eligible editor without a fresh load | activation asks for the load; resolve and inline init run no Lute pass |
| edit-sync: edits before the seed use full serialization and plain posts; the late seed is then dropped | before the seed: unseeded path, no exact post; a seed after an edit is dropped |
| edit-sync: a seed for the untouched init bytes seeds the cache and the next edit is incremental | after the seed, the incremental path resumes |
| edit-sync: drops a seed computed for other bytes than the init | seed for an older document version |
| edit-sync: holds a seed that lands before the editor mounts until the mount starts seeding | early seed |

Failing first: with the five product files reset to their committed versions and the new tests in place, 9 of these tests failed: the 8 ordering, drop and seed tests, plus the resolve case of the activation test. The guard cases passed on the committed code too, as expected, because the committed code never sends a deferred seed. All pass with the change.

### Commands and results

- `npx vitest run --config test/vitest.config.mts` on the three touched test files, the 29 test files that import the changed modules, `test/backend/module-boundaries.test.ts` and `test/backend/lute-host.test.ts`: exit 0, 34 files, 1353 tests passed.
- `npm run typecheck`: exit 0. `npx tsc --noEmit -p ./`: exit 0. `npm run lint`: exit 0. `npm run knip`: exit 0. `npm run depcruise`: exit 0, no violations (host and webview).
- `node build.mjs`: exit 0.

### Open

- Real-VS-Code verification and the before/after timings belong to S3. Specs to run there: `incremental-seed.spec.ts` (it polls the seed state until `ready`, which now follows a separate message), `edit-propagation.spec.ts` and `mutation-local-helpers.spec.ts` (they read the seed state).
- Fix 4 needs a decision on the code cache or the teaser by message (see above). Without one of them, this step does not shorten the cold chain before the webview exists.

## Execution progress — 2026-10-15 (S2a fix 4)

Owner decision (2026-10-15, chat, verbatim): "Task 641 fix 4 go with cache code"

### What changed

- `src/lute/lute-host.ts`: the host loads `lute.min.js` with `vm.Script` and V8 `cachedData`. `configureLuteCodeCache(globalStorageDir, extensionVersion)` sets the cache folder `<global storage>/lute-code-cache`; without a storage folder there is no cache, and nothing falls back to another location. The cache file is `lute-<key>.bin`, where the key is a hash of the extension version, the SHA-256 of the Lute script, `process.versions.v8`, `.node` and `.electron`, so any change starts a fresh cache.
  - Read: a missing, unreadable, empty or oversize file (over 64 MB) is a miss and is never read.
  - Write: after a miss, or when V8 sets `cachedDataRejected` (a corrupt file), the write runs 5 s after the load on an unref'd timer, off the editor-open path. It calls `createCachedData`, writes asynchronously to a temporary file, renames it into place atomically, then removes `lute-*.bin` entries for other keys. Every disk error is swallowed, so the load always works and activation never touches the disk.
  - Lute itself is unchanged: same sandbox, same `Lute.New`, `SetHeadingID` and warm-up.
- `src/app/extension.ts`: `activate` calls `configureLuteCodeCache(context.globalStorageUri?.fsPath, extensionVersion())` before `prewarmLute`.
- Tests: new `test/backend/lute-code-cache.test.ts`; `test/backend/editor-session.test.ts` (the activation test also checks the cache configuration).

### Tests mapped to acceptance and edge cases

| Test | Proves |
|---|---|
| lute-code-cache: writes the cache after the first load and passes it as `cachedData` on the next load | cache hit; written only in `<storage>/lute-code-cache` and no temporary file left; same Lute output; a hit does not rewrite |
| lute-code-cache: rebuilds and rewrites when the key changes | key mismatch: no `cachedData`, new file, old entry removed |
| lute-code-cache: replaces a corrupt cache that V8 rejects | rejection rewrites the file |
| lute-code-cache: ignores and replaces an oversize cache file | oversize file is not read and is replaced |
| lute-code-cache: falls back silently when the storage is unusable | storage path is a file, or the cache file path is a folder: Lute still loads, no error, no write |
| lute-code-cache: no cache without the global storage | no `cachedData` and no pending write |
| editor-session: starts the Lute load at activation … | `activate` configures the cache with `context.globalStorageUri.fsPath`, before `prewarmLute` |

- Failing first: all 6 new code-cache tests failed before the change (the functions did not exist). The activation test failed with the committed `src/app/extension.ts`.
- One test process is one V8 isolate. After the first load, V8's in-memory compilation cache serves the same source and never consults `cachedData`, so V8 cannot reject a corrupt cache there. The rejection test therefore forces the `cachedDataRejected` flag that V8 sets in a fresh process.

### Measurement (plain Node 24.19.0, outside VS Code, separate process per run, interleaved)

A scratch script mirrors the load: read, key hash, cache read, compile, run, `Lute.New`, `SetHeadingID` and warm-up. The cache was produced after the load plus a 10,000-character render.

| Cold load | runs (ms) | median (ms) |
|---|---|---:|
| without cache | 184, 210, 200 | 200 |
| with cache | 96, 91, 103 | 96 |

The cache file is 2,853,240 bytes, and V8 accepted it in every cached run (`cachedDataRejected` false). The real-VS-Code number comes in S3.

### Commands and results

- `npx vitest run --config test/vitest.config.mts` on 22 files (the touched test files, the files importing `lute-host`, the Lute artifact helper or the extension entry, and `module-boundaries.test.ts`): exit 0, 22 files, 612 passed and 1 expected fail.
- `npm run typecheck`, `npx tsc --noEmit -p ./`, `npm run lint`, `npm run knip`, `npm run depcruise` (no violations), `node build.mjs`: all exit 0.

### Open

- S3: measure the real-VS-Code cold open with a warm cache (the second extension-host start after the cache is written) and with no cache.
- The first start after an install or update pays the uncached load and writes the cache 5 s later. If the extension host exits before then, the next start writes it.
## Execution progress — 2026-10-15 (S2b webview)

Scope: Owner decision 2, fixes 3 and 5 from S1 (webview only; the host changes are other steps). No real VS Code run in this step (S3 measures).

### What changed

- **Fold glyph alignment off the startup path** (`media-src/src/nav/section-fold.ts`). `alignListFoldGlyph` is split into a read-only `measureListFoldGlyph` and a write step. The controller no longer measures anything while it is created or applied: `applyListFoldsWithin` only marks each foldable item dirty. The first idle period (`requestIdleCallback`, timeout 1 s; a 100 ms timer where it does not exist) starts one `IntersectionObserver` on the foldable items, with a 600 px margin and the clipping scroller as its root (a margin does not widen a clipping ancestor; the first Chromium run showed an item 56 px below a 420 px pane never reported as near). Dirty items that the observer reports near the viewport are measured in one batch, every layout read before every style write (the old per-item write-then-read cost one forced layout per item). Resize, font load and per-item resize notifications mark all items dirty and measure the near ones only. An item scrolled into the margin is measured when the observer reports it. The item a user folds or unfolds is measured at once, and a click on a foldable list item measures that item before the gutter hit test. Without `IntersectionObserver` every dirty item counts as near (still after the idle trigger).
- **History base in idle time** (`media-src/src/editing/undo-keybind.ts`). The base reported when Vditor's own timer (open, a host update's `setValue`, a first visit to a mode) records the first entry of an empty stack is now pending and read in an idle period (`requestIdleCallback`, timeout 2 s; 50 ms timer fallback). It is taken at once, before the document can change, by: every call of `addToUndoStack` or `vmdeSeedBaseline` (so every Task 598 seed point: keydown, `beforeinput`, cut, drop, undo boundary, editor action), `compositionstart`, and Undo/Redo. The Task 598 seed still reads in place (it is the user's first action). A pending base is dropped when its stack was reset (first entry no longer the same) or the mode changed, because the reset's own first entry reports the new base. The `history-base` message, the Undo/Redo transition messages and the entry-recorded flush are unchanged.

### Tests, failing first, mapped to the brief

Red-first was checked by running each new test against the unchanged `section-fold.ts` and `undo-keybind.ts` (restored afterwards): 6 of 7 new `section-fold.test.ts` cases and 4 of 4 new/changed `undo-keybind.test.ts` cases failed; 6 of 7 new Chromium cases failed. Not red on the old source: the Chromium "Undo before the idle period" case (the old code already posted the base earlier; it guards the new ordering) and the `section-fold.test.ts` scroller-root case (added after the Chromium run showed the margin problem).

| Acceptance item | Test |
|---|---|
| Vitest: fold glyph alignment is not called synchronously during init | `section-fold.test.ts` "measures no list item while the controller is created and applied" |
| Vitest: it runs for near-viewport items after the idle trigger (and not for far ones) | "after the idle trigger measures the items the observer reports near the viewport" |
| Vitest: reads before writes, no layout thrash | "measures every foldable item in one batch of reads before any write" |
| Vitest: folding aligns its glyph; resize keeps near glyphs correct; scroller root; dispose | "aligns a list item the moment it is folded...", "recomputes the glyph center of near items...", "observes against the clipping scroller...", "keeps no pending work after dispose" |
| Vitest: history-base capture deferred; forced by seed, composition start, next entry, Undo, Redo; reset drops it; timer fallback | `undo-keybind.test.ts` "reports each recorded entry at once, and the first entry of an empty stack as the base in an idle period", "takes a pending base before the first action...", "drops a pending base whose stack was reset...", "falls back to a short timer..." |
| Chromium, large fixture (1,500 foldable items): no long task from fold alignment during init | `open-deferred-work.spec.ts` "a large list opens without measuring every foldable item": foldable-item box reads are timed in the page. Old source: 3,000 reads, 4,737 ms (machine shared with another Chromium run). New source: 14 reads, under 1 ms in total |
| Chromium: folding a list still aligns its glyph; a far item is aligned when scrolled near | "a far item is aligned when scrolled near, and folding a visible item aligns it" (a far item has no centre before the scroll; the folded item has a centre and the right-pointing glyph) |
| Chromium: first edit right after ready, then Undo restores the opened bytes exactly (IR, WYSIWYG) | "<mode>: an edit before the idle period takes the base first, and Undo restores the opened bytes" (idle scheduler held by the test; the base message carries the opened text and precedes the first `edit`) and "<mode>: the base is taken in the idle period, then the first edit undoes to the opened bytes" |
| Chromium: Undo before idle pairs the base first | "Undo before the idle period takes the pending base before the transition" |

### Commands and results

- `npx vitest run --config test/vitest.config.mts` on `section-fold.test.ts`, `undo-keybind.test.ts`, `finish-init.test.ts`, `message-router.test.ts`, `undo-boundaries.test.ts`, `reading-position.test.ts` (the files that import the two changed modules, found with grep) plus `test/backend/module-boundaries.test.ts`: exit 0, 451 tests passed.
- `npm run typecheck`: exit 0. `npx biome check` on the five touched or new files: exit 0 (formatter fixes applied with `--write` to the files of this step only).
- `node build.mjs`: exit 0 (twice, the second after the last source edit).
- Chromium (port 9123 was held by another run, so a temporary config on a free port was used and deleted afterwards): `open-deferred-work` + `section-fold` + `mutation-local`: 17 passed, 1 failed (`section-fold.spec.ts:1194`, the known failure: block handle hidden; the same failure on the unchanged source, with the painted-glyph soft assertions before it passing on both). Undo and history specs (`external-update-undo-base`, `exact-actions-after-edit`, `undo-boundaries`, `undo-restore-caret`, `undo-snapshot-index`, `held-drag-undo-snapshot`, `undo-pending-diagram`, `undo-interop`, `text-field-history`, `shortcut-negative`, `wiki-deferred-keys`): 210 passed, 5 failed: `text-field-history.spec.ts:178` in three modes (known failure) and `shortcut-negative.spec.ts:509` in IR and WYSIWYG ("Alt+Up/Down request no Move Block"): the same two failures on the unchanged source, so not caused by this step, but not on the known list.
- Not run: `npm run quality` (task-completion gate, orchestrator batch), `@visual` goldens (local-only), real VS Code.

### Open

- S3 must measure whether the history-base serialization (still one 277-340 ms task on a 150 KB file) now lands outside the input path: the idle callback runs when the main thread is idle, but the serialization itself cannot be sliced, so an input that arrives during it still waits.
- The fold glyph uses the CSS fallback centre until the first idle period (at most about 1 s on a busy main thread) and for items outside the margin; the first paint can show it a few pixels off for non-default markers. S3 should look at the 150 KB open for the removed `getBoundingClientRect` self time (467-557 ms profiled in S1).
- `shortcut-negative.spec.ts:509` fails on the unchanged source too; the known-failure list does not name it.
- Edge left as is: the scroller root is chosen when the observer is created; a pane that becomes scrollable later keeps a document-level root until the surface changes.

## Execution progress — 2026-10-15 (S3, real-VS-Code verification and re-measurement)

Scope: verify fixes 2-5 (init before the seed, host Lute V8 code cache, fold glyphs after first paint, idle history base) in real VS Code and re-measure. Part C (the Owner's real profile) was **not run**: see "Part C" below. No product file changed. New file: `test/vscode-e2e/init-before-seed.spec.ts`. Harness scripts, raw probes, screenshots and CPU profiles are under the ignored `tmp/641/`.

### Part A — correctness in real VS Code (`node build.mjs` first, `--workers=1 --retries=0`, key-binding-free window manager with `VMDE_XTEST=1`)

Same VS Code 1.129.0 as S1. Where a spec failed, the same spec was run on a build of the parent commit (the branch before fixes 2-5, built into a scratch folder under `tmp/641/base`) to separate pre-existing failures from regressions.

| Spec | New build | Parent build | Verdict |
|---|---|---|---|
| `incremental-seed.spec.ts` | 1 failed at line 138 (`maxLongTaskMs` 180, limit 50); the seed-state, reason and later steps are not reached | same failure (195) | pre-existing, not on the known list |
| `edit-propagation.spec.ts` | 2 passed | not run | pass |
| `mutation-local-helpers.spec.ts` | 1 failed at line 274 (Enter in a list item: 99 items, expected 100) | same failure | pre-existing, not on the known list |
| `undo-first-edit.spec.ts` | run 1: 5 passed, 1 failed (cold Mermaid detector: "race window missed", the diagram had rendered before the first key); isolated rerun of that case: passed; full rerun: 6 passed | 6 passed | intermittent race-window detector, 1 failure in 3 runs on the new build, not attributed (see open items) |
| `section-fold.spec.ts` (real VS Code) | 1 failed at line 1000 (block handle still visible) | same failure | pre-existing, not on the known list (same symptom family as the Chromium line 1194) |
| `section-hoist.spec.ts` | 1 passed | not run | pass |
| `large-document-interaction.spec.ts` | 2 failed (lines 265, 416: known), 2 passed | not run | known failures only |
| `init-before-seed.spec.ts` (new) | 1 passed | fails: no `incremental-seed` message within 60 s (the seed rides inside `init` there) | red on parent, green on new |

New spec `init-before-seed.spec.ts` (acceptance: init before the seed in the real webview; first edit after ready, then Undo, restores the opened bytes). It opens two copies of the large mixed fixture (asserted above the 100,000-character inline-init size, so the `ready` then `init` route runs) in one VS Code, with a read-only message recorder installed before the webview exists. Per document it asserts: the host holds the opened bytes and is clean at ready; one `init` message reaches the webview, carries the whole document and no seed; a separate `incremental-seed` message follows it, for the same character count; one OS-level (XTEST) `X` after a click lands in the host (length +1, dirty); one OS-level Ctrl+Z (its trusted keydown observed) restores the host text to exactly the opened bytes and the document is clean. First document: edit after the seed arrived; second document: edit right after the editor is ready (the seed had already arrived before the key in both runs, recorded in the log line, so "edit before the seed" is covered by the Vitest and Chromium cases of S2a only). Commands: `npx biome check` on the spec: exit 0 (after `--write`); `npm run typecheck:vscode-e2e`: exit 0; spec: 1 passed (25 s); the same spec on the parent build: 1 failed as above.

The clean-profile typed check of Part B (below) repeated "first edit after ready, then Undo" on 45 typed opens (27 + 9 on the new build, 9 on the parent build): 0 left the document dirty after Undo (one earlier launch, before the harness waited for the dirty flag, showed two opens still dirty three seconds after Undo; not reproduced, see open items).

### Part B — clean profile re-measurement

Method as S1 (clean profile per launch, Quick Open + Enter, t0 = trusted Enter keydown, cold = first open after launch, warm1 = second open, same three files, same milestone probes; instrumented host marks on a scratch copy of the build). Additions: a second profile condition for the code cache (cold with no cache file; cold on the next launch with the profile reused and the cache file present), an OS-level click after ready, and a typed key (`x`) 700 ms after the click followed by Ctrl+Z, measuring key-to-`input` event time and the time until the tab is clean again.

**Machine drift.** The S1 numbers could not be used alone: a later batch of the parent build on this machine gave 1781 / 2684 / 4355 ms (2 / 30 / 150 KB cold) against 1022 / 1513 / 3496 in S1, and the speed changed again between batches. The before/after below therefore comes from an interleaved run: for each size and each of 3 rounds, parent build (fresh profile, cold + warm1), new build with a fresh profile (cold, no cache) and the new build on the same profile again (cold with cache + warm1), launched one after another. Cold and warm columns are medians (min-max) of 3 launches.

| Editor ready (content built, teaser gone), ms after open | S1 cold | parent cold | new cold, no cache | new cold, cache | S1 warm | parent warm1 | new warm1 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2 KB | 1022 | 1000 (992-1909) | 1149 (950-2013) | 1043 (956-1671) | 476 | 443 (432-875) | 378 (346-709) |
| 30 KB | 1513 | 1873 (1576-2247) | 1698 (1545-2169) | 1632 (1325-2250) | 905 | 1004 (909-1194) | 1109 (773-1229) |
| 150 KB | 3496 | 4476 (3384-6122) | 2455 (2215-2612) | 2060 (2029-2320) | 2468 | 3179 (2588-3629) | 1523 (1340-2050) |

| Content visible (first contentful paint of the teaser), ms | parent cold | new cold, no cache | new cold, cache | parent warm1 | new warm1 |
|---|---:|---:|---:|---:|---:|
| 2 KB | 658 | 743 | 694 | 212 | 196 |
| 30 KB | 992 | 811 | 957 | 427 | 412 |
| 150 KB | 1009 | 940 | 755 | 427 | 306 |

Milestones for the 150 KB file (medians of 3, ms after open): host `ready` received 1089 parent / 1006 new no cache / 719 new cache (warm1 397 / 273); host `init` posted 2436 / 1026 / 739 (warm1 1205 / 279); webview `init` received 2444 / 1030 / 742; Vditor instance 2501 / 1057 / 779; Lute script fetched 2600 / 1178 / 870; editor ready 4476 / 2455 / 2060; quiet after ready 4919 / 2455 / 2060 (warm1 3582 / 1523). Host incremental seed 1309 / 1217 / 1045 ms, now after `init`.
For 2 KB and 30 KB the host and webview milestones before ready are within the run spread of the parent build (for example 30 KB cold: `init` received 1112 / 900 / 939, editor ready 1873 / 1698 / 1632); the 30 KB parent build's quiet-after-ready (2520, history-base task) is now equal to ready (1632) in the cold-cache column.

Larger matrix (3 chains per size, not interleaved with the parent build, so used for ranges only): cold no cache 1083 / 1677 / 2173 ms (2 / 30 / 150 KB; n=3), cold with cache 960 / 1351 / 1953 (n=6), warm1 599 / 850 / 1368 (n=9); content visible, cold with cache 587 / 717 / 696.

**Init before the seed.** In 36 of 36 opens of the 150 KB file the host `init` reached the webview before the `incremental-seed` message (init median 746 ms, seed median 2067 ms, range 1875-2373, so the seed lands at about the time the editor is ready); 0 of 72 opens of the 2 and 30 KB files had a seed message (no seed for those, as designed). The `init` carried no seed in the real-VS-Code spec above.

**Code cache.** The cache file is written by the first launch (cache folder empty before it, one file after it, 2.5-2.9 MB depending on what had run when it was written) and is not rewritten by later launches. Interleaved medians, first launch (no cache) against the next launch (cache): host Lute load 212 / 201 / 226 ms against 105 / 112 / 96 ms (2 / 30 / 150 KB); host `resolveCustomTextEditor` entered at 301 / 281 / 324 against 204 / 220 / 185 ms; editor ready, cold, 1149 / 1698 / 2455 against 1043 / 1632 / 2060 ms. About 100-130 ms of the host chain goes away; the ready gain is 66-395 ms and inside the run spread for the small files.

**Input after ready (cache cold, 3 launches per size, typed check included).** First click accepted (S1 metric; caret in the editor after the OS click), ms after open: 2 KB 992, 30 KB 1398, 150 KB 2006 (the click was sent 34 / 80 / 68 ms after ready). Typed key `x` to the editor `input` event: 9 / 32 / 175 ms (cold), 8 / 38 / 179 (warm1), 8 / 36 / 180 (warm3). Undo (Ctrl+Z) made the tab clean again within 602 / 718 / 727 ms median (small: already clean at the first poll; mid range 620-1243, large 704-1768). Caveat for the click metric: it takes the first editor selection event after the click's pointer-down timestamp; the OS timestamp runs 13-30 ms ahead of the dispatch time and the editor's own caret placement fires in the same 20 ms, so in one batch of 9 launches (cache cold with click only) the same code gave 492-573 ms for 30 KB and later 75-82 ms with the typed check on. The typed-key latency is the editable measure to trust; both are recorded.

**Where the 150 KB cold time goes now** (one profiled cold launch, sampling 1 ms, editor ready 2102 ms profiled): boot to `init` 217 ms; `init` to ready 1382 ms, of which the Vditor constructor 974 ms (Markdown to IR through Lute `md` in `src/shared/lute-gap-repair.ts:276` and `media-src/src/editing/live-line-breaks.ts:124`: 767-806 ms, with `restoreCellGaps` 257 ms inside it, and the first `setValue` 458 ms); `runFinishInit` 84 ms (S1: 548-630 ms, the fold-glyph forced layouts are gone). Post-ready 3 s: one 312 ms long task, the history-base serialization (`historyText`, `media-src/src/bridge/edit-sync.ts:1420`, `media-src/src/editing/undo-keybind.ts:100`), now in idle time; the host seed is 1 s of host time that no longer blocks `init`.

### Part C — the Owner's real profile: not run

Blocked by the permission system. Done before the block: pre-flight (no VS Code process of the Owner's install or any other installed VS Code was running), safe backup by copy of the state databases (global and the main-checkout workspace, with their backup copies), the workspace marker file, `storage.json` and `settings.json` into `tmp/641/backup-2026-10-15/` with a sha256 manifest (`MANIFEST.sha256`), and a record of the sizes and hashes needed for the integrity check. No launch flag, setting, extension or Settings Sync state was touched and no VS Code was started on the real profile. When I tried to create the real-profile harness (a copy of the clean-profile harness that launches the Owner's installed VS Code with the Owner's user-data and extensions folders and opens the main-checkout `LOCAL_AGENT_TASK.md` and `tasks/299-placeholder-text.md`, 3 cold opens each, clicks on plain text only, no typing), the automatic permission check refused the file edit as interfering with the Owner's workloads, so the run did not start. The Owner's approval (this record, "Owner decisions", item 4) was given in chat to the orchestrator, not to the permission system; a permission rule or an explicit approval in the session that runs the harness is needed. Plan for the run, ready to execute: 6 launches (1 uncached + 2 cached of the 150 KB file, then 3 of the small file), record content visible, editor ready and first click accepted, then compare the hashes of `settings.json`, `keybindings.json` (absent) and `extensions.json` and the extension folder list with the values recorded before, and record the size of the code-cache file in the extension's global storage as the only new file.

### Targets (Owner, 2026-10-15: content visible and editable; about 1 s for small and mid files; about 1.5-2 s for large files)

- Small (2 KB): content visible at 0.69 s cold, editor ready 1.04 s cold with cache (1.15 s without; range 0.95-1.67 s), 0.38 s warm: met on the median, not on every launch.
- Mid (30 KB): content visible 0.96 s cold (0.72 s in the larger matrix), editor ready 1.63 s cold with cache (1.35 s in the larger matrix), 1.1 s warm (0.85 s in the larger matrix): **not met** for editable on a cold open.
- Large (150 KB): editor ready 2.06 s cold with cache (1.95 s in the larger matrix; 2.46 s on the first start after install), 1.52 s warm: **met at the upper edge** (about 2 s) on warm-cache starts, slightly above it on a first start. Against the parent build in the same run: 4.48 s to 2.06 s cold and 3.18 s to 1.52 s warm.

### Commands and results

- `node build.mjs`: exit 0. `npm run typecheck:vscode-e2e`: exit 0. `npx biome check` on the new spec: exit 0.
- Real-VS-Code specs as in the Part A table. One of them (the first `incremental-seed.spec.ts` run) fetched VS Code 1.129.0 (295 MB) into the e2e cache folder of this worktree because the copied cache sat in the wrong folder; later runs reused it.
- Clean-profile harness runs, each in its own virtual display with a key-binding-free window manager and XTEST input, one VS Code launch per run, about 110 in all: 27 (chains A/B/C), 9 (parent build, with click), 18 (chains prep + typed, after 12 launches of a first harness version that were superseded), 9 (repeat of the typed Undo check, new and parent), 27 (interleaved comparison), 2 (profiled cold open) and a few short debugging launches. Every launch finished; the only harness error was one launch whose second open was never detected because the first open's tab was still dirty (see open items). Leftover-process check at the end: none.
- Not run: `npm run quality`, `@visual` goldens, Part C.

### Open

- **Part C** (the Owner's real profile): needs permission, see above. Backup is ready.
- **Mid and small files cold:** the 30 KB cold open is 1.3-1.6 s (target 1 s). The fixed chain before the editor starts (workbench webview creation 0.3-0.4 s, document start about 0.5 s, `main.js` and Lute script fetches, Vditor construction and first render 0.5-0.7 s for 30 KB) is not changed by fixes 2-5. The 150 KB open is dominated by the Lute Markdown-to-IR pass in the Vditor constructor (about 0.8 s); rendering only what is on screen first is the deferred item (Owner decision 3).
- **Seed and history base on 150 KB:** the seed message lands at about the time the editor is ready and the history-base serialization is still one 312 ms task after ready; typed key latency on 150 KB is about 175 ms.
- **Intermittent items, not attributed:** `undo-first-edit.spec.ts` cold Mermaid detector failed in 1 of 3 runs on the new build (the first key arrived after the diagram had rendered), 0 of 1 on the parent build; in one earlier typed-check launch (30 KB, before the harness waited for the dirty flag) the cold and warm3 tabs were still dirty 3 s after Undo, with one extra `request-exact-authority` message after the last `edit`; 0 of 45 typed opens afterwards, new and parent builds, left the tab dirty.
- **Known list additions to consider:** `incremental-seed.spec.ts:138`, `mutation-local-helpers.spec.ts:274` and the real-VS-Code `section-fold.spec.ts:1000` fail the same way on the parent build.
