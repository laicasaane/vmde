# Task 675 — SV exact-authority relation after a mode switch and for Source text Vditor changed

**Status:** planned (2026-11-01). Filed at the close of Task 669; waits for a future batch.
**Origin:** Task 669 (steps A1b and A1c).
**Severity:** medium (estimated; the actions fail closed, so no bytes are lost).
**Tech stack:** `media-src/src/bridge/edit-sync.ts` (`projectRendered`, `provesExact`, `receiveExactAuthority`), `test/vscode-e2e/exact-authority-other-actions.spec.ts`, `test/vscode-e2e/helpers/shortcut-xtest-kit.ts`.
**Depends on:** Task 669.

## Problem

The exact SV actions (Format table, Fix list numbering, Renormalize all lists and the other exact Source-mode actions) acquire the host's exact text after typing. In Source mode the host-request relation is plain equality: `normalizeEol(exact) === rendered`. It fails in two measured cases, and then the acquisition returns nothing and the action declines with no write:

- After a switch from IR or WYSIWYG to Source mode, the Source text is Lute's serialization (a padded table, for example) while the host text stays raw. Once trusted typing has revoked the owned exact text, `receiveExactAuthority` sees `sameRendered: true`, `sameTrusted: true`, `provesExact: false`.
- On a document opened directly in Source mode, Vditor itself changes the text it shows: an ordered list `3. alpha` / `5. beta` is shown renumbered (`4. beta`) while the host keeps `5. beta`. The relation fails at that line.

Task 669 replaced the line mapping inside the SV commands with an alignment proof, but the commands are never reached in these cases. The cases `list-normalize-sv` and `table-format-sv` of the Task 630 exact-authority matrix therefore still cannot run in Source mode.

## Proposed work

Replace the equality in the Source-mode relation by a proof that accepts text Vditor or Lute changed and still refuses stale text. One candidate is the bounded alignment of Task 605 (`alignText`) between the host text and the Source text, requiring that every difference lies inside a region the commands later re-prove (normalized table padding, list numbers) and that the typed span is the only other difference. The relation must fail closed on any other difference.

Restore the Source-mode cases in `exact-authority-other-actions.spec.ts`:

- Add `'sv'` to the action loop and the scenarios `list-normalize-sv` (a misnumbered list; the command renumbers it) and `table-format-sv` (a raw CRLF table; the command formats it), on a CRLF document with a raw table and a list. Each case must apply, change only its span, restore with one Undo, and write the result on Save, like the visual-mode cases.
- Open the document in Source mode both by a mode switch and, through an opt-in switch in the shared kit (`openDocument(..., direct)` setting `vmde.editor.defaultMode` and restoring it afterwards), directly.
- Place the caret, dispatch `selectionchange` after the gesture end (the gesture end clears the retained Source selection, a real pointer gesture is followed by its own `selectionchange`), then run the command from the host.

## Tests to write

- Vitest in `edit-sync.test.ts`: a Lute-padded table, a renumbered list, a stale host text and an unrelated difference (accepted, accepted, refused, refused).
- Real VS Code: the two Source-mode cases above, in both open modes.
