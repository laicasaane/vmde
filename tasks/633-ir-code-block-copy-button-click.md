# Task 633 — Code block copy button click falls through to the code block

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner report (chat, 2026-10-14).
**Severity:** medium (estimated). A visible control does not work; no markdown is changed.
**Tech stack:** TypeScript webview (`media-src/src/clipboard/code-copy.ts`), Vditor IR code-block DOM, Vitest, Chromium, real VS Code.

## Problem

Clicking the copy button on a code block does not copy the code. The click falls through the copy button to the code block instead. The Owner requires the fix to be tested in IR (Instant Rendering) mode.

## Current code

`installCodeCopy` in `media-src/src/clipboard/code-copy.ts` listens for `click` on the document in the bubble phase. It finds `[data-vmde-copy-code="true"]`, reads the sibling `textarea`, and posts `copy-code` to the host.

## Suspected cause (unverified)

In IR, Vditor handles the earlier `mousedown`/`pointerdown` (or its own click handler) on the code block first: it expands the block into its editable source and moves the caret. The copy button is then moved, hidden or replaced before the document-level `click` reaches it, or Vditor stops the event. Part 1 must confirm the cause by measurement before a fix is chosen.

## Acceptance

- [ ] Cause measured in real VS Code IR mode and recorded (event order, which handler wins, DOM before and after the press).
- [ ] In IR, a click on a code block's copy button copies the exact code text to the clipboard (host `copy-code` received with the expected content) and does not expand the block, move the caret or change the selection.
- [ ] The document bytes, dirty state and Undo history are unchanged by the click.
- [ ] Keyboard activation of the button (if it is focusable) behaves the same.
- [ ] WYSIWYG and the SV preview keep working (regression check); a click elsewhere on the code block still enters editing as before.
- [ ] Focused real-VS-Code IR spec written and run; `npm run quality` passes.

## Tests

- Vitest: `code-copy.test.ts` for the new event handling (press on the button is consumed; press elsewhere passes through).
- Chromium harness: IR code block, press and click on the copy button; caret, selection and block state unchanged; copy message posted.
- Real VS Code (`test/vscode-e2e/`, related: `copy-clipboard.spec.ts`): IR first, then WYSIWYG and SV preview regression legs. Run `node build.mjs` first, then the spec under `xvfb-run`.
