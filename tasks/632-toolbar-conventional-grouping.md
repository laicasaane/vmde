# Task 632 — Rearrange toolbar buttons into conventional groups

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14 and approved the reorder the same day (see Owner decision). Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (low risk; layout only).
**Tech stack:** TypeScript webview (`media-src/src/chrome/toolbar.ts`, `toolbar-layout.ts`, `toolbar-overflow.ts`), Vitest, Chromium, real VS Code.
**Supersedes:** the two-row order of [Task 571](done/571-reorder-two-row-toolbar-controls.md) (Owner-approved 2026-10-14). Task 571 keeps its record as history.
**Related:** [Task 631](631-toolbar-collapse-toggle.md) (collapse toggle at the end of row 1).

## Problem

The current two-row order (Task 571) mixes groups that established editors keep apart. For example, Undo/Redo sit in the middle of row 2, Inline Code is separated from the other inline formats, and block inserts (Code Block, Math, Table) are split across both rows. Users who know Word, Google Docs, Notion, Typora, Obsidian or the GitHub Markdown editor look for these controls in familiar places.

## Conventions to follow

Established editors group toolbar controls in this left-to-right order:

1. History: Undo, Redo.
2. Block type: Headings / paragraph style.
3. Inline text formatting: Bold, Italic, Underline, Strikethrough, Inline Code; then Subscript, Superscript.
4. Link.
5. Lists and indentation: Bulleted, Numbered, Checklist; Outdent, Indent.
6. Block inserts: Blockquote, Callout, Details, Code Block, Math, Table, Horizontal Rule.
7. Media and symbols: Upload (image/file), Emoji.
8. Document structure: Insert Before, Insert After.
9. View and navigation: Outline, Preview; Go Back, Wiki Pages.
10. Mode and app: Edit In VS Code, Edit Mode, More.

## Proposed order (approved by the Project Owner on 2026-10-14)

Row 1 (editing and formatting):

Undo, Redo | Headings | Bold, Italic, Underline, Strikethrough, Inline Code | Subscript, Superscript | Link | Bulleted List, Numbered List, Checklist | Outdent, Indent

Row 2 (insert, view and mode):

Blockquote, Callout, Details, Code Block, Math, Table, Horizontal Rule | Upload, Emoji | Insert Before, Insert After | Outline, Preview | Go Back, Wiki Pages | Edit In VS Code, Edit Mode, More

`|` is a separator. Go Back and Wiki Pages appear only when wiki navigation is enabled (unchanged). Task 631's toggle, when present, stays at the trailing end of row 1.

## Owner decision (2026-10-14, chat)

The Project Owner approved reordering the toolbar controls and changing their positions based on the established patterns and designs of highly regarded software and applications. The proposed order above is the approved starting point. Part 1 may refine positions within it when a well-established convention supports the change; record each refinement and its reason in this file. No further Owner approval is needed for such refinements. Adding, removing or renaming controls stays out of scope.

## Scope

- Change only the order, row membership, separators and the overflow give-way order of existing top-level controls. Overflow gives way from the end of each row by whole groups; History, Headings and More stay visible longest.
- Preserve every control's action, submenu, tooltip, shortcut, enabled/active state, wiki availability, keyboard access, focus return and read-only Preview behavior. Keep exactly two rows.
- No new controls, icons or actions.

## Acceptance

- [ ] The final order (the approved proposal plus any recorded Part 1 refinements) is recorded in this file before implementation.
- [ ] Both rows match the approved order and separators, with wiki navigation enabled and disabled; no control is missing or duplicated.
- [ ] Narrow widths overflow whole groups into More in the approved give-way order, restore them in order, and leave no leading, trailing or doubled separators.
- [ ] Keyboard traversal follows the new visual order.
- [ ] Unit inventory test, Chromium wide/narrow checks and a focused real-VS-Code spec updated and run; `npm run quality` passes.

## Tests

- Vitest: update the Task 571 inventory and row-order tests (`toolbar-layout.test.ts`, `toolbar-overflow.test.ts`) to the approved order, wiki on and off.
- Chromium harness: wide and narrow layouts, overflow and restore, separators, keyboard order.
- Real VS Code (`test/vscode-e2e/`): update the Task 571 toolbar-order spec. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run. Refinements below are within the Owner's 2026-10-14 approval (Part 1 may refine with recorded reasons).

- **Entry points (verified).** Visual order is the flat order in `createToolbar` (`media-src/src/chrome/toolbar.ts`); `ensureToolbarRows` (`toolbar-layout.ts`) appends items in `ROW_ONE` to row 1 and the rest to row 2, keeping a `|` only between two items of the same row, so the flat list must hold all row-1 items, then all row-2 items. Give-way order: `ROW_ONE_CLUSTER_ORDER`, `ROW_TWO_CLUSTER_ORDER`, `LEGACY_CLUSTER_ORDER`; pinned `PRIMARY_ROW_ONE = ['emoji']`, `PRIMARY_ROW_TWO = ['undo', 'redo']`; inventory `KNOWN_TOOLBAR_ITEMS` (`toolbar-overflow.ts`). `decideOverflowGroups` moves out the first listed group first, so today each row gives way from its start (Headings first); the record's "from the end" is a behaviour change, not only a reorder. Keyboard traversal follows DOM order with wrap (`editing/escape-toolbar.ts`). Separators are re-evaluated only inside `apply()` after the unchanged-signature early return; Vditor hides `outdent`, `indent`, `outline`, `insert-before`, `insert-after` in SV (`EditMode.ts`).
- **Final order (the record's order, unchanged).** Row 1: `undo redo | headings | bold italic underline strike inline-code | subscript superscript | link | list ordered-list check | outdent indent` (16 controls; Task 631's toggle follows `indent` with no separator). Row 2: `quote callout details code math table line | upload emoji | insert-before insert-after | outline preview | navigate-back wiki-pages | edit-in-vscode edit-mode more` (18 controls; 16 without wiki links, dropping `| navigate-back wiki-pages`).
- **Pinned (never give way).** Row 1: `undo`, `redo` (History stays longest) and the Task 631 toggle. Row 2: `emoji` (Tasks 563/566 direct-Emoji contract, asserted by current specs) and `more`.
- **Give-way groups = separator groups, from each row's end.** Row 1: [outdent, indent], [list, ordered-list, check], [link], [subscript, superscript], [bold, italic, underline, strike, inline-code], [headings]. Row 2: [navigate-back, wiki-pages], [outline, preview], [insert-before, insert-after], [upload], [quote, callout, details, code, math, table, line], [edit-in-vscode, edit-mode].
- **Refinements.** R1: Edit In VS Code and Edit Mode give way last in row 2, as the anchor beside More — established editors keep mode/app controls at the far right while the middle collapses, and it keeps today's behaviour for that group. R2: derive the legacy single-row order from the row-1 list followed by the row-2 list instead of a third hand-kept list.
- **Separator defect to fix in S1 (hypothesis, probe first).** A mode switch with an unchanged overflow set does not re-evaluate separators. With the new order SV would show `check |` trailing in row 1 and a doubled `| |` before Preview in row 2. Probe at HEAD (SV at 1400 px, read visible row tokens), then run `updateSeparators` before the signature return and schedule `apply` on item `style` changes or in the edit-mode hook. The existing SV `dangling` check misses doubled separators; extend it.
- **Part 2.** S1: reorder `toolbar.ts` (no `|` between `indent` and `quote`), update `ROW_ONE`, cluster lists, the `PRIMARY_*` lists and `KNOWN_TOOLBAR_ITEMS`, the separator fix; update `toolbar.test.ts` (Task 571 order block; the `subscript+2` neighbour is now `link`; "Math after Emoji" becomes "Math after Code Block"), `toolbar-layout.test.ts` (row lists, `math`/`insert-before` row checks), `toolbar-overflow.test.ts` (`ownerControlOrder` and the flat-fixture cases that expect Headings in More first). S2: `media-src/e2e/toolbar-overflow.spec.ts` row lists, Math moves to row 2, row-boundary keys (Emoji ArrowRight → `insert-before`; More ArrowRight wraps to `undo`), choose a width where Math overflows, add SV and wiki-off separator checks (no leading, trailing or doubled) and a check that give-way runs from the row end (first verify the stale-looking "Emoji ArrowRight goes to `list`" assertion at HEAD). S3: `test/vscode-e2e/toolbar-order.spec.ts` row lists and `mathInRow`; read the first overflowed control at 700 px from the DOM instead of the hard-coded `headings`; rerun `test/vscode-e2e/toolbar-overflow.spec.ts` (order checks and the SV dangling check).
- **Edge cases.** The first roving stop changes from Headings to Undo (Escape, Tab, Enter now runs Undo — record it); the Task 631 toggle is not separator content (treat like `more`); Emoji opens from row 2 (re-check panel bounds in a narrow split); wiki off: the separator after `preview` touches `edit-in-vscode`.
- **Owner questions (provisional choices, reversible).** (1) R1 — adopted. (2) Keep Emoji pinned in row 2 — adopted. (3) Task 631's toggle has no separator and never gives way; whichever of 631/632 lands second adds it to `ROW_ONE`, the pinned list, `KNOWN_TOOLBAR_ITEMS` and the separator non-content rule — adopted (632 runs first).

## Execution progress — 2026-10-14 (S1)

- **Done.** `toolbar.ts` now authors the approved order (no separator between `indent` and `quote`; the wiki block keeps `navigate-back, wiki-pages, |`). `ROW_ONE` (`toolbar-layout.ts`) holds undo, redo, headings, the inline group, link, lists and indentation. `toolbar-overflow.ts`: row cluster lists give way from each row's end (R1: Edit In VS Code and Edit Mode last in row two), `PRIMARY_ROW_ONE = undo, redo`, `PRIMARY_ROW_TWO = emoji`, `KNOWN_TOOLBAR_ITEMS` in the new order, and the legacy single-row list is derived from the two row lists (R2).
- **Separator probe (before the fix, Source mode, 1400 px, wiki on).** Row one read `... check | | quote ...` (doubled rule) and row two started with `| upload table ...` (leading rule). The defect reproduced at the old order too, so it is independent of the reorder.
- **Separator fix.** The unchanged-signature path now runs `updateSeparators` before returning, and a `MutationObserver` on item wrappers' `style` schedules a layout pass (it ignores dividers, so the controller cannot retrigger itself). After the fix the same probe reads row one `undo redo | headings | ... | list ordered-list check` and row two `quote ... line | upload emoji preview | navigate-back wiki-pages | edit-in-vscode edit-mode more`: no leading, trailing or doubled rule.
- **Vitest.** `toolbar.test.ts` (order block, `subscript` neighbours, Math after Code Block), `toolbar-layout.test.ts` (row lists, Math in row two, Emoji row two, Undo row one), `toolbar-overflow.test.ts` (`ownerControlOrder`, fixture in production order, row-independence case, new separator-recompute test, new give-way-from-the-end test).
- **Chromium `toolbar-overflow.spec.ts` (not edited in S1) — expected failures for S2:** (1) owner row order test (old row lists); (2) row-boundary keys (Emoji ArrowRight now reaches `insert-before`, not `list`); (3) overflowed Math submenu test (Math now gives way later than at 360 px); (4) overflowed-rows test expects Headings in More at 180 px (Headings now gives way last in row one); (5) row-two give-way order test (its `preview` assertion assumes the old order). 23 of 28 pass.
- **Edge cases recorded.** The first roving stop is now Undo, not Headings. Task 631's toggle is not added here.
- **Not run in S1.** Real-VS-Code specs (S3) and `npm run quality`.

## Execution progress — 2026-10-14 (S2)

- **Done.** `media-src/e2e/toolbar-overflow.spec.ts` now asserts the approved contract (expected values taken from the record's final order, pinned controls and give-way groups): row lists with Math in row two; row-boundary keys (Emoji ArrowRight reaches `insert-before`, More ArrowRight wraps to `undo`); the overflowed-Math submenu test runs at 300 px, where Math has moved into More (it is still in the row at 360 px); the overflowed-rows test at 180 px expects the inline-formatting group in More and Headings still direct beside Undo and Redo; the row-two give-way test is rewritten as a group-order invariant (wiki on and off; Emoji and More always present; groups move whole; Edit In VS Code and Edit Mode last).
- **Added.** Row-one give-way from the row end with History always present; Source-mode and wiki-off separator checks (no leading, trailing or doubled rule across widths, including a mode switch at 1400 px and at 420 px where the overflow set does not change); keyboard traversal test (first stop Undo, ArrowRight walks the full visual order of both rows and wraps to Undo, ArrowLeft wraps to More).
- **Math submenu assertion changed.** The old test expected focus to stay on `math-inline-github` after ArrowDown and End. In the new layout ArrowDown/End move within the Math panel (`math-block`), and Home returns; the test now asserts that. Not re-checked against the pre-632 layout (no old build run).
- **Old "Emoji ArrowRight goes to `list`" assertion.** By the pre-632 source order, Emoji's successor was Math, so that assertion did not match the old order either; the new expectation is `insert-before`. Not run against the old build.
- **Separator rule fixed (follow-up).** In Source mode, row two showed `upload emoji preview` with no rule between the Emoji and Preview groups, because the rule logic only looked at the group next to each rule. `toolbar-overflow.ts` now keeps exactly one rule between consecutive visible groups (a rule is kept when a visible control precedes it since the last kept rule and one follows it later in the row). One helper serves both the DOM update and the row-width projection, so the overflow decision counts the same rules that are shown. A unit test covers a hidden middle group plus a partly hidden group (`emoji | preview`, and no leading rule when the first group is hidden too). The Chromium Source-mode check pins `... upload emoji | preview | navigate-back wiki-pages | edit-in-vscode edit-mode more` (wiki on) and the wiki-off variant.
- **Results (Chromium, own port).** `toolbar-overflow.spec.ts`, `toolbar-selection.spec.ts`, `escape-toolbar-harness.spec.ts` and `math.spec.ts` 51/51 after the follow-up; toolbar unit tests 109/109 (`src/chrome`). Biome clean. Not run: `npm run quality`, real-VS-Code specs (S3).
