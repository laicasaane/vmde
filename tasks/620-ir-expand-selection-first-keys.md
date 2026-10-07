# Task 620 — IR Expand Selection stays on the inline scope on the first keys after opening

**Status:** planned (2026-10-05). The Project Owner approved filing this record on 2026-10-05. Implementation has not started.
**Origin:** Task 580 CP4-1 classification runs (2026-10-05). Pre-existing: the same result on the pre-580 build `8c2ec1f0` (Expand was Ctrl+E) and on HEAD `0138a286` (Expand Selection is Shift+Alt+Right, `vmde.expandSelection`).
**Severity:** medium. Expand Selection does not widen past the inline scope, so the command does nothing useful. The source is not changed.
**Scope:** IR structural selection (`media-src/src/editing/selection-scope.ts`) inside an inline IR node (for example bold) on a document with no edit since it opened. Keep the Task 580 CP2-6 inline → cell → block → document ladder.

## Problem

Open a document in IR, put the caret inside a bold span, and run Expand Selection several times. Every press selects the same inline text. Expected: the first press selects the inline text, and the second selects the paragraph.

## Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--retries=0`. Large synthetic fixture `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (174,517 characters), IR. The caret was placed collapsed 3 characters into a word inside a bold IR node whose text is 20 characters. Three presses, 900 ms apart. Two runs per build gave identical results.

| Build | Key | Selection after presses 1, 2, 3 | Text-node lengths inside the inline node after presses 1, 2, 3 |
| --- | --- | --- | --- |
| `8c2ec1f0` (pre-580) | Ctrl+E | 20 characters each time, not the paragraph | `[2,0,20,0,2]`, `[2,0,0,20,0,0,2]`, `[2,0,0,0,20,0,0,0,2]` |
| `0138a286` (HEAD) | Shift+Alt+Right | 20 characters each time, not the paragraph | `[2,0,0,20,0,0,2]`, `[2,0,0,0,20,0,0,0,2]`, `[2,0,0,0,0,20,0,0,0,0,2]` |

- Each press adds 2 empty text nodes inside the bold node (one on each side of the 20-character text).
- On HEAD the selection ends move onto the new empty text nodes (start `#text` length 0, offset 0).
- Host: on HEAD the host stayed exact and clean. On the pre-580 build the host became dirty (181,855 characters, first difference at offset 66, the known large-fixture normalization).
- Evidence: session scratch logs `cls-pre1.log` and `cls-head1.log` from a temporary classification spec (`zz-cls580.spec.ts`) in a scratch worktree. Neither is committed; the numbers above are copied from them.

## Reproduction

1. Open the large synthetic fixture in IR. Do not edit.
2. Place the caret inside a bold word.
3. Press Shift+Alt+Right three times, about 1 s apart. The selection stays on the bold text.

## Suspected cause

- `handleScopeSelect` (`media-src/src/editing/selection-scope.ts:516`) → `selectNextScope` (`:492-499`) picks the first scope whose range is not `rangesEqual` (`:390`) to the current selection.
- The inline scope range comes from `inlineContentRange` (`:326`), which snaps its ends to the edge text nodes. When new empty text nodes appear between presses, the freshly computed inline range has different endpoint nodes than the current selection. `rangesEqual` never matches, so the inline scope is selected again on every press.
- The empty text nodes probably come from Vditor's `recordFirstPosition` → `addCaret` (`media-src/node_modules/vditor/src/ts/undo/index.ts:84-108`, `:227`). On each keydown while the history has one entry, it inserts and removes a `vditor-wbr` marker, which splits text nodes (the text-node split that `766eb74a` handles for the command selection snapshot). Unverified: confirm which code creates the nodes.
- Related: [Task 617](617-first-keydown-select-all-delete.md) (the same first-keydown path desynchronizes a whole-document selection).

## Candidate approaches

1. Compare scopes by text position (for example, by the text offsets within the inline node), not by DOM node identity, or ignore empty text nodes in `rangesEqual` for scope matching.
2. Stop the first-keydown marker insert from leaving empty text nodes (normalize after `addCaret`), coordinated with Task 617 and [Task 598](done/598-first-edit-undo-baseline.md).

## Tests

- **Vitest:** `selection-scope` with empty text nodes added around an inline node's text: the next scope after the inline stage is the block.
- **Chromium:** fresh document, caret in bold, three Expand Selection runs: inline, then paragraph, then document.
- **Real VS Code** (build first, `--retries=0`, OS-level XTEST): the same with Shift+Alt+Right on a freshly opened document; host exact and clean.

## Execution progress

- 2026-10-05, Task 580 regression fix (uncommitted at the time of writing): `rangesEqual` in `media-src/src/editing/selection-scope.ts` now treats two ranges as equal when they cover the same characters. Two boundary points match when no character lies between them, so split text nodes, empty text nodes and element boundaries next to text no longer make the ladder re-select a stage. This is candidate approach 1. Vditor still adds the empty text nodes; the ladder ignores them.
- Vitest (`selection-scope.test.ts`): new tests for empty text nodes around the inline text (Expand widens to the block), a split text node, element-versus-text boundaries, and distinct ranges staying unequal. They failed before the change and pass after it.
- Chromium `structural-selection.spec.ts`: the Ctrl+A and Expand Selection tests (including :115, inline → paragraph → document) pass in two runs of 4 workers × 4 repeats and in one 1-worker run.
- Real VS Code with XTEST and Openbox (`shortcut-identity.spec.ts`, large fixture, IR, fresh document): the stages after the inline stage were block then document in 2 of 2 full runs. Before the change, 3 of 13 recorded runs stayed on the inline stage. The leg now asserts block then document; one run passed with the tighter assertion.
- Not yet done: a dedicated real-VS-Code three-press check on a freshly opened document with "host exact and clean" recorded as this task's own evidence, and the "unchanged after an edit" acceptance item. Do not close this task on the evidence above alone.

## Acceptance

- [ ] IR, fresh document: Expand Selection inside an inline node selects the inline text, then the block, then the document (Chromium and real VS Code).
- [ ] Repeated presses do not keep adding text nodes, or the ladder ignores them.
- [ ] The Task 580 CP2-6 ladder (inline, cell, block, document) and Select All are unchanged after an edit.
