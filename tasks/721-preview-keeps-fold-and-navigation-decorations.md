# Task 721 — Preview keeps fold controls and other reading and navigation decorations

**Status:** planned (2026-11-09).
**Origin:** Owner request, 2026-11-09.
**Severity:** medium (estimated). Preview, the mode meant for reading, lacks the controls that help reading and navigation in the edit modes.
**Tech stack:** section fold (heading and list fold gutters), other non-Markdown decorations added by VMDE in IR/WYSIWYG, the Preview render route (`preview-render.ts`, Vditor Preview patch chain in `esbuild-shared.mjs`).
**Depends on:** none.

## Problem

Owner request: heading fold controls, bullet-list fold controls, and the other non-Markdown decorations must also be present in Preview mode. They exist to help reading and navigation inside the document, so leaving them out of Preview makes no sense.

Not yet known: the full list of VMDE decorations shown in IR/WYSIWYG and which of them Preview already has; which ones change editing state and so need a read-only form in Preview; whether fold state is shared between modes.

## Decisions

- D1 (Owner, 2026-11-10): Preview gets every decoration that the inventory classes as a reading or navigation aid, in a read-only form. Fold state is shared per document between Preview and the edit modes.

## Proposed work

1. Inventory every VMDE decoration in IR/WYSIWYG (fold gutters for headings and lists, and any other reading or navigation aid) and mark which are missing in Preview.
2. Decide with the Owner which decorations Preview gets, and whether fold state is shared with the edit modes.
3. Add them to Preview with a failing test first and a focused real-VS-Code spec; Preview stays read-only and the saved Markdown is unchanged.

## Acceptance

- [ ] Inventory recorded, with each decoration's Preview status.
- [ ] Heading and bullet-list fold controls work in Preview.
- [ ] The other agreed decorations are present in Preview.
- [ ] Saved Markdown is unchanged; Preview stays read-only.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
