# Task 724 — Front-matter block can be folded, with a default setting and per-file state

**Status:** planned (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** medium (estimated). Long front matter pushes the document body down on every open.
**Tech stack:** front-matter properties table (Task 207), section fold (fold controls and fold-state storage), extension settings in `package.json` `contributes.configuration`, per-document state on the host (for example workspace state keyed by document URI).
**Depends on:** none. Related: Task 723 (table size and font settings) and Task 721 (fold controls in Preview); Task 722 (fold control alignment).

## Problem

Owner request: the YAML front-matter block can be folded. A VMDE setting sets the default fold state for all files. Each file remembers its own front-matter fold state.

Open before implementation: the setting name and default value (folded or expanded); what the folded block shows (for example a one-line summary or the first property); which modes get the control (IR, WYSIWYG, Split View preview, Preview); where per-file state is stored and how it behaves on rename, on a file opened outside a workspace, and in an untitled document; whether the per-file state overrides a later change to the default. Settle them in the contract step and ask the Owner if unclear.

## Proposed work

1. Settle the contract above with the Owner.
2. Add a fold control to the front-matter block, consistent with the existing fold controls (Task 722 alignment).
3. Add the default-state setting, applied when a file has no stored state.
4. Store and restore each file's fold state across reopen and VS Code restart.
5. Unit tests for the state store and setting; a real-VS-Code spec for fold, unfold, default, and per-file restore after reopen.

## Acceptance

- [ ] The front-matter block folds and unfolds from its control in every agreed mode.
- [ ] The setting sets the state of files with no stored state.
- [ ] Each file reopens, including after a VS Code restart, with its own last fold state.
- [ ] Folding never changes the saved Markdown.
- [ ] Focused real-VS-Code spec and `npm run quality` pass.
