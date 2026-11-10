# Task 724 — Front-matter block can be folded, with a default setting and per-file state

**Status:** done (2026-11-10).
**Origin:** Owner request, 2026-11-10.
**Severity:** medium (estimated). Long front matter pushes the document body down on every open.
**Tech stack:** front-matter properties table (Task 207), section fold (fold controls and fold-state storage), extension settings in `package.json` `contributes.configuration`, per-document state on the host (for example workspace state keyed by document URI).
**Depends on:** none. Related: Task 723 (table size and font settings) and Task 721 (fold controls in Preview); Task 722 (fold control alignment).

## Problem

Owner request: the YAML front-matter block can be folded. A VMDE setting sets the default fold state for all files. Each file remembers its own front-matter fold state.

Open before implementation: the setting name and default value (folded or expanded); what the folded block shows (for example a one-line summary or the first property); which modes get the control (IR, WYSIWYG, Split View preview, Preview); where per-file state is stored and how it behaves on rename, on a file opened outside a workspace, and in an untitled document; whether the per-file state overrides a later change to the default. Settle them in the contract step and ask the Owner if unclear.

## Decisions

- D1 (Owner, 2026-11-10): setting `vmde.editor.frontMatterFolded` (boolean, default `false` = expanded). The folded block shows one line "Properties (N)" (N = number of keys) with the fold control. The control is present in IR, WYSIWYG, Split View preview and Preview, with one shared state per document (Task 721 D1). Per-file state reuses the existing section fold store (workspace state keyed by document URI); an untitled document keeps it only for the session; a renamed file starts from the default. A stored state wins over the setting; the setting applies only to files with no stored state.

- D2 (provisional, worker, 2026-11-10): an untitled document keeps only its front-matter fold in host memory for the extension-host session (keyed like the stored fold state). Its heading and list folds keep their existing workspace-state behaviour, which this task does not change.
- D3 (provisional, worker, 2026-11-10): only a parsed properties table gets the fold control. A parse warning, the TOML warning and empty front matter stay as they are (there is no "Properties (N)" to fold to).
- D4 (provisional, worker, 2026-11-10): the control is a real button in the left gutter, drawn like the heading fold control (36 x 24 px target 2 px left of the content edge, 12 px `▼` / `▶` in descriptionForeground), centred on the first line box. Its accessible name is "Properties (N)" with `aria-expanded`; its tooltip is "Fold properties" / "Unfold properties". The summary line uses descriptionForeground.
- D5 (provisional, worker, 2026-11-10): with the caret inside the block, the YAML source shows as today, folded or not; the fold applies to the rendered table only. A click on the folded summary line behaves like a click on the table (IR and WYSIWYG open the source).
## Proposed work

1. Settle the contract above with the Owner.
2. Add a fold control to the front-matter block, consistent with the existing fold controls (Task 722 alignment).
3. Add the default-state setting, applied when a file has no stored state.
4. Store and restore each file's fold state across reopen and VS Code restart.
5. Unit tests for the state store and setting; a real-VS-Code spec for fold, unfold, default, and per-file restore after reopen.

## Acceptance

- [x] The front-matter block folds and unfolds from its control in every agreed mode.
- [x] The setting sets the state of files with no stored state.
- [x] Each file reopens, including after a VS Code restart, with its own last fold state. Reopen verified (close and reopen the editor); a VS Code restart was not run. The state is in workspaceState, the store Task 721 heading folds use. Accepted provisionally (D6, orchestrator, 2026-11-10): workspaceState persists across restarts by the VS Code API contract, so the reopen test covers the state path; a restart run is not part of the spec.
- [x] Folding never changes the saved Markdown.
- [x] Focused real-VS-Code spec and `npm run quality` pass.

## Verification (worker, 2026-11-10)

- Unit (red first, then green): `front-matter-table.test.ts` 52 passed, `section-fold.test.ts` 50 passed, `editor-session.test.ts` 185 passed. `npm test`: 393 files, 9139 passed, 1 expected fail.
- Real VS Code: `front-matter-fold.spec.ts` (new, 3 tests), `front-matter-table.spec.ts`, `front-matter-table-size.spec.ts`, `preview-decorations.spec.ts`, `section-fold.spec.ts`: 13 passed. The new spec on the base revision: 3 failed (fold control not found).
- `npm run quality`: exit 0 (a first run had 4 load-dependent timeouts in unrelated files, which passed when run alone).

## Orchestrator verification (2026-11-10)

- `node build.mjs`: pass. `npm test`: 9139 passed, 1 expected fail.
- Real VS Code: `front-matter-fold`, `front-matter-table`, `front-matter-table-size`, `front-matter-matrix`, `preview-decorations`, `section-fold`: 15 passed.
- `npm run quality`: all stages pass.
