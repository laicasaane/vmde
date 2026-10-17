# Task 644 — Insert ID: write and resolve HTML `id` link targets

**Status:** open.
**Origin:** Project Owner feature request.
**Severity:** feature (medium risk; changes inserted source, link-target resolution and renames internal modules).
**Tech stack:** shared parser (`src/shared/named-anchor.ts`), host link actions (`src/session/asset-link-actions.ts`), webview (`media-src/src/editing/named-anchor-insertion.ts`, `links/same-doc-anchor.ts`, `boot/main.ts`, `boot/finish-init.ts`), Vitest, Chromium, real VS Code.
**Builds on:** [Task 556](done/556-html-named-anchor-navigation.md) (HTML named-anchor navigation and insertion).
**Related:** [Task 642](642-toolbar-layout-follow-ups.md) (renames the More item to **Insert ID** and gives it the `#` icon).

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

- [ ] Insert ID inserts `<a id="NAME"></a>` at the caret with one Undo step and exact bytes elsewhere, in IR, WYSIWYG and Split.
- [ ] `#NAME` and `file.md#NAME` links navigate to `<a id="NAME">` targets in IR, WYSIWYG, Split and Preview.
- [ ] `<a name="NAME">` targets still navigate as before.
- [ ] A value already used by an `id` or a `name` target is refused with the existing duplicate message.
- [ ] The caret inside an existing `id` or `name` target opens the read-only inspection.
- [ ] `id` targets on elements other than `<a>` navigate; tags in code spans and fences do not.
- [ ] When a heading anchor and an `id` share a name, links reach the first in document order; Insert ID refuses a value a heading anchor uses.
- [ ] No identifier, file, event or text key in the source still uses "named anchor" wording for this feature; the module manifest and boundary test pass.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: target parsing of `id` on any element and `name` on `<a>` (code spans and fences ignored, case-sensitive values, `id` preferred over `name`, document order against heading anchors), insertion planning, duplicate check across both forms.
- Chromium: insertion in IR, WYSIWYG and SV; inspection of both forms; same-document navigation.
- Real VS Code (`test/vscode-e2e/`): extend the Task 556 named-anchor specs with `id` insertion, same-document and cross-file `id` navigation, and a `name` regression case.
