# Task 590 — Host Lute in the web extension host

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28). Blocked on program decision D3.
**Goal:** On the web, the extension host loads the same Lute build asynchronously and evaluates it in a sandbox. Saves then keep untouched blocks byte-for-byte, and undo-to-clean works, as on desktop. The desktop loader does not change.
**Spec:** This file, [Task 581](581-web-extension-support.md) section 2 (review-focus item 4) and decision D3.
**Dependencies:** [Task 584](584-host-runtime-seam.md) (the `LuteLoader` seam) and Task 582 row P5 (measured read, compile and eval cost and global leakage in the real worker).
**Repository skills:** `.agents/skills/vmde-lute-features/SKILL.md` (read first) and `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Web Lute loader

- [ ] Add `src/lute/lute-web-loader.ts` (proposed). It is in the web graph and has no `node:*` imports. It implements `LuteLoader`.
  - `prewarm()` starts `ensure()`. `ensure()` reads `media/vditor/dist/js/lute/lute.min.js` with `vscode.workspace.fs.readFile(vscode.Uri.joinPath(extensionUri, LUTE_REL))`. If row P5 shows `readFile` failing on a CDN extension location, it uses `fetch(uri.toString(true))` instead. It then decodes the bytes with `utf8Decode`.
  - It evaluates the source with `new Function('self', 'window', 'global', src).call(sandbox, sandbox, undefined, undefined)`, where `sandbox = Object.create(globalThis)`.
    - GopherJS picks `$global` from `typeof window`, then `self`, then `global`. These parameters make it write `$global.Lute` and `$global.fs` onto the sandbox.
    - Part 1 confirms the parameter set against row P5 before implementation.
  - It saves `Error.stackTraceLimit` before the evaluation and restores it in `finally`.
  - It calls `Lute.New()` with the same options and warm-up as the Node loader (`SetHeadingID(true)`).
  - `getSync()` returns the instance once loaded and `undefined` before that. It never blocks.
  - `didFail()` is true after a read, evaluation or `New()` failure; no retry loop runs.
- [ ] Unit tests, run in Node through the same `new Function` path:
  - Output is byte-identical to the Node loader for the existing `lute-host` fixtures and for a mixed table, code and wiki-link document.
  - After loading, `globalThis.Lute` and `globalThis.fs` are undefined and `Error.stackTraceLimit` is unchanged.
  - A failed read gives `didFail() === true`, and `getSync()` returns `undefined`.

### Checkpoint 2 — Cold-state behavior

- [ ] Make `canonicalizeIrMarkdown`, `reserializeMarkdown` and `renderForMode` return `undefined` while a web loader is cold. Their callers already handle `undefined`, per the Task 584 contract; add tests where coverage is missing.
- [ ] Keep the prerender overlay off on the web (D3 sub-choice): the web runtime never requests `renderForMode` for first paint.
- [ ] Add a write-back unit test for the cold-to-warm transition:
  - The first save while cold emits the editor block, as the current fallback does (`src/markdown/minimal-diff-writeback.ts` around lines 73–110).
  - After Lute becomes warm, the next edit tick minimizes against the clean baseline (`src/writeback/writeback-controller.ts` around lines 338–352) and restores the original bytes of untouched blocks.
  - `isSemanticNoop` detects undo-to-clean once warm.
- [ ] Record the residual here: saves made before Lute is ready can briefly carry editor-normalized bytes for touched and untouched blocks until the next tick.

## 2. Scope

- **In scope:** the web loader, the cold behavior and their tests.
- **Out of scope:**
  - Wiring the loader into the web entry (Task 591).
  - The webview's own Lute (Task 592 preloads it).
- **Preservation:** the desktop Node loader and its synchronous cold load, write-back byte preservation, and the desktop prerender overlay.

## 3. Verification

- The unit tests above, plus the existing `lute-host`, `minimal-diff-writeback` and `writeback-controller` tests.
- Web: Task 591's smoke test records Lute ready time and heap on `@vscode/test-web`. It also checks exact bytes for untouched blocks after edit and save.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
