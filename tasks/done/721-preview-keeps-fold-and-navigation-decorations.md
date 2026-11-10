# Task 721 — Preview keeps fold controls and other reading and navigation decorations

**Status:** done (2026-11-10).
**Origin:** Owner request, 2026-11-09.
**Severity:** medium (estimated). Preview, the mode meant for reading, lacks the controls that help reading and navigation in the edit modes.
**Tech stack:** section fold (heading and list fold gutters), other non-Markdown decorations added by VMDE in IR/WYSIWYG, the Preview render route (`preview-render.ts`, Vditor Preview patch chain in `esbuild-shared.mjs`).
**Depends on:** none.

## Problem

Owner request: heading fold controls, bullet-list fold controls, and the other non-Markdown decorations must also be present in Preview mode. They exist to help reading and navigation inside the document, so leaving them out of Preview makes no sense.

Not yet known: the full list of VMDE decorations shown in IR/WYSIWYG and which of them Preview already has; which ones change editing state and so need a read-only form in Preview; whether fold state is shared between modes.

## Decisions

- D1 (Owner, 2026-11-10): Preview gets every decoration that the inventory classes as a reading or navigation aid, in a read-only form. Fold state is shared per document between Preview and the edit modes.

- D2 (provisional, worker, accepted by the orchestrator 2026-11-10): section hoist stays suspended in Preview (a view-scope command; the stored scope returns when Preview is turned off).
- D3 (provisional, worker, accepted by the orchestrator 2026-11-10): Vditor's H1 to H6 heading level markers stay out of Preview (stand-ins for the source syntax; Preview matches VS Code's native preview).
- D4 (provisional, worker, accepted by the orchestrator 2026-11-10): the Split View preview pane gets no fold gutters or change bars, as before (split scroll sync anchors on heading offsets).
## Proposed work

1. Inventory every VMDE decoration in IR/WYSIWYG (fold gutters for headings and lists, and any other reading or navigation aid) and mark which are missing in Preview.
2. Decide with the Owner which decorations Preview gets, and whether fold state is shared with the edit modes.
3. Add them to Preview with a failing test first and a focused real-VS-Code spec; Preview stays read-only and the saved Markdown is unchanged.

## Acceptance

- [x] Inventory recorded, with each decoration's Preview status.
- [x] Heading and bullet-list fold controls work in Preview.
- [x] The other agreed decorations are present in Preview.
- [x] Saved Markdown is unchanged; Preview stays read-only.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Findings

- Inventory of 44 VMDE decorations (reading/navigation aid, editing aid, rendering). Missing in Preview before this task: heading fold gutter, list fold gutter, Git change bars. Already present: code and front-matter copy buttons, code references, diagram zoom and controls, find highlights, callouts, wrap hints and the rendering decorations. Editing aids (block handle, selection bubble, link popover, table controls, gap paragraphs, callout and details authoring) stay out of Preview.
- Added: heading and list fold gutters and Git change bars in Preview, read-only, with the edit modes' look and the Task 722 alignment. Fold state is shared per document through the existing per-file fold store.
- The Preview fold pass runs in slices (150 top-level blocks per frame, 300 list items), so an 800 KB stream adds no long task (before the slicing: 161 ms; after: none over 62 ms). The first slice runs in the Preview mutation callback, so a reading-position save never anchors inside a section that is about to fold (that race dropped the stored fold state on reopen).

## Verification

- Unit: `media-src/src/nav` and `diff-markers`: 308 passed.
- Real VS Code: `preview-decorations.spec.ts` (new), `section-fold`, `list-fold-alignment`, `diff-gutter`, `preview-mode-stream`: 8 passed; stream long tasks none.
- `npm run quality`: exit 0.
- Not caused by this task (fail on the base too): `preview-memory.spec.ts:457` (VS Code restart, intermittent timeout), `preview-mode-timing.spec.ts:59` (load-dependent timing, Task 700).

## Owner approval

- 2026-11-10 (Owner, chat): "I approve to close 719–725 as they are now." Every provisional decision in this record is accepted as final.
