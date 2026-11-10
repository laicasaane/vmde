# Task 725 — Edit front matter in the properties table

**Status:** done (2026-11-10).
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
- D2 (Owner, 2026-11-10): editing in IR and WYSIWYG only; Split View preview and Preview stay read-only. Click a key or value cell to edit it in place; Enter or Tab commits, Esc cancels; list, map and multi-line cells open a small YAML text box in that cell only. "+ Add property" button under the table appends `: ""` and opens the new placeholder row; repeated presses add several rows. A remove (×) button on row hover; reorder by a drag handle and by Alt+Up/Alt+Down on the focused row. One Undo step per committed cell edit and per structural action (add, remove, reorder); keystrokes inside a cell are not separate Undo steps. A rename to a key that another row already has is written as typed (requirement 1, D1 "kept as typed"); both rows then show a duplicate-key warning, the same way placeholder rows are shown, and the rest of the table stays editable.

## Open questions (settled by D2)

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

- [x] Every edit changes only the edited key or value text; all other front-matter bytes are identical (unit and real-VS-Code byte checks).
- [x] List, nested-map and multi-line cells edit as YAML source inside that cell only.
- [x] Add inserts `: ""` as the last front-matter line; several can be added and filled later.
- [x] Remove, rename and reorder work, each as one Undo step.
- [x] Empty-key `: ""` lines show as editable placeholder rows (D1); other malformed YAML and TOML stay read-only with the warning.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Step 1 provisional decisions (edit core, worker, PROVISIONAL)

- D3: `frontMatterYaml()` returns the text without the line break that ends its last line, so the edit core keeps that shape. `appendFrontMatterPlaceholder` returns `yaml + eol + ': ""'` (no trailing eol); only a text that already ended with an eol gets `': ""' + eol`; empty text gives `': ""'`. This differs from the brief's literal "`: ""` + eol" because the caller re-adds the break before the closing fence.
- D4: move swaps only the two entries' line ranges; comment and blank lines between them (and a comment above an entry) stay in place.
- D5: removing the last entry (no final line break) also removes the line break before it, so the text keeps its no-trailing-break shape. Removing any other entry deletes only its own lines.
- D6: block `valueStart` skips spaces and tabs after the `:` (it can sit on the line break when the value starts on a later line, so `valueText` then begins with the line break, e.g. `"\n  - a\n  - b"`); `valueEnd` is the end of the last value token, so a trailing comment on the last line stays outside the range. Block edits write the text verbatim except that line breaks are converted to the document's eol.
- D7: a value with an anchor, tag or alias, or a value on a later line, is `block`/verbatim (range includes the props). An anchored or tagged key, an explicit `?` key, a flow/complex key, several documents and any parse error other than duplicate keys make the map `unsupported`.
- D8: a placeholder is any entry whose decoded key is `''` (also `"": v`); renaming to empty text writes `"": …`. Scalar edits keep the original value style, so `: ""` filled with `x` becomes `: "x"`, and `:` (empty) becomes `: x`.
- D9: `FrontMatterEntryKind` is not exported (knip: no consumer yet); the UI step may export it when it imports it.

## Step 2 provisional decisions (UI, worker, PROVISIONAL)

- D10: `media-src/src/boot/main.ts` installs the editor (`installFrontMatterEdit`) next to `configureTableActions` with the same transaction deps (owned exact bytes, authority, `setApplying`, `postExact`). This file is outside the brief's file list; the transaction cannot be wired without it. It is installed at boot so its window capture listeners run before the editor's own ones (`installUndoBoundaries` and the rest install later).
- D11: Module names: the UI controller is `media-src/src/editing/front-matter-editor.ts` (manifest IDs are global basenames and `front-matter-edit` is the core); the `yaml` side of the UI (`parseFrontMatterTable`, `editFrontMatterDocument`) is `media-src/src/editing/front-matter-edit-model.ts`, imported only by the lazy entry and tests. The lazy global now has `parse` (a table result with `edit` rows), `edit` and `yaml`; the controller reads `edit`/`yaml` from it once the parser bundle has loaded, so `boot/finish-init.ts` is unchanged.
- D12: Event isolation: every event whose target is a cell editor (keys, input, composition, clipboard, mouse, focus) is stopped at the window in the capture phase; defaults are kept, so the browser edits the control's text. Consequence: VS Code keybindings (save, command palette, Undo) do not run while a cell editor has focus; Ctrl+Z in a cell editor does nothing (the field history is not recorded and the router returns for a focused text field). Keyup and mouseup on focused cells and row buttons are stopped too (Vditor's WYSIWYG keyup rule opened its table popover for this table); keydown chords on a focused cell pass, so Ctrl+Z there is a document Undo.
- D13: Focus leaving the table commits the open editor. A click on another cell, Add, remove or reorder first commits the open editor (its own Undo step), then acts.
- D14: YAML box: Enter commits (D2), Shift+Enter inserts a line break. The box shows the exact value source, including the leading line break of a value that starts on the next line (the D6 form; step-1 question 1 settled for the UI with this form).
- D15: Focus after an action: Enter keeps focus on the same cell (focused cell: Enter or F2 opens it, arrows move between cells, Alt+Up/Alt+Down reorder, Esc returns the caret to where it was before the table took focus); Tab opens the next cell (name, value, next name; past the last cell, the Add button); Add opens the new row's name; mouse remove and drag restore the document caret; keyboard remove focuses the row that takes the removed one's place.
- D16: Placeholder and duplicate-key rows (with their markers) also show in the Split View preview and Preview, read-only; those panes no longer show the malformed-YAML warning for these two cases either.
- D17: Layout: the drag handle and the remove button sit in the right gutter of each row (shown on row hover and focus); "+ Add property" sits under the table; both hide with the table while folded. The Task 723 cell geometry is unchanged (the controls are absolutely positioned or below the table).
- D18: Core fix (found by the UI unit test): a plain value that is not a string (number, boolean, null, empty) stays plain when the new text is one plain scalar, so `count: 3` edited to `4` gives `count: 4`, not `count: "4"`. A plain string value keeps the old rule (`name: Ann` edited to `4` gives `name: "4"`).
- D19: Core API: `FrontMatterEntryKind` is exported and `FrontMatterEntry` has `verbatim` (the value edits as YAML source), which the UI needs for a placeholder whose value is not one scalar.
- D20: A click on a cell now opens its cell editor instead of the YAML source; the caret still enters the source by keyboard (ArrowUp from the next block), and caret-inside behaviour is unchanged. `front-matter-table.spec.ts` follows that, and its malformed fixture (duplicate keys, now editable rows by D2) is `a: 1` + `  b: 2` (still malformed).
- D21: While focus is in the table, IR keeps the table shown and the source and its `---` markers hidden although the node is marked `--expand` (the editor selection sits on the focused cell inside the node), and WYSIWYG does not show Vditor's popover (main.css, measured in real VS Code).

## Step 2 open questions

- Q1: After Undo or Redo of a table edit, the caret goes to the change site (Task 720 rule), which is in the front matter, so IR and WYSIWYG show the YAML source until the caret leaves. Options: (a) keep (consistent with other Undo); (b) a front-matter change site places the caret after the block and the table stays.
- Q2: An empty front matter (`---` + `---`) shows no table and so no Add button (Task 207 empty state); removing the last property leaves that state. Options: (a) keep (type in the source); (b) show an empty editable table with only "+ Add property" in IR/WYSIWYG.
- Q3: D12 blocks VS Code keybindings while a cell editor has focus (Ctrl+S saves nothing until the cell is committed). Options: (a) keep; (b) commit the cell and pass Ctrl/Cmd+S through.
- D22: In WYSIWYG, ArrowUp with the caret at the start of the block after the front matter enters the YAML source (at the end of its text), as IR does natively. Without it WYSIWYG had no way into the source once a click opens a cell editor (front-matter-table.spec.ts failed). Alternative for the Owner: an explicit "Edit as YAML" control.

## Open questions settled by the orchestrator (PROVISIONAL)

- D23 (Q1): keep (a). After Undo or Redo of a table edit the caret goes to the change site, as for every other Undo (Task 720 rule).
- D24 (Q2): keep (a). An empty front matter shows no table and no Add button (Task 207 empty state); type in the source.
- D25 (Q3): keep (a). VS Code keybindings do not run while a cell editor has focus; commit the cell first (Enter, Tab or a click outside).
- D26 (Q4): accept D22. WYSIWYG enters the YAML source by ArrowUp from the next block, like IR; no separate "Edit as YAML" control.

## Verification (orchestrator, 2026-11-10)

- `node build.mjs`: exit 0.
- `npm test`: 9420 passed, 1 expected fail.
- Real VS Code, through the wrapper: `front-matter-edit.spec.ts`, `front-matter-table.spec.ts`, `front-matter-table-size.spec.ts`, `front-matter-fold.spec.ts`, `front-matter-matrix.spec.ts` and `undo-redo-steps.spec.ts`: 18 passed.
- `npm run quality`: exit 0; every stage passes.
- `npm run check:bundle-size` exceeds the budget on this change and also on `dev` before it, so the overrun was already there. The change adds about 20 KB to `main.js`; `yaml` and the edit model stay lazy. `check:bundle-size` is not part of `npm run quality`.
- Residual: unit line coverage of `front-matter-editor.ts` is 74 %; the rollback branch has no test. Ctrl+Z inside an open cell editor does nothing (D12). The comment above an entry does not move with the entry on reorder (D4).
