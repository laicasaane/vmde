# Task 654 — Raw HTML links render as links in IR and WYSIWYG

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 647).
**Severity:** low to medium.
**Tech stack:** webview (IR and WYSIWYG rendering of inline raw HTML).
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

Raw HTML `<a href="…">` shows as source markers and plain text in IR and WYSIWYG. It has no link element, so it is neither a link nor underlined in those panes. Preview renders a real link.

## Requirements

1. In IR and WYSIWYG, a raw HTML `<a href="…">` element is shown as a link.
2. The link is underlined in the same way as other links in those panes.
3. The saved Markdown is unchanged.

## Open design points

- How the raw HTML anchor is recognised and displayed in IR and WYSIWYG.
- Handling of anchors without an `href`, or with other attributes.

## Scope

- In: display of raw HTML `<a href>` links in IR and WYSIWYG.
- Out: Preview, Split, and Markdown link syntax, which already render correctly.

## Acceptance

- [ ] A raw HTML `<a href="…">` in IR and in WYSIWYG renders as a link element with underline. (Chromium proven; real-VS-Code S6 pending.)
- [x] Preview output for the same content is unchanged. (Chromium: `Md2HTML` of the fixture is byte-identical with and without the reader, and anchors without a safe `href` stay bare; no Preview file touched.)
- [ ] Saved Markdown is byte-identical after editing and saving. (`getValue` identity proven in Chromium; on-disk bytes after save are S6, pending.)

## Tests

- To be specified in Part 1 (webview behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-10-18)

Read-only pass on `dev` at `9a9f54ff`. Evidence comes from reading the source and from Node probes of the vendored Lute (`media/vditor/dist/js/lute/lute.min.js`, `SetSanitize(true)`, IR and WYSIWYG instances). The probe scripts ran outside the repository. No browser, build or VS Code run happened. Anything that needs one is marked **unverified** and assigned to Part 2 S1.

### Verified facts

1. **IR DOM of an inline `<a href>`** (`Md2VditorIRDOM`, probe.js). Each tag is its own node, `span[data-type="html-inline"].vditor-ir__node > code.vditor-ir__marker` with the escaped tag text. The link body is made of ordinary siblings in the same parent (text, `em`/`code` IR nodes, other html-inline nodes). No element wraps the body. Example: `See <span data-type="html-inline" class="vditor-ir__node"><code class="vditor-ir__marker">&lt;a href=&quot;https://example.com&quot;&gt;</code></span>site<span …>&lt;/a&gt;</span> end.` The same shape appears in `h1`, `li`, `blockquote > p` and `td`.
2. **WYSIWYG DOM** (`Md2VditorDOM`). Each tag is a `code[data-type="html-inline"]` whose text starts with U+200B (`​&lt;a href=…&gt;`). The body is again plain siblings. A ZWSP text node is added before a leading marker and between adjacent markers.
3. **Preview** (`Md2HTML`) renders a real `<a href>`. The sanitizer drops `href` for `javascript:` (any case, leading spaces, `&#x09;`/`&#97;` entity tricks), `data:text/html` and `data:image/svg+xml`, which leaves `<a>t</a>`. It keeps `vbscript:`, `data:image/png`, `file:`, `mailto:`, `tel:`, `command:`, `#anchor`, relative paths and `//host`. The rule is in the blob next to the literals `"data:image/svg+xml"`, `"data:text/html"` and `"javascript"` (an attribute filter, found by grep).
4. **Round trip without any change.** `VditorIRDOM2Md(Md2VditorIRDOM(md))` gives back the same bytes for every inline case probed: plain, multiple attributes, single quotes, uppercase `<A HREF>`, `javascript:`, `data:`, `<a id>`, `<a name>`, nested `<b>`/`*em*`/`` `code` ``/`<sub>`, two links in one paragraph, unclosed `<a>`, heading, list and quote. **WYSIWYG drift that exists today:** `x <a href="?a=1&amp;b=2">ent</a> y` serializes to `…href="?a=1&b=2"…` through `VditorDOM2Md`. IR keeps `&amp;`. This is Lute behaviour and unrelated to this task. The table case also differs in both modes only because Lute rewrites the delimiter row (`|---|` becomes `| --- |`).
5. **No Lute option renders inline HTML as elements in the Vditor modes.** The `Set*` list in the blob (grep of `"Set…"` literals) offers `SetVditorHTMLBlockPreview` for blocks only, plus Protyle-only `SetHTMLTag2TextMark`. JS renderers (`SetJSRenderers`) are already owned by the wiki renderer (`media-src/src/links/custom-renderer.ts:98-110`). Calling it replaces the whole renderer set, it is registered only when wiki links are enabled ("registering custom renderers broke wysiwyg/sv rendering", `custom-renderer.ts:51-53`), and the host prerender (`src/lute/lute-host.ts`) has no renderers. A render patch would therefore disagree with the prerender and with the wiki renderer. Rejected.
6. **Block-level anchors already render.** `<div><a href="u">blk</a></div>` and a multi-line `<a href="u">\nmulti\n</a>` become an `html-block` dual node. Its `pre.vditor-ir__preview[data-render="2"]` (WYSIWYG: `pre.vditor-wysiwyg__preview[data-render="2"]`) contains a real `<a href="u">`. This task covers inline anchors only. Whether that preview anchor is underlined by the Task 647 rule is unverified (S1).
7. **Unquoted `href=u` is not an html-inline token for Lute.** `x <a href=u>unq</a> y` renders the opening tag as plain text, while `</a>` alone is an html-inline node.
8. **A real `<a>` inside the editor DOM is corrupted by Lute if it reaches the serializers.** With the body wrapped in `<a href="u">`, both `VditorIRDOM2Md` and `VditorDOM2Md` give `See <a href="u">[site *em*](u)</a> end.`. Vditor also has `A`-specific behaviour in WYSIWYG: copying produces `[sel](href)` (`media-src/node_modules/vditor/src/ts/wysiwyg/index.ts:226-235`), a click calls `link.click` (`:439-446`), and Alt+Enter opens the popover (`wysiwyg/processKeydown.ts:199-208`).
9. **A bare class-only `<span>` around the body is transparent to Lute.** Unstripped, both serializers return the original bytes. `SpinVditorIRDOM` drops the span, so a decoration lasts only until the next spin. This matches `media-src/src/links/code-ref-decorate.ts:1-21`.
10. **There is a direct precedent: HTML inline formatting readers** (Tasks 553–555, `media-src/src/editing/html-subscript.ts`). It pairs authored `<sub>`/`<sup>`/`<ins>` html-inline markers per container (`pairMarkers`, `:118-143`; one invalid or unbalanced token cancels every pair in that container, `:126`, `:137-141`). It skips markers inside code, math, `pre` or `data-render` (`protectedMarker`, `:102-116`). It moves the body into an owned element tracked by a per-session issued id (`decorate`, `:295-…`). It hides both markers with inline `display:none` and `aria-hidden` (`hideMarker`, `:145-…`). The source is revealed when the selection touches the element (`onSelection`, `:367`) or on pointerdown/click (`onPointer`, `:400`). The presentation is removed before all four Lute readers `VditorIRDOM2Md`, `VditorDOM2Md`, `SpinVditorIRDOM` and `SpinVditorDOM` (`stripHtmlSubscriptPresentation` `:163`, `wrapHtmlInlineFormattingLute` `:186`). Those readers are installed for every Lute instance in `media-src/src/boot/preload.ts:11-22`. One observer on `#app` covers IR and WYSIWYG (`observeHtmlInlineFormattingReaders`, `:458`; `media-src/src/boot/finish-init.ts:525-528`). The descriptor list is `:40`, and `OWNED_SELECTOR` (`:41`) is built from `descriptor.tag`.
11. **IR markers collapse at rest by Vditor CSS.** `.vditor-ir__node .vditor-ir__marker { width:0; height:0; overflow:hidden; display:inline-block }`, shown under `--expand` (`vditor/src/assets/less/_ir.less:36-41, 48-53`). Neither `main.css` nor Vditor less has an `html-inline` rule (grep). Task 647 still records that IR "shows source markers". How visible the IR html-inline tags really are at rest is **unverified** (S1 measures it). The precedent hides them with `display:none` in both modes regardless.
12. **IR expand logic** (`vditor/src/ts/ir/expandMarker.ts`). It expands the top-most `.vditor-ir__node` ancestor of the caret plus an adjacent node. An element without `vditor-ir__node` is invisible to this logic.
13. **Link activation today.** The document click handler routes a real `a[href]` with the modifier policy and the raw attribute (`media-src/src/links/link-click-fix.ts:208-219`, `raw-href.ts`). IR Markdown links open in a capture-phase click (`:139-156`). Activate Link at Caret uses `linkLikeInSelection` (`caret-link.ts:28-29` selector `[data-wiki-link="1"],[data-code-ref="1"],a[href],.vditor-ir__link`) and then `hrefForLinkLike` (`link-click-fix.ts:81-87`), registered at `:246`. The policy is `shouldOpenLink` (`link-open-policy.ts`).
14. **The host is the open-time security boundary.** `classifyHref` (`src/shared/link-target.ts:56`) allows external http(s), `SAFE_SCHEMES = {mailto, tel}` (`:47`) and contained local paths. It refuses everything else, including `command:`, `javascript:`, `data:`, `file:` and `vscode:` (`:9`, `:25-26`), and `AssetLinkActions.onOpenLink` shows "Can't open this link" (`src/session/asset-link-actions.ts:276-300`).
15. **Link look (Task 647, `media-src/src/main.css:1331-1373`).** `.vditor-reset :is(a[href], span[data-type='link-ref']):not(…)` is `underline solid currentcolor`, offset `2px`. The IR outer `span[data-type='a']` has the same line with color `var(--vmde-link, var(--vscode-textLink-foreground, #4493f8))`. `--vmde-link` is `var(--vscode-textLink-foreground)` in `auto` (`main.css:131`). Each named content theme sets `.markdown-body a { color }` to the same value as its `--vmde-link` (`media/markdown-themes/*.css`, e.g. `github-markdown-light.css:25,48`). Vditor's content-theme CSS has no `.vditor-reset a { color }` (Node scan).
16. **Module edges.** `editing → links` is already used (`media-src/src/editing/link-popover.ts:10-11`). `links → editing` has no import today, so adding one would create a cycle. `code-ref-decorate.ts:84` skips `a[href]` but would not skip a new span.

### Decisions

- **D1 Mechanism: extend the HTML inline formatting reader with a fourth descriptor, `LINK`.** It is display-only and reversible. The owned element is removed before every Lute reader (fact 10). An unstripped leftover is still harmless (fact 9). Saved bytes cannot change through it. Rejected: a Lute render patch (fact 5), CSS alone (a bare text node cannot be styled), and a real `<a>` (fact 8).
- **D2 Owned element: `<span>`, never `<a>`.** Attributes: `class="vmde-html-link"`, `data-vmde-html-link="1"`, `data-vmde-html-link-owner="<id>"`, `data-vmde-html-link-href="<decoded href>"`, `role="link"`. No `href`, `title` or `target` is copied: all links open through the host, and there is no navigable attribute in the webview. Hidden markers get `data-vmde-html-link-marker`. A revealed container gets `data-vmde-html-link-revealed`.
- **D3 Recognition.** The open token passes `parseHtmlInlineToken` with name `a` and the close token is `</a>`, in the same parent (the existing pairing). The href is read with an inert `<template>`: `template.innerHTML = token` (leading ZWSP stripped), then `content.firstElementChild` must be `A` with `hasAttribute('href')`, and its `getAttribute('href')` is used. This gives the browser's attribute and entity decoding (`&amp;` becomes `&`), the same as Preview's `rawHrefOf`. The anchor is **not decorated** (it keeps today's source look) when it has no `href` (`<a id>`, `<a name>`), or when Preview's sanitizer would drop the href. The check removes the code points U+0000 to U+0020 and U+007F, lowercases, then rejects the prefixes `javascript`, `data:text/html` and `data:image/svg+xml` (fact 3). The body must also have content (the existing `hasPresentBody`). An empty `href=""` is decorated, as Preview keeps `<a href="">` (fact 3, Md2HTML of a Markdown link). Activating it does nothing (`openLinkUrl('')` returns false).
- **D4 Descriptor order: `[SUBSCRIPT, SUPERSCRIPT, UNDERLINE, LINK]`.** With LINK last, `<sub>` and friends inside a link are decorated first. The link's own markers then still share the container parent, and the owned inner element moves into the link span. `OWNED_SELECTOR` must come from the element name (`span[data-vmde-html-link="1"]`), not from `tag`.
- **D5 Descriptor shape.** Add `element?: string` (defaults to `tag`) and `accept?: (open: Element) => Record<string, string> | null`. `accept` returns the extra attributes to set, or null to skip the pair. Keep `tag: 'a'` as the source tag name. Existing descriptors are unchanged.
- **D6 Look** (new `main.css` block right after the Task 647 IR rule, before the code-reference rule at `:1367`). `.vditor-reset .vmde-html-link` gets `color: var(--vmde-link, var(--vscode-textLink-foreground, #4493f8)); text-decoration-line: underline; text-decoration-style: solid; text-decoration-color: currentcolor; text-underline-offset: 2px; cursor: pointer;`. Also add `.vmde-html-link` to the 647 code-reference-in-link selector (`:1369-1373`) so a code reference inside does not draw a second line. Comment it per `.agents/rules/css.md`.
- **D7 Reveal behaviour (default, pending Owner question 1).** Same as sub/sup/ins and IR Markdown links. At rest only the underlined link text shows. A caret or selection touching it, or a plain click (when the policy is `modifier`), reveals `<a …>body</a>` as source for editing. Leaving the container decorates it again.
- **D8 Activation.** Ctrl/Cmd+click (or a plain click in `click` mode) opens the link through the host:
  - In `onPointer` (pointerdown) for an owned LINK when `shouldOpenLink(event)` (import from `links/link-open-policy`, an allowed edge): do not reveal. Record `openGesture = owned`.
  - `onSelection` does not reveal `openGesture` while it is set.
  - On root `click`, clear `openGesture` and run `onSelection` again with `setTimeout(…, 0)`, so the document handler sees the attached span first and the source is revealed afterwards, like IR Markdown links. Also clear it on `pointercancel`, and on `pointerup` with `setTimeout(…, 0)` as a fallback.
  - `link-click-fix.ts` gets a branch before the generic `a[href]` one: `target.closest('[data-vmde-html-link="1"]')`. If `shouldOpenLink(e)`, then `preventDefault`, `stopPropagation` and `openLink(dataset.vmdeHtmlLinkHref)`. Return either way.
  - Activate Link at Caret in the revealed state is Owner question 3. The default is to support it through a pure helper `htmlLinkHrefAt(node): string | null` in the new `links/html-link.ts`. The caret is strictly inside the body between an accepted `<a href>` open marker and its `</a>` in the same container (a-only depth count). `activateLinkAtCaret` falls back to it, and the caret-gesture match becomes `(n) => linkLikeAt(n) ?? htmlLinkAt(n)`.
- **D9 New pure module `media-src/src/links/html-link.ts`.** It exports `htmlAnchorHref(token: string): string | null` (D3) and `htmlLinkHrefAt` (D8). It lives in `links/` so `editing/html-subscript.ts` can import it. Register its id in `scripts/module-manifest.mjs` (`links.ids`) with a Task 654 comment. It must not import `editing/`.
- **D10** Add `[data-vmde-html-link]` to `code-ref-decorate.ts` `SKIP_SELECTOR`. That matches how it treats `a[href]` (no code-reference chip inside a link).
- **D11 Unchanged:** Preview, Split, SV (no html-inline nodes), Lute, `build.mjs`, the host, the content themes, and block-level HTML anchors (fact 6). The host prerender overlay still shows source tags until the live editor attaches, as with sub/sup/ins.

### State, DOM, messages

- At rest (decorated): `…<span data-type="html-inline" … style="display:none" aria-hidden="true" data-vmde-html-link-owner=ID data-vmde-html-link-marker=ID>…&lt;a href=…&gt;…</span><span class="vmde-html-link" data-vmde-html-link="1" data-vmde-html-link-owner=ID data-vmde-html-link-href="https://example.com" role="link">site</span><span … hidden close marker>…`. WYSIWYG is the same with `code[data-type="html-inline"]` markers.
- Revealed: the original DOM, plus `data-vmde-html-link-revealed="1"` on the container.
- Message: the existing `{ command: 'open-link', href }`. No new message and no protocol change.

### Part 2 steps

Each step writes its test cases first and shows them failing (RED).

- **S1 Executable probes (Chromium, html-subscript harness, no product change). No owned files beyond the harness.**
  - Add `?fixture=link` to `media-src/e2e/html-subscript-harness.ts`, choosing an alternate `value` so existing specs keep theirs: plain link, three attributes, `&amp;` href, nested `<b>`/`*em*`/`` `code` ``/`<sub>`, two links in one paragraph, `<a id>`, `<a name>`, `javascript:`, `data:text/html`, `href=""`, `<div><a href>` block, `./target.md` link, and a Markdown link `[md](https://example.com)` as the look reference.
  - Measure:
    - (a) the rest visibility of IR html-inline markers today (fact 11);
    - (b) whether a Ctrl+pointerdown on a span inside the editable surface fires `selectionchange` before `click`, and whether `click.target` stays inside the span when it is not revealed (D8);
    - (c) the computed decoration of the `html-block` preview `<a>` (fact 6).
  - Record the values in the task record. If (b) shows that the click target is lost, switch D8 to opening on pointerdown (with `preventDefault`) and swallowing the next click. Record that choice.
- **S2 Pure helper + unit tests.** Owned files: new `media-src/src/links/html-link.ts`, `media-src/src/links/html-link.test.ts`, `scripts/module-manifest.mjs` (one id). Test cases: the D3 table, with expected results from probe2.js (decorated: https, relative, `#x`, `mailto:`, `vbscript:`, `data:image/png`, `''`, single quotes, `<A HREF>`, three attributes, `&amp;` decoded; not decorated: no href, `id`, `name`, `javascript:`, `  javascript:`, `JaVaScRiPt:`, `jav&#97;script:`, `java&#x09;script:`, `data:text/html`, `data:image/svg+xml`). Then `htmlLinkHrefAt`: body text, a nested node in the body, outside the pair, on a marker, two links, an unclosed `<a>`.
- **S3 Reader descriptor.** Owned files: `media-src/src/editing/html-subscript.ts`, `media-src/src/editing/html-subscript.test.ts`. Test cases (jsdom, the shapes of facts 1 and 2):
  - wraps the body in the owned span with the decoded href; markers hidden;
  - `stripHtmlSubscriptPresentation(decorated innerHTML)` equals the original innerHTML byte for byte, in IR and WYSIWYG shapes;
  - not decorated: no href, unsafe href, an unbalanced container, a link inside inline code;
  - nested `<sub>` decorated inside the link and both strip cleanly;
  - two links in one paragraph;
  - selection entering reveals the source and leaving decorates again;
  - an open gesture (mocked `shouldOpenLink`) does not reveal until after the click.
  - Gates for S3: `html-subscript.test.ts`, `html-subscript-command.test.ts`, `html-subscript-action.test.ts`.
- **S4 Activation and look.** Owned files:
  - `media-src/src/links/link-click-fix.ts` and `media-src/src/links/link-click-fix.test.ts`: click branch; caret activation if Owner question 3 is A;
  - `media-src/src/links/code-ref-decorate.ts` (D10) and its test (one case);
  - `media-src/src/main.css` (D6).
  - Unit test cases: Ctrl+click posts `open-link` with the decoded href; a plain click in `modifier` mode posts nothing; Activate Link at Caret in a revealed body posts the href.
- **S5 Chromium spec.** Owned file: new `media-src/e2e/html-link.spec.ts` (uses `?fixture=link`). Test cases, per mode IR and WYSIWYG:
  - (1) rest: every accepted link has `.vmde-html-link` with `text-decoration-line` `underline`, style `solid`, offset `2px`, and `color` equal to the Markdown reference link's color in the same pane (IR: `.vditor-ir__link`; WYSIWYG: `a[href]`); markers are `display:none`; controls (`<a id>`, `<a name>`, `javascript:`, `data:text/html`) are not decorated and their source shows;
  - (2) caret entry reveals the source, typing one character in the body and moving out redecorates, and `getValue()` equals the fixture plus exactly that character;
  - (3) `getValue()` before decoration, after decoration and after reveal/redecorate are identical to the fixture (byte for byte, including `&amp;` in IR);
  - (4) Preview anchors for the fixture equal those from `Md2HTML` (href attributes and text), so Preview is unchanged.
  - Gates for S5: the new spec, plus `html-subscript.spec.ts`, `link-underline.spec.ts` and `codenav.spec.ts`.
- **S6 Real-VS-Code spec** (holds the machine-wide real-VS-Code token; `node build.mjs` first; `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- html-link-display.spec.ts`, `--workers=1 --retries=0`). Owned file: new `test/vscode-e2e/html-link-display.spec.ts` with 2 tests:
  - (1) IR: rest underline/color/offset equal to a Markdown link in the real webview (`auto` and `github-light`); Ctrl+click on `<a href="./target.md">` opens `target.md` as a VMDE tab (the `tabGroups` technique from `local-link-open.spec.ts:118-146`); the caret reveals the source; editing a different paragraph and saving leaves the HTML link bytes identical on disk.
  - (2) WYSIWYG: the same rest look; an edit elsewhere, save, and the file bytes for the link lines are identical; the document is not dirty after a Ctrl+click; Preview shows the same `<a href>`.
- **S7 Closure.** Focused gates once per closure batch: `npm run lint:ci`, `npm run typecheck`, `npm run knip`, `npm run jscpd`, `npm run depcruise`, the boundary test `test/backend/module-boundaries.test.ts`, `npm run test:coverage`. Then update the record checklists.

### Tests mapped to acceptance

| Acceptance item / edge case | Test (cheapest layer) |
|---|---|
| A1 link element with underline, IR and WYSIWYG | S5 (1); S6 (1)(2) in the real webview |
| A2 Preview unchanged | S5 (4); S6 (2) Preview check; no Preview file touched |
| A3 saved Markdown byte-identical after edit + save | S3 strip identity (unit); S5 (2)(3); S6 (1)(2) on-disk bytes |
| Recognition, entities, schemes, no href, multiple attributes, quotes, case | S2 unit table |
| Nested formatting, `<sub>` in a link, two links, unbalanced | S3 unit; S5 fixture |
| Reveal/caret editing | S3 unit; S5 (2); S6 (1) |
| Ctrl/Cmd+click → `open-link` | S4 unit; S6 (1) real open |
| Activate Link at Caret (if Owner question 3 is A) | S2 + S4 unit |
| Block-level `<a>` (out of scope, record only) | S1 (c) measurement |

### Owner questions

1. Rest display of an inline HTML link in IR and WYSIWYG.
   - A (recommended): show only the underlined link text at rest and reveal `<a …>…</a>` on caret entry or a plain click. This matches sub/sup/ins (Tasks 553–555) and IR Markdown links.
   - B: keep the tags visible and only underline the body (no reveal logic).
2. Which anchors count as links.
   - A (recommended): the same as Preview. Decorate when Preview would render `a[href]`; leave anchors without `href` and those with sanitized-away hrefs (`javascript:`, `data:text/html`, `data:image/svg+xml`) as source. The host still refuses unsafe schemes when opened.
   - B: decorate only the hrefs the host can open (http(s), mailto, tel, relative, `#`). Preview would then show some links that IR/WYSIWYG do not.
3. Activate Link at Caret (`vmde.activateLinkAtCaret`) while the caret is inside a revealed HTML link.
   - A (recommended): supported through the marker-pair lookup (D8).
   - B: not supported; Ctrl/Cmd+click at rest only.

### Residual risks

- The `pairMarkers` rule is all-or-nothing (fact 10). A stray or unrecognised tag in the same container (for example `<a href=u>`, fact 7) leaves every HTML link and sub/sup/ins in that container undecorated.
- The D8 gesture timing (selectionchange compared with click on a moving DOM) is unverified until S1 (b).
- WYSIWYG entity drift (`&amp;` → `&` on edit) exists today in Lute (fact 4). A3 holds for unedited blocks through the minimal-diff write-back, but editing the block that contains such an href changes those bytes regardless of this task. Record it, or open a separate task.
- `html-subscript-command.ts` reads html-inline markers for toolbar state and splices. Hidden link markers next to sub/sup/ins could affect it. S3 runs its tests as a gate.
- Caret placement right after a decorated span (before its hidden close marker) can leave typed text outside the link or inside it, as with the sub precedent. This is covered by S5 (2) only for the inside case.
- In `auto`, the WYSIWYG link color depends on VS Code's injected `a { color }`. D6 assumes it equals `--vscode-textLink-foreground`. S6 asserts equality with the sibling Markdown link.
- The host prerender overlay shows the source tags until the live editor decorates (D11).

## Execution progress — 2026-10-18 (Part 2)

**Owner answers (2026-10-18, chat):** Q1 A (text only at rest, reveal on caret), Q2 A (same anchors as Preview); Q3 not asked — default A (Activate Link at Caret supported). Worktree `wt/654`; steps S1 to S5 done, S6 (real VS Code) and S7 (closure gates) not started.

### S1 Probes (Chromium, `?fixture=link`, no product change)

- (a) IR html-inline tags at rest: the marker `code` is `inline-block` with width 0 (Vditor collapses it), so the tag source is already invisible in IR at rest; in WYSIWYG the `code[data-type="html-inline"]` tags are visible at rest (about 266 px for the open tag). The reader hides both with `display:none` in both modes.
- (b) Ctrl+pointerdown on an inner span: `click.target` stays inside the span in both modes. `selectionchange` fires between mousedown and mouseup in WYSIWYG (before click) and after click in IR. So D8 stands: hold the reveal back until the click is handled; no switch to open-on-pointerdown.
- (c) The `html-block` preview `<a>` (`<div><a href>`) is `underline solid 2px` by the Task 647 rule; block-level anchors are unchanged and out of scope.
- Reference colours in the harness: IR `.vditor-ir__link` is the `#4493f8` fallback. WYSIWYG `a` is the browser default blue unless VS Code's injected `a { color: var(--vscode-textLink-foreground) }` is present, so the fixture page emulates that rule; the real-VS-Code spec re-checks it for real.

### S2 to S5 (RED first)

- S2 `links/html-link.ts` (`htmlAnchorHref`, `htmlLinkHrefAt`) with `html-link.test.ts` (34 cases). RED: the module did not exist, then GREEN. It does not import `editing/` (a cycle with `editing -> links`), so it carries a small self-contained open/close tag check; the reader still validates tokens with `parseHtmlInlineToken` before pairing.
- S3 `editing/html-subscript.ts`: fourth descriptor `LINK` (element `span`, `accept` hook, `ownedSelectorOf`), open-gesture hold (`pointerdown`, `click`, `pointercancel`, `pointerup` fallback with a zero-delay settle). Also `showMarker` now drops an emptied `style` attribute so the strip restores the markup byte for byte. 16 new cases in `html-subscript.test.ts`; 10 were RED before the change.
- S4 `links/link-click-fix.ts` (click branch, caret activation, caret-gesture matcher), `code-ref-decorate.ts` skip selector, `main.css` rule. 5 and 1 new unit cases, 4 RED before the change.
- S5 `e2e/html-link.spec.ts`, 10 Chromium cases (IR and WYSIWYG): rest look and colour equal to the Markdown link, markers hidden, controls untouched; reveal, type one character, redecorate, value equals baseline plus the character; `getValue` identical decorated, revealed and redecorated (IR equals the fixture); Ctrl+click reaches the document handler with the attached span and does not edit; Preview `Md2HTML` unchanged. A temporary run with the reader disabled failed 6 of 8 non-Preview cases (the two Preview cases pass by design).
- Known and unchanged: WYSIWYG already rewrites `&amp;` to `&` on serialization (Lute, fact 4), so WYSIWYG cases compare with the same-mode undecorated baseline, not the raw fixture.

### Review fixes (2026-10-18)

- A link nested in `<sub>`, `<sup>` or `<ins>` is now decorated: `sourceMarkers` excludes only markers inside owned elements of the same descriptor. Unit cases in IR and WYSIWYG shapes, strip byte-identical.
- The href scheme check also drops Unicode whitespace (NBSP, ideographic space) inside the scheme, as Preview does.
- The link span is trusted only when owned: `ownedHtmlLinkSpan` requires the owner attribute, `.vditor-ir`/`.vditor-wysiwyg`, and no `[data-render]` ancestor; used by the click branch and the caret lookup. Authored look-alike spans in Preview and in an HTML block preview are not opened.
- Code-reference chips are skipped for text and inline code between an accepted `<a>` marker pair (revealed state); the decorated state was already skipped by the selector.

### Residual risks

- Caret placement at a span edge: typing right after a decorated link span can land outside the link (or inside it), the same as the existing sub/sup/ins presentation; only typing inside the body is tested.
- One stray or unrecognised tag in a container leaves every HTML link and sub/sup/ins in it as source (all-or-nothing pairing).
- WYSIWYG still rewrites `&amp;` to `&` in an edited block (Lute, unrelated to this task).
- Existing WYSIWYG drift, measured with the reader detached (`observe=0`) and attached: an edit in WYSIWYG makes `getValue` return `&` for an `&amp;` in an `href` on an untouched line. It is identical with and without the Task 654 decoration, so the real-VS-Code fixture keeps entities out of its untouched link line and a separate task would be needed to change the drift.

**Combined real-VS-Code runs (2026-10-18, integration build, `--workers=1 --retries=0`):**
- Round 1: IR test, `link-underline.spec.ts` 4/4 and `html-subscript-editing.spec.ts` 2/2 passed. The WYSIWYG test failed on the link colour in dark `auto` (fixed by the WYSIWYG dark rule).
- Round 2: the WYSIWYG untouched line lost `&amp;`. This is existing WYSIWYG drift, measured without 654; the fixture now avoids entities.
- Round 3: the WYSIWYG Ctrl+click locator also matched the hidden IR pane; the click is now scoped to the WYSIWYG pane.
- Round 4: `html-link-display.spec.ts` 2/2, `link-underline.spec.ts` 4/4, `local-link-open.spec.ts` 6/6 and `code-ref-open.spec.ts` passed.
- `local-link-open.spec.ts:306` failed in rounds 1 and 2 because of the test environment: the worktree symlinked `test/vscode-e2e/node_modules`, so the harness got a different `vscode` API instance. It passed in rounds 3 and 4 after that folder became a real copy.
