# Task 655 — Autolink bare URLs

**Status:** open.
**Origin:** Project Owner request (follow-up of Task 647).
**Severity:** low (feature).
**Tech stack:** webview and Lute options (Preview, IR, WYSIWYG and Split preview).
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

Bare URLs (`https://example.com` without `<>`) are plain text in every pane.

## Requirements

1. Decide in Part 1 whether to enable GFM autolink literals (a Lute option) for Preview, IR, WYSIWYG and Split preview.
2. If enabled, bare URLs render as links in the panes covered by the decision.
3. The saved Markdown stays byte-identical. Autolinking must not rewrite the source text.

## Open design points

- Whether to enable GFM autolink literals, and for which panes.
- How the decision affects Markdown that already uses `<>` or `[text](url)` links.

## Scope

- In: the autolink decision and, if enabled, its display in the panes it covers.
- Out: other Lute options and link syntax changes.

## Acceptance

- [x] Part 1 records the decision for each pane. (Handoff "Decisions" plus the Owner answers line; IR, WYSIWYG, Preview and Split preview on, SV off.)
- [ ] If enabled, a bare `https://example.com` renders as a link in each covered pane.
- [ ] Saved Markdown is byte-identical after editing and saving.

## Tests

- To be specified in Part 1 (webview and Lute behaviour; real-VS-Code verification is required for behaviour that depends on the VS Code integration).

## Part 1 handoff (2026-10-18)

Read-only design pass; Node probes of the vendored Lute ran outside the repository.

### Verified facts

1. **Lute has the option, and Vditor already turns it on.** The setter is `SetGFMAutoLink(bool)` (`media-src/vendor/lute/lute.min.js`, offset about 3591481: `b.ParseOptions.GFMAutoLink=a`). Vditor's default is `gfmAutoLink: true` (`media-src/node_modules/vditor/src/ts/constants.ts:55`). It is passed to the editor Lute (`vditor/src/index.ts:526-529` → `ts/markdown/setLute.ts:20`) and to the static `md2html` (`ts/markdown/previewRender.ts:62-65`). VMDE never overrides it: `media-src/src/boot/vditor-options.ts:44-50` sets only `callout`, `toc`, `mark`, `sup` and `sub`, and nothing in `src/`, `media-src/src/` or `media-src/esbuild-shared.mjs` mentions `gfmAutoLink`.
2. **Lute turns autolinks off in every Vditor mode.** The inline parse guard is at blob offset about 2031989: `n = VditorWYSIWYG || VditorIR || VditorSV || ProtyleWYSIWYG; o = ProtyleWYSIWYG && ProtyleWYSIWYGAutoLink; if ((GFMAutoLink && !n) || o) { parseGFMAutoEmailLink; parseGFMAutoLink }`. When any Vditor mode flag is set, `GFMAutoLink` does nothing. The only way past the guard is the Protyle (SiYuan) flag pair, which belongs to a different editor model and cannot be used here.
3. **Probe results (p1, p2).** For `Visit https://example.com today.`, a fresh Lute with no mode flags renders `<a href="https://example.com">` from `Md2HTML`. The same text renders as plain text from `Md2VditorIRDOM`, `Md2VditorDOM`, and from `Md2HTML` on any Lute with `SetVditorIR`, `SetVditorWYSIWYG` or `SetVditorSV(true)`.
4. **Why Preview and Split preview show plain text.** They reuse the editor Lute (`vditor.lute.Md2HTML`), which is patched in `media-src/esbuild-shared.mjs` (`patchPreviewInstanceSoftBreak`, helper `vmdePreviewMd2HTML`). That Lute always has one Vditor mode flag set, so the Task 647 inventory row "Bare URL: plain text in every pane" (`tasks/done/647-ir-inline-code-in-link-underline.md:74`) is Lute behaviour, not a VMDE option. The host prerender (`src/lute/lute-host.ts:216-226`) calls `Md2VditorIRDOM` and does not autolink either.
5. **Lute's own autolinking is wrong in several cases (p3, p5).** Run with no mode flags, it gives:
   - no link for `See https://example.com,` / `(https://example.com)` / `https://example.com?` / `https://example.com!`. The GFM spec links these and leaves the punctuation outside.
   - `http://a` → `h<a href="ttp://a">ttp://a</a>`, a broken link.
   - inside a footnote definition: `h<a href="ttps://d.com">…<a …goto-ref>↩</a></a>`, nested and broken anchors.
   - `x@y` and the large fixture's `Atfw.@lytkk` (`test/vscode-e2e/fixtures/large-observable-models-synthetic.md`, 2 table cells) become `mailto:` links. GFM requires a dot in the domain.
   - `https://j.com/~user/%20x` shows as `/ x`: `%20` is decoded in the visible text.
   - `file:///tmp/x` and `vscode://file/x` are linked.
   - It does handle code spans, existing links, `<…>` autolinks, `www.`, `Foo_(bar)` parentheses and `.` / `_` at the end correctly.
6. **A class-only wrapper span is invisible to Lute's serializers (p4).** The probe rendered a 22-block corpus (`corpus.md`: headings, quotes, nested lists, a table, emphasis, strikethrough, inline and fenced code, math, a footnote, task items, entities, inline HTML, escapes, hard and soft breaks) to IR and to WYSIWYG DOM with the real Lute. It then wrapped each bare URL text in `<span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="…">`, using jsdom and the same pruning walk as `code-ref-decorate.ts:120-145`.
   - In 19 blocks the probe wrapped 29 URLs per mode. `VditorIRDOM2Md`, `VditorDOM2Md`, `SpinVditorIRDOM` and `SpinVditorDOM` gave byte-identical output with and without the spans: 0 differences of each kind.
   - The probe found no bare URLs to wrap in `README.md`, `DEVELOPMENT.md`, `CHANGELOG.md` or the large fixture (their URLs are all in link syntax), so those files exercised nothing. The 174 KB large fixture has no `http`/`www.` text at all.
   - This matches the Task 229 precedent: `media-src/src/links/code-ref-decorate.ts:1-21` documents that a bare class-only span is transparent to Lute and must not use `data-render`.
7. **A real `<a href>` would change the saved text (p5).** `VditorDOM2Md` and `VditorIRDOM2Md` turn `<a href="https://example.com">https://example.com</a>` into `[https://example.com](https://example.com)`. IR and WYSIWYG must never get a real anchor. The read-only Preview DOM is never serialized: `Preview.render` serializes the edit DOM, per `media-src/esbuild-shared.mjs` (`PREVIEW_INSTANCE_MARKDOWN_ANCHOR`, `getMarkdown(vditor)`).
8. **There is an existing decorator to copy.** `observeCodeRefs` is wired to both `#app` and the Preview element, `innerVditor()?.preview?.previewElement`, which also serves Split preview (`media-src/src/boot/finish-init.ts:456,496-503`).
   - It skips the block that holds the caret (`code-ref-decorate.ts:213-235`), works on one block at a time through `scopeMutations`, and re-walks on `selectionchange`.
   - Its skip selector is at `code-ref-decorate.ts:84-85`.
   - Its own spans are excluded from mutation scoping by `OWN_DECORATION_CLASSES` (`media-src/src/util/mutation-impact.ts:20-29`).
   - Clicking a chip follows the same modifier rule as a real link (`media-src/src/links/link-click-fix.ts:147-161`): Ctrl/Cmd+click in editable panes, plain click in Preview.
   - Real `a[href]` in Preview goes through the generic branch (`link-click-fix.ts:198-211`, `openLink`).
   - Activate Link at Caret matches `LINK_LIKE_SELECTOR` (`media-src/src/links/caret-link.ts:28-29`).
9. **Link underline CSS from Task 647.** It covers `:is(a[href], span[data-type='link-ref'])` and the IR `span[data-type='a']` (`media-src/src/main.css:1339,1373`). A new span class needs its own rule.
10. **Task 390 comments.** These say "GFM autolinks a bare `https://x`" (`src/markdown/minimal-diff-writeback.ts:337-345`, `src/writeback/writeback-controller.ts:372-376`, `src/shared/protocol.ts:463-468`, `media-src/src/bridge/edit-sync.ts:936-942`). They describe the host's semantic reserialize-equality check. This decision changes no Lute option or serializer input, so it leaves them unaffected.
11. **Timing (p5, Node, not the webview).** `Md2HTML` on the large fixture took 220 ms with the IR flag and 281 ms without it. Only the two false `mailto:` cells differed, and the output was identical once those links were removed. These are not webview figures.
12. **Module registration.** New webview modules must be registered in the `links` cluster of `scripts/module-manifest.mjs`, which lists `code-ref-decorate` at line 384.

### Decisions

- **Leave Lute's options alone.** Keep `gfmAutoLink` as it is. Do not toggle the Vditor mode flags around the Preview `Md2HTML`, and do not register a Lute JS renderer. Reasons:
  - Fact 2: the option has no effect in IR and WYSIWYG.
  - Fact 5: Lute's native output in Preview is wrong in several cases and would differ from IR and WYSIWYG.
  - `custom-renderer.ts:49-53`: registering renderers previously broke WYSIWYG and SV.
- **Add a VMDE DOM decorator** for bare URLs, built like the code-ref decorator, in four panes: IR, WYSIWYG, Preview and Split preview. SV source mode is out of scope; it shows source text.
- **IR and WYSIWYG get a class-only span.** No `data-render`, no `contenteditable`, no `tabindex`:
  `<span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="<href>">url text</span>`
  The text inside the span is the source text, so serialization does not change (Fact 6).
- **Preview and Split preview get a real `<a class="vmde-bare-url" href="<href>">`.** That DOM is never serialized (Fact 7), and real anchors get the existing Preview link handling and underline CSS without new code.
- **Matcher: a pure TS function implementing the GFM spec's extended autolinks, not Lute's version.**
  - It recognises `www.`, `http://`, `https://` and email addresses.
  - It does not link `ftp://`, `file:`, `vscode:`, `mailto:` written out, or domains without a dot such as `localhost`.
  - The `href` is `http://` + text for `www.`, `mailto:` + text for email, and the text itself otherwise.
  - Boundaries follow the GFM rules (details under Contracts). Text-node start counts as a boundary.
  - **This matcher is the product definition.** It deliberately differs from Lute in the cases listed in Fact 5.
- **Where it does not apply.** Skip code, `pre:not(.vditor-reset)`, links, link references, inline and block HTML, math, IR markers and previews, wiki chips, code-ref chips, footnote markers, link-reference-definition blocks, `svg`, `[data-render]`, and anything Task 654 adds for raw `<a href>`. A URL that overlaps a code-ref match is linked as a URL; code-ref drops overlapping matches.
- **Caret block.** As in code-ref, a URL is not decorated while the caret is in its block. It is decorated when the caret leaves, and Vditor's next rebuild of that block removes it.
- **No setting.** Feature on by default. This is Owner question 2.
- **Saved Markdown.** Byte-identical by construction: no change to Lute options or serializer inputs, and transparency verified by probe (Fact 6). Proven in Part 2 by the Vitest suite and the real-VS-Code spec.
- **Tasks 604, 606 and 607 (exact-source authority and normalizing-document detection).** I did not open these records. They should be unaffected, because the host Lute (`lute-host.ts`) and every serializer input stay byte-identical. The real-VS-Code save check confirms this.

### State, DOM and contracts (names settled)

- New file `media-src/src/links/bare-url-match.ts`. Pure, no DOM:
  - `export interface BareUrlMatch { index: number; source: string; href: string; kind: 'url' | 'www' | 'email' }`
  - `export function findBareUrls(text: string): BareUrlMatch[]`, left to right, non-overlapping.
  - Rules:
    - Start: start of text, whitespace, or one of `* _ ~ (`.
    - Valid domain: segments of letters, digits, `_` and `-` separated by `.`; at least one `.`; no `_` in the last two segments.
    - The URL runs until whitespace or `<`. Then trim from the end: `? ! . , : * _ ~`, a `)` without a matching `(`, and an `&name;` entity.
    - Email: local part `[A-Za-z0-9.+_-]+`, then `@`, then a domain of `[A-Za-z0-9._-]` with at least one `.`. The last character is not `-` or `_`; a final `.` is trimmed.
    - Fast path: return `[]` unless the text contains `://`, `www.` or `@`.
- New file `media-src/src/links/bare-url-decorate.ts`:
  - Exports `applyBareUrls(root)`, `applyBareUrlsWithin(block)` and `observeBareUrls(root): () => void`.
  - Built like `code-ref-decorate.ts`: pruning TreeWalker, right-to-left `splitText`, caret-block skip, `coalescePerFrameWithRecords`, `scopeMutations`, re-walk on `selectionchange`.
  - Element shape: a `span` inside `[contenteditable]` (IR and WYSIWYG roots) and an `a[href]` otherwise (the Preview element). Detect with `root.closest('[contenteditable="true"]')` or by checking for the Preview element.
  - Idempotent: an existing `[data-bare-url]` or `a.vmde-bare-url` is never wrapped again.
  - `SKIP_SELECTOR = 'pre:not(.vditor-reset), code, svg, a[href], [data-render], .vditor-ir__marker, .vditor-ir__preview, [data-type="a"], [data-type="link-ref"], [data-type="link-ref-defs-block"], [data-type="html-inline"], [data-type="html-block"], [data-type="html-entity"], [data-type="math-inline"], [data-type="math-block"], [data-type="footnotes-ref"], [data-type="heading-id"], [data-wiki-link], [data-code-ref], [data-bare-url], .vmde-comment'`. Add whatever selector Task 654 introduces for raw anchors.
- `media-src/src/boot/finish-init.ts`:
  - Add `observers.set('bare-urls', observeBareUrls(app))` and `observers.set('preview-bare-urls', observeBareUrls(previewEl))`.
  - Register them before the code-ref observers.
- `media-src/src/util/mutation-impact.ts`: add `'vmde-bare-url'` to `OWN_DECORATION_CLASSES`.
- `media-src/src/links/code-ref-decorate.ts`:
  - Add `[data-bare-url]` and `a.vmde-bare-url` to `SKIP_SELECTOR`. The second is already covered by `a[href]`.
  - In `decorateTextNode`, drop code-ref matches that overlap a `findBareUrls` range.
- `media-src/src/links/link-click-fix.ts`: add a `[data-bare-url="1"]` branch before the wiki branch. If the element is in editable content, require `shouldOpenLink(e)`. Then `preventDefault` and `stopPropagation`, and call `openLink(el.dataset.bareUrlHref)`. Preview anchors use the existing `a[href]` branch.
- `media-src/src/links/caret-link.ts`: add `[data-bare-url="1"]` to `LINK_LIKE_SELECTOR`, and resolve its href from `data-bare-url-href` in the existing activation path. It rarely matches, because of the caret-block skip; this keeps behaviour consistent.
- `media-src/src/main.css`: give `.vmde-bare-url` the link color and the Task 647 underline (`underline solid auto 2px`) in both groups and in high contrast. Copy the `.vmde-code-ref-chip` placement near `:1435` and the 647 rule at `:1339`. In Preview the `a[href]` rule already covers it.
- `scripts/module-manifest.mjs`: add `'bare-url-match'` and `'bare-url-decorate'` to the `links` cluster.
- Messages: none new. Uses the existing `{ command: 'open-link'; href }` (`src/shared/protocol.ts:517`).

### Part 2 steps

- **S1, RED probes and tests**. Owned files: `media-src/src/links/bare-url-match.test.ts` and `media-src/src/links/bare-url-decorate.test.ts`, plus empty stubs for the two modules if typecheck needs them.
  - `bare-url-match.test.ts`: a table of the GFM spec's extended-autolink examples plus every case in Fact 5, with expected `index`, `source` and `href`.
  - `bare-url-decorate.test.ts`, under `// @vitest-environment jsdom`:
    - (a) element shape, editable vs Preview root;
    - (b) every `SKIP_SELECTOR` context;
    - (c) idempotence;
    - (d) caret-block skip;
    - (e) parity with `media-src/src/testing/real-lute.ts`: for the p4 corpus in both IR and WYSIWYG, `serialize(decorated) === serialize(plain)` and `Spin*DOM(decorated) === Spin*DOM(plain)`.
  - S1 must also confirm by inspection, without editing, that the Task 578 DOM-to-source index and `serializeForHost`'s incremental IR fast path (`media-src/src/bridge/edit-sync.ts`) treat a class-only inline span like the existing code-ref chip. Record the file:line where they do.
  - Checks: `npx vitest run media-src/src/links/bare-url-match.test.ts media-src/src/links/bare-url-decorate.test.ts`. Must be RED for missing behaviour, not for syntax errors.
- **S2, GREEN**. Owned files: `bare-url-match.ts`, `bare-url-decorate.ts`, `finish-init.ts`, `mutation-impact.ts`, `code-ref-decorate.ts` (+ its test, one overlap case), `link-click-fix.ts` (+ one unit case in `link-click-fix.test.ts`), `caret-link.ts`, `main.css`, `scripts/module-manifest.mjs`.
  - Checks: the S1 tests, `code-ref-decorate.test.ts`, `link-click-fix.test.ts`, `caret-link.test.ts`, `test/backend/module-boundaries.test.ts`, typecheck, and lint of the changed files.
  - Then `node build.mjs`.
- **Independent review**. Covers source fidelity: the transparency argument, the skip selector against Task 654's final DOM, and any URL that would be visible to the serializer through a stray real anchor.
- **S3, real-VS-Code spec**. Owned file: `test/vscode-e2e/bare-url-autolink.spec.ts`, plus fixture `test/vscode-e2e/fixtures/bare-url-autolink.md` containing the p4 corpus lines.
  - Run: `node build.mjs`, then `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode -- bare-url-autolink` (the spec-filter form follows DEVELOPMENT.md).
- **Closure**. Run `npm run quality` once for the closure batch, and update the task record, the §1 table and §7.22.

### Tests mapped to acceptance

| Acceptance item / edge case | Layer | Test |
|---|---|---|
| A1: decision recorded for each pane | record | This handoff: IR, WYSIWYG, Preview and Split preview on; SV off. |
| A2: bare `https://example.com` renders as a link in each covered pane | real VS Code | Spec `test('bare URLs are links in IR, WYSIWYG, Preview and Split preview')`. Open the fixture in IR, move the caret out of the URL paragraph, then assert in each pane: `span.vmde-bare-url[data-bare-url-href="https://example.com"]` with computed `text-decoration-line: underline`, or `a.vmde-bare-url[href]` in Preview and Split preview. Also assert that `[t](u)`, `<https://…>`, inline code and a fenced block contain no `.vmde-bare-url`. Ctrl+click in IR and a plain click in Preview each post exactly one `open-link` with the right `href`, captured by wrapping the webview API `postMessage` (pattern from `block-handle.spec.ts:623-632`) and not forwarded. |
| A3: saved Markdown byte-identical after editing and saving | real VS Code + Vitest | Spec `test('editing and saving keeps bare URL bytes identical')`. In IR and in WYSIWYG, type one character in a paragraph without a URL and one inside a URL paragraph, move the caret away (the URL is decorated again), and save. The file on disk must equal the original plus exactly the two typed characters. Vitest parity (S1 e) covers the serializers and the spin. |
| Trailing punctuation, parentheses, `www.`, email, no-dot domain, `<`, entity, CJK boundary | Vitest | `bare-url-match.test.ts` table |
| URLs in code, in existing links, in HTML and in math are not decorated | Vitest (+ A2 spec negative asserts) | `bare-url-decorate.test.ts` (b) |
| Code-ref overlap | Vitest | `code-ref-decorate.test.ts`, one new case |
| Performance on the large fixture | not a test | Fixture has no bare URLs; the fast path does all the work. S3 records the time `applyBareUrls(app)` takes on the large fixture through `evaluateInVSCode` (expected about the same as the code-ref walk). |

### Owner questions

1. **Panes and approach.**
   - **A (recommended):** a VMDE decorator with a GFM-spec matcher in IR, WYSIWYG, Preview and Split preview. The same URLs are linked in every pane and Lute is not touched.
   - **B:** Preview and Split preview only, using Lute's native autolinking by clearing the Vditor mode flags around the preview `Md2HTML`. IR and WYSIWYG stay plain. Lute's errors from Fact 5 would show in Preview: broken `h`+`ttp://a` links, nested anchors in footnotes, false `mailto:` links on `x@y`.
   - **C:** do not enable.
2. **Setting.**
   - **A (recommended):** always on, no setting.
   - **B:** a new `vmde.markdown.autolinkBareUrls` boolean, default `true`.
3. **Domains without a dot** (`http://localhost:3000`).
   - **A (recommended):** follow the GFM spec and leave them unlinked. This also matches Lute.
   - **B:** also link `http(s)://` URLs whose host has no dot.

**Owner answers (2026-10-18, chat):** Q1 A — a VMDE decorator in IR, WYSIWYG, Preview and Split preview. Q2 B — add the setting `vmde.markdown.autolinkBareUrls` (boolean, default `true`); when `false`, no pane decorates bare URLs and a live change applies without reopening the editor. Q3 A — GFM rules; hosts without a dot stay plain. These answers override the handoff where they differ.

### Residual risks

- In IR and WYSIWYG a URL is not linked while the caret is in its block. Activate Link at Caret therefore rarely finds a bare URL. This matches the code-ref behaviour.
- The prerender overlay shows plain URLs until the live editor swaps in and the observer runs.
- Preview cannot tell raw HTML block content from Markdown text. A bare URL written inside a raw HTML block, such as `<div>https://x.com</div>`, will be linked in Preview but not in IR or WYSIWYG, where it is skipped as HTML.
- The decorator adds one more full text walk on `selectionchange`, the same cost as code-ref. Not measured in the webview; S3 measures it.
- Task 654's final raw-anchor DOM is not known yet. The skip selector must be extended to it before S2 ends.
- I did not read the Task 578 source index, the incremental `serializeForHost` path, or the Task 604/606/607 records. Their compatibility rests on the code-ref chip precedent and the serializer probe. Unverified until S1 inspects them and S3's save test runs.
- I am not sure the matcher rules are exactly cmark-gfm's (for example whether `ftp://` is included and how `localhost` is handled). Unverified; the S1 table fixes the behaviour as the product contract.

## Execution progress — 2026-10-18 (Part 2)

Worktree branch `wt/655`. Steps S1 and S2 are done; S3 (real-VS-Code spec) and closure are not started. Acceptance items 2 and 3 stay unticked until the combined real-VS-Code round passes.

### S1 (RED)

- Added `media-src/src/links/bare-url-match.test.ts` (GFM extended-autolink table plus every Fact 5 case) and `media-src/src/links/bare-url-decorate.test.ts` (element shape, every skip context, idempotence, caret-block skip, setting gate, real-Lute IR and WYSIWYG parity on the 22-block corpus). The setting tests were written in `test/backend/resource-scoped-config.test.ts`, `test/backend/manifest.test.ts` and `media-src/src/boot/live-config.test.ts`.
- RED before any implementation (stub modules returning nothing): the matcher file failed 40 of 47 cases, the decorator file 15 of 67 (the skip-context negatives pass vacuously against a stub; the positive "next to a skipped context" case and the parity test keep them honest), and the setting tests failed on missing behaviour (host option `undefined`, manifest key absent, live strip not done).
- Inspection, without edits, of the Task 578 DOM-to-source index and the incremental IR fast path: both treat a class-only inline span like the code-ref chip.
  - `media-src/src/bridge/edit-sync.ts:383-391` serializes the `outerHTML` of changed top-level blocks through `lute.VditorIRDOM2Md`; a class-only span is transparent there (parity test).
  - `media-src/src/editing/find-map.ts:41-46` decides which Text nodes are serializable by class and attribute selectors, none of which match the new span. `find-map.ts:336-349` rebuilds a memoized map when a Text node of its unit is unknown to it, which covers the Text nodes `splitText` creates.

### S2 (GREEN)

- New: `bare-url-match.ts` (matcher), `bare-url-decorate.ts` (decorator, `setBareUrlsEnabled`). Wired in `finish-init.ts` (`bare-urls`, `preview-bare-urls`, before the code-ref observers), `mutation-impact.ts` (`vmde-bare-url`), `code-ref-decorate.ts` (skip `[data-bare-url]`, drop code-ref matches that overlap a URL; shared `collectTextNodes`, `hasLiveCaret` and `caretBlockOf` are now exported), `link-click-fix.ts` (span click branch and `hrefForLinkLike`), `caret-link.ts` (`LINK_LIKE_SELECTOR`), `main.css`, `scripts/module-manifest.mjs`.
- Setting `vmde.markdown.autolinkBareUrls` (boolean, default `true`, resource scope): `package.json` (Markdown Extensions, order 4, inline `markdownDescription`; the repository has no `package.nls*.json`), `src/shared/protocol.ts` (`autolinkBareUrls`), `src/platform/editor-config.ts` (host read), `media-src/src/boot/live-config.ts` (`applyBodyOptions` calls `setBareUrlsEnabled`, so a config change strips or restores decoration live and is not in `INIT_ONLY_OPTIONS`), `media-src/src/diagram-kit/diagram-config-delta.test.ts` (key classification).
- Deviation from the handoff selector: the body text between two inline HTML tags (`<span>html https://h.com</span>`) is plain sibling text in the Lute IR and WYSIWYG DOM and is decorated, matching what Preview renders. Only the tag tokens (`[data-type="html-inline"]`) and block HTML are skipped. Task 654's `[data-vmde-html-link]` span and the text between its tags are skipped.
- Not done here: S3 spec, the large-fixture timing, `npm run quality`.
