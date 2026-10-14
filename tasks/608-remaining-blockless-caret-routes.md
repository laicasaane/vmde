# Task 608 — Resolve remaining blockless IR caret and toolbar routes

**Status:** planned (2026-09-29). The Project Owner assigned Task 600's OQ5 and OQ6 residuals to a follow-up; The Project Owner approved the interaction policy on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** Task 600 Part 1 audit and S3a real-VS-Code probe.
**Scope:** IR only. Do not change Task 600's block-marker normalization or its seven-action format/list refusal without evidence that those contracts are involved.

## Problem and evidence

| Route | Evidence | Current consequence |
| --- | --- | --- |
| Ctrl+Home in a document beginning with a thematic break made from four hyphens | Measured in VS Code 1.129.0, Task 600 S3a: tmp/task600-checks/relay2/oq6.log and tmp/task600-checks/relay2/observations/oq6-results.json. The first IR node was HR[data-block="0"] and the selection became PRE.vditor-reset@0. | Native root landing has no block marker for Task 600 B1 to normalize. The Markdown remained unchanged in the probe; later editing from that caret is unmeasured. |
| Ctrl+Home in a document beginning with [toc] and markdown.toc enabled | Same S3a probe: caret remained in Echo text@15. | Navigation to the start was not proved. This is an investigation control, not a confirmed root landing. |
| Fresh open or another path with no live IR range, then Headings | Code audit in tmp/queue-part1/600-part1-handoff.md §5.C: Vditor getEditorRange can synthesize (editor, 0); processHeading in Vditor ir/process.ts can edit the first heading marker or insert at the root. | Predicted route; no post-Task-600 behavioral measurement yet. |
| The VMDE Link button at a blockless range | Same audit: media-src/src/chrome/toolbar.ts calls insertValue('[]()'). | Predicted new top-level paragraph; no post-Task-600 measurement yet. |
| Code and Table buttons at a blockless range | Same audit: Vditor inserts new top-level blocks. | An intentional insertion may be valid. Determine the desired contract before guarding either action. |

Task 600 now protects bold/italic/strike/inline-code and list/ordered-list/check at a blockless IR range. Those seven actions are controls here. Task 597 owns the distinct Undo root-range path, and Task 599 owns Find-close selection restoration.

## Investigation and decision boundary

1. Reproduce the hr-first root landing in the current build using real VS Code and a privacy-safe fixture. Record the native selection before and after Ctrl+Home, the active block, the next Right/Left/typing outcome, and exact host bytes. Repeat with a TOC-first document to establish whether that control can navigate to its first block.
2. In fresh-open and explicitly seeded root states, exercise Headings, Link, Code and Table by toolbar mouse click and the promoted hotkey where one exists. Record selection, document value, host write, Undo boundary and any pre-existing first block mutation. Include an ordinary in-block control for each action.
3. Apply the Owner decisions below for Headings, Link, Code and Table. Preserve their intended empty-editor and in-block behavior. Do not infer a blanket refusal policy from Task 600's seven-action guard.
4. Implement only the approved action policy and root-navigation repair. Prefer one owning layer per route, preserve source bytes and history, and avoid editor-wide caret scans.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

After the navigation repair, at a blockless IR caret:

- **Headings and Link** refuse: no edit and no history entry, like Task 600.
- **Code block and Table** insert a new top-level block at the caret's root position, with exact bytes and one Undo step.

## Verification

- Vitest for any new pure guard and anchor-asserted Vditor source patch; require a RED result against the reproduced route before implementation.
- Chromium tests for navigation and each toolbar route, including first-paragraph preservation, fresh-open fallback, empty-editor behavior and unchanged seven-action Task 600 controls.
- A focused no-retry real-VS-Code spec, built first with node build.mjs, for OS-level Ctrl+Home on hr-first and TOC-first documents and the Owner-approved toolbar actions. Assert exact host text, focus and caret membership after every action.
- Run the focused Task 600 blockless-caret specs and relevant marker/navigation regressions. Record inherited quality and budget results separately.

## Acceptance

- [ ] At a blockless IR caret, Headings and Link refuse with no edit and no history entry; Code block and Table insert a new top-level block at the root position with exact bytes and one Undo step.
- [ ] Ctrl+Home and ordinary navigation in the confirmed hr-first case leave a usable caret inside an editable block, with no unintended Markdown change.
- [ ] Every guarded action at a blockless IR range leaves the document and first paragraph intact; every approved insertion remains source-faithful and undoable.
- [ ] Focused Chromium and real-VS-Code tests pass without retries, with exact host text and clear baseline comparison for any inherited failure.

## Part 1 handoff (2026-10-14)

Read-only review of the source plus scratch Lute simulations; nothing was run in the product.

- **Task 625 first.** Task 625's cause was CSS (an empty paragraph without a line box); its caret stayed inside a block, so it is not a blockless route. Task 609 (marker ties) does not overlap these routes.
- **Cause and entry points.** Ctrl+Home on an HR-first document (measured in Task 600 S3a): Lute renders `----` as a bare `<hr data-block="0">` with no marker, so Task 600's marker normalizer (`editor-caret.ts`) lets the native root landing through. TOC-first: the TOC is a non-editable `div.vditor-toc`; the measured "caret stays put" is unexplained (probe). An existing owner covers this class: Task 292's gap cursor (`gap-boundary.ts` `needsGap`, `gap-nav.ts`, `gap-click.ts`, `gap-paragraph.ts`) — ArrowUp after a leading HR already places a transient gap paragraph at boundary 0; Ctrl+Home is the route with no handler. Headings: Vditor `ir/process.ts` processHeading uses `hasClosestBlock(start) || range.startContainer`; at the root it rewrites the first heading anywhere in the document or inserts text at the root and spins the whole editor (both the toolbar and Format: Heading N reach it). Link: `chrome/toolbar.ts` insertMarkdownLink focuses and inserts `[]()` at a possibly root range. Code and Table: processToolbar inserts a root span and `ir/input.ts` spins the whole editor; simulated results: clean at root offset 0, but at offset 1 (HR then paragraph) the structure is corrupted (front-matter-like), and Table between paragraphs adds a blank line — Vditor's stock root insertion fails "exact bytes".
- **Contract (Owner rule plus refinements).** (1) Navigation, IR only: on primary+Home (Cmd+ArrowUp on Mac), when content block 0 is atomic (`needsGap` at boundary 0), pre-empt and place the caret in the boundary-0 gap (`gap-nav.ts` keydown, the single owner of void-boundary navigation); Markdown unchanged unless the user types; the gap is reclaimed when the caret leaves. Fallback, only if S1 measures other keyboard root landings: in `editor-caret.ts` apply(), act on a collapsed root range only after a trusted navigation keydown in that frame (gap if `needsGap`, else the near edge of the adjacent text block); never normalize programmatic root ranges (Tasks 439/446/490 jump-to-top risk; Task 600's seeded tests); skip during composition or a live caret intent. (2) Blockless predicate: range start inside the IR editor, no closest block, and the editor has a `:scope > [data-block]` child (the empty editor keeps Vditor's paths). (3) Headings refuse: one anchor-asserted patch at processHeading's `headingElement` line returns when blockless (covers toolbar, toggle and chord; no input, no Undo entry). (4) Link refuses: a guard in insertMarkdownLink after focus/range restore (no `editing/` import into `toolbar.ts` — use Vditor's `hasClosest` inline; confirm with module-boundaries and depcruise). (5) Code and Table insert: patch processToolbar so a collapsed blockless code/table insert first adds a `<p data-block="0">` holder at the range's root offset and moves the range into it, so only that block spins; bytes equal the in-block empty-paragraph control; one Undo step; chained after Task 600's blockless inline-format patch.
- **Part 2.** S1 (real VS Code, measure only): HR-first and TOC-first Ctrl+Home with a selection log, then Right/Left/type; PageUp, Ctrl+End on an HR-last document, an HR-only document; the four toolbar routes plus Format: Heading 2 and the code command at fresh-open and stored-root states with in-block controls (selection, exact host bytes, Undo count, whether `----` survives); the empty-editor IR DOM; whether the Task 596 gate disables Code at the root. S2a RED: `gap-nav.test.ts` (Ctrl+Home with an atomic-first fixture places the caret in the gap; paragraph-first untouched) and `test/backend/vditor-source-patches.test.ts` (heading and code/table patches; one anchor; drift throws). S2b GREEN: the gap-nav repair (+ the editor-caret fallback only if S1 needs it). S3: the processHeading and processToolbar patches and the Link guard (`toolbar.test.ts`: Link refuses at a blockless range and inserts in the empty editor). S4: new `test/vscode-e2e/blockless-routes.spec.ts` (HR-first and TOC-first navigation; the four actions at fresh-open and seeded root with in-block controls); Chromium cases in `media-src/e2e/blockless-caret.spec.ts` (HR-first and TOC-first fixtures); regressions `blockless-caret` (Chromium and real VS Code), `hr-edit.spec.ts`, Chromium `gap-cursor.spec.ts`, `marker-reveal`, `toc-invalidation`. S5: closure.
- **Edge cases.** TOC with `markdown.toc` off; an HR-only document; gap cleanup after Code/Table inserted in the gap; Ctrl+Shift+Home (non-collapsed); root text nodes; a stale Headings current class after a refusal (cosmetic); large-document incremental serialization.
- **Decisions (provisional, reversible).** (1) Ctrl+Home on an atomic-first document lands in the transient gap paragraph before the HR/TOC, consistent with Task 292's ArrowUp and click — adopted (navigation layer is a Part 1 decision). (2) A non-collapsed range starting at the root: all four actions refuse (the Owner rule covers carets only; matches Task 600's refusal of the seven actions for non-collapsed ranges; stock Code/Table would replace the document with rendered text) — adopted provisionally, Owner asked. (3) HR-only/TOC-only document: Ctrl+Home lands in the boundary-0 gap; stock root typing otherwise out of scope — adopted.
- **Risks.** Exact pins for `----` depend on host exact-source preservation (unverified); Task 600's Chromium seeded-root tests stay safe only if the fallback normalizer stays keyboard-gated; the Lute outcomes are simulations.
