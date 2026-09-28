# Task 600 — Never leave or act on an IR caret outside every block (Ctrl+Home then Ctrl+B corrupts the document)

**Status:** planned (2026-09-28). The Project Owner approved the finding. Implementation has not started; the decisions below are open.
**Origin:** found during the Task 596 investigation (2026-09-28). The defect predates Task 579.
**Severity:** high. Ordinary keyboard use inserts content into the document.
**Recommended implementer effort:** high.
**Tech stack:** TypeScript webview (`media-src/src/editing/editor-caret.ts`, `media-src/src/bridge/message-router.ts`), optionally a build-time Vditor patch, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:** none; this task can run first.

- **Task 599** (Find close selection) removes one route to this state.
- **Task 597** removes the Undo route (a `<wbr>` at the root level).

**Evidence:** `tmp/task596-603-evidence/t599/results2.json` (S10, S13, S14) in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build, IR mode.

## Problem

All results below use the document `# Probe\n\nAlpha bravo charlie delta.\n\nEcho \`foxtrot\` golf hotel.\n`. Find is not involved.

| Sequence | Selection | Result |
| --- | --- | --- |
| Caret in body text, Ctrl+Home | `PRE.vditor-reset@0` | Ctrl+B gives `****\n\n# Probe…`; typing `Q` gives `**Q**\n\n# Probe…` |
| Same state, click the toolbar Bold button | `PRE@0` | `****\n\n# Probe…` |
| Same state, press Right once | still `PRE@0` | the caret does not leave this position |

Ctrl+G at `PRE@0` inserts ``` `` ``` in the same way.

Measured cause:

1. **The caret is ejected from the heading.** A native move to the heading marker (`"# "@0`) is followed, about 16 ms later, by `installIrMarkerReveal` → `normalizeMarkerNavigationCaret` (`editor-caret.ts:156-202`, write at `:191-194`). That code treats a **block** IR node (`H1.vditor-ir__node[data-block]`) like an inline node and places the caret in `node.parentNode`, which is the editor root. `isInlineIrNode` (`editor-caret.ts:109`) already tells the two cases apart, but the normalizer does not use it.
2. **Formatting does not refuse such a caret.** IR `processToolbar` (`vditor/src/ts/ir/process.ts:170, 203-221`) inserts `<span>**<wbr>**</span>` at `PRE@0`. `input()` then finds no block (`ir/input.ts:88-91`), re-renders the whole editor (`:179`), and creates a new top-level paragraph. This happens on the hotkey path and on toolbar mouse clicks alike.

## Design

1. **B1 — root fix, in `normalizeMarkerNavigationCaret`.** For a node with `data-block`, put the caret at the start or end of the block's content text, after the heading marker, and never in `node.parentNode`. Keep the ejection of inline nodes unchanged.
2. **B2 — defence in depth: refuse inline formats at a caret outside every block.**
   - **Hotkey route:** in `handleTriggerToolbarHotkey`, after `restoreFormatHotkeySelection`, do not dispatch bold, italic, strike or inline-code when `!hasClosestBlock(range.startContainer)` and the start container is the editor root. Coordinate the placement with Task 596's gate.
   - **Mouse route:** either a capture-phase guard on those toolbar buttons, or a build-time patch to IR `processToolbar` in `esbuild-shared.mjs` that returns early for a caret outside every block.
3. **Audit** the other writers of `requestCaret({node: parent…})` and any other code that can produce a caret at the root, and list them in this record. Check WYSIWYG and SV for the same state; neither was probed.

## Owner decisions needed

1. With the caret at the start of a heading's text, should Ctrl+B produce `# **Q**Probe` (Vditor's normal empty-bold insertion inside the heading, recommended), or do nothing?
2. Include B2 for toolbar mouse clicks as well (recommended), or only for the hotkey route?
3. Where should the mouse-route guard live: a capture listener in VMDE, or a Vditor source patch?

## Tests

- **Vitest**
  - `editor-caret.test.ts`: a collapsed caret at a non-expanded `H1[data-block] > .vditor-ir__marker--heading` text@0 normalizes to inside the H1 content, never `H1.parentNode`. Inline-node ejection is unchanged.
  - `message-router.test.ts` (B2): a collapsed selection at the root does not dispatch bold, italic, strike or inline-code.
- **Chromium:** Ctrl+Home, then a toolbar Bold click. The rendered value never starts with `****`. Repeated Right presses move into the heading text.
- **Real VS Code** (XTEST, new spec `test/vscode-e2e/blockless-caret.spec.ts`):
  - Ctrl+Home, then Ctrl+B, then `Q`: the host exactly matches decision 1, and never matches `/^\*\*/`.
  - The same with the toolbar Bold click and with Ctrl+G.
  - A paragraph-first document as a control.
  - IR required. Run WYSIWYG and SV to confirm, and record the results.

## Acceptance

- [ ] No keyboard or mouse navigation in IR leaves the caret at the editor root.
- [ ] No inline-format route inserts a new top-level block from a caret outside every block.
- [ ] Exact host text for every leg in real VS Code. The results for WYSIWYG and SV are recorded.
