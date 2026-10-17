# Task 652 — Restore caret and selection after Preview is turned off

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 651).
**Severity:** low to medium (the caret position is lost on every Preview toggle).
**Tech stack:** webview (Vditor Preview overlay in IR, WYSIWYG and Split source panes).
**Related:** [Task 651](done/651-remember-preview-toggle-state.md) (remember Preview toggle state).

## Problem

Vditor's Preview overlay collapses the editor selection and moves the caret on every Preview toggle. Turning Preview on hides the focused pane. The same happens on any click on the Preview control.

## Requirements

1. After Preview is turned off, the caret and selection return to the position they had before Preview was turned on, in IR, WYSIWYG and Split source.
2. Turning Preview on and off does not change the saved Markdown.

## Open design points

- Where the selection is captured and restored: the Preview toggle path, the Vditor overlay, or both.
- Behaviour when the document changes while Preview is open.

## Scope

- In: caret and selection restore after Preview is turned off, in IR, WYSIWYG and Split source.
- Out: Preview rendering, Preview toggle state memory (Task 651), and any other pane behaviour.

## Acceptance

- [ ] In IR, WYSIWYG and Split source, the caret and selection are unchanged after a Preview on and off cycle.
- [ ] A click on the Preview control has the same result as the toolbar toggle.
- [ ] Saved Markdown is unchanged by the cycle.

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-10-18)

Read-only pass at HEAD `9a9f54ff` (branch `dev`). No repository file changed. No build, Vitest, Chromium or VS Code run. No Lute probe was needed: the change touches no serialization.

### Verified facts (each checked by reading the file)

**Vditor Preview handler** (`media-src/node_modules/vditor/src/ts/toolbar/Preview.ts`; `esbuild-shared.mjs` does not patch this file)
- F1. One listener on the button, bound at construction for `getEventName()`, which is `click` everywhere except iPhone (`Preview.ts:14`, `util/compatibility.ts:18-24`). It calls `preventDefault()` and returns early when the button has `vditor-menu--disabled` (`Preview.ts:15-19`).
- F2. Turning on runs synchronously. It disables the edit toolbars (`edit-mode` included) and shows the preview. In SV it hides `vditor.sv.element`; in IR and WYSIWYG it hides `vditor[currentMode].element.parentElement` (`Preview.ts:38-44`). Then it renders the preview, sets `vditor-menu--current` and hides the hint, popover and sub-toolbar (`Preview.ts:45-47`), and finally calls `setPadding` (`Preview.ts:52`).
- F3. Turning off is also synchronous. It removes the class and sets the pane's `display` back to `block` (`Preview.ts:23-33`), then re-enables the toolbars and re-renders the outline (`Preview.ts:35-36`). It never touches the selection or focus. So the edit pane is visible again before the click dispatch ends. A bubble listener on the button that runs after Vditor's own listener therefore sees the visible pane and a laid-out DOM.

**VMDE Preview wiring**
- F4. `previewButton()`, `previewShowing()` (class `vditor-menu--current`) and `openInPreview()` are at `media-src/src/chrome/open-preview.ts:19-43`. `openInPreview()` sets `programmatic = true` around a synchronous `dispatchEvent(new MouseEvent('click', {bubbles: true}))` (`open-preview.ts:36-41`). `installPreviewMemory` binds a bubble `click` listener on the button node after Vditor's listener and compares the class with the previous state (`open-preview.ts:51-66`).
- F5. `installPreviewMemory` is registered in `runFinishInit` with `observers.set('preview-memory', …)` (`media-src/src/boot/finish-init.ts:638-641`). `Disposables.set` disposes the previous entry and `disposeAll` tears down on re-init (`media-src/src/util/disposables.ts:6-21`).
- F6. A remembered or rule-driven Preview opens right after `finishInit()` (`media-src/src/boot/vditor-init.ts:587`) or in the stream's `onDone` (`vditor-init.ts:537`). On a re-init the editor's own `previewShowing()` is read before `destroy()` (`vditor-init.ts:270-280`). Any listener installed in finish-init therefore sees these programmatic clicks too.
- F7. Toolbar `mousedown` is cancelled in capture phase, so a real click on a toolbar button does not move focus or the selection (`media-src/src/chrome/toolbar-scroll-guard.ts:59-75`, installed at `finish-init.ts:612`). When the Preview `click` arrives, focus and the selection are still where the user left them.
- F8. Module boundaries: `chrome->editing` is not an allowed edge, but `editing->chrome` is (`test/backend/module-boundaries.test.ts:241-302`). The caret modules belong to the `editing` module (`scripts/module-manifest.mjs:249-260` and the editing id list). A new restore module must live in `editing/` and import `chrome/open-preview`.

**Caret authority** (`media-src/src/editing/caret.ts`)
- F9. `requestCaret(intent)` replaces any live intent. It writes once immediately (the first write rewrites even when the coordinates already match), then re-asserts on every animation frame until one of these happens: a gesture invalidates it, the bound editor changes, more than 90 consecutive misses, or more than 300 ticks (`caret.ts:356-367`, `458-503`, `526-541`). A directional selection is a supported intent, `{anchor, focus}` (`caret.ts:76-78`, `389-419`). Endpoints can be `{node, offset}` (exact while the node is still in the editor, `caret.ts:333-341`) or `{textOffset}` (clamped walk over the editor's text nodes, `caret.ts:232-257`).
- F10. Only these events invalidate an intent: `keydown`, `pointerdown`, `beforeinput` and `compositionstart`, all on the document in capture phase (`caret.ts:579-606`). A programmatic `addRange`/`setBaseAndExtent` that bypasses `requestCaret` does not invalidate it. For a collapsed intent, `tryPlace` rewrites whenever the live range differs from the target (`caret.ts:429-444`).
- F11. Ticks only advance on animation frames (`caret.ts:453-456`). An intent armed shortly before frames stop (a hidden or unfocused webview) keeps its remaining ticks, so it can write again on the next frame a later layout or config event produces. Inference from F9-F11 (not measured): this is the most likely mechanism behind the Task 649 finding (`tasks/done/649-section-indentation-by-heading-level.md:199,235`; `media-src/e2e/section-indent.spec.ts:895-901`). A programmatic range set while an older caret intent was still live gets overwritten by that intent.
- F12. `editor-caret.ts` keeps `lastEditorRange` from `selectionchange` (`editor-caret.ts:18-39`). `restoreEditorCaretIfLost()` restores only the start of that range, as a collapsed caret (`editor-caret.ts:590-605`).

**Focus handling** (`media-src/src/editing/focus-restore.ts`)
- F13. A `focusout` from inside the editor schedules `restoreEditorFocus(win, true)` one frame later, gated on `document.hasFocus()` (`focus-restore.ts:129-160`). When `activeElement` is BODY and the selection anchor is inside the editor, it calls `editor.focus({preventScroll:true})` and then `requestCaret({node: saved.startContainer, offset: saved.startOffset})` (`focus-restore.ts:91-115`). That is a **collapsed** intent at the selection start, and it has no check for a hidden editor. If hiding the focused pane fires `focusout` in the VS Code webview, this path collapses the selection (Task 651's "collapsed and moved") and arms an intent against the hidden editor. Each frame is then a miss, for up to 90 frames. Whether the `focusout` actually fires is **unverified** (Chromium focus-fixup event behaviour on `display:none`). The Task 651 Chromium harness keeps the selection, and it installs neither focus-restore nor caret invalidation (`media-src/e2e/preview-memory-harness.ts:1-41`). That fits this hypothesis.
- F14. `installFocusRestore`, `installCaretInvalidation`, `installEditorCaretTracking` and `installIrMarkerReveal` are installed once in `main.ts` (`media-src/src/boot/main.ts:145,160-161,166`).
- F15. The editor-action gate already treats the hidden editor's selection as possibly still present while Preview shows (`media-src/src/bridge/editor-actions.ts:202-206`).

**Editor element per mode**
- F16. `activeModeElement(v)` returns `v.vditor[currentMode].element`: the IR or WYSIWYG `pre.vditor-reset`, or the SV source element (`media-src/src/util/source-map.ts:325-330`). This is the element `requestCaret` binds to.

### Decisions

- D1. **New module `media-src/src/editing/preview-caret.ts`** (manifest id `preview-caret` in the `editing` list). It exports `installPreviewCaretRestore(button: HTMLElement, deps?: Partial<PreviewCaretDeps>): () => void`. It is wired in `finish-init.ts` next to Task 651's listener: `observers.set('preview-caret', installPreviewCaretRestore(previewBtn))`. It keeps its state per install, so a re-init drops it (F5).
- D2. **Capture point:** a capture-phase `click` listener on the button node. At the target, capture listeners fire before Vditor's target listener. Capture runs when the button is not disabled and not `vditor-menu--current` (turning on). Because of F7, the real click and `openInPreview()`'s dispatched click both leave the selection intact at this point. Keyboard activation (Enter or Space on the focused button) also produces a `click`.
- D3. **Snapshot** (taken only when both selection endpoints are inside `activeModeElement`):
  ```ts
  interface PreviewCaretSnapshot {
    editor: HTMLElement; mode: 'ir' | 'wysiwyg' | 'sv'
    anchor: { node: Node; offset: number; textOffset: number }
    focus: { node: Node; offset: number; textOffset: number }
    hadFocus: boolean // editor.contains(document.activeElement) at capture
  }
  ```
  `textOffset` uses the same rule as `caret-preserve.ts:22-31` (the `Range.toString().length` from the editor start to the endpoint). It is the same text space `resolveTextOffset` walks. If the selection is outside the editor (for example in Split's preview pane) or absent (a first open or a stream open, F6), no snapshot is taken and nothing is restored later.
- D4. **Confirm on, then quiet the authority:** a bubble listener on the button (registered after Vditor's) checks that the class actually went from off to on. If it did not (disabled button), the snapshot is discarded. If it did, it calls `invalidateCaret()`, so no older intent writes into the hidden editor while Preview shows.
- D5. **Restore point:** the same bubble listener, on an on-to-off class change, inside the same click dispatch. By then the pane is visible (F3). Steps:
  1. Read `editor = activeModeElement(window.vditor)`. If `editor !== snap.editor` or `currentMode !== snap.mode`, discard (re-init or mode switch while in Preview).
  2. Resolve each endpoint. If `node.isConnected && editor.contains(node)`, use `{node, offset}` (exact). Otherwise use `{textOffset}` (the document was rebuilt while Preview was open, for example by a Preview checkbox toggle or an external update; clamped; see Owner question Q1).
  3. Record `prevActive = document.activeElement`.
  4. If `snap.hadFocus`, call `editor.focus({preventScroll: true})`.
  5. Call `requestCaret(collapsed ? anchorIntent : {anchor, focus})`. A collapsed snapshot is one where both endpoints match.
  6. If `!snap.hadFocus` and `prevActive` is an HTMLElement other than BODY that is no longer `document.activeElement` (writing a selection can move focus into the editable, `edit-activity.ts:322-331`), call `prevActive.focus({preventScroll: true})`.
  7. Clear the snapshot. A snapshot is used once.
- D6. **Focus rule:** focus returns to the editor only if the editor had it at capture. A keyboard user on the Preview button keeps focus on the button and still gets the selection back.
- D7. **Task 649 finding (coordinator scope addition).**
  - (a) 652's restore **must go through the caret authority**. It uses `requestCaret` with a `{anchor, focus}` intent (D5.5), and capture calls `invalidateCaret()` (D4). Otherwise a still-live older intent overwrites the restored range on the next frame, and the restore can be undone by any later layout or config event (F10, F11). With D4 and D5, the restored selection is the live intent, so a later event re-asserts the restored selection, not an older caret.
  - (b) The general fix (any programmatic selection write retires or updates the live intent) is **a separate task, not 652**. It changes ADR-0007's contract for every authority caller (about 20 call sites: `requestCaret` users in `edit-activity.ts:360`, `selection-scope.ts:261,634,861,1588,1740`, `rewrap-command.ts:470,534,581`, `math-insertion.ts:666`, `gap-click.ts:71`, `table-actions.ts:163-164`, `escape-toolbar.ts:411`, `caret-preserve.ts:52`, `focus-restore.ts:115`, and the patched Vditor undo bridge `window.__vmdeRequestCaret`, `caret.ts:621-635`). It needs a way to tell the authority's own writes from foreign ones. A `selectionchange` that does not match the live intent's last write is the obvious signal, but `selectionchange` is async and Vditor's own undo/spin writes would also trip it. That makes it a design question with regression risk across undo, gap-nav and IME, not a leftover of the Preview toggle.
  - Proposed follow-up: "Foreign selection writes retire a stale caret intent", from Tasks 649 and 652. Part 1 must first measure the actual Task 649 mechanism (F11 is an inference).
- D8. **focus-restore guard:** in `restoreEditorFocus` (`focus-restore.ts:42`), return early when `previewShowing()` is true (import from `../chrome/open-preview`; `editing->chrome` is allowed). A hidden editor cannot take focus, and that path's collapsed `requestCaret` (F13) is the likely collapse. This covers both the `focusout` path and the window-`focus` path (leaving and returning to the tab while Preview shows). In jsdom the toolbar is absent, so `previewShowing()` is false and existing unit cases are unaffected. The 652 restore does not depend on this guard (it restores from its own snapshot). The guard stops the stray write into the hidden selection while Preview shows.
- D9. **Out of scope or unchanged:** Vditor's `Preview.ts`, preview rendering, Task 651's memory listener, scroll handling (`preventScroll` and Selection writes do not scroll the view; the real-VS-Code test asserts `scrollTop` is unchanged), Undo (selection writes add no history entry), and saved Markdown (no DOM content change; IR marker reveal changes classes only, `editor-caret.ts:480-483`).
- D10. **Streaming:** the stream-end `openInPreview()` runs with no editor selection, so there is no snapshot. Turning Preview off then behaves as today. A stream in progress cannot be toggled into Preview by the user any differently, so no extra rule is needed.

### State, DOM, messages
- No new host message, setting, state key or DOM attribute. Module-local state per install: `snapshot: PreviewCaretSnapshot | null` and `wasOn: boolean`.
- `PreviewCaretDeps` (injectable for Vitest): `getVditor(): InnerVditor | null`, `document: Document`, `requestCaret`, `invalidateCaret`.

### Part 2 steps

- **S1 – RED and measurement.**
  - Owned files: new `test/vscode-e2e/preview-caret.spec.ts`; extend `media-src/e2e/preview-memory-harness.ts` and `media-src/e2e/preview-memory.spec.ts` (new `describe('caret restore')` cases).
  - Write the real-VS-Code test (shape below) and the Chromium cases first. In the Chromium harness, install `installCaretInvalidation()`, `installFocusRestore(window)` and `installEditorCaretTracking()` as `main.ts` does, guarded by a `?caret=1` parameter so the Task 651 cases keep their setup.
  - Run `node build.mjs`, then `cd test/vscode-e2e && env -u ELECTRON_RUN_AS_NODE xvfb-run -a npx playwright test preview-caret.spec.ts --workers=1 --retries=0`, and `xvfb-run -a npm --prefix media-src run test:e2e -- preview-memory.spec.ts`. Record the failures.
  - In the same RED run, log (in the spec, not product code) after Preview on and after Preview off: whether a `focusout` from the editor fired, `activeElement`, and the selection offsets. Record this in the task record. It confirms or refutes F13 and decides whether D8 is the collapse cause.
- **S2 – fix to GREEN.**
  - Owned files: new `media-src/src/editing/preview-caret.ts` and `media-src/src/editing/preview-caret.test.ts`; `media-src/src/boot/finish-init.ts` (one `observers.set` line next to line 641, plus the import); `scripts/module-manifest.mjs` (id `preview-caret` in `editing`); `media-src/src/editing/focus-restore.ts` and `focus-restore.test.ts` (D8); the Chromium harness from S1 (install `installPreviewCaretRestore`).
  - Write the Vitest cases first (RED), then implement D1-D8.
  - Checks: focused Vitest (`preview-caret`, `focus-restore`, `open-preview`, `finish-init`, `module-boundaries`, `caret`, `editor-caret`); `npm run typecheck`; `npx tsc --noEmit -p ./`; `npx biome check` on changed files; the Chromium spec; `node build.mjs`; the real-VS-Code spec.
- **Independent review:** shared caret path. Check D4/D5 ordering against `installPreviewMemory`, the authority lifetime, and focus.
- **S3 – real-VS-Code spec GREEN and closure:** rerun `preview-caret.spec.ts` once on the final build. Closure gates once per closure batch as DEVELOPMENT.md and the queue define them.

### Tests mapped to Acceptance

| Acceptance or edge case | Layer and case |
|---|---|
| A1: IR, WYSIWYG and Split caret and selection unchanged after on and off | Vitest `preview-caret.test.ts`: exact-node restore of a directional selection (anchor after focus kept); collapsed caret restored as a collapsed intent. Chromium (`?caret=1`, modes ir/wysiwyg/sv): anchor and focus text offsets, selected string and `isCollapsed` identical after a real click on and off. Real VS Code: same for all three modes. |
| A2: a click on the Preview control equals the toolbar toggle | Chromium and real VS Code: a real click (Playwright click on the button) and a dispatched `click` (the `openInPreview` path or `button.click()`) give the same restored result. Vitest: keyboard-style activation with focus on the button restores the selection and leaves focus on the button (D6). |
| A3: saved Markdown unchanged | Real VS Code: document text on disk, `isDirty` false and Undo depth unchanged before and after the cycle. Chromium: `getValue()` identical and the `__inputs` count unchanged. |
| Focus only if the editor had it | Vitest: `hadFocus` true focuses the editor; false does not. Real VS Code: `activeElement` is inside the editor after off, and a typed character lands at the restored caret, then Ctrl+Z (leaves the text unchanged). |
| Older caret intent does not override (649 interplay) | Vitest: a live intent before capture becomes null after on (`liveCaretIntentForTests`, `caret.ts:638`), and after off the live intent is the snapshot's `{anchor, focus}`. Chromium: arm `window.__vmdeRequestCaret({textOffset: 3})`, then set a range programmatically, cycle Preview, dispatch `resize`, wait 2 frames: the range holds. Real VS Code: after the cycle, change a live setting (`vmde.editor.sectionIndent` on, then back) and the selection still holds. |
| Selection made in the preview pane while Preview shows | Chromium and real VS Code: select text in the overlay, turn Preview off, and the original editor selection is back. |
| No selection in the editor (first open, remembered Preview, Split preview-pane selection) | Vitest: no snapshot, so off writes nothing (`requestCaret` spy not called). |
| Document changed while in Preview | Vitest: snapshot nodes disconnected (editor content replaced) fall back to clamped `{textOffset}` endpoints (per Q1). |
| Re-init or mode switch while in Preview | Vitest: editor identity or mode changed means discard (no write); the disposer removes both listeners. |
| Disabled button | Vitest: a click with `vditor-menu--disabled` leaves no snapshot and calls no `invalidateCaret`. |
| focus-restore guard (D8) | Vitest `focus-restore.test.ts`: with a fake toolbar Preview button carrying `vditor-menu--current`, a `focusout` restore calls neither focus nor `requestCaret`. |

**Real-VS-Code spec `test/vscode-e2e/preview-caret.spec.ts`:** one `test()` on the harness VS Code with a small fixture. The steps run in order:
1. IR: select a range across a paragraph into a heading. Real click on Preview on, select text in the overlay, real click off. Assert offsets, string, focus and `scrollTop`.
2. Type one character, assert it lands at the restored selection, then Ctrl+Z.
3. Toggle `sectionIndent` and assert the selection holds.
4. Switch to WYSIWYG (edit-mode menu) and repeat the cycle with a collapsed caret.
5. Switch to Split and repeat with a range in the source pane.
6. Assert the file on disk is unchanged and the editor is not dirty.

A second `test()` only if the dispatched click case cannot share the editor state.

### Owner questions

- **Q1. What should the restore do when the document changed while Preview was open** (a checkbox toggled in Preview, or an external update)?
  - (a) **Recommended:** restore at the same character offsets, clamped. This is consistent with how external updates already keep the caret (`caret-preserve.ts`).
  - (b) Discard and restore nothing.
  - (c) Restore only if the text before the selection is unchanged, else discard.

### Residual risks
- F13 (the `focusout` collapse) is a hypothesis until S1 measures it. If the collapse has another cause, D5 still restores from the snapshot, and D8 is then only hygiene.
- `editor.focus({preventScroll:true})` and `requestCaret` are expected not to scroll. The real-VS-Code `scrollTop` assertion is the check.
- The restored intent stays live for up to about 5 s (300 frames). A programmatic selection written in that window by another non-authority writer would be overwritten. That is the general Task 649 issue, left to the proposed follow-up (D7b).
- With fallback (a), a large edit while in Preview can put the restored selection on different text.
- iPhone `touchstart` is not handled (Vditor's `getEventName`). That platform does not apply in the VS Code webview.
