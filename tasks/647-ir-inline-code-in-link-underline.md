# Task 647 — Underline every link in Preview and IR, including inline code used as link text

**Status:** open.
**Origin:** Project Owner request.
**Severity:** low to medium (visual consistency across all links; no source change).
**Tech stack:** webview CSS (`media-src/src/main.css`, content themes in `media/markdown-themes/`, Vditor's `.vditor-reset` styles), IR link DOM (Vditor/Lute `data-type="a"` nodes), Preview DOM, Chromium, real VS Code.

## Problem

Links are not underlined consistently:

- **Preview:** not every link has an underline today. Which links lack one depends on the link kind and the content theme (for example, a theme that underlines links only on hover).
- **IR:** a link whose text is inline code shows the code without the link underline that Preview draws for it.

Example source:

```markdown
[`Code.cs:53-58`](../../../Module/Code.cs#L1-L5)
```

- Preview: `Code.cs:53-58` is drawn in the inline-code style, with the link underline.
- IR: `Code.cs:53-58` is drawn in the inline-code style, without the link underline.

## Requirements

1. **Every link is underlined in Preview and IR.** Every hyperlink shows an underline at rest, not only on hover, in every content theme and in high-contrast themes. This covers inline links, reference links, autolinks (`<https://…>` and bare URLs), HTML `<a href="…">`, links to headings and anchors in the same document, links to other files (including `file.ts:42` and `#L42` forms), and wiki links.
2. **Inline code inside a link is underlined.** When link text is, or contains, inline code, the underline runs under the code too, matching the rest of the link, in Preview and IR.
3. **One look.** The underline uses the same style, thickness and color source for every link kind within a theme, and the same in Preview and IR.
4. **Rendered state only in IR.** The underline applies while an IR link shows its rendered form. When the caret enters the link and IR reveals its Markdown markers, the source keeps today's look.
5. **Not links stay as they are.** Text that is not a hyperlink keeps today's look: plain inline code, emphasis, HTML targets without `href` (`<a id="…">`, `<a name="…">`), and footnote markers unless Part 1 shows they are links.
6. **No source change.** The fix is styling only: document text, caret, selection, dirty state and Undo history do not change.

## Open design points (settled in Part 1)

- An inventory of link kinds in Preview and IR, with today's measured underline (at rest and on hover) per content theme and in high contrast, and the rule that sets or removes it for each (Vditor's `.vditor-reset a`, a content theme, or `main.css`).
- The IR DOM of a link whose text is inline code (where `<code>` sits relative to `.vditor-ir__link` and the marker spans).
- Detected code references (`code.vmde-code-ref` and `.vmde-code-ref-chip`, for text such as `src/foo.ts:42` that is not written as a link) are clickable but are not Markdown links; they keep their hover underline unless the Owner decides otherwise. When such text is also link text (as in the example), the link underline wins and must not be doubled or removed on hover.
- Whether WYSIWYG and Split's preview pane show the same gaps; fix them in this task if they share the cause, otherwise record them.

## Scope

- In: link underline CSS in Preview and IR (and WYSIWYG or Split's preview pane if they share the cause), including inline code inside links.
- Out: link colors, fonts or padding; link behaviour; underlines for text that is not a link.

## Acceptance

- [ ] For a fixture with every link kind in requirement 1, each link in Preview and in IR (rendered state) has a computed `text-decoration-line` of `underline` at rest, in light, dark and high-contrast themes and in every bundled content theme.
- [ ] For the example source, the inline code inside the link is underlined in Preview and IR, with the same underline style and color as the rest of the link.
- [ ] With the caret inside an IR link (markers revealed), the source look is unchanged from today.
- [ ] Plain inline code, emphasis, HTML targets without `href`, and detected code references outside links are unchanged.
- [ ] Document text, caret, selection, dirty state and Undo history are unchanged.
- [ ] A focused Chromium check and a real-VS-Code spec are written and run; network-free gates pass at closure.

## Tests

- Chromium: a fixture with every link kind plus non-link controls; computed `text-decoration` per element in Preview and IR, per content theme and in high contrast; the example's `<code>`; the caret-inside state.
- Real VS Code (`test/vscode-e2e/`): the same fixture in IR and Preview in the real webview, measured computed style for each link kind and the example.

## Part 1 handoff (2026-10-17)

Measured in Chromium (computed styles; 4 panes x 19 theme configurations x 28 targets, rest and hover) through the real webview entry (`prerender.html` stubbed host) with the real `main.css`, Vditor's patched `index.css`, Vditor's content-theme link and each bundled content theme as a `ct-*` link. Configurations: auto light, dark, high-contrast, high-contrast-light; each named theme (`github-light`, `github-dark`, `material-dark`, `vscode-light-2026`, `vscode-dark-2026`) plain, `+hc` and `+hc-light`. Fixture: every link kind, links in a heading, table cell, quote and list item, code references (also as link text), non-link controls. Private scripts and raw results are under the untracked `tmp/647/` (`fixture.md`, `measure.mjs`, `caret.mjs`, `results-baseline.json`, `results-fix.json`). The cause is CSS only (no DOM or Lute change needed).

### Link-kind inventory (today, before the fix)

"U" = computed `text-decoration-line: underline`, "-" = none. High-contrast and high-contrast-light give the same result as their base theme (no rule depends on them). Hover never changes a link's line in any pane or theme (a theme comment claiming Vditor underlines on hover is wrong: `github-markdown-light.css:24`).

Theme group A = `auto` (all kinds) and `material-dark` (declares no `text-decoration`, so the browser's default link underline applies). Group B = `github-light`, `github-dark`, `vscode-light-2026`, `vscode-dark-2026` (declare `text-decoration: none`).

| Kind | Preview and Split preview pane | WYSIWYG | IR rendered | Is it a link? |
|---|---|---|---|---|
| Inline `[t](u)`, anchor `#id`, file `src/f.ts:42` and `#L42`, heading/table/quote/list links | `<a href>`: A U, B - | `<a href>`: A U, B - | `span[data-type=a] > span.vditor-ir__link`: - in every theme | yes |
| Reference `[t][r]`, collapsed, shortcut | `<a href>`: A U, B - | `span[data-type=link-ref]`: - everywhere | `span[data-type=link-ref]`: - everywhere | yes |
| Autolink `<https://...>` | `<a>`: A U, B - | `<a>`: A U, B - | rendered as `a` node (`[url](url)` markers): - | yes |
| Bare URL `https://...` | plain text | plain text | plain text | no (Lute does not link it in any pane; out of scope, no source change allowed) |
| HTML `<a href="...">` | `<a href>`: A U, B - | `code[data-type=html-inline]` source markers and plain text: - | `span[data-type=html-inline]` source markers and plain text: - | yes in Preview/Split; in WYSIWYG/IR it is shown as raw HTML source, there is no link element to style (Owner question 2) |
| HTML `<a id>` / `<a name>` | `<a>` without `href`: - | source markers: - | source markers: - | no |
| Wiki `[[page]]` | `span.wiki-link-chip`: U (both groups) | U | U | yes (already correct) |
| Footnote ref | `sup.footnotes-ref > a[href]`: A U, B - | `sup[data-type=footnotes-ref]`: - | `sup[data-type=footnotes-ref]`: its visible `1` is a hidden-marker span, none | marker, not counted (Owner question 1); in Preview it is a real `<a>` |
| Footnote back-reference | `a.vditor-footnotes__goto-ref`: - everywhere | - | - | marker, not counted |
| Code reference `code.vmde-code-ref` / `.vmde-code-ref-chip` (not link text) | rest -, hover U (offset 2px) | same | same | no |
| Inline code, emphasis | - | - | - | no |

The IR link text is a `span.vditor-ir__link`, never an `<a>`; Preview, Split and WYSIWYG use real `<a href>`.

Computed look of the lines that do exist today: `<a>` (group A) = `underline solid`, thickness `auto`, offset `auto`, color = the link's color; wiki chip and code-ref hover = `underline solid`, thickness `auto`, offset `2px`.

Harness caveats (not verified in real VS Code): VS Code's injected default sheet (`a { color }`, `a:hover { color }`, focus outline) is not present, so link colors for `auto` read the browser default (`rgb(0, 0, 238)`); `material-dark`'s link color reads Vditor's dark-theme blue because the harness swap of the content-theme link re-loads it after the `ct-*` links (underline is unaffected; link color is out of scope). Also not measured: Windows forced-colors emulation (underline line property is not a color, so it is expected unchanged) and `a:visited`.

### IR DOM (obligation 2)

Example `[`Code.cs:53-58`](../x.cs#L1-L5)`, rendered state (caret elsewhere), same in all themes:

```
span[data-type=a].vditor-ir__node
  span.vditor-ir__marker.vditor-ir__marker--bracket   "["     (inline-block, width 0, height 0: collapsed)
  span[data-type=code].vditor-ir__node
    span.vditor-ir__marker "`"                                  (collapsed)
    code[data-newline=1] "Code.cs:53-58"
    span.vditor-ir__marker "`"                                  (collapsed)
  span.vditor-ir__marker.vditor-ir__marker--bracket   "]"
  span.vditor-ir__marker.vditor-ir__marker--paren     "("
  span.vditor-ir__marker.vditor-ir__marker--link      "../x.cs#L1-L5"
  span.vditor-ir__marker.vditor-ir__marker--paren     ")"
```

For plain link text the text sits in `span.vditor-ir__link` instead; for mixed text (`[a `x` b](u)`) the `code` node is a sibling between two `.vditor-ir__link` spans, and for `[**b**](u)` the `.vditor-ir__link` span is inside `<strong>`. So `<code>` is never inside `.vditor-ir__link`, which is why the underline cannot go on `.vditor-ir__link`: the code would not be covered. The outer `span[data-type=a]` is the only common ancestor. Caret inside or next to the link: the same node gains `vditor-ir__node--expand` (measured with keyboard navigation and a programmatic caret in the link text, for `a` and `link-ref` nodes in four configurations: the `a` node, not the inner `code`/`strong` node, is the one that carries the class); markers become visible (bracket markers have Vditor's own `underline` and color `rgb(0, 0, 255)`, `.vditor-ir__link` stays `none`).

Preview/Split: `<p><a href="..."><code>Code.cs:53-58</code></a></p>`. WYSIWYG: `<a href="...">` + zero-width space + `<code data-marker="`">`.

CSS fact the fix relies on: a text decoration set on an ancestor is painted across all in-flow inline descendants and a descendant's `text-decoration: none` cannot remove it. So an underline on the outer node covers `.vditor-ir__link`, `code` and `strong`, and `.vditor-ir__link`'s own `none` needs no change. Its color is the decorating element's, so the IR rule must set the color explicitly (below); in Preview the `<a>` carries the link color and the nested `code` keeps its own text color while the line keeps the link color (measured, screenshot compared).

### Rules that set or remove a link underline (obligation 3)

| Rule | Where | Effect |
|---|---|---|
| Browser default `a:-webkit-any-link { text-decoration: underline }` | user agent | the only source of today's underline for `<a>` in group A |
| `.markdown-body a { ...; text-decoration: none; }` | `media/markdown-themes/github-markdown-light.css:25`, `github-markdown-dark.css:24`, `vscode-light-2026.css:27`, `vscode-dark-2026.css:27` | removes the default underline (specificity 0,1,1) |
| `.markdown-body a { color }` only | `media/markdown-themes/material-dark.css:19` | no decoration, default underline stays |
| `.vditor-ir__link { color: var(--vmde-link, ...); text-decoration: none; }` | generated `media/vditor/dist/index.css`, rewritten from Vditor's `underline` by `build.mjs:457-458` (task 464) | IR link text never underlined |
| `.vditor-ir__node--expand .vditor-ir__marker--bracket { text-decoration: underline }` | Vditor `_ir.less:77-80` | revealed bracket markers underlined (source look; keep) |
| `.vditor-footnotes__goto-ref { text-decoration: none }` | Vditor `_reset.less:550-552` | back-reference never underlined |
| `.vditor-linkcard a { text-decoration: none }` (and `:hover`) | Vditor `_reset.less:477-489` | link-card anchors |
| `span[data-type=toc-h]` underline | Vditor `_ir.less:256`, `_wysiwyg.less:166` | table-of-contents entries (not a link kind here) |
| `.wiki-link-chip { underline; solid; offset 2px }`, `:hover` solid, `[data-wiki-missing] dotted`, hover dashed | `media-src/src/main.css:1334-1337, 1344, 1363, 1367` | wiki chips (correct today) |
| `.vmde-code-ref-chip { text-decoration: none }`; `:hover, :focus-visible { underline solid; offset 2px }` | `main.css:1388-1396` | prose code reference, hover only |
| `code.vmde-code-ref:hover, :focus-visible { underline solid; offset 2px }` | `main.css:1412-1415` | inline-code reference, hover only; inside a link it adds a second, offset line on top of the link's (measured: hover decider is `code.vmde-code-ref`, offset 2px) |
| `.vmde-d2-md a { color: inherit; text-decoration: underline }` | `main.css:1010-1013` | diagram label links (already underlined) |
| `.vmde-find-replace [data-action='word'] span { underline }` | `main.css:2313` | find-bar glyph, not a link |

No rule in the repo ever sets an underline on `.vditor-ir__link` or the IR `a` node.

### The fix (obligation 4)

Styling only, `media-src/src/main.css`, one new block placed directly above the wiki-link chip block (before `main.css:1331`, so wiki chip and code-reference rules stay adjacent and later in source order). It needs no `!important`, no change under `media/markdown-themes/`, `build.mjs`, Vditor or Lute. Comment it per `.agents/rules/css.md` (what: every link underlined at rest; why: themes set `none` and Vditor/`build.mjs` strip the IR underline; how: decoration on the outer node so nested `code` is covered). Proposed declarations, validated by injection in the harness (below):

```css
/* Preview, Split preview, WYSIWYG and IR reference links: a real <a href> (or the link-ref span) in the
   reading surface gets the one link underline. Group-B content themes set `.markdown-body a {text-decoration:
   none}` (0,1,1); this selector (0,3,2) wins without !important. Excluded: footnote markers (not links for this
   task, they keep today's look), Vditor link cards, and the IR revealed state (source look). Decoration color
   is the element's own link color. */
.vditor-reset
  :is(a[href], span[data-type='link-ref']):not(
    .footnotes-ref a,
    .vditor-footnotes__goto-ref,
    .vditor-linkcard a,
    .vditor-ir__node--expand
  ) {
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-color: currentcolor;
  text-underline-offset: 2px;
}

/* IR rendered link: the link text is a span.vditor-ir__link and inline code is a SIBLING node, not inside
   it, so the underline goes on the outer node (the only common ancestor; a descendant's `none` cannot cancel an
   ancestor decoration). The outer node is not link-colored, so the color mirrors the build-patched
   `.vditor-ir__link` color. Not applied while expanded: the revealed Markdown keeps Vditor's source look. */
.vditor-ir .vditor-reset span[data-type='a']:not(.vditor-ir__node--expand) {
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-color: var(--vmde-link, var(--vscode-textLink-foreground, #4493f8));
  text-underline-offset: 2px;
}

/* A code reference that is also link text: the link's line already runs under it, so drop the code reference's
   own hover/focus underline (it uses offset 2px and would draw a second line). Outside links it is unchanged. */
.vditor-reset
  :is(a[href], span[data-type='a']:not(.vditor-ir__node--expand))
  :is(code.vmde-code-ref, .vmde-code-ref-chip):is(:hover, :focus-visible) {
  text-decoration-line: none;
}
```

Decisions inside it: one look = `underline solid`, thickness `auto`, offset `2px`, i.e. the wiki chip's existing look (no wiki change; the `<a>` offset goes from `auto` to `2px`, also under inline code where it keeps a clear gap). Color source: the link's own color for `<a>` and `link-ref`; the IR `a` node uses the same `--vmde-link` expression as `.vditor-ir__link`, so IR and Preview match in every theme. Link colors themselves are unchanged (note: WYSIWYG/IR reference-link spans keep Vditor's hard-coded `#4285f4`, wiki chips keep `--vscode-textLink-foreground`; both are color questions, out of scope).

Cascade/specificity: theme `.markdown-body a` (0,1,1) and the browser default lose to the first selector (0,3,2); `:is` and `:not` take their most specific argument. Order does not matter (theme `ct-*` links load after `main.css`). The IR node rule (0,4,1) has no competitor (nothing sets a decoration on that node). Nothing under an ancestor decoration can cancel it, so `.vditor-ir__link {none}` stays as is. Because there is no `:hover` variant, hover keeps the same line. Expanded IR link: `:not(.vditor-ir__node--expand)` (and the `link-ref` exclusion in the first rule, which an earlier draft missed and which the caret check caught) leaves the revealed look byte-identical.

Validation done now (CSS injected after `main.css` in the harness, no file edit): rest and hover underline = `underline solid auto 2px` for all 18 link targets in all four panes and all 19 configurations (IR, WYSIWYG, Preview, Split preview), including `Code.cs:53-58`, mixed text with code, bold, reference kinds, autolink, anchor, file forms, heading/table/quote/list links, code reference inside a link (hover decider is the link, no second line). Controls unchanged: inline code, emphasis, `<a id>`, `<a name>`, bare URL, code reference outside a link keep rest `none` and hover `underline` (2px). Footnote refs unchanged. IR revealed state: 56 comparisons (7 link shapes, adjacent and inside the link, 4 configurations incl. high-contrast) identical to baseline, element by element. Screenshots at 3x: IR and Preview of the example match (blue line under the code, same offset); mixed text matches.

Known limits of the fix: IR and WYSIWYG show raw `<a href>` as source markers (no link element), so only the Owner can decide whether to change that (question 2); WYSIWYG caret inside a link has no marker reveal, so the underline stays (requirement 4 is IR only).

### Part 2 steps (queue 7.5.2)

Test layer per acceptance item; every test is written first and shown failing.

- **S1 CSS fix + Chromium check.** Files: `media-src/src/main.css`, new `media-src/e2e/link-underline.spec.ts` (reuses the `prerender.html` stubbed-host pattern from `high-contrast.spec.ts` and the `ct-*` link switch used here; no new harness entry). Chromium test cases:
  1. (acceptance 1, 3) every link kind in IR rendered, WYSIWYG, Preview and Split preview, per theme (auto light/dark/high-contrast, five named themes, one high-contrast entry per named theme group): `underline solid auto 2px` at rest and on hover; color equals the element's link color source.
  2. (acceptance 2) the example: `code` inside the link is underlined, in IR and Preview, same decoration color as the link text.
  3. (acceptance 3 of the checklist) IR caret next to and inside the link: bracket markers keep `underline`/`rgb(0, 0, 255)`, `.vditor-ir__link` and the node have no underline (values recorded from today).
  4. (acceptance 4) controls (inline code, emphasis, `<a id>`, `<a name>`, bare URL, code reference outside a link, footnote ref) unchanged at rest and hover; code reference inside a link has no second line on hover.
  5. (acceptance 5) `getValue()` before and after theme switch and hover is identical and no edit message is posted (CSS-only; one assertion inside case 1).
  Focus states to check (visible ones): (a) `.vmde-caret-inside` outline on a rendered IR link together with the underline (underline not removed); (b) code reference inside a link with `:focus-visible` (outline kept, no second line); (c) wiki chip with the caret inside (expanded `[[ ]]`, underline kept); (d) Preview `a:focus-visible` only in real VS Code (VS Code's default focus outline is not in the harness). Tolerances: `text-decoration-line`, `-style`, `-thickness` and `text-underline-offset` exact strings; color equal to the computed link color string exactly (no pixel tolerance); no screenshot comparison (computed styles only).
  Gates for S1: the new spec; `content-theme.spec.ts`, `high-contrast.spec.ts`, `wiki.spec.ts` and `codenav.spec.ts` (they exercise `main.css`/code-reference or wiki chip rules); lint of changed files; typecheck.
- **S2 real-VS-Code spec** (holds the machine-wide real-VS-Code token; `node build.mjs` first; `xvfb-run -a`, `--workers=1 --retries=0`). File: new `test/vscode-e2e/link-underline.spec.ts`, at most 3 tests: (1) IR rendered fixture: every link kind and the example's `code` underlined with the link color, controls unchanged; (2) IR caret revealed: markers visible, source look unchanged; (3) Preview with a group-B named theme (`github-light`) and with `auto`: all kinds underlined, hover unchanged, code reference inside a link without a second line. Real-webview facts to confirm there (unverified in Part 1): VS Code's injected `a`, `a:hover` and focus rules, `a:visited`, `--vmde-link` resolution in `auto`.
- **S3 closure.** Files: `tasks/647-ir-inline-code-in-link-underline.md` (check the acceptance boxes with real results), `tasks/README.md` only when fully complete, `CHANGELOG.md` entry if the release process requires it; no queue-table edit by the step worker. Gates: `npm run quality`, plus the focused specs above run once; record pre-existing failures separately.

### Owner questions (the task does not settle these)

1. Footnote markers. In Preview and Split the footnote reference is a real `<a href="#footnotes-def-N">` (underlined today in `auto`/`material-dark` only) and the back-reference arrow is not underlined anywhere; in WYSIWYG and IR it is a superscript, not a link.
   - A (recommended): not links for this task; excluded from the rule, keep today's per-theme look. Smallest change; requirement 5 default.
   - B: underline the Preview/Split footnote reference only (never the arrow). Consistent with "every `<a>`", but a superscript digit with an underline and no matching WYSIWYG/IR look.
   - C: force no underline on footnote markers in every theme (changes today's `auto` look).
2. Raw HTML `<a href="...">` in IR and WYSIWYG is displayed as source markers with plain text between, so there is no link element to underline (Preview and Split do get it).
   - A (recommended): leave as is and record it; it is raw HTML shown as source, not a rendered link.
   - B: a separate follow-up task to render such anchors as links in IR/WYSIWYG (a DOM and round-trip change, outside this CSS-only task).
3. Bare URLs (`https://...` without brackets) are not links in any pane (Lute does not link them), so nothing is underlined.
   - A (recommended): leave; making them links is a parsing/source change.
   - B: a separate task to enable GFM autolinks.
4. One underline offset. The fix gives every link `text-underline-offset: 2px` (the wiki chip's existing value) in place of the browser default `auto` on `<a>`.
   - A (recommended): 2px everywhere (clear gap under inline code).
   - B: `auto` everywhere, which also changes the wiki chip and code-reference hover lines.

Open design point answers: code references keep their hover underline outside links; inside links only the link's line shows (above); WYSIWYG and Split's preview pane share the Preview cause (same `<a>` and theme rules) and are fixed by the same rule; WYSIWYG reference links are `span[data-type=link-ref]` (covered by the first selector).
