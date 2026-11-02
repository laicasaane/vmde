# Task 698 — Typed-key and chord results differ from the expected bytes or actions in XTEST specs at `f84a4258`

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate rerun at `f84a4258` (Task 695): the suite failed these cases in chunks and again when each spec file ran alone (`--workers=1 --retries=0`, XTEST, fresh X server per file).
**Severity:** high (estimated; Expand Selection, shortcut identity and typed edits are deterministic user-visible actions).
**Tech stack:** `test/vscode-e2e/{expand-selection-first-keys,shortcut-identity,sv-line-start-edit,github-inline-math,paste-plain-chord,auto-wrap,cut-backspace-stability,wiki-inline-code-edit}.spec.ts`; `test/vscode-e2e/helpers/xtest-input.ts`; keybinding and edit paths in `media-src/src/`.
**Depends on:** none.

## Problem

These cases fail in the full suite and again alone at `f84a4258`:

- `expand-selection-first-keys.spec.ts:189`, `:241`, `:317`: "press 1 delivers one Expand Selection action" fails (paragraph ladder).
- `shortcut-identity.spec.ts:874` (large fixture, IR and SV), `:897`, `:1244`: "failed legs" lists many failing keys.
- `sv-line-start-edit.spec.ts:472`: whole-document type-over fails; the host length is 2 where 40 is expected after Undo.
- `github-inline-math.spec.ts:351`: typed source differs in SV.
- `paste-plain-chord.spec.ts:19`: the poll for the pasted text stays false for 30 s.
- `auto-wrap.spec.ts:31`: the interaction-state poll stays false for 30 s.
- `cut-backspace-stability.spec.ts:302`: caret token `list-backspace-ABCDE` does not settle.
- `wiki-inline-code-edit.spec.ts:33`: typed `sidebar.!` is missing from the README line.

XTEST keymap check (the Task 693 cause): the typed text in these specs is ASCII only (non-ASCII characters occur only in comments), so the once-per-X-session delivery limit for non-keymap characters does not explain these failures. Whether the cases share one cause is not measured.

No earlier full-suite baseline exists, so the commit that introduced each failure is unknown, and whether the cases in this group share one cause is not measured.

## Proposed work

1. Find the last good commit for each failing case: run the spec alone on earlier `dev` revisions.
2. Group the cases by first bad commit and measure the cause of each group.
3. Fix each cause with a failing test first, or fix the test where the test, not the product, is wrong (state which).

## Acceptance

- [ ] Each failing case has a first bad commit (or is shown to be a test defect) and a measured cause.
- [ ] Each product cause is fixed with a test that fails before and passes after.
- [ ] The listed cases pass in one real-VS-Code run, alone and in the full suite.

## Tests to write

- A test per product cause; the listed real-VS-Code cases are the acceptance tests.
