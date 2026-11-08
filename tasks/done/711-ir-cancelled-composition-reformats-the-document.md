# Task 711 — IR: a cancelled composition reformats the document

**Status:** ✅ done (2026-11-08).
**Origin:** Split from [Task 698](698-key-and-chord-results-differ-in-xtest-specs.md) at its closure (Part 2c, `shortcut-identity.spec.ts:1247`).
**Severity:** medium (estimated). With an input method such as IBus, pressing Ctrl+Shift+U and then Escape in IR marks the document dirty and rewrites it in Lute's form.
**Tech stack:** vendored Vditor IR `compositionend` handler (`media-src/node_modules/vditor/src/ts/ir/index.ts:112-117`), VMDE's SV cancelled-composition guard (Task 629), the IR input path and host write-back.
**Depends on:** none.

## Problem

Measured in Task 698 Part 2c under `XMODIFIERS=@im=ibus`: Ctrl+Shift+U starts IBus Unicode entry. On Escape the input method sends an empty composition update, an input event and `compositionend` with empty data. Vditor's IR `compositionend` handler calls `input()` even when the composition was cancelled. The block is rebuilt, the space after the word becomes `&nbsp;`, and the host receives the whole-document serialization: 174517 characters grow to 181855, first difference at offset 66, document dirty. VMDE guards a cancelled composition only in SV (Task 629), not in IR (and WYSIWYG is unchecked).

Repro: in IR with IBus running, put the caret after a word in a file that does not round-trip byte for byte, press Ctrl+Shift+U, then Escape.

## Proposed work

1. Write a failing test first: a cancelled composition in IR (and WYSIWYG, if affected) leaves the host text unchanged and the document clean.
2. Guard the cancelled composition in IR (and WYSIWYG if affected) like the SV guard, without patching unrelated Vditor input paths.
3. Real-VS-Code test: drive the composition events (the XTEST environment no longer runs an input method after Task 698, so dispatch the composition sequence in the webview, or start an IBus session explicitly in a `@probe` spec).

## Acceptance

- [x] A test fails before and passes after the fix for IR (and WYSIWYG if affected). Evidence: `vditor-source-patches.test.ts` cancelled-composition cases, RED in IR and WYSIWYG, then GREEN.
- [x] A real-VS-Code spec shows a cancelled composition leaves the file unchanged and clean. Evidence: `ir-cancelled-composition.spec.ts` RED 2 of 3 (IR and WYSIWYG), GREEN 4 of 4 together with `ime-composition.spec.ts`.
- [x] `npm run quality` passes. Evidence: orchestrator rerun, all 8 stages pass.

## Part 1 handoff / Implementation (2026-11-08)

### Measurements (real VS Code, pre-fix bundle)

- Driver: CDP `Input.imeSetComposition` ("u", then empty text) into the focused webview. Chromium sends the same event sequence that Task 698 measured with IBus: `compositionstart ""`, `compositionupdate "u"`, `insertCompositionText "u"`, `compositionupdate ""`, `insertCompositionText`, `compositionend ""`. The editor `textContent` at `compositionend` equals its value at `compositionstart` in IR and WYSIWYG.
- Large fixture `fixtures/large-observable-models-synthetic.md`, caret after `ldzwcwrn`: IR rebuilds the paragraph and the host grows from 174517 to 181855 characters, first difference at 66, dirty (the Task 698 numbers). **WYSIWYG is affected too:** the paragraph is rebuilt and the host grows to 181842 characters, first difference at 74, dirty.
- A small fixture (unpadded table and short setext underline, 97 characters) does not reproduce the defect: `input()` runs, but the host stays exact and clean. Small documents take a different write-back path. The spec therefore uses the large fixture.
- WYSIWYG has a second publisher. Its `input` listener calls `afterRenderEvent` for the composition's own input events while `composingLock` is set. IR returns early there. That timer (the Task 601 `vmdeAfterRender` record) fires after `compositionend`. With only the `input()` guard, the WYSIWYG block was no longer rebuilt, but the host still grew to 181842 characters and became dirty.

### Decisions

- Definition of "cancelled" (matches SV, Task 629 c): `compositionend.data` is empty and the editor `textContent` is identical to its value at `compositionstart`. A committed composition, an empty one that changed the text, and a `compositionend` without a recorded start still run `input()` as before.
- Site: a narrowly scoped source patch, `patchIrCancelledComposition` and `patchWysiwygCancelledComposition` in `media-src/esbuild-shared.mjs`, wired into the existing `ir/index.ts` and `wysiwyg/index.ts` registry entries. A VMDE listener was not used, for two reasons. First, it could skip Vditor's listener only with stopPropagation, which also skips the `composingLock = false` reset and the later listeners. Second, a window hook would need install wiring in `finish-init.ts`, which this step does not own.
- WYSIWYG only: on a cancelled `compositionend`, the patch retires the pending `vmdeAfterRender` record (it clears the timer and drops the record, as `retireAfterRenderRecords` does). It does this only when no record was pending at `compositionstart`. A record that was already pending holds an earlier real edit, so the patch keeps it.

### Tests

- Vitest `test/backend/vditor-source-patches.test.ts`, "cancelled composition guard (Task 711)": these tests run the registry-transformed IR and WYSIWYG composition listeners against stubs. They cover a cancelled composition, a committed one, an empty one that changed the text, a `compositionend` with no recorded start, the per-composition reset, the WYSIWYG record (retired, kept when pending at start, kept on commit, judged per start), anchor drift and a double application. Before the fix, 4 tests failed (2 in IR, 2 in WYSIWYG) and 2 failed for the WYSIWYG record.
- Real VS Code `test/vscode-e2e/ir-cancelled-composition.spec.ts`. Before the fix: IR cancelled failed (181855, dirty, block rebuilt), WYSIWYG cancelled failed (181842, dirty, block rebuilt), IR committed passed. After the fix: all 3 pass, and `ime-composition.spec.ts` passes in the same invocation.

## Decision (provisional, orchestrator on the Owner's behalf, 2026-11-08)

- Render-only after-render record pending at `compositionstart`: (a) accepted. The WYSIWYG guard keeps any record that was pending at `compositionstart`. A cancel during a pending render-only publish can still reformat the document; that narrow case is a follow-up if it is ever observed.
- Cost: the guard reads `textContent` once at `compositionstart` and once at `compositionend`, per composition and not per key.

## Closure (2026-11-08)

- The orchestrator reviewed the Vditor patch diff. The guard is anchored in the source patch: it fails loudly if the vendored file drifts, and it refuses to apply twice.
- `npm run quality` failed on load timeouts in files this task does not touch. The orchestrator's rerun, with nothing else running, passed all 8 stages.
- WYSIWYG is affected too and is fixed in this task.
