# Task 594 — Webview build target and Firefox/Safari engine fixes

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Needs program decisions D1 and D5.
**Goal:** The webview bundle states its browser floor and loads in every browser vscode.dev supports. It fixes the known Safari and Firefox defects, and it records measured Firefox and WebKit results so D1's support stance rests on evidence. Chromium and desktop behavior do not change.
**Spec:** This file, [Task 581](581-web-extension-support.md) section 2 (webview syntax floor) and decision D1.
**Dependencies:**
- None on the host tasks; this task touches only the webview and its build.
- D5 must approve Playwright `firefox` and `webkit` downloads for Checkpoint 2.

**Repository skills:** `.agents/skills/vmde-lute-features/SKILL.md` (Vditor build-time patches) and `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Build target and known defects

- [ ] Set the explicit esbuild target `['chrome111', 'edge111', 'firefox121', 'safari16.4']` for the JS and CSS builds in `media-src/build.mjs` (lines 13–26) and `media-src/esbuild-shared.mjs`.
  - Confirm that the bundle still builds, and that the CSS output now carries `-webkit-user-select` wherever `user-select` appears.
  - Record the `main.js` and `main.css` size change (reporting only).
- [ ] Set `style.webkitUserSelect` next to `style.userSelect` in `media-src/src/editing/fix-table-ir.ts:191`.
- [ ] In `media-src/src/clipboard/image-convert.ts:140-146`, return the original file when `blob.type !== plan.mime`, as well as when the blob is empty. Make the comment match the code. Safari cannot encode WebP and returns PNG bytes.
- [ ] In the WYSIWYG click-to-caret Vditor patch (`media-src/esbuild-shared.mjs` around lines 403–404), try `document.caretPositionFromPoint` first and fall back to `caretRangeFromPoint`. Firefox before 150 lacks `caretRangeFromPoint`.
- [ ] Add a build-time Vditor patch to the keydown composition guards in `vditor/src/ts/ir/processKeydown.ts` (lines 29–30) and `wysiwyg/processKeydown.ts` (lines 31–32). Extend `event.isComposing` to `event.isComposing || event.keyCode === 229`. Safari fires the Enter that commits a composition with `isComposing: false` and `keyCode: 229`. Use the existing patch-assert mechanism, so a Vditor upgrade that moves the code fails the build.

### Checkpoint 2 — Engine runs

- [ ] Add `firefox` and `webkit` projects to `media-src/playwright.config.ts`, enabled only by an environment flag (proposed `VMDE_ENGINES=1`). Default runs stay Chromium-only.
- [ ] Under both engines, run the existing Chromium e2e specs for caret, selection, cut/copy/paste, table, IME/composition, trailing and gap paragraphs, and focus restore, found by search. Record per spec and engine in section 4: pass, fail with first error, or not applicable.
- [ ] Fix a failure here only when it is a one-line engine difference in the files above. Record every other failure in section 4 as a follow-up for the Owner, with its evidence.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:** host code, and Chromium behavior changes.
- **Preservation:** Chromium caret and IME behavior, the Vditor patch set, and the WebP conversion in Chromium.

## 3. Verification

- Unit tests:
  - `image-convert` with a mocked `convertToBlob` returning another type;
  - patch-applied assertions;
  - `caretPositionFromPoint`-first behavior with a stubbed document.
- The Chromium e2e suite subset passes unchanged.
- Real VS Code: run `node build.mjs` first. Then run the focused image paste and WYSIWYG click-to-caret specs with `--retries=0`.
- Engine results are recorded in section 4.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## 4. Engine results

Filled in Checkpoint 2.

## Execution progress

Not started.
