# Task 644 — Insert ID: write and resolve HTML `id` link targets

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (medium risk; changes inserted source, link-target resolution and renames internal modules).
**Tech stack:** shared parser (`src/shared/named-anchor.ts`), host link actions (`src/session/asset-link-actions.ts`), webview (`media-src/src/editing/named-anchor-insertion.ts`, `links/same-doc-anchor.ts`, `boot/main.ts`, `boot/finish-init.ts`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 556](556-html-named-anchor-navigation.md) (HTML named-anchor navigation and insertion).
**Related:** [Task 642](642-toolbar-layout-follow-ups.md) (renames the More item to **Insert ID** and gives it the `#` icon). Also [Task 243](../243-anchor-links-heading-ids.md) (planned: heading `{#custom-id}` ids and fragment links; its custom heading ids share the name space of requirement 7) and [Task 263](../263-block-references.md) (planned: Obsidian block ids).

## Problem

The More item inserts a legacy HTML named anchor:

```markdown
<a name="setup-steps"></a>Install the package and run the build.
```

In HTML, a `#setup-steps` link jumps first to the element whose `id` is `setup-steps`; `<a name="…">` is only a legacy fallback, and the `name` attribute on `<a>` is obsolete in HTML5. VMDE reads only the `name` form (`namedAnchorInTag` in `src/shared/named-anchor.ts`), so a target written with `id` is not found by VMDE's link navigation, although browsers and GitHub jump to it.

## Requirements

1. **Insert ID writes an `id` target.** The command inserts `<a id="NAME"></a>` at the caret instead of `<a name="NAME"></a>`:

   ```markdown
   <a id="setup-steps"></a>Install the package and run the build.

   See [the setup steps](#setup-steps).
   See [the setup steps](guide.md#setup-steps).
   ```

2. **`id` targets resolve.** Same-document and cross-file `#id` links navigate to `<a id="…">` targets in IR, WYSIWYG, Split and Preview, as `<a name="…">` targets do today.
3. **Existing `name` targets keep working.** `<a name="…">` stays a valid target, so documents written before this task keep their links.
4. **One name space.** The duplicate check treats `id` and `name` targets as one set: Insert ID refuses a value already used by either form. When both forms carry the same value, an `id` wins, as in HTML.
5. **Dialog unchanged otherwise.** The value rules (a letter first, then letters, digits, `.`, `-`, `:` or `_`), the read-only inspection of an existing target at the caret, the single Undo step and the exact-source write stay as they are, now covering both forms.
6. **`id` on any HTML element counts.** As in HTML, any element whose source carries an `id` attribute is a target, not only `<a>`: for example `<span id="limits">…</span>`, `<div id="faq">` or `<h2 id="intro">`. Tags inside code spans and fences are not targets. Insert ID still writes `<a id="…"></a>`.
7. **Same name as a heading's automatic anchor.** Headings and explicit `id` targets share one name space, as HTML ids do: a link goes to the first target with that name in document order. Insert ID refuses a value that a heading anchor already uses, with the message "A heading already uses this ID.", so the command never creates an ambiguous target. Existing documents with a collision keep working by the document-order rule.
8. **Internal names follow the rename.** Code identifiers, files, events and text keys change from "named anchor" to "ID" wording (for example `src/shared/named-anchor.ts`, `editing/named-anchor-insertion.ts`, the `vmde-insert-named-anchor` event and the `insertAnchor` text key), with `scripts/module-manifest.mjs` updated to match. Behaviour does not change because of the rename.

## Scope

- In: the inserted source, target parsing and resolution for `id` (any element) and `name`, the shared name space with heading anchors, the duplicate check, the inspection dialog for both forms, and renaming internal identifiers.
- Out: the menu label, tooltip, icon and placement (Task 642); renaming or rewriting existing anchors in documents.

## Acceptance

- [x] Insert ID inserts `<a id="NAME"></a>` at the caret with one Undo step and exact bytes elsewhere, in IR, WYSIWYG and Split.
- [x] `#NAME` and `file.md#NAME` links navigate to `<a id="NAME">` targets in IR, WYSIWYG, Split and Preview. (Same-document links proven in all four modes; cross-file links proven into an IR target panel; cross-file into a Split/Preview target panel is the recorded pre-existing gap, decision D2.)
- [x] `<a name="NAME">` targets still navigate as before.
- [x] A value already used by an `id` or a `name` target is refused with the existing duplicate message.
- [x] The caret inside an existing `id` or `name` target opens the read-only inspection.
- [x] `id` targets on elements other than `<a>` navigate; tags in code spans and fences do not.
- [x] When a heading anchor and an `id` share a name, links reach the first in document order; Insert ID refuses a value a heading anchor uses.
- [x] No identifier, file, event or text key in the source still uses "named anchor" wording for this feature; the module manifest and boundary test pass.
- [x] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: target parsing of `id` on any element and `name` on `<a>` (code spans and fences ignored, case-sensitive values, `id` preferred over `name`, document order against heading anchors), insertion planning, duplicate check across both forms.
- Chromium: insertion in IR, WYSIWYG and SV; inspection of both forms; same-document navigation.
- Real VS Code (`test/vscode-e2e/`): extend the Task 556 named-anchor specs with `id` insertion, same-document and cross-file `id` navigation, and a `name` regression case.

## Part 1 handoff (2026-11-01)

### Problem and cause

- The Insert ID command writes `<a name="NAME"></a>` (`planNamedAnchorInsertion` in `media-src/src/editing/named-anchor-insertion.ts`).
- The shared scanner (`namedAnchorInTag` in `src/shared/named-anchor.ts`) accepts only `<a>` tags with a quoted `name` attribute, so `id` targets on any element are never found by the host resolver (`fragmentTargetMessage` in `src/session/asset-link-actions.ts`) or by the webview resolver (`tryScrollToSameDocAnchor` in `media-src/src/links/same-doc-anchor.ts`).
- Both resolvers try headings first and then the HTML target; no code compares source positions, so the document-order rule of requirement 7 is not implemented. The cause is read from source; it is not yet measured by a failing test (Part 2 step 2 measures it).
- Measured (read-only probe of the vendored Lute `Md2HTML`, sanitize on and off): `<a id>`, `<span id>` and `<div id>` keep their `id` attribute in rendered Preview HTML, and Preview headings get no `id`. A rendered-element lookup in Preview is therefore possible for `id` targets.

### Scope

- In: the parser for `id` (any element) and `name` (`<a>` only); one shared fragment resolver with the document-order rule for host and webview; the inserted bytes `<a id="NAME"></a>`; the duplicate and heading checks; inspection of both forms; the internal rename in the table below.
- Out: menu label, tooltip, icon and placement (Task 642); rewriting existing anchors; HTML comments, multi-line tags and raw-HTML blocks such as `<pre>`/`<script>` (the scanner keeps its current per-line rules); cross-file reveal in a Split or Preview target panel (see decision D2).

### Settled names (rename table)

| Old | New |
|---|---|
| `src/shared/named-anchor.ts` (module id `named-anchor`) | `src/shared/id-target.ts` (module id `id-target`) |
| `media-src/src/editing/named-anchor-insertion.ts` (module id `named-anchor-insertion`) | `media-src/src/editing/id-insertion.ts` (module id `id-insertion`) |
| `media-src/src/editing/named-anchor-insertion.test.ts` | `media-src/src/editing/id-insertion.test.ts` |
| `test/backend/named-anchor.test.ts` | `test/backend/id-target.test.ts` |
| `test/vscode-e2e/named-anchor-navigation.spec.ts` | `test/vscode-e2e/id-insertion.spec.ts` |
| `test/vscode-e2e/named-anchor-mode-fidelity.spec.ts` | `test/vscode-e2e/id-insertion-mode-fidelity.spec.ts` |
| `NamedAnchor` | `IdTarget` |
| `parseNamedAnchorsFromMarkdown` | `parseIdTargetsFromMarkdown` |
| `findNamedAnchor` | `findIdTarget` |
| `namedAnchorInTag` (private) | `idTargetsInTag` (exported) |
| `NamedAnchorInsertion` / `NamedAnchorInsertionDeps` | `IdInsertion` / `IdInsertionDeps` |
| `configureNamedAnchorInsertion` / `installNamedAnchorInsertion` | `configureIdInsertion` / `installIdInsertion` |
| `planNamedAnchorInsertion` | `planIdInsertion` |
| `namedAnchorNameAtSourceOffset` | `idTargetValueAtSourceOffset` |
| event `vmde-insert-named-anchor` | `vmde-insert-id` |
| text key `insertAnchor` | `insertId` |
| text key `tipInsertAnchor` | `tipInsertId` |
| observer key and `reportError` context `named-anchor-insertion` (`finish-init.ts`, `main.ts`) | `id-insertion` |
| error text `Named anchor SV source transaction could not apply` | `Insert ID SV source transaction could not apply` |
| real-VS-Code log tag `NAMED_ANCHOR_HISTORY`, case id `'named-anchor'` (`exact-authority-other-actions.spec.ts`), document names `named-anchor*.md` in specs | `ID_INSERTION_HISTORY`, `'insert-id'`, `id-insertion*.md` |
| fixture prose `Named anchor target body.` (`anchor-links-sibling.md`) | `Name attribute target body.` |
| comments that say "named anchor" for this feature | "`name` target" or "ID target" |

Unchanged on purpose: the toolbar item name `insert-anchor`, the dialog attributes `data-vmde-anchor-dialog`, `data-vmde-anchor-error`, `data-vmde-anchor-cancel`, the input name `anchor-name`, the class `vmde-anchor-dialog`, the visible dialog strings except the new heading message, and dated records under `tasks/` and `docs/`. See decision D1.

### Shared interfaces (exact)

`src/shared/id-target.ts` (imports `createFenceTracker` from `./md-scan` and `parseHeadingsFromMarkdown`, `resolveFragment`, `SlugifyMode` from `./heading-slug`):

```ts
export type IdTargetAttribute = 'id' | 'name'
export interface IdTarget {
  /** Source spelling of the attribute value; matching is case-sensitive. */
  value: string
  /** Zero-based source line of the opening tag. */
  line: number
  attribute: IdTargetAttribute
}
/** Targets declared by one opening tag `<…>`: `id` on any element, `name` only on `<a>`. */
export function idTargetsInTag(tag: string): Array<{ value: string; attribute: IdTargetAttribute }>
export function parseIdTargetsFromMarkdown(markdown: string): IdTarget[]
/** `value` is already decoded. First `id` target in document order, else first `name` target. */
export function findIdTarget(targets: readonly IdTarget[], value: string): IdTarget | undefined
/** decodeURIComponent with the raw text as the fallback for a malformed escape. */
export function decodeFragment(raw: string): string
export type FragmentTarget =
  | { kind: 'heading'; index: number }
  | { kind: 'target'; target: IdTarget }
/** One resolver for host and webview; takes the raw (undecoded) fragment. */
export function resolveFragmentTarget(
  markdown: string,
  rawFragment: string,
  mode: SlugifyMode,
): FragmentTarget | undefined
```

`src/shared/heading-slug.ts`: `HeadingRecord` gains `line: number` (zero-based source line, counted over the same `split('\n')` iteration). Additive; the `toEqual` expectations in `test/backend/heading-slug.test.ts` gain the field.

`media-src/src/editing/id-insertion.ts`:

```ts
export type IdValueRefusal = 'invalid' | 'duplicate' | 'heading'
export function idValueRefusal(markdown: string, rawValue: string, mode: SlugifyMode): IdValueRefusal | undefined
export function planIdInsertion(markdown: string, offset: number, rawValue: string, mode: SlugifyMode = 'github'): IdInsertion | null
export function idTargetValueAtSourceOffset(markdown: string, offset: number): string | undefined
```

The dialog reads the mode with `getSlugifyMode()` from `../links/same-doc-anchor` (an `editing/` to `links/` import already exists in `html-subscript.ts` and `link-popover.ts`).

### Parser rules (settled)

1. Per line, outside fences, indented code and inline code spans, exactly as today (fence tracker, `inlineCodeSpans`, escaped `<` skipped, quote-aware `>` search).
2. A tag starts with `<` followed by a tag name `[A-Za-z][A-Za-z0-9-]*` and then whitespace, `/` or `>`. End tags (`</`), `<!…>` and `<?…>` are not tags. Autolinks such as `<https://…>` fail the name rule.
3. Attributes are tokenized, not matched by a free regex: a name is a run of characters other than whitespace, `"`, `'`, `>`, `/`, `=`; names compare case-insensitively; `data-id` is not `id`. Only a quoted, non-empty value counts (Task 556 rule). The first occurrence of an attribute in a tag wins (HTML duplicate-attribute rule).
4. `id` counts on every element; `name` counts only on `a`. A tag with both emits both records, `id` first. `<a/>`-style tags with no attributes emit nothing.
5. Records keep document order (line, then column).

### Resolution rule (settled; host and webview)

1. Decode the fragment once (`decodeFragment`). Empty fragment: no target.
2. Heading candidate: `resolveFragment(headings, decoded, mode)` (custom `{#id}` first, then slug, as in Task 243); its line is `headings[index].line`.
3. `id` candidate: the first record with `attribute === 'id'` and `value === decoded`.
4. If both exist, the smaller line wins; on the same line the heading wins. If only one exists, it wins.
5. Otherwise the first `name` record with that value (headings and `id` targets beat `name`, as `getElementById` beats the `name` fallback in HTML; this keeps the Task 243/556 precedence for `name`).
6. Host: `{kind:'heading'}` becomes `scroll-to-heading`; `{kind:'target'}` becomes `reveal-line` with the target's line; Task 635 line locations run only when this returns undefined (unchanged).
7. Webview same-document: `{kind:'heading'}` calls `scrollToHeadingIndex`; `{kind:'target'}` looks for a rendered element in the visible surface root — `inner.preview.element` when it is shown (`style.display === 'block'`, Preview and the Split preview pane), else `activeModeElement(vditor)`. Match `[id]` by `getAttribute('id') === value` for an `id` target, `a[name]` by `getAttribute('name') === value` for a `name` target, first in DOM order; scroll its `closest('[data-block]') ?? element` and flash it. With no rendered match, call `revealSourceLine(vditor, line)`.

**Preview target-resolution contract for Task 643:** a Preview surface resolves a fragment with `resolveFragmentTarget(markdown, rawFragment, mode)`; a heading result scrolls that heading index; a target result scrolls the first rendered element in the Preview root whose `id` (for an `id` target) or `name` on `<a>` (for a `name` target) equals `target.value`, else the block for `target.line`. Lute keeps `id` on rendered HTML (probe above).

### Insertion and dialog rules (settled)

- Inserted bytes: `<a id="VALUE"></a>` at the caret; caret after it; single Undo step and exact-source write unchanged; the SV path keeps the U+200B trailing-caret-line handling (`svMarkdownWithoutTrailingCaretLine`) exactly (Task 646 audit).
- Refusal order: invalid value, then duplicate (any `id` or `name` record with that value, case-sensitive), then heading (`resolveFragment` over the same markdown and the current slugify mode is defined).
- Messages: invalid `Use letters, numbers, dot, dash, colon, or underscore.` (unchanged); duplicate `An anchor with this name already exists.` (unchanged); heading `A heading already uses this ID.` (new). The exact-plan path (`insertExact`) uses `planIdInsertion` with the same mode, so a heading or duplicate that appears only in the host-exact text is refused with `The insertion point could not be confirmed.` (unchanged path).
- Inspection: a caret strictly inside an opening tag (`start <= offset < end` of `<…>`, as today) whose tag declares an `id` (any element) or `name` (`<a>`) opens the read-only dialog with the `id` value when both exist; the tag must also be a parser record on that line (so code is excluded). Text `Existing anchor target. Incoming links are unchanged.` unchanged.

### Invariants

- Behaviour changes only where the requirements say; the rename alone changes nothing (Part 2 step 1 is behaviour-neutral and its checks are the existing suites).
- `name` targets keep resolving exactly as before when no heading or `id` uses the value.
- Host and webview use one resolver, so cross-file and same-document precedence cannot drift.
- Task 635 line locations, Task 243 heading precedence among headings, and SV exact-byte rules are unchanged.

### Edge cases (covered by tests in step 2)

- `<span id="limits">`, `<div id="faq">`, `<h2 id="intro">` count; `<span name="x">` does not; `data-id="x"` does not; `id=bare` does not; `id=""` does not.
- Tags in fences, indented code and inline code spans do not count; escaped `\<a id="x">` does not.
- Case-sensitive values: `#Intro` does not reach `id="intro"`.
- `<a id="x" name="y">` gives two records; `<a id="x" id="z">` gives only `x`.
- `id` before a same-value heading: link goes to the `id`. Heading before: link goes to the heading. Same line: heading.
- `name` before a same-value heading: heading wins (unchanged).
- CRLF documents: lines counted the same way as today.
- Known limits kept: HTML comments on one line are not excluded; multi-line tags are not parsed.

### Decisions

- **D1. Rename breadth.** Provisional decision (2026-11-01), reversible: rename every "named anchor" identifier, file, event and module id plus the text keys `insertAnchor` and `tipInsertAnchor`; keep the toolbar item name `insert-anchor` and the dialog DOM attributes. Evidence: requirement 8 and its acceptance check target "named anchor" wording and list `insertAnchor`; `insert-anchor` and the dialog attributes carry no "named" wording, are not persisted in settings, and appear in about 90 test sites across 19 files that parallel toolbar work also touches. Selected by a recorded decision check (probability 0.75; full rename 0.11).
- **D2. Cross-file reveal in Split/Preview target panels.** Provisional decision (2026-11-01), reversible: same-document links are covered in IR, WYSIWYG, Split and Preview; cross-file links are covered into IR and WYSIWYG target panels through the existing `reveal-line` path. A cross-file `reveal-line` into a panel in Split or Preview does not reveal today for any target (`revealSourceLine` returns false outside IR/WYSIWYG; `name` targets and `#L42` locations have the same gap). This stays out of this task: Preview anchoring belongs to Task 643's Preview surface (contract above), and Split cross-file reveal is a follow-up to report. Acceptance item 2 is therefore proven for same-document links in all four modes and for cross-file links into IR/WYSIWYG. Selected by a recorded decision check (probability 0.94; message extension 0.02).
- **D3. Heading line source.** Provisional decision (2026-11-01), reversible: add `line` to `HeadingRecord` instead of a second heading scan, so one parser defines heading lines (smallest change; only `heading-slug.test.ts` expectations move).
- **D4. Rendered lookup root.** Provisional decision (2026-11-01), reversible: search only the visible surface root (shown preview element, else the active mode element), not the whole document, so ids of extension UI or hidden mode panes cannot match a user value. The existing jsdom test builds its DOM inside `vditor[currentMode].element`, which this root covers.
- **D5. Slugify mode in the dialog.** Provisional decision (2026-11-01), reversible: read `getSlugifyMode()` directly; no new configure dependency.

### Acceptance-to-test map

| Item | Proof |
|---|---|
| 1 Insert `<a id>`, one Undo step, exact bytes, IR/WYSIWYG/Split | Vitest `id-target.test.ts` (`planIdInsertion`), `id-insertion.test.ts`; Chromium `toolbar-overflow.spec.ts` Insert ID cases; real VS Code `id-insertion.spec.ts`, `id-insertion-mode-fidelity.spec.ts` (IR, WYSIWYG, SV) |
| 2 `#NAME`, `file.md#NAME` reach `<a id>` | Vitest resolver (`id-target.test.ts`), `same-doc-anchor.test.ts`, `asset-link-actions.test.ts`; real VS Code `id-target-navigation.spec.ts` (same-document IR, WYSIWYG, SV, Preview) and `anchor-links.spec.ts` (cross-file into IR); scope per D2 |
| 3 `<a name>` still works | Existing Vitest cases kept; `id-target-navigation.spec.ts` same-document `name` case; existing `anchor-links.spec.ts` cross-file `#named-target` |
| 4 Duplicate across both forms refused | Vitest `idValueRefusal`/`planIdInsertion` cases; real VS Code duplicate case in `id-insertion.spec.ts` |
| 5 Inspection of `id` and `name` | Vitest `idTargetValueAtSourceOffset`; Chromium inspection cases in `toolbar-overflow.spec.ts` |
| 6 `id` on other elements; code ignored | Vitest parser cases; real VS Code `<span id>` same-document case |
| 7 Document order; heading refusal | Vitest resolver and `idValueRefusal` cases; real VS Code collision case in `id-target-navigation.spec.ts` and heading-refusal case in `id-insertion.spec.ts` |
| 8 No "named anchor" wording; manifest and boundary test | `rg` check in step 1; `test/backend/module-boundaries.test.ts` |
| 9 Specs written and run; gates | Closure step |

### Part 2 step plan

Common check prefix: run from the worktree root. Vitest command: `npx vitest run --config test/vitest.config.mts <files>`.

1. **Rename (GREEN, behaviour-neutral, Light).** Result: the rename table applied with no behaviour change (inserted bytes stay `<a name>` in this step). Owned files: the six renamed files (move with `mv`, no git commands), `scripts/module-manifest.mjs`, `src/session/asset-link-actions.ts`, `media-src/src/links/same-doc-anchor.ts`, `media-src/src/boot/main.ts`, `media-src/src/boot/finish-init.ts`, `media-src/src/chrome/toolbar.ts`, `media-src/src/chrome/toolbar-tips.ts`, `media-src/src/util/lang.ts`, `media-src/src/chrome/toolbar.test.ts`, `media-src/e2e/webview-behaviors.spec.ts`, `media-src/e2e/toolbar-overflow-harness.ts`, `test/vscode-e2e/exact-authority-other-actions.spec.ts`, `test/vscode-e2e/anchor-links.spec.ts` (comment/message only), `test/vscode-e2e/fixtures/anchor-links-sibling.md` (line 147 text only). Proves item 8. Checks: `npm run typecheck` (exit 0); `npm run lint` (exit 0); Vitest `test/backend/id-target.test.ts media-src/src/editing/id-insertion.test.ts media-src/src/chrome/toolbar.test.ts media-src/src/chrome/toolbar-tips.test.ts media-src/src/chrome/toolbar-labels.test.ts media-src/src/links/same-doc-anchor.test.ts test/backend/asset-link-actions.test.ts test/backend/module-boundaries.test.ts` (all pass); `rg -n -i "named[ _-]?anchor|insertAnchor|tipInsertAnchor|insert-named" src media-src/src media-src/e2e test scripts --glob '!**/node_modules/**' --glob '!**/.vscode-test/**'` (no output).
2. **Vitest RED.** Result: failing tests for every new rule; no product code. Owned files: `test/backend/id-target.test.ts`, `test/backend/heading-slug.test.ts`, `media-src/src/editing/id-insertion.test.ts`, `media-src/src/links/same-doc-anchor.test.ts`, `test/backend/asset-link-actions.test.ts`. Cases: every edge case above; `resolveFragmentTarget` document order (id before heading, heading before id, same line, name after heading, decode); `findIdTarget` id over name; `HeadingRecord.line`; `planIdInsertion` writes `<a id="custom"></a>`; `idValueRefusal` duplicate for `id` and for `name`, heading refusal for a slug and a `{#custom}` id, GitLab mode; inspection on `<a id>`, `<span id>`, `<a name>`, and none inside code; webview rendered `[id]` lookup in the active root and Preview root; host `reveal-line` for an `id` target and document-order choice. Proves (as RED) items 1, 2, 3, 4, 5, 6, 7. Check: the step-1 Vitest command plus `test/backend/heading-slug.test.ts`; expected: the new cases fail for missing exports or wrong behaviour, all pre-existing cases pass (except inserted-byte expectations the step updates to `<a id>`, which fail too). Record the failing test names.
3. **Vitest GREEN.** Result: parser, resolver, heading line, host and webview resolution, insertion and dialog per the rules above. Owned files: `src/shared/id-target.ts`, `src/shared/heading-slug.ts`, `src/session/asset-link-actions.ts`, `media-src/src/links/same-doc-anchor.ts`, `media-src/src/editing/id-insertion.ts`. Proves items 1–7 at the unit layer. Checks: `npm run typecheck`, `npm run lint` (exit 0); the step-2 Vitest command (all pass).
4. **Chromium (merged RED+fix, Light).** Result: `media-src/e2e/toolbar-overflow.spec.ts` Insert ID cases expect `<a id="…"></a>` bytes (sites near lines 722–816); new cases: inspection of `<a id>`, `<span id>` and `<a name>` in IR and WYSIWYG; heading refusal message in IR; SV insertion bytes. Owned file: `media-src/e2e/toolbar-overflow.spec.ts`. Proves items 1, 5, 7 in a browser. Check: `xvfb-run -a npm --prefix media-src run test:e2e -- toolbar-overflow.spec.ts --grep "Insert ID|anchor"` (all selected pass; port 9123 or a scratch config on a free port).
5. **Real VS Code.** Result: specs written and run. Owned files: `test/vscode-e2e/id-insertion.spec.ts` (`<a id>` bytes, Undo/Redo, save, duplicate refusal, heading refusal), `test/vscode-e2e/id-insertion-mode-fidelity.spec.ts` (`<a id>` bytes in IR, WYSIWYG, SV), `test/vscode-e2e/exact-authority-other-actions.spec.ts` (inserted bytes), new `test/vscode-e2e/id-target-navigation.spec.ts` (same-document `#a-id`, `#span-id` in IR, WYSIWYG, SV, Preview; heading/`id` document-order case; `name` regression), `test/vscode-e2e/anchor-links.spec.ts` plus fixtures `anchor-links-main.md` (new link `anchor-links-sibling.md#id-target`) and `anchor-links-sibling.md` (`<a id="id-target"></a>` block appended at the end of the file, so earlier geometry is unchanged) for cross-file into IR. Proves items 1–4, 6, 7 in real VS Code. Checks: `node build.mjs` (exit 0), then `the shared real-VS-Code wrapper script 644 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- id-insertion.spec.ts id-insertion-mode-fidelity.spec.ts id-target-navigation.spec.ts anchor-links.spec.ts exact-authority-other-actions.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'` (all pass; record start time and result paths).
6. **Closure.** Focused gates (`node build.mjs`, `npm run typecheck`, `npm run lint`, the step-2 Vitest files, the step-4 Chromium selection, the step-5 real-VS-Code result), `npm run quality` (record stages), the step-1 `rg` check, checklists, one final gate check, `tmp/644/completion-report.md`.

## Progress

- 2026-11-01: Part 1 done (handoff above).
- 2026-11-01: Part 2 step 1 (rename) done. Files and identifiers follow the rename table; behaviour unchanged (inserted bytes still `<a name>`; the target record keeps its `name` field and the private tag reader is `idTargetInTag` until step 3 reshapes them). `typecheck`, `lint`, the step-1 Vitest set (8 files, 155 tests) pass and the wording search returns nothing. Next: step 2 (Vitest RED).
- 2026-11-01: Part 2 step 2 (Vitest RED) done. New and updated cases in `test/backend/id-target.test.ts`, `test/backend/heading-slug.test.ts`, `media-src/src/editing/id-insertion.test.ts`, `media-src/src/links/same-doc-anchor.test.ts` and `test/backend/asset-link-actions.test.ts`. Run of those five files: 40 fail, 134 pass; every failure is a missing export (`idTargetsInTag`, `decodeFragment`, `resolveFragmentTarget`, `idValueRefusal`) or missing behaviour (record shape with `value`/`attribute`, `HeadingRecord.line`, `<a id>` bytes, heading refusal, `id` reveal, document order). No product code changed. Next: step 3 (Vitest GREEN).
- 2026-11-01: Part 2 step 3 (Vitest GREEN) done. `src/shared/id-target.ts` (tokenizing tag reader, `id`/`name` records, `decodeFragment`, `findIdTarget`, `resolveFragmentTarget`), `HeadingRecord.line`, the host `fragmentTargetMessage`, the webview `tryScrollToSameDocAnchor` (rendered `[id]`/`a[name]` lookup in the visible surface root) and `id-insertion.ts` (`idValueRefusal`, `<a id>` bytes, heading message, id/name inspection) are implemented. `typecheck` and `lint` exit 0; the nine-file Vitest set passes (244 tests). Two step-2 test expectations were wrong and were corrected, not weakened (slugify-mode case, Preview-root style setup). Real-VS-Code and Chromium proof is still open (steps 4 and 5). Next: step 4 (Chromium).
- 2026-11-01: Part 2 step 4 (Chromium) done. `media-src/e2e/toolbar-overflow.spec.ts`: Insert ID history cases and the WYSIWYG repeated-prefix case expect `<a id>` bytes; new cases inspect an `<a id>`, a `<span id>` and an `<a name>` target in IR, an `<a id>` target in WYSIWYG, and show the heading and id-duplicate refusal messages. Run `toolbar-overflow.spec.ts --grep "Insert ID|Insert anchor|Undo then an immediate Redo"`: 17 passed (after `node build.mjs`, which the worktree needed for the vendored Vditor files). The cases were written after the step-3 fix, so no failing run of them was recorded. Next: step 5 (real VS Code).
- 2026-11-01: Part 2 step 5 (real VS Code) PARTIAL, blocked on a product question. Specs written: bytes updated in `id-insertion.spec.ts`, `id-insertion-mode-fidelity.spec.ts`, `exact-authority-other-actions.spec.ts`; new heading-refusal case in `id-insertion.spec.ts`; new `id-target-navigation.spec.ts`; cross-file `id-target` link in `anchor-links.spec.ts` and its fixtures. Run (start 04:43): 9 passed, 4 failed. Passed: `anchor-links.spec.ts` (including the new cross-file `<a id>` case into IR), all `exact-authority-other-actions.spec.ts` cases, `id-insertion.spec.ts` (3 of 3 when run alone), and the IR `id-insertion-mode-fidelity` case. Failures: (a) `id-insertion-mode-fidelity.spec.ts` WYSIWYG (Undo does not restore the document) and SV (Undo/Redo do nothing; the undo stack count stays 4) with `<a id>`; the same spec passes in IR and, measured with a temporary switch to emit `<a name>` (reverted), passes in WYSIWYG and SV. So the `id` form changes Undo/Redo in WYSIWYG and SV; cause not yet found (needs a bounded reasoning turn). (b) `id-target-navigation.spec.ts` fails with `link #alpha-id not found` in one mode: the spec's link lookup needs fixing per mode (IR links are `data-type="a"` nodes, not `a[href]`). The first `id-insertion.spec.ts` duplicate case failure in the long run did not reproduce in isolation. Acceptance items 1 (WYSIWYG/SV Undo) and 2 (Split, Preview) stay open.
- 2026-11-01: Step D1 (reasoning) done: failure 1 is test-order coupling, not a product defect (see the amendment below). Next: repair step R1.
- 2026-11-01: Repair step R1 done. Spec isolation (close all editors per case), navigation spec picks its search root by mode and waits for the rendered pane, WYSIWYG repeated-prefix case waits for surface readiness. One wrapper run of `id-insertion.spec.ts`, `id-insertion-mode-fidelity.spec.ts`, `id-target-navigation.spec.ts`, `anchor-links.spec.ts`: 9 passed (start 06:17:55). `exact-authority-other-actions.spec.ts` passed in step 5. Acceptance items 1–7 ticked. Next: step 6 (closure: gates, `npm run quality`, completion report).
- 2026-11-01: Step 6 (closure) done. Gates: typecheck and lint exit 0; focused Vitest 9 files, 244 tests pass; Chromium `toolbar-overflow` and `webview-behaviors` selection 18 passed; real VS Code 9 passed (R1 run) plus the `insert-id` cases of `exact-authority-other-actions.spec.ts` (step 5). `npm run quality`: brand identifiers, `lint:ci`, knip, jscpd, depcruise, `test:coverage` (374 files, 8038 tests) and the zero-coverage-module check pass; the audit stage fails on dependency advisories (`qs`, `undici`, `launch-editor`) in packages this task did not touch, recorded and not fixed. Wording check `rg -i 'named.?anchor'` over `src`, `media-src/src`, `test`, `scripts` has no hits. Known limit (decision D2): a cross-file link into a Split or Preview target panel does not reveal the target.

## Part 1 handoff amendment (2026-11-01, after step 5)

### Finding for failure 1 (WYSIWYG/SV Undo after Insert ID)

- Measured: Lute renders `<a id>` and `<a name>` identically in IR, WYSIWYG and SV (html-inline markers) and round-trips both.
- Measured in real VS Code with a temporary probe spec (removed): after inserting `<a id>` through the toolbar in WYSIWYG and SV (values `mode-wysiwyg`, `mode-sv`, `pidwysiwyg`, `pidsv`), Undo reverts the document (undo stack 4 to 3, `contenteditable` stays `true`, no console errors). Six of six probe cases passed.
- Measured: `id-insertion-mode-fidelity.spec.ts` WYSIWYG and SV cases with `<a id>`, run without the IR case first (`--grep "reopen in (wysiwyg|sv)"`), pass 2 of 2.
- Conclusion: the product's Undo/Redo after Insert ID works in WYSIWYG and SV. The failure appears only when the IR case runs first in the same VS Code instance (it reopens its document and leaves editors open; the spec never closes editors between cases, and `wf(workbox)` addresses the first matching webview). The single passing `<a name>` sequence run is not enough to make this a product difference. Vditor's `undo()` exits early only on `contenteditable="false"` or fewer than two undo entries, consistent with the case acting on a different or inactive editor in that sequence (inference).
- Provisional decision (2026-11-01), reversible: fix test isolation, not the product; keep `<a id>`. Selected by a recorded decision check (probability 1.00).

### Repair step R1 (real VS Code; replaces the rest of step 5)

Owned files: `test/vscode-e2e/id-insertion-mode-fidelity.spec.ts`, `test/vscode-e2e/id-insertion.spec.ts`, `test/vscode-e2e/id-target-navigation.spec.ts`. No product files.

1. Failure 1: at the start of each case in `id-insertion-mode-fidelity.spec.ts` and `id-insertion.spec.ts`, run `workbench.action.closeAllEditors` through `evaluateInVSCode` before opening the case's document (the pattern at the start of `anchor-links.spec.ts`).
2. Failure 2 (`link #alpha-id not found` in `id-target-navigation.spec.ts`): pass the test's mode into `ctrlClickLink` and `inView` and choose the root from it — `inner.preview.element` for `sv` and `preview`, `inner[inner.currentMode].element` for `ir` and `wysiwyg` — instead of reading `preview.style.display` (the preview element can report `block` while IR is active after boot, inference). Include the mode and the list of found hrefs in the thrown error. Close all editors at the start of the test as in item 1.
3. Failure 3 (the first `id-insertion.spec.ts` case failed once in the long run, typed text landed in the editor, error text empty; 3 of 3 pass alone): covered by item 1; if it recurs in sequence, record the log and report it, do not change product code.
4. Checks: `node build.mjs` (exit 0), then one wrapper run: `the shared real-VS-Code wrapper script 644 env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & OB=$!; VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- id-insertion.spec.ts id-insertion-mode-fidelity.spec.ts id-target-navigation.spec.ts anchor-links.spec.ts --workers=1 --retries=0; R=$?; kill $OB; exit $R'` (all pass). `exact-authority-other-actions.spec.ts` already passed in step 5 and is not rerun. Expected: WYSIWYG and SV mode-fidelity cases pass in sequence after the IR case; navigation passes in IR, WYSIWYG, SV and Preview. If WYSIWYG/SV still fail in sequence after isolation, stop and report the sequence log as a product question.
5. Then step 6 (closure) as planned.
