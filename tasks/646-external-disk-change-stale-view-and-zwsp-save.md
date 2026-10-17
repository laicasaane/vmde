# Task 646 — External disk changes may not reach an open VMDE editor, and a saved file gained a zero-width space

**Status:** open.
**Origin:** Project Owner report, from an observed incident.
**Severity:** high (est.; possible silent loss of newer file content, and an internal character written to the user's file).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/writeback/writeback-controller.ts`, `src/writeback/sync-state.ts`, `src/app/extension.ts`), webview (`media-src/src/bridge/edit-sync.ts`, `bridge/message-router.ts`, `boot/vditor-init.ts`, `editing/caret-preserve.ts`), Vitest, Chromium, real VS Code.

## Incident

A task record in this repository was open in VMDE while the same file was changed on disk by another process and committed several times within a few minutes. Two unexpected changes reached the file on disk:

1. **Older text written over newer text.** After a commit that added new paragraphs and acceptance text, the file on disk again held the text from before that commit: the three changed passages were reverted, and nothing else changed.
2. **A zero-width space saved into the file.** A later on-disk change appended a blank line and a line holding only U+200B ZERO WIDTH SPACE (bytes `e2 80 8b`) at the end of the file. The same change also removed two spaces of indentation from one line inside a fenced `text` block; that edit may have been the user's own.

VMDE uses U+200B internally (for example as a caret placeholder), so it should never reach a saved file. A known source is the WYSIWYG inline-code caret pad in Vditor's code rendering, which [Task 191](191-mouse-ops-test-plan.md) found in copied inline code and normalized only on the copy path. It is not known whether the editor tab had unsaved edits when the disk changed, which mode it was in, or whether VS Code showed its "file is newer" prompt on save.

## Questions to answer

1. When a file open in VMDE with no unsaved edits changes on disk, does VMDE show the new text, in IR, WYSIWYG and Split, including while a write-back or an input flush is pending?
2. Can VMDE write its older content back after such a reload, through a delayed write-back, an Undo checkpoint, a flush on blur or save, or a reconnect after the webview was hidden?
3. When the document has unsaved edits and the disk changes, does VMDE behave as VS Code does for text editors (no silent reload; the save conflict prompt appears), and does it never write the disk version's content into its history in a way that loses either side?
4. Which path writes U+200B into the document text: a caret placeholder, an empty paragraph created by Enter at the document end, a gap line between blocks, or another site? Does it reach the host text, the saved file, or both?

## Requirements

1. **Reproduce first.** Write real-VS-Code cases for each question above before changing code. Record what passes and fails, with the mode and timing that trigger each failure.
2. **New disk content always reaches the view.** For a document with no unsaved edits, an external change is shown in the open VMDE editor in every mode, and no later VMDE write-back, flush or Undo checkpoint writes the previous content back.
3. **No silent loss with unsaved edits.** For a document with unsaved edits, VMDE follows VS Code's text-editor behaviour: it does not overwrite the disk version without the user's choice, and the user's edits are not lost.
4. **No internal characters in saved text.** U+200B and any other editor-internal placeholder never reach the host text or the saved file, except where the user typed them or they were already in the file.
5. **Fix where needed.** Fix each confirmed cause at its source, with a test that fails without the fix. Causes that do not reproduce are recorded with the cases that cleared them.

## Scope

- In: external-change handling for open VMDE editors, write-back and flush ordering around a reload, the save conflict path, and every site that can insert U+200B or another placeholder into document text.
- Out: VS Code's own conflict UI, Git integration, multi-window editing of one file.

## Acceptance

- [ ] Real-VS-Code cases exist for questions 1–4, in IR, WYSIWYG and Split, with results recorded.
- [ ] An external change to a clean document is shown in VMDE and survives the next key, save, Undo and Redo: the saved file holds the new disk text plus the typed key only.
- [ ] With unsaved edits, an external change never silently overwrites the disk or loses the edits.
- [ ] No case writes U+200B (or another internal placeholder) into the host text or the saved file unless it was typed or already present.
- [ ] Every confirmed cause has a fix and a failing-first test; non-reproducing hypotheses are recorded.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Real VS Code (`test/vscode-e2e/`): open a clean document in each mode, change it on disk from outside, check the view, then type one key, save, and compare the file bytes; repeat with a pending write-back and after hiding and showing the tab; repeat with unsaved edits and check the save conflict path. Check for U+200B in host text and on disk after Enter at the document end, gap lines, empty paragraphs and caret moves. Reuse helpers from `doc-sync.spec.ts`, `save-fidelity.spec.ts` and `writeback-own-race.spec.ts`.
- Vitest: write-back and sync-state ordering around an external change; placeholder stripping at every serialization exit.
- Chromium: placeholder sites in the webview (serialization never emits U+200B that was not in the source).
