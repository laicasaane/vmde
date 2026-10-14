# Task 636 — Slow open of a local markdown file under the Owner's real VS Code profile

**Status:** done (2026-10-14).
**Origin:** Project Owner report (chat, 2026-10-14).
**Severity:** high (estimated). Opening one ordinary file takes a very long time in daily use.
**Tech stack:** extension host (`src/app/`, `src/session/`, `src/webview-host/`), webview boot (`media-src/src/boot/`), Lute host prerender, real VS Code with the Owner's own profile.
**Local material:** environment details, absolute paths, the file under test, profile settings, extension lists and raw logs/profiles live in an untracked local companion file under the ignored `tmp/` folder. That file is never committed. This record holds only redacted findings.

## Problem

With the repository folder open in VS Code, opening one untracked local markdown file in the workspace root (about 60 KB, about 600 lines of headings, lists, tables and long lines) with VMDE takes a very long time. Earlier performance tasks (for example Tasks 529, 534, 538, 573, 574, 578) measured with the isolated test profile and synthetic fixtures; the Owner reports that they did not improve this daily experience as much as expected.

## Owner decisions (2026-10-14, chat)

- Investigate with a real VS Code instance that uses the Owner's own profile, settings and extensions intact. Do not use the isolated test profile for this investigation or for its acceptance measurements.
- The task's material is split in two:
  - Public (this record, committed): redacted findings, relative repository paths, timings, cause and fix. No absolute paths, user or machine names, profile contents, or third-party extension lists.
  - Local (untracked companion file and raw evidence under `tmp/`, ignored by the tracked `.gitignore`): anything machine-specific or sensitive.

## Constraints for real-profile runs

- Use the real profile read-only: do not change settings, keybindings, extensions, extension state, workspace trust or recent-files history beyond what opening the folder and file does.
- Comparison legs use launch flags only (for example disabling other extensions for one run); never uninstall, disable permanently or edit the profile.
- A run on the real profile shares VS Code's single-instance lock with any window the Owner has open. Ask the Owner before a run that would need their windows closed, and batch runs to keep interruptions short.
- Raw profiles, logs and screenshots stay under `tmp/`. They are never sent to external services; only redacted numbers and code locations may be.

## Acceptance

- [x] Open time measured on the real profile (several runs; cold and warm), split into phases: command/editor resolution, extension activation, host document read and prerender, webview HTML and boot, first paint, editor ready, post-ready work. Evidence: "Execution progress (E3a)" and "Execution progress (S1 fix, S2)": cold and warm Explorer-click opens split into editor tab, webview created, first paint, editor ready and `init` to `wiki-update`.
- [x] The dominant cause or causes are attributed with evidence (CPU profiles, phase timings, comparison legs), and recorded here in redacted form. Evidence: "Cause" section (discriminating legs, idle host profile, serial directory walk).
- [x] A fix (VMDE-side) is implemented with regression tests, or, if the cause is outside VMDE, the evidence and a recommendation are reported to the Owner. Evidence: commits `36a5b6ef` (RED), `2d3da9c1` (host), `ed338175` (webview); tests in `src/wiki` and `media-src/e2e/wiki-deferred-keys.spec.ts`.
- [x] The same real-profile measurement after the fix shows the improvement; the target is agreed with the Owner from the measured baseline. Evidence: S2 cold median 3.3 s, max 4.3 s, warm median 2.1 s, against 24.3–32.6 s before; Owner target met.
- [x] Repository gates: the focused real-VS-Code regression spec required by `AGENTS.md` runs in the test harness (it is not evidence of the real-profile improvement); `npm run quality` passes. Evidence: `test/vscode-e2e/wiki-deferred-keys.spec.ts` (6 passed over 3 runs); the quality stages were run one by one on the closing commit, audit omitted by Owner instruction (see "Closure").
- [x] The public record and every commit are checked for absolute paths, user or machine names and profile contents before committing. Evidence: closing text search of the record and the diff for absolute paths, user or machine names and profile contents found none.

## Measurement plan (2026-10-14)

- Measure on the real profile, with the installed build as the baseline and a development-build leg to check build drift.
- Phases: window ready; extension activation; editor resolution; host read and prerender; webview created; first paint; editor ready; interactive; a 5 s post-ready window.
- Instrumentation, with no code change: the editor's built-in startup timings; CPU profiles of the extension host, workbench and webview over the debugger protocol; webview paint and long-task observers; VMDE trace-level log lines enabled per session by a launch flag. The test-only performance seams are not used, because they also clear the render cache.
- Control: the same file in the plain text editor, with VMDE disabled for that launch only.
- Comparison legs, by launch flags only: VMDE alone; other extensions disabled in groups and then halved; selected built-in features disabled; copies of the file split in halves and with a simplified shape.
- Cold means the first open after a fresh launch; warm means repeat opens in the same session. Five runs per main leg and three per bisect leg; report median, min and max.
- Stop when a leg moves the baseline median by 30% or more beyond the run spread, or when the bisect narrows to two candidates or one file half. Stop and ask if the slow open does not reproduce. Budget: two short sessions with the Owner.
- Raw profiles and logs stay in the ignored local folder. Only phase medians, leg labels and relative VMDE code locations are published.
- The runs are scripted. The Owner closes the editor windows for each batch, approves the debug-port flags, and does one stopwatch run with the usual gesture.

## Owner decisions (2026-10-14, chat, after the plan)

- The Owner opens the file from the Explorer panel; the estimated open time today is over 20 s, up to over a minute.
- **Target:** under 5 s in the best case and under 10 s in the worst case on the Owner's machine.
- A safety backup of the editor's state database is allowed before scripted runs.
- Temporary setting changes are allowed only after a proper backup of the settings and with Settings Sync turned off first; the settings leg still runs only if the other legs leave more than 30% of the time unexplained.
- The debugger-protocol launch flags are approved for the real profile.
- Measuring the installed version as the baseline and building local versions to measure and fix are approved.

## Execution progress — 2026-10-14 (E3a, first real-profile runs)

- The measurement harness drives a real editor window in a private display (Explorer click by OS-level input, phase timings and CPU profiles over the debugger protocol). Every instrument's deliberate positive control fired, except a named-function control inside the webview's own profile, which the frame layout does not separate.
- Cold open of the file from the Explorer, installed build, full profile: editor tab 61 ms, webview created 530 ms, first paint 965 ms (prerender teaser), **editor ready 24.9 s** after the click. The same file in the plain text editor (VMDE disabled for that launch): **0.27 s**. One earlier run was void (a tab restored at startup was reopened).
- Lead, not yet an attribution: after the webview reports ready (0.9 s), the next host log line comes about 23 s later, and both the extension host and the webview are mostly idle in between — the time looks like waiting, not computation.

## Cause (attributed 2026-10-14)

- Discriminating legs (installed build, real profile, cold Explorer-click opens): baseline ready 24.3–25.6 s; with the built-in Git extension disabled 23.7–28.7 s; with every other non-built-in extension disabled 23.7–23.8 s; a copy of the file in an ignored folder 26.6 s. Git, other extensions and webview resource loading are excluded: the webview's resources finish within 0.85 s, it reports ready at about 1 s, and the host's `init` message reaches it only 22.4–27.1 s after the click.
- The extension-host CPU profile of that window is 76–80% idle; the busy part is directory-read round trips from VMDE's wiki page scan. On `ready`, the host awaits the wiki init payload before posting `init` (`src/session/editor-session.ts`), which builds the wiki cache (`src/wiki/wiki-cache.ts`) by a serial, unfiltered directory walk of the workspace root (`src/wiki/wiki.ts` `collectWikiMarkdownFiles`) — about 30,000 directories here, most of them in ignored build and test folders — one round trip each. Wiki links are on by default and the wiki root defaults to the workspace folder, so every Markdown open in a large workspace pays this before the editor can start.

## Part 1 handoff — fix (2026-10-14)

- **Layer (a), required:** do not block `init` on the scan. `onReady` posts `init` at once; if a built cache exists for the root, `init` carries the page keys and display names; otherwise it carries the wiki context without keys ("pending"), and a background build posts the existing `wiki-update` message when it resolves (always after `init`; dropped if the session was disposed or the root changed). This makes the open independent of workspace size and needs no setting.
- **Layer (b), recommended:** replace the directory walk with one `workspace.findFiles` search under the wiki root (Markdown extensions), with a cancellation token, so keys arrive soon after the open and the extension host stays free. The page set depends on the exclude (Owner question 1).
- **Layer (c):** a parallel or capped walk only as a fallback if (b) is rejected.
- **Consumers.** Host: wiki-link open and the pages list await the shared build (they wait, they do not fail); the prerender teaser already shows chips without missing styling. Webview: chips are marked missing when the known-page set lacks the key — with an empty pending set every chip would flash missing, so the webview needs a "keys known" flag; the `[[` hint shows an empty list until keys arrive; `wiki-update` refills the sets but does not restyle chips already rendered and does not update the stored init message, so a configuration re-init after a late update would drop the keys.
- **Contract.** (1) HTML and inline init unchanged. (2) `init` posted without waiting; keys included only from an already built cache. (3) Background build shared and de-duplicated per root; `wiki-update` chained after `init`. (4) Watcher events still post `wiki-update`; the change-listener unsubscriber joins the session disposables (today it outlives the panel). (5) Dispose drops the pending delivery and unsubscribes; invalidation cancels the search and a per-root generation keeps a stale build from being stored. (6) Webview: while keys are pending no chip is marked missing; on `wiki-update` refill the sets, mark keys known, copy them into the stored init message, and update `data-wiki-missing`/`title` on existing chips — attributes only, no edit, dirty state or Undo entry. (7) Multi-root: per document folder. (8) A set wiki root is searched alone; a missing root gives no keys, not an error. (9) Wiki disabled: no scan, no update.
- **Part 2.** S1 RED (host Vitest: `init` posted while the build never resolves; pending `init` has no keys and `wiki-update` follows after it; dispose before resolve posts nothing and later watcher events post nothing; an invalidated build is not stored; a built cache puts keys in `init` with no extra post; one search call and no directory reads; wiki disabled gives no scan. Chromium: `init` without keys marks no chip missing; after `wiki-update` an existing-page chip stays unmarked, a missing one is marked, and no edit is sent; a configuration re-init after `wiki-update` keeps the keys; the `[[` hint lists names after `wiki-update`). S1 GREEN host, then S1 GREEN webview. S2: real-profile re-run on the development build with the fix (5 cold + 5 warm Explorer-click opens; 2 cold runs of the development build without the fix as a drift check; 3 cold runs on a copy with existing and missing wiki links, recording chip state and the time from `init` to `wiki-update`). Pass: cold median under 5 s, every cold run under 10 s, warm median under 5 s, no missing-styling flash on existing-page chips. S3: focused real-VS-Code spec (temporary workspace with wiki pages, a deep tree of a few thousand directories, an excluded page): message order, editor ready before keys, existing-page chips never marked missing, missing-page chip marked after keys arrive, wiki disabled gives no update. S4: closure.
- **Owner decisions (2026-10-14, chat, on the handoff questions).**
  1. Page set after the switch to a search: approved — honour `files.exclude` and skip `node_modules` (behaviour change: Markdown files under those folders are no longer wiki pages). No new setting.
  2. `[[` completion while keys are pending: the Owner asked for an appropriate fix chosen from established practice. Resolution (following the suggest widgets of established editors, which show a non-insertable loading row and refresh in place when results arrive): while keys are pending, the `[[` hint shows one localized "Loading pages…" row that cannot be inserted — Enter or Tab with only that row behaves as if no hint were open (Enter inserts its normal newline), Escape closes it; when keys arrive while the hint is open, it re-runs with the current query and shows the matches in place; after keys are known the hint behaves as today (including its no-match behaviour).
  3. Stale keys after a wiki setting change: approved as a separate follow-up task (not part of this task).
  4. Inline init for wiki files: not done (target met without it) — approved.

## Conditional follow-up — persistent wiki page cache (Owner decision, 2026-10-14)

- **Today.** One in-memory cache per wiki root (`src/wiki/wiki-cache.ts`), kept current by a file watcher. A full scan runs once per extension-host lifetime and after a wiki setting change (`src/wiki/wiki-session.ts` `onConfigChanged`), so every first open after a window starts pays the scan.
- **Proposal (stale-while-revalidate).** Store the page list per wiki root in local workspace state. On the first open after a restart, send the stored keys in `init` at once; revalidate in the background with the new search, post `wiki-update` through this task's delivery path if anything changed, and store the new list. Costs: brief stale chip state for pages changed while the editor was closed; a storage key per root with a schema version and a size limit; invalidation on a root change; tests for the stale-to-fresh transition.
- **Trigger.** File it as its own task only if this task's S2 real-profile re-run shows the time from `init` to `wiki-update` above 1–2 s, or the "Loading pages…" row is noticeable in daily use. Combine it with the approved follow-up for stale keys after a wiki setting change (Owner decision 3), since both concern wiki-key freshness.
- **Obligations here.** S2 records the `init` → `wiki-update` time (median, min, max over the cold and warm runs). Closure states whether the trigger fired: if it fired, file the new task record, cross-link it from this record and queue it without starting it; if not, record "not needed" with the measured numbers. This task's contract, RED tests and scope are unchanged.
- **Related.** Trigger fired (S2: time from `init` to `wiki-update` median about 2.9 s, range 1.8–3.8 s over 8 cold runs) — filed as Task 638, combined with Task 637. See `tasks/638-persistent-wiki-page-cache.md`.

## Execution progress — 2026-10-14 (S1 fix, S2 real-profile re-run)

- S1: RED tests (`36a5b6ef`), host fix (`2d3da9c1`: `init` posted without waiting for the wiki scan, keys delivered by a later `wiki-update`, one workspace search honouring `files.exclude` and skipping `node_modules`, case-insensitive extensions, folder-anchored excludes rebased onto a subfolder wiki root, cancellation and a per-root generation for invalidated builds, watcher listeners released on dispose), webview fix (`ed338175`: no missing styling while keys are pending, chips restyled on `wiki-update` by attributes only, the stored init message keeps the keys, a non-insertable "Loading pages…" row in `[[` completion with in-place refresh).
- S2, real profile, Explorer-click opens, development build with the fix: cold ready 2.7 / 3.5 / 3.2 / 3.3 / 4.3 s (**median 3.3 s, max 4.3 s**); warm reopen median **2.1 s**; a copy with wiki links cold median 4.3 s. Installed build before the fix: 24.3–32.6 s; the development build before the fix: 38.5–39.5 s. **Owner target met** (cold median under 5 s, every cold run under 10 s).
- Wiki chips: a link to an existing page was never styled as missing at any point; links to missing pages were styled once the keys arrived.
- Time from `init` to `wiki-update` (keys arrival): median about 2.9 s, range 1.8–3.8 s over 8 cold runs; warm reopens carry the keys in `init`. This is above the 1–2 s trigger of the conditional persistent-cache follow-up.
- The real profile's settings, keybindings and extension list were unchanged by the runs; only the editor's own state database was rewritten by the editor itself.

## Execution progress — 2026-10-14 (S3, harness regression spec)

- New real-VS-Code spec `test/vscode-e2e/wiki-deferred-keys.spec.ts` (test profile; harness regression, not real-profile evidence). Each test generates its own workspace before VS Code opens it: wiki pages at the root and in a subfolder (`Guide.MD`, upper-case extension), 3,330 empty directories, a page under `node_modules`, a page under a plain `files.exclude` key (`drafts/**`) and a page under a brace-valued key (`**/scratch-{a,b}/**`). Read-only instrumentation installed before the webview exists records every host message in order and watches every `data-wiki-missing` attribute and chip insertion from the first node.
- Test 1 (wiki on) asserts: `init` first with no keys, then exactly one `wiki-update`; the `[[home]]` and `[[Guide]]` chips never carried `data-wiki-missing` at any moment and nothing was marked missing before the update; after it `[[Hidden]]`, `[[Draft]]`, `[[Scratch]]` and `[[no-such-page]]` are marked missing and the two existing pages are not; the host document is clean and byte-identical (document text and file); an OS-level Ctrl+Z after the update changes nothing (the trusted keydown is observed, host still clean and unchanged); an OS-level `[[` lists the root and subfolder pages (`Guide`, `home`, and the open document) and none of the excluded pages. Test 2 (wiki off) asserts an `init` but no `wiki-update` and no chip marked missing.
- Recorded, not asserted: in the harness the search finishes about 0.2 s after `init` (init at about 0.5 s, keys at about 0.7 s), while the real editor reports ready at about 1.2-1.4 s, so the keys arrive before the editor is ready and the `[[` completion cannot be typed while keys are pending. The pending state is covered by the Chromium spec; this spec covers the host-to-webview order, the host prerender teaser (chips present from about 0.05 s, never marked before the update) and the final state. The cache was not built at `init` (no keys in `init`).
- Commands: `node build.mjs` (exit 0); `npx biome check` on the spec (exit 0); `npm run typecheck:vscode-e2e` (exit 0); the spec under a virtual display with the X11 flag and a key-binding-free window manager (the plain command cannot reach XTEST; see docs/os-keyboard-testing-setup.md): 3 runs, 2 tests each, **6 passed, 0 failed**. Neighbour real-VS-Code specs (`wiki-chip-focus`, `wiki-hint-consecutive`, `wiki-inline-code-edit`, `local-link-open`): first run 8 passed, 2 failed (`wiki-chip-focus` host-command test: caret never entered the chip; `wiki-inline-code-edit`: the typed `!` never landed); reruns: `wiki-chip-focus` 15 of 16 runs passed in all, `wiki-inline-code-edit` failed 2 of 6 runs on the fixed build and 1 of 5 on a build of the parent of the fix with the same signature, so that spec's flake is pre-existing (it places a synthetic selection and types without waiting for the first undo snapshot); the single `wiki-chip-focus` failure is not reproduced (10 of 10 reruns passed on both builds) and is not attributed.

## Closure — 2026-10-14

- **Outcome.** Opening a Markdown file in a large workspace no longer waits for the wiki page scan. Cause: `init` was held until a serial directory walk of the whole workspace finished. Fix: `init` posts at once, one workspace search honouring `files.exclude` and skipping `node_modules` builds the page set in the background, and a later `wiki-update` delivers the keys. Real profile, development build: cold ready median 3.3 s (max 4.3 s), warm median 2.1 s, against 24.3–32.6 s on the installed build. Existing-page chips were never styled as missing. The profile's settings, keybindings and extensions were unchanged.
- **Commits.** Records: `61dfc14e`, `3d410724`, `56a77cf7`, `73ece278`, `49f1c0cb`, `acb5190c`, `22aeebfc`. RED `36a5b6ef`. Host fix `2d3da9c1`. Webview fix `ed338175`. Real-VS-Code spec `cc51d74c`.
- **Gates on the closing commit (exit 0 unless noted).** `npm run lint:ci`; `npm run typecheck`; `npm run knip`; `npm run jscpd`; `npm run depcruise`; `npm run test:coverage` (334 files, 6,204 passed, 1 expected fail); `npm run check:coverage-modules` (11 modules at 0%, baseline 11); `npm run check:brand-identifiers`; `npm run typecheck:vscode-e2e`. `npm run quality` as one command was not run, and its audit stage was omitted by Owner instruction.
- **Bundle.** `media/dist/main.js` is 947,510 B (925.3 KiB), +2,348 B against the Task 627 close (945,162 B). `npm run check:startup-cost` reports 354 eager modules (Task 627 close: 353) and exits non-zero against its budget of 294; the budget miss was already present at the Task 627 close and is reported, not changed here.
- **Persistent-cache trigger.** Fired (`init` to `wiki-update` median about 2.9 s, range 1.8–3.8 s). Filed as Task 638 and combined with Task 637; neither is started and both need the Owner to start them.
- **Residuals.**
  - The pending `[[` window is not reached in the harness spec (keys arrive in about 0.7 s there); the Chromium spec covers it.
  - The real-VS-Code `wiki-inline-code-edit` flake is pre-existing (it also fails on the build without the fix).
  - One `wiki-chip-focus` failure is unattributed: 1 of 16 runs on the fixed build against 0 of 15 before the fix; 10 of 10 reruns passed on each build.
  - The watcher create path indexes excluded files and its glob is case-sensitive (Task 637).
  - Nested-brace exclude keys are verified by the harness spec. A brace-group exclude key is dropped when the wiki root is a subfolder (known limitation).
- **Follow-ups.** `tasks/637-wiki-keys-after-wiki-setting-change.md`, `tasks/638-persistent-wiki-page-cache.md`.
