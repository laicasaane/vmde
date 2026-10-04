# Task 614 — SV collapsed cut deletes the whole document

**Status:** ✅ DONE (2026-10-04) on `dev`, based on HEAD `9253dd61`.
**Origin:** measured during Task 580 CP2-11. The behavior is identical on `929c6f6d` and `e4e94570`.
**Severity:** high. A collapsed Ctrl+X in split mode replaced the whole document with `"\n"`.
**Tech stack:** the collapsed-caret line expansion (`media-src/src/clipboard/clipboard-line.ts`), the Vditor SV cut patch (`media-src/esbuild-shared.mjs`, `patchCutDeleteSync`), Vitest (jsdom), Chromium, real VS Code 1.129.0.

## Problem

In split mode (SV), put a collapsed caret 2 characters into the middle line `Anchor line BRAVO with a second sentence.` of this 97-character source:

```markdown
# Title

First paragraph ALPHA.

Anchor line BRAVO with a second sentence.

Last paragraph ZULU.
```

A native Ctrl+X leaves the source as `"\n"`, and the clipboard holds the whole 97-character document. A Ctrl+C copies the whole document.

## Root cause

`expandToLine` treats the nearest `div[data-block]` as the line. Vditor's SV `setValue` renders the whole document as flat spans inside one `div[data-block='0']`. The re-spin (`processSpinVditorSVDOM`) splits blocks only after blank lines. So in SV the "line" was the document, or several paragraphs. Since `e4e94570` the expansion runs on the document-capture `beforecopy`/`beforecut` listeners, and the cut deletes the expanded range, so the whole document was removed.

The existing Chromium (`media-src/e2e/copy-cut.spec.ts`) and real-VS-Code (`test/vscode-e2e/clipboard-collapsed.spec.ts`) collapsed-copy tests skipped their line assertions for SV (`svOneBlock`), which hid this.

A second defect appeared once the line was right. Chromium's delete of a range that starts at an SV line start also deletes the hidden `\n` of the previous newline span. The `<br>` stays, but the SV source is the editor's text, so the previous line is joined to the next one. Measured in the Chromium harness on `Alpha line\nBravo line\nCharlie line\n`: every boundary shape of the line `Bravo line\n` gave `Alpha lineCharlie line`, with the Delete key and with `execCommand("delete")`. The same happened in real VS Code (`Alpha lineCharlie line\n`). A range that starts at the end of the previous line's content, before its newline span, deleted exactly its text.

## Fix

- In SV the line is the **source line**, including the newline that ends it. This is what VS Code's own collapsed copy and cut take (`emptySelectionClipboard`). SV shows the source, so a multi-line paragraph is several lines there. IR and WYSIWYG keep the containing block as the line (Task 385).
- SV DOM (Lute `SpinVditorSVDOM`, checked by running `lute.min.js` in Node): every source line ends with `<span data-type="newline"><br><span style="display: none">\n</span></span>`, and markers (`heading-marker`, `li-marker`, `blockquote-marker`, code fence markers) are sibling spans on the same line.
- `svLine` (used when the editor element has class `vditor-sv`) scans the newline spans in document order and returns two ranges over the same text:
  - `copy`: from the node after the last newline span that ends at or before the caret (or the editor start) to just after the first newline span past the caret (or the editor end). The selection is set to it, so Vditor's SV copy puts the line and its newline on the clipboard. The start is placed before the line's first node, after stepping into a `div[data-block]` wrapper, so the range never crosses a block boundary (which `Selection.toString()` would copy as an extra newline).
  - `remove`: the previous newline span and the line's content (before its own newline span). For the first line it is `copy`. It removes the same characters as `copy`, and Chromium deletes it exactly.
  - A caret inside a newline span (an empty line) copies that newline and removes the previous one. It refuses (returns `false`, so a cut stays inert) when the line would be empty, for example on the empty line after the final newline.
- `beforecut` records a collapsed cut's SV line (`__vmdeSvLineCut`, read once, 2 s TTL like the cut intent). The SV branch of `patchCutDeleteSync` calls `__vmdeSelectSvLineDelete()` after Vditor's copy and before its `execCommand("delete")`. It selects `remove` only while the selection is still exactly the copied line. A real-selection cut and every non-SV mode are unchanged.
- Cut intent is unchanged: `beforecut` records `collapsed: false` when the expansion took a line.

## Acceptance

- [x] SV, collapsed caret in the middle, first and last line of the 97-character source, and in the middle of three adjacent lines: Ctrl+X gives the exact source without that line, the clipboard is the line plus `\n`, and one Undo restores the exact source (real VS Code).
  - Where the cut line is next to a blank line, the source after the cut is VS Code's result after Vditor's SV re-spin: the cut's `input` makes Vditor re-spin the text through Lute, which merges consecutive blank lines and drops a leading one, as after any SV edit (`SpinVditorSVDOM("…ALPHA.\n\n\nLast…")` gives `…ALPHA.\n\nLast…`, checked in Node). The adjacent-lines case has no blank line to merge, and its result is VS Code's character for character (`Alpha line\nCharlie line\n`).
- [x] SV, the same lines: Ctrl+C puts the line plus `\n` on the clipboard and leaves the source unchanged (real VS Code).
- [x] SV in `torture.md`: a collapsed copy/cut in the paragraph's second source line takes only that line, and the paragraph's first line survives (real VS Code). The Chromium SV leg takes only `LINE alpha to cut.\n`, and a new Chromium test cuts exactly the middle of three adjacent lines.
- [x] Unit: the source line, its markers and its newline in SV, for one block and for re-spun blocks; an empty line; a caret just after a newline span; refusal on the trailing empty line; the undo-snapshot split range; a real selection untouched; `beforecut` records a real range; the `remove` range for the middle, first, last and empty line and across re-spun blocks; the delete hook is read once, refuses a moved selection, and is never armed by a copy.
- [x] IR and WYSIWYG collapsed copy/cut unchanged: their unit tests, Chromium legs and real-VS-Code tests pass.

## RED-before / GREEN-after evidence

| Layer | RED (HEAD `clipboard-line.ts`, swapped in alone) | GREEN (fix) |
| --- | --- | --- |
| Vitest `clipboard-line.test.ts` | 12 of the first 13 SV tests failed: every expansion selected the whole document text, and the trailing-empty-line case returned `true`. | 46/46 passed |
| Chromium `copy-cut.spec.ts` | SV leg: the copy held both paragraphs (`Keep this line.\n\nLINE alpha to cut.\n`). Adjacent-lines test: the source after the cut was `\n`. | 16/16 passed with `copy-cut-probes.spec.ts`, `--retries=0` |
| Real VS Code `clipboard-collapsed.spec.ts`, SV tests | 5/5 failed. The `torture.md` leg copied the whole document; the middle/first/last/adjacent tests failed on `line copy` (the clipboard held the whole document). | 11/11 passed (whole file), `--retries=0` |
| Real VS Code, first fix (line range only, no `remove` range) | The adjacent-lines cut gave `Alpha lineCharlie line\n`, which led to the `remove` range. | — |

With HEAD's `clipboard-line.ts`, the patched SV cut handler's `__vmdeSelectSvLineDelete?.()` is undefined and does nothing, so the swap reproduces HEAD behavior. The file was restored (`cmp` identical) and rebuilt before the GREEN runs.

## Follow-ups (not fixed; outside this root cause)

1. **SV delete of a selection that starts at a line start joins the previous line.** It is the same Chromium behavior as above, on paths this task does not change. Measured in real VS Code: selecting `Bravo` (by `Selection.modify`) at the start of `Bravo line` and pressing Ctrl+X gave `Alpha line line\nCharlie line\n`. In the Chromium harness, Delete or `execCommand("delete")` on `Bravo line` (content only) gave `Alpha line\nCharlie line` (the empty line's newline was also removed). Delete, Backspace, type-over and real-selection cuts probably all share this.
2. **An SV Undo within `undoDelay` of an edit does nothing.** Vditor records the SV edit on its undo stack only when the `undoDelay` timer fires, and `undo` needs two entries. Measured in real VS Code: after the line cut had reached the host the SV stack was 1 entry deep, and an immediate Ctrl+Z left the source unchanged. After the snapshot (2 entries) one Ctrl+Z restored the exact source. The real-selection cut above behaved the same. The new real-VS-Code tests wait for the cut's own snapshot (polling the stack depth) and then assert that one Undo restores the source.

## Verification

| Command | Result |
| --- | --- |
| `node build.mjs` | exit 0 (final build is the fixed sources) |
| `npm run typecheck` | exit 0 |
| `npx vitest run --config test/vitest.config.mts media-src/src/clipboard/clipboard-line.test.ts test/backend/vditor-source-patches.test.ts` | 281 passed |
| `npm test` | 327 files; 5625 passed, 53 expected fail, 1 failed: `markmap-security.test.ts` "keeps long mailto linkification bounded" (a timing bound, 4.18 vs 3.5); it passed alone (4/4) |
| `npx biome check` on the 7 changed source/test files | clean |
| `npx tsc -p test/vscode-e2e/tsconfig.json` | 1 error, pre-existing, in untouched `preview-task-checkbox.spec.ts:122` |
| `xvfb-run -a npx playwright test e2e/copy-cut.spec.ts e2e/copy-cut-probes.spec.ts --retries=0` (media-src) | 16 passed |
| Real VS Code `clipboard-collapsed.spec.ts --retries=0` | 11 passed |
| Real VS Code `cut-selection`, `cut-selection-sv`, `copy-clipboard` `--retries=0` | 3, 1, 2 passed |
| `npm run quality` | lint:ci, jscpd, depcruise, test:coverage, check:coverage-modules PASS. check:brand-identifiers, knip and audit FAIL on files this task does not touch (`vmarkd` strings in `scripts/patch-vscode-test-playwright.mjs`, its test and the Task 580 record; 9 unused exports in table-resize, emoji-recents, inline-picture, svg-data-image-adapter and outline-tree; npm audit advisories for brace-expansion/braces). `clipboard-line.ts` coverage: lines 97.4%, branches 90.7%. |

One earlier full run of `clipboard-collapsed.spec.ts` failed once on the IR "a real selection still cuts normally" test (the cut did not settle in 20 s). It passed alone and in both later full runs, and Task 614 does not change that path (an IR real selection).

## Execution progress

- [x] Task record.
- [x] SV DOM study and line design.
- [x] RED unit tests, then the fix in `clipboard-line.ts`.
- [x] Phase B: build, RED on HEAD `clipboard-line.ts`, GREEN Chromium and real VS Code.
- [x] Measured the Chromium SV delete defect; added the `remove` range, the cut-handler hook and their tests; added the adjacent-lines cases (Chromium and real VS Code).
- [x] Follow-ups recorded.
- [x] Orchestrator: review, `tasks/README.md` index, record move, commit.
