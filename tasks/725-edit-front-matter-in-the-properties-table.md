# Task 725 — Edit front matter in the properties table

**Status:** planned (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** medium (estimated). Feature: edit YAML front matter like a normal table instead of only through its YAML source.
**Tech stack:** front-matter properties table (Task 207, `media-src/src/editing/front-matter-table.ts`, `front-matter-entry.ts`, `src/shared/front-matter.ts`, the `yaml` library), the exact-edit and Undo path for document edits, Lute IR/WYSIWYG DOM for the front-matter block.
**Depends on:** none. Related: Task 723 (table size and fonts), Task 724 (front-matter fold) — same table; keep their layout.

## Owner requirements

1. Unedited lines keep their bytes. An edit changes only the text of the edited key or value (plus required quoting); every other line, comment, spacing and quote style in the front matter is unchanged.
2. Lists, nested maps and multi-line text fall back to YAML source inside that cell: only the cell being edited shows its YAML source while the user edits it; the rest of the table stays a table.
3. Properties can be added, removed, renamed and reordered.
4. Add inserts a new line `: ""` as the last line of the front-matter block (before the closing `---`).
5. If possible, the user can add several `: ""` rows in a row and fill them in later in one go.

## Decisions

- D1 (Owner, 2026-11-10): placeholder rows approved. Several `: ""` lines are empty keys, which YAML treats as an error (the `yaml` library reports "Map keys must be unique"; one empty key may parse as a null key). The table shows each such line as an editable placeholder row instead of switching the whole block to the malformed-YAML warning, and the text is kept as typed on save and mode switch (requirement 1). Rendering details of a placeholder row are settled in the contract step.

## Open questions (settle in the contract step; ask the Owner)

- Controls for add, remove, rename and reorder (buttons, context menu, drag handle, keyboard), and which modes allow editing (IR, WYSIWYG; Preview stays read-only).
- Undo granularity: one Undo step per cell commit or per structural action.
- Key rename collisions with an existing key.

## Proposed work

1. Contract step: the questions above, with the Owner.
2. Byte-preserving edit core: map each table cell to its exact source range in the front matter and replace only that range; unit tests prove unedited bytes stay identical (comments, quotes, blank lines, CRLF).
3. Cell editing for scalar values and keys; YAML-source editing inside the cell for lists, nested maps and block scalars.
4. Add (appends `: ""`), remove, rename and reorder as single exact edits with one Undo step each; repeated add for several placeholder rows.
5. Real-VS-Code spec: edit, add several rows then fill them, remove, rename, reorder, a list cell edited as YAML, Undo/Redo, save; compare saved bytes with the expected text.

## Acceptance

- [ ] Every edit changes only the edited key or value text; all other front-matter bytes are identical (unit and real-VS-Code byte checks).
- [ ] List, nested-map and multi-line cells edit as YAML source inside that cell only.
- [ ] Add inserts `: ""` as the last front-matter line; several can be added and filled later.
- [ ] Remove, rename and reorder work, each as one Undo step.
- [ ] Empty-key `: ""` lines show as editable placeholder rows (D1); other malformed YAML and TOML stay read-only with the warning.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
