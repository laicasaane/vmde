# Task 207 — Front-matter properties: `aliases:` + `tags:` resolution, properties table rendering

**Status:** ✅ done (2026-11-08) · **Impact:** 🟡 med · **Origin:** task 192 §3; properties table added by the Owner on 2026-11-08

## Problem

Zero host-side front-matter parsing. `WikiCache` keys come only from file paths
(`src/wiki.ts:58-64`), so a page reachable in Obsidian via a declared alias shows as a
*missing* page here; front-matter `tags:` are invisible to any tag index. (Rendering-wise
front matter round-trips as an editable yaml block, verified. The Owner asked on 2026-11-08 for
a rendered properties table; see "Properties table rendering" below.)

## Scope

- [ ] (moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md), not done) Host: lightweight front-matter extractor (first `---` block, YAML subset:
      `aliases`/`tags` as list or scalar; tolerate malformed YAML by skipping the file's
      metadata, never erroring the scan).
- [ ] (moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md), not done) `WikiCache`: alias keys join the path-derived keys (normalized via
      `normalizeWikiLookupKey`); ambiguity handling identical to duplicate filenames
      (existing picker). Incremental: re-parse on save/watch events.
- [ ] (moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md), not done) `tags:` feed task 205's index (if 205 unshipped, store and expose; don't block).
- [ ] (moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md), not done) Chip resolution + `[[` hint list include aliases (hint shows `alias → file` hint text).
- [ ] (moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md), not done) Rename-refactor interplay (task 202): alias-resolved links must NOT be rewritten on
      file rename (the alias still resolves) — pin this.

## Follow-ups (added 2026-07-03 — the Front Matter CMS slices worth having natively)

Front Matter CMS (eliostruyf, ~74.5K installs) is whole-vault CMS tooling that coexists
fine with VMDE — do NOT reimplement its dashboard/taxonomy/media surfaces. The three
slices that fit a document editor, as extensions of this task's parsing:
- [ ] (separate, not done) `draft: true` / future-`date` badge in the status bar + a toggle-draft command.
- [ ] (separate, not done) Optional title/description length hints (SEO-style) on the front-matter block.
- [ ] (separate, not done) `Open on local site` command: map slug/permalink → a configured localhost URL
      pattern (the honest answer to "docusaurus/hugo preview helpers").

## Properties table rendering (Owner request, 2026-11-08)

Render YAML front matter as a vertical two-column table instead of a YAML code block.

- [x] Column 1 holds the front-matter property (key) names. Column 2 holds the matching values,
      shown without their YAML quotes (`title: "Hello"` shows `Hello`).
- [x] Each cell (key and value) has a copy button that copies that cell's content to the
      clipboard. The copied text is the displayed text (no quotes).
- [x] The copy button is an icon only, with no text label. Use a common copy icon: Codicons
      `copy` (CC BY 4.0, same set as the toolbar). Record its use in the notice at
      `media/codicons.LICENSE` and in a source comment, like the existing toolbar icons in
      `media-src/src/chrome/toolbar-icons.ts`. Give the button an accessible name
      (`aria-label`, `title`) because it has no visible label.
- [x] The copy button always shows on every cell (not only on hover or focus).
- [x] The copy button is aligned to the right edge of its cell.
- [x] Both columns reserve enough space (for example right padding at least the button width
      plus a gap) so the copy button never overlaps the cell content, also for long or wrapped
      values and narrow editor widths.
- [x] The copy button is highlighted on hover (and on keyboard focus).
- [x] After a click, the button icon changes to a checkmark for 1.5 seconds to confirm the copy,
      then changes back. Use Codicons `check` (CC BY 4.0); record it in the same notice. A second
      click during the 1.5 s restarts the timer.
- [x] Round-trip safety: the table is a rendered view only. The saved markdown keeps the original
      front-matter bytes unchanged (apply the `vmde-lute-features` skill before injecting DOM).

Decisions (all settled by the Owner on 2026-11-08; ready to plan):

- D1 Modes — SETTLED (Owner, 2026-11-08): the table shows in every rendered surface (IR,
  WYSIWYG, Split preview, Preview pane). In IR and WYSIWYG, the YAML source shows when the caret
  enters the block (click or arrow keys) and the table shows again when the caret leaves, like
  mermaid and math blocks. Source mode stays raw. A click on a copy button must not move the caret
  into the block (for example `preventDefault` on `mousedown`); a real-VS-Code test pins this.
- D2 Non-scalar values — SETTLED (Owner, 2026-11-08): a list shows each item as a chip (or
  line) inside column 2. A nested map shows as a small inner key/value table inside the cell, with
  no copy buttons on the inner cells. A block scalar (`|`, `>`) shows as plain text with its line
  breaks kept. The value copy button copies the whole value without its key: the YAML text of a
  list or map (for example `[a, b]` or the map lines), the plain text of a scalar or block scalar.
- D3 Malformed YAML — SETTLED (Owner, 2026-11-08): when the front matter does not parse (or is
  not YAML, for example TOML between `+++` lines), the block shows as the current YAML code block,
  with a small in-place warning at the block, for example "Front matter could not be parsed:
  <parser message>". Editing works as before. No table, no partial table.

Tests for this section: L1 unit for key/value extraction and quote removal (single, double,
plain, block scalars, lists, malformed); Chromium for layout (no overlap at narrow widths, button
right-aligned, hover style, icon swap and restore after 1.5 s); L3 real-VS-Code (mandatory) for
the table render, clipboard content of a key and a value cell, the checkmark swap, and an
unchanged saved file.

## Out of scope

- A properties editor UI (the properties table is read-only display plus copy), arbitrary property queries (task 105 dataview epic), alias
  WRITE-side tooling, Front Matter CMS's vault surfaces (see above).

## Verification

- L1 backend: extractor unit (list/scalar/missing/malformed), cache-key merge, ambiguity,
  incremental update on alias edit.
- L2: `[[Some Alias]]` chip renders resolved when a fixture declares it.
- L3 real-VS-Code (mandatory): click alias chip opens the declaring file; hint offers the
  alias.
- Properties table: see the tests listed in "Properties table rendering".

## Part 1 handoff (2026-11-08)

Scope of this handoff: the properties table only (section "Properties table rendering", D1–D3).
Product decisions D1–D3 are settled and are not reopened here. Every public name, class name,
message string and constant below is fixed for Part 2; a worker that finds a contradiction reports
it instead of renaming.

### Aliases and tags: not in this implementation

The `aliases:`/`tags:` resolution (section "Scope") stays out of this implementation. It shares only
the YAML parser module (`src/shared/front-matter.ts`, step S2), which this implementation creates in
a form the host can reuse. Proposed order after the table ships, one task part each:

1. Host extractor: `frontMatterSource(markdown)` + `aliases`/`tags` reader in `src/shared/front-matter.ts`
   (reuses the same `yaml` parse; malformed input means "no metadata", never a scan error).
2. `WikiCache` alias keys: today keys come only from paths, in `src/wiki/wiki-cache.ts:153-167`
   (`indexFile` → `getWikiKeys`) and `src/shared/wiki-core.ts:59-73` (`wikiKeysForRelativePath`).
   The record's `src/wiki.ts:58-64` location is stale. Alias keys join there, normalized with
   `normalizeWikiLookupKey` (`src/shared/wiki-core.ts:48`), re-parsed on the watcher's change events.
3. Chip resolution and the `[[` hint list (`alias → file` hint text).
4. Rename interplay with task 202 (still planned): pin "alias-resolved links are not rewritten".
5. `tags:` into task 205 (still planned): store and expose only.
The Front Matter CMS follow-ups stay separate, after item 1.

### Problem restated, with source locations (verified 2026-11-08 on `dev` 6844f1af)

- Lute renders YAML front matter as a plain source block with no rendered half. Probe
  `tmp/207/probe-render.cjs` (vendored `media-src/vendor/lute/lute.min.js`):
  - IR: `<div data-block="0" data-type="yaml-front-matter" class="vditor-ir__node"><span data-type="yaml-front-matter-open-marker">---</span><pre class="vditor-ir__marker--pre"><code data-type="yaml-front-matter" class="language-yaml">…</code></pre><span data-type="yaml-front-matter-close-marker">---</span></div>`.
    The `pre` has NO `vditor-ir__marker` class (a code block's pre has both), so it never collapses.
  - WYSIWYG: `<div class="vditor-wysiwyg__block" data-type="yaml-front-matter" data-block="0"><pre><code data-type="yaml-front-matter">…</code></pre></div>` (no `vditor-wysiwyg__preview`).
  - Preview (`Md2HTML`, used by Split preview and the Preview pane, both `vditor.preview.previewElement`):
    `<pre class="vditor-yml-front-matter"><code class="language-yaml">…</code></pre>`.
  - TOML between `+++` lines is NOT front matter to Lute: it renders as a paragraph `<p>+++\n…\n+++</p>`
    in all three surfaces (see open question Q1).
- Vditor already toggles `vditor-ir__node--expand` on the IR front-matter node as the caret enters
  and leaves (`vditor/src/ts/ir/expandMarker.ts:47-77`; the node is a `vditor-ir__node`), and its CSS
  shows `---` pseudos only while expanded (`vditor/src/assets/less/_ir.less:9-16,100-104`).
- Vditor's IR keyup moves the caret from a preview into its source with ArrowUp/ArrowLeft, using
  `previewRenderElement.previousElementSibling.firstElementChild` (`vditor/src/ts/ir/index.ts:258-270`).
  WYSIWYG uses `showCode(preview)` on click and arrows (`vditor/src/ts/wysiwyg/index.ts:468-476,519-560`,
  `wysiwyg/showCode.ts`), and hides `preview.previousElementSibling` 200 ms after the caret leaves
  (`wysiwyg/highlightToolbarWYSIWYG.ts:608-617`). So the injected preview must be the element
  directly after the `pre` in both modes.
- Precedents: callouts dual-node by hand (`media-src/src/editing/callouts.ts:783-810` `syncPreview`,
  `:1395-1440` `decorateCallout`, `:1483-1556` `observeCallouts` with the selectionchange re-sync);
  copy button that never moves the caret (`media-src/src/clipboard/code-copy.ts:11-59`, host
  `src/session/editor-session.ts:550-571,1701`); observer wiring on `#app` and `previewEl`
  (`media-src/src/boot/finish-init.ts:511-548`); own-decoration filter (`media-src/src/util/mutation-impact.ts:20-60`).

### Design

1. Parsing uses the `yaml` package (2.9.0, ISC, already a root devDependency and bundled like every
   other dependency, since the VSIX ships `--no-dependencies`). A hand-written subset parser was
   rejected: D3 shows the warning only when YAML does not parse, and a subset parser would warn on
   valid YAML (anchors, flow maps, tags). Measured: `parseDocument` bundled and minified = 95 KB
   (30 KB gzip), so it must NOT enter the eager `media/dist/main.js`. It ships in a new lazy bundle,
   loaded only when a front-matter block exists (precedent `d2-main.js`).
2. Pure model in `src/shared/front-matter.ts` (imports `yaml`; reusable by the host later). The
   eager webview module imports it with `import type` ONLY; the lazy entry imports the functions.
3. Rendering: a non-editable preview injected directly after the front-matter `pre`, carrying
   `data-render="1"` and `contenteditable="false"` (skill vmde-lute-features). Probe
   `tmp/207/probe-inject.cjs`: with the preview after the `pre`, at the node end, and even without
   `data-render`, `VditorIRDOM2Md` and `VditorDOM2Md` give the same output as without the preview;
   `SpinVditorIRDOM`/`SpinVditorDOM` drop it (transient, re-injected by the observer). Note: Lute
   already drops the blank line after front matter on its own (`base !== md` in both probes); the
   saved bytes stay correct only through the existing minimal-diff write-back, which the
   real-VS-Code test checks on disk.
4. Mode classes on the preview: `vditor-ir__preview` in IR (so Vditor's keyup arrow rule enters the
   source), `vditor-wysiwyg__preview` in WYSIWYG (so Vditor's `showCode` and 200 ms hide work), none
   in Preview. Vditor only runs `processCodeRender` on `[data-render='2']`, so it never touches ours.
5. State attribute on the block (IR node, WYSIWYG block, Preview `pre.vditor-yml-front-matter`):
   `data-vmde-front-matter="table" | "error" | "empty"`. CSS keys off it. Spin drops it; the observer
   re-adds it synchronously before paint (callouts pattern).
6. Commit-on-leave: while the caret is inside the block (`data-vmde-front-matter-editing` present),
   the observer re-injects the last committed preview (cached clone) and does NOT parse. A
   `selectionchange` handler parses and commits when the caret leaves (callouts task-179 pattern).
   This keeps typing cost flat and stops the warning from flickering while the user types.
7. Copy: document capture listeners. `mousedown` (primary button on a copy button) →
   `preventDefault` (D1: caret never moves). `click` → `preventDefault` + `stopPropagation` (stops
   Vditor's IR/WYSIWYG click handlers), then post `copy-property`. `keydown` Enter/Space on a focused
   copy button → `preventDefault` + `stopPropagation` + copy (Vditor's editor keydown must never see
   it). The host writes the clipboard (webview `navigator.clipboard` is not used, same as code copy).
8. Checkmark: each button holds both icons; `data-copied` shows the check icon by CSS. An attribute
   change is invisible to the childList/characterData observers, so the swap wakes no observer. One
   timer per button in a `WeakMap<HTMLButtonElement, number>`; a second click clears and restarts it.
9. Theming: model #1 (DOM + CSS). The table sits inside `.vditor-reset`, so the content theme's table
   rules apply; only layout and the button use `--vscode-*` tokens.

### Fixed names, strings and constants

- Shared module `src/shared/front-matter.ts` (add id `front-matter` to `HOST_MODULES.shared.ids` in
  `scripts/module-manifest.mjs`):
  ```ts
  export type FrontMatterValueView =
    | { kind: 'text'; text: string }
    | { kind: 'list'; items: FrontMatterValueView[] }
    | { kind: 'map'; rows: { key: string; value: FrontMatterValueView }[] }
  export interface FrontMatterRow { key: string; value: FrontMatterValueView; keyCopy: string; valueCopy: string }
  export type FrontMatterParseResult =
    | { status: 'table'; rows: FrontMatterRow[] }
    | { status: 'empty' }
    | { status: 'error'; warning: string }
  export function parseFrontMatterProperties(yamlText: string): FrontMatterParseResult
  export const FRONT_MATTER_NESTING_LIMIT = 4
  ```
- Warning strings (exact): `Front matter could not be parsed: <yaml message> (line <L>, column <C>)`,
  where `<yaml message>` is `YAMLError.message` with `prettyErrors: false` (for example
  `Map keys must be unique`), and `<L>` is the DOCUMENT line (yaml line + 1 for the opening `---`).
  Top level not a map: `Front matter could not be parsed: expected key: value properties`.
  TOML (only if Q1 option a): `Front matter could not be parsed: TOML front matter is not supported`.
- Lazy entry `media-src/src/editing/front-matter-entry.ts` sets
  `window.__vmdeFrontMatter = { parse: parseFrontMatterProperties }`. Output
  `media/vditor/dist/js/front-matter/front-matter-main.js` (IIFE, minified, no sourcemap, new options
  block in `media-src/build.mjs` beside `d2Options`). Loaded with
  `loadScript(\`${cdn}/dist/js/front-matter/front-matter-main.js\`, 'vmdeFrontMatterScript')`
  (`media-src/src/util/load-script.ts`), promise cached once.
- Eager module `media-src/src/editing/front-matter-table.ts` (add `front-matter-table` and
  `front-matter-entry` to the `editing` ids in `scripts/module-manifest.mjs`; add the entry to
  `knip.jsonc` beside `d2-entry.ts`):
  - `export function observeFrontMatter(root: HTMLElement | null | undefined, deps: FrontMatterDeps): () => void`
  - `export function decorateFrontMatter(block: HTMLElement, result: FrontMatterParseResult | null): void` (pure DOM, tested directly)
  - `export function installFrontMatterCopy(target: Window & typeof globalThis, post: (m: Extract<WebviewMessage, { command: 'copy-property' }>) => void): () => void`
  - `export interface FrontMatterDeps { loadParser: () => Promise<(yamlText: string) => FrontMatterParseResult> }`
  - `export const FRONT_MATTER_COPY_CONFIRM_MS = 1500`
  - Codicons `copy` and `check` SVG strings as module constants `copyIcon`/`checkIcon`, with a source
    comment in the style of `media-src/src/chrome/toolbar-icons.ts:4-6` (artwork CC BY 4.0, notice in
    `media/codicons.LICENSE`). Path data lifted from `microsoft/vscode-codicons` `src/icons/copy.svg`
    and `src/icons/check.svg` (no local copy exists in `node_modules`). Add one sentence to
    `media/codicons.LICENSE`: "The front-matter properties table uses the Codicons copy and check icons."
- DOM (exact classes):
  ```html
  <div class="vmde-front-matter [vditor-ir__preview|vditor-wysiwyg__preview]" data-render="1" contenteditable="false" data-sig="<yaml text>">
    <table class="vmde-front-matter__table"><tbody>
      <tr class="vmde-front-matter__row">
        <th class="vmde-front-matter__key" scope="row"><span class="vmde-front-matter__content">title</span><button …></button></th>
        <td class="vmde-front-matter__value"><span class="vmde-front-matter__content">…value view…</span><button …></button></td>
      </tr>
    </tbody></table>
  </div>
  <div class="vmde-front-matter__warning" data-render="1" contenteditable="false" role="note">Front matter could not be parsed: …</div>
  ```
  Value views: text = `span.vmde-front-matter__text`; list = `span.vmde-front-matter__list` of
  `span.vmde-front-matter__chip`; map = `table.vmde-front-matter__inner` (rows `th`/`td`, no buttons).
  Button: `<button type="button" class="vmde-front-matter__copy" data-copy-text="…" title="Copy name" aria-label="Copy name: <key>">`
  (value: `title="Copy value"`, `aria-label="Copy value of <key>"`), children
  `span.vmde-front-matter__icon.vmde-front-matter__icon--copy` and `…--check`, both `aria-hidden="true"`.
  All text through `textContent` (no `innerHTML` of document content). Do not add the classes to
  `OWN_DECORATION_CLASSES` (`media-src/src/util/mutation-impact.ts:20`): its `data-render` check
  already treats both injected nodes as own decorations.
- Protocol: `{ command: 'copy-property'; content: string }` in `src/shared/protocol.ts` (beside
  `copy-code`, line 593); `'copy-property': []` in `src/webview-host/webview-message-shape.ts:139`
  and the comment at `:55`; host route `'copy-property': (message) => this.onCopyToClipboard(message, 'property')`
  in `src/session/editor-session.ts:1701`, extending the union at `:554`. Resulting host strings:
  information message `Copy property successfully!`, live-region announcement `Copied property`.
- Wiring: `media-src/src/boot/finish-init.ts` after `preview-callouts` (`:548`):
  `observers.set('front-matter', observeFrontMatter(app, deps))` and
  `observers.set('preview-front-matter', observeFrontMatter(previewEl, deps))`;
  `media-src/src/boot/main.ts:802` beside `installCodeCopy`: `installFrontMatterCopy(window, (m) => vscode.postMessage(m))`.
- No new setting. No new command.

### Display and copy rules (D2, exact)

- Key: scalar key → parsed string (quotes removed); non-scalar key → its source text. `keyCopy` = displayed key.
- Scalar value: `QUOTE_DOUBLE`/`QUOTE_SINGLE` → parsed value (`"Hello"` → `Hello`, `'it''s'` → `it's`);
  `PLAIN` → `source` text unchanged (`1.0` stays `1.0`, `true`, `null`, `2024-01-02` stay literal);
  empty value (`key:`) → empty string. `valueCopy` = displayed text.
- Block scalar: `|` → parsed value with trailing newlines removed; `>` → the body lines as written
  (header line dropped, common indentation removed, trailing newlines removed), so its line breaks
  are kept as D2 says. Display with `white-space: pre-wrap`. `valueCopy` = displayed text.
- List: each item is a chip; a scalar item shows its scalar text; a map item shows an inner table;
  a list item shows nested chips. `valueCopy` = the value's YAML source: if the value starts on the
  key's line (flow, `[a, b]`) the exact source slice; otherwise the full source lines of the value,
  common indentation removed, trailing whitespace removed (`- One\n- Two`).
- Map: inner key/value table, no copy buttons inside; `valueCopy` = YAML source lines as for lists.
- Alias (`*b`): source text. Depth beyond `FRONT_MATTER_NESTING_LIMIT`: the value's YAML source as text.
- Comment-only or empty front matter (`---\n---`): `status: 'empty'` → code block unchanged, no table, no warning.
- Duplicate keys, bad indentation, tabs, unterminated quotes: `status: 'error'` (yaml's own errors).

Probe `tmp/207/probe-yaml.mjs` confirms each input above (types, `source`, ranges, error codes
`DUPLICATE_KEY`, `BAD_INDENT`, `TAB_AS_INDENT`, `MISSING_CHAR` with line/column).

### CSS (in `media-src/src/main.css`, one new commented section)

- IR, `table` state, collapsed: hide the `pre` the way Vditor hides a diagram source (exact variant
  chosen by probe P1), set `::before`/`::after` `content: none` on the node, show the preview.
  Expanded (`.vditor-ir__node--expand`): hide `.vmde-front-matter` and `.vmde-front-matter__warning`.
- WYSIWYG: hide `.vmde-front-matter` while `[data-vmde-front-matter-editing]`; in `error` state force
  `> pre { display: block !important }` (Vditor's Escape handler hides `firstElementChild` of a
  two-child block, `wysiwyg/processKeydown.ts:80-86`, and the error block has `pre` + warning).
  On leave, the selectionchange handler sets the `pre` `style.display = 'none'` immediately so the
  table and source never show together during Vditor's 200 ms delay.
- Preview: `pre.vditor-yml-front-matter[data-vmde-front-matter="table"] { display: none }`.
- Table: `width: 100%; display: table; table-layout: fixed`; key column `width: min(35%, 16em)`;
  cells `position: relative; overflow-wrap: anywhere; padding-right: calc(var(--vmde-fm-copy-size, 22px) + 8px)`.
  Button: `position: absolute; top: 4px; right: 4px; width/height: var(--vmde-fm-copy-size, 22px)`,
  always visible, transparent background; `:hover` and `:focus-visible` background
  `var(--vscode-toolbar-hoverBackground, rgba(90, 93, 94, 0.31))`, `:focus-visible` outline
  `1px solid var(--vscode-focusBorder, #007fd4)`. Chips: `var(--vscode-badge-background)` /
  `var(--vscode-badge-foreground)`. Warning: `font-size: 0.85em; color: var(--vscode-editorWarning-foreground, #bf8803)`.

### Steps (each standalone; failing tests first)

- S1 (test, red). Own: `test/backend/front-matter.test.ts`. Cases: every rule in "Display and copy
  rules", every warning string with document line numbers, top-level list/scalar, empty, depth cap.
  Check: `npx vitest run --config test/vitest.config.ts test/backend/front-matter.test.ts` fails on the missing module.
- S2 (impl). Own: `src/shared/front-matter.ts`, `scripts/module-manifest.mjs`. Check: S1 green;
  `npx vitest run --config test/vitest.config.ts test/backend/module-boundaries.test.ts`; `npm run typecheck`.
- S3 (host protocol). Own: `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`,
  `src/session/editor-session.ts`, plus a red-first `copy-property` case beside the `copy-code` cases in
  `test/backend/editor-session.test.ts` and `test/backend/extension.test.ts`. Check: those tests, `npm run typecheck`.
- S4 (lazy bundle). Own: `media-src/src/editing/front-matter-entry.ts`, `media-src/build.mjs`,
  `scripts/check-bundle-size.mjs` (new row, 110 KB, "lazy, only when a document has YAML front matter"),
  `knip.jsonc`. Check: `node build.mjs`; the file exists; `node -e "const m=require('./media/dist/main.meta.json');const k=Object.keys(m.outputs).find(x=>x.endsWith('main.js'));console.log(Object.keys(m.outputs[k].inputs).filter(p=>p.includes('node_modules/yaml')).length)"` prints `0`.
- S5 (test, red). Own: `media-src/src/editing/front-matter-table.test.ts` (jsdom + `createRealLute`
  from `media-src/src/testing/real-lute.ts`, parser imported directly from the shared module).
  Cases: DOM shape and names; IR and WYSIWYG serializer output identical with and without the
  preview and warning; second decoration with the same text makes no DOM mutation; Preview
  (`Md2HTML`) decoration; error and empty states; copy click posts `{ command: 'copy-property', content }`
  with key and value texts; `mousedown` default prevented only for button 0; Enter/Space keydown
  copies and is stopped; `data-copied` set, cleared after 1500 ms, restarted by a second click
  (fake timers); editing attribute while the selection is inside, commit on leave.
- S6 (probe harness). Own: `media-src/e2e/front-matter-table-harness.ts`, `.html`,
  `media-src/e2e/front-matter-table.spec.ts` (probe tests tagged `@probe`). Run P1–P4 below with the
  candidate CSS injected by `addStyleTag`. Record the measured values in this record.
- S7 (impl). Own: `media-src/src/editing/front-matter-table.ts`, `media-src/src/main.css`,
  `media/codicons.LICENSE`, `media-src/src/boot/finish-init.ts`, `media-src/src/boot/main.ts`,
  `scripts/module-manifest.mjs`. If P1/P2 fail both variants, also `media-src/src/editing/callout-nav.ts`
  (extend its keydown entry selector to the front-matter node) in the same step.
  Check: S5 green; coverage of the new lines (vmde-testing "Coverage" command); `npm run typecheck`,
  `npm run typecheck:strict`; `npm run lint:ci`.
- S8 (Chromium acceptance). Own: the S6 spec (acceptance tests, untagged). Check:
  `xvfb-run -a npm --prefix media-src run test:e2e -- front-matter-table.spec.ts`.
- S9 (real VS Code). Own: `test/vscode-e2e/front-matter-table.spec.ts`,
  `test/vscode-e2e/fixtures/front-matter-table.md`, `test/vscode-e2e/fixtures/front-matter-malformed.md`.
  Pattern: `test/vscode-e2e/code-copy-button.spec.ts` (sentinel clipboard, real mouse, host state).
  The orchestrator runs it (`node build.mjs` first, then the wrapper).
- S10 (only if the Owner picks Q1 option a). Own: `front-matter-table.ts`, its test, `main.css`.
  Leading `+++` paragraph gets the TOML warning as `span[data-render="1"][contenteditable="false"]`
  inside that paragraph (inline injection rule), in IR, WYSIWYG and Preview.

### Probes Part 2 runs first (S6, Chromium harness, IR unless noted)

- P1 collapsed geometry and arrow entry. Variant A: collapsed `pre` `display: inline-block; width: 0; height: 0; overflow: hidden`.
  Variant B: `display: block; height: 0; overflow: hidden`. Measure (a) node height minus preview
  height, (b) after ArrowUp from the start of the heading below: node has `--expand` and the
  selection is inside `code[data-type="yaml-front-matter"]`. Expected: A → (b) true, (a) ≈ one line
  height (line strut, needs the pseudo/marker fix); B → (a) ≤ 1 px, (b) unknown. Choose the variant
  with (a) ≤ 1 px and (b) true; if none, use B plus the callout-nav extension in S7.
- P2 click on table text (not a button), IR and WYSIWYG. Expected IR: node expands and selection is
  inside the code (as for callouts); WYSIWYG: `showCode` puts the selection in the code. If IR
  fails, S7 adds a preview `mousedown` handler that writes the caret at the code start (`writeSelection`
  from `media-src/src/editing/caret.ts`) and calls Vditor's `expandMarker`.
- P3 focus: `button.focus()` inside the `contenteditable="false"` preview in IR. Expected
  `document.activeElement === button` and `:focus-visible` matches after a keyboard focus. If not,
  add `tabindex="0"`.
- P4 undo: after open, the Undo depth of a document with front matter equals that of the same
  document without it (the injection adds no Undo step). Expected equal; if not, follow
  `callouts.ts`'s `seedHistoryOf` use.

### Edge cases

- Front matter is always the first block; the observer handles only `[data-type="yaml-front-matter"]`
  blocks and `pre.vditor-yml-front-matter` in Preview, scoped through `observeScopedMutations`.
- Lazy bundle not loaded yet or load failure: the block stays the current code block (no warning);
  failure goes through `reportError` once. Decoration runs when the parser resolves.
- Text read from `code` `textContent` with `​` removed; `<wbr>` never reaches it in IR/WYSIWYG.
- Long unbroken values, wrapped values and widths down to 320 px: no overlap (S8 asserts).
- Find skips the table (`[data-render]` in `media-src/src/editing/find-map.ts:45`) and matches the YAML source.
- Block handle keeps front matter inert (`media-src/src/nav/block-handle.ts:23,399`), unchanged.
- Undo restore re-renders a stale preview from the snapshot; the `data-sig` guard rebuilds it.
- Source mode (`sv`) editor stays raw; Split's preview pane shows the table.
- Mode switch and full Preview re-render: the `#app` and `previewEl` observers re-apply (fresh DOM).
- Copy in Preview and Split preview works the same (no caret there).
- Keyboard: Tab inside the editor is owned by the editor (indent), so buttons are reached by pointer;
  focus styling still applies when a button gets focus.

### Performance intent

- Documents without front matter: no parse, no bundle load, one selector test per scoped mutation batch.
- With front matter: one parse per committed text (open, caret leave, external update); none per
  keystroke while editing (cached clone re-injected). Parse of a typical block is well under 1 ms.
- The 95 KB parser stays out of `main.js` (S4 check). No allocation on the steady-state observer path
  beyond the re-injected clone after a spin.

### Test plan mapped to acceptance items

| Acceptance item | Vitest | Chromium | Real VS Code |
|---|---|---|---|
| Two-column table, keys/values, quotes removed | S1, S5 | — | table rows and texts in IR, WYSIWYG, Preview |
| Copy button per cell, copies displayed text | S1 (copy texts), S5 (message) | — | clipboard after key click (`title`), value click (`Hello`), list value (`[a, b]`) |
| Icon only, Codicons, accessible name | S5 (`aria-label`, `title`, no text) | — | — |
| Always visible | — | S8 visible without hover | — |
| Right aligned, no overlap at narrow widths | — | S8 at 320/480/800 px, long value | — |
| Hover and focus highlight | — | S8 computed background on hover/focus | — |
| Checkmark 1.5 s, restart on second click | S5 (fake timers) | S8 swap and restore | checkmark swap after a real click |
| Round-trip safe, saved bytes unchanged | S5 (serializers) | — | host text unchanged, not dirty; after save, disk bytes equal the fixture |
| D1 caret enter shows YAML, leave shows table | S5 (editing attr) | S8 click and arrows, P1/P2 | caret entry by click shows source |
| D1 copy click never moves the caret | S5 (mousedown) | — | selection, `--expand` count, Undo depth unchanged after copy (code-copy pattern) |
| D2 lists, nested maps, block scalars | S1, S5 | — | fixture rows render (chips, inner table) |
| D3 malformed: code block + warning | S1 (strings), S5 | — | malformed fixture shows code and the exact warning |

Regression set for the orchestrator's combined run: real VS Code `front-matter-matrix.spec.ts`,
`hljs-colour-timing.spec.ts`, `hljs-initial-stylesheet.spec.ts`, `code-copy-button.spec.ts`,
`rewrap.spec.ts`; Chromium `block-handle.spec.ts`, `gap-cursor.spec.ts`, `keybugs.spec.ts`,
`callouts.spec.ts`. The `frontmatter-code.md` and `all-renderers.md` fixtures contain front matter,
so geometry or colour assertions on them may need the table state taken into account.

### Observed while planning (not part of this task)

- After `node build.mjs` in this worktree, `npm run check:bundle-size` reports
  `media/dist/main.js 1082 KB / 608 KB` and `check:startup-cost` reports `eager modules 392 / 294`
  before any change. This is pre-existing on `dev` 6844f1af; S4 must judge only its own row and the
  `yaml`-absent check.

### Open questions (for the orchestrator or Owner)

- Q1 TOML `+++`: D3 says TOML "shows as the current YAML code block" with a warning, but Lute renders
  it as a paragraph, not a code block. Options: (a) recommended: keep today's paragraph and add the
  TOML warning inside it (S10); (b) no warning for TOML, YAML `---` only; (c) render TOML as a code
  block (needs a Lute change; out of scope).

### Orchestrator decisions on the Part 1 handoff (2026-11-08; provisional, on the Owner's behalf, reversible)

- **Q1:** option (a): keep the current TOML paragraph and add the TOML warning inside it (step S10 runs).
- **Scope:** this implementation delivers the properties table (D1–D3). The `aliases:`/`tags:` resolution part of this record moves to a new task at closure, with the order proposed in the handoff.
- **Order:** Part 2 runs the probes P1–P4 first, then S1–S10 in order, in one implementation session, a few steps per turn; the orchestrator runs the real-VS-Code spec (S9) in its batched run.

## Part 2a results (2026-11-08)

Probes P1–P4 (S6 harness `media-src/e2e/front-matter-table-harness.ts`, spec `front-matter-table.spec.ts`, tests tagged `@probe`),
then S1–S3. S4–S10 not started. Harness note: the IR harness installs the production marker reveal
(`installCompositionState()` + `installIrMarkerReveal()`, as `boot/main.ts:162-163`); without it Vditor's
stock keyup `expandMarker` is replaced and no arrow key expands a node, so P1(b) could not be measured.
The harness injects a hand-built candidate preview (not the production module, which is S7).

### Probe results (Chromium, 4 workers off, one run each, values repeated on a second run)

| Probe | Hypothesis | Measured | Selects |
|---|---|---|---|
| P1 (a) node height − preview height | A `inline-block; 0×0` | 21 px (node 151, preview 130) | A fails (≈ one line strut) |
| P1 (a) | B `block; height: 0; overflow: hidden` | 0 px (node 130, preview 130) | B passes |
| P1 (b) ArrowUp from heading start, after one frame | A | `--expand` true, selection in `code[data-type="yaml-front-matter"]` | A true |
| P1 (b) | B | `--expand` true, selection in the code | B true |
| P2 click on table text, IR | node expands, selection in code | `--expand` true, in code | no `mousedown` handler needed in IR |
| P2 click on table text, WYSIWYG | `showCode` puts selection in code | in code, `pre` inline `display: block` | no extra handler needed |
| P3 `button.focus()` in `contenteditable="false"` preview, IR | `activeElement === button`, `:focus-visible` after keyboard | active true, `:focus-visible` true | no `tabindex="0"` needed |
| P4 Undo depth | equal with and without front matter | open: 0 / 0 / 0 (no front matter / front matter / front matter + injected preview); after one typed character: 2 and 2 | no `seedHistoryOf` use needed |

Decisions for S7 (they follow from the values, no design change): collapsed `pre` uses **variant B**
(`display: block; height: 0; overflow: hidden`); the `callout-nav.ts` extension is NOT needed (B passes both
(a) and (b)); no preview `mousedown` caret handler, no `tabindex`, no `seedHistoryOf`. Timing note for the S8
acceptance spec: the `--expand` class lands one frame after the key (marker reveal is frame-coalesced), so
assert with a wait/poll, not immediately after `keyboard.press`.

### Steps

- S1 RED: `npx vitest run --config test/vitest.config.ts test/backend/front-matter.test.ts` failed on the
  missing module (exit 1, "no tests", import of `src/shared/front-matter` unresolved). 27 cases.
- S2 GREEN: `src/shared/front-matter.ts` created, id `front-matter` added to `HOST_MODULES.shared.ids`.
  27/27 pass; `module-boundaries.test.ts` 7/7 pass. One fix during S2: `Alias.source` is the anchor name
  only, so an alias value uses the source slice (`*b`).
- S3: `copy-property` added to `src/shared/protocol.ts`, `webview-message-shape.ts` (`[]` + comment), and
  `editor-session.ts` (union + route). Red-first cases in `test/backend/editor-session.test.ts` (announce case:
  clipboard, `Copy property successfully!`, announcement `Copied property`) and `test/backend/extension.test.ts`
  (clipboard + information message) both failed before the change, pass after.

### Checks (exit codes)

- `npx vitest run --config test/vitest.config.ts test/backend/front-matter.test.ts` → 0 (27 tests)
- `npx vitest run --config test/vitest.config.ts test/backend/module-boundaries.test.ts` → 0 (7)
- `npx vitest run --config test/vitest.config.ts test/backend/editor-session.test.ts test/backend/extension.test.ts` → 0
- `npx vitest run --config test/vitest.config.ts test/backend` → 0 (116 files, 3108 passed, 1 expected fail)
- `xvfb-run -a npx playwright test front-matter-table.spec.ts` (in `media-src`) → 0 (6 probe tests)
- `npm run typecheck` → 0; `npm run lint:ci` → 0 (infos only, none in new files)

### Files touched

New: `src/shared/front-matter.ts`, `test/backend/front-matter.test.ts`, `media-src/e2e/front-matter-table.html`,
`media-src/e2e/front-matter-table-harness.ts`, `media-src/e2e/front-matter-table.spec.ts`.
Changed: `scripts/module-manifest.mjs`, `src/shared/protocol.ts`, `src/webview-host/webview-message-shape.ts`,
`src/session/editor-session.ts`, `test/backend/editor-session.test.ts`, `test/backend/extension.test.ts`,
`media-src/e2e/harness-entries.mjs` (one registry row for the S6 harness; required by `harness-registry.test.ts`,
not named in the S6 file list).

### Notes for the orchestrator

- Parser detail the contract left open: a map with no items (`{}`) returns `status: 'empty'`; whitespace-only
  text returns `empty`; only the first parse error is reported. A plain key keeps its source text (`1.0`, `true`).
- Probe values were taken against a hand-built candidate DOM; S7's production DOM must keep the preview
  directly after the `pre`, or P1/P2 must be re-run.

## Part 2b results (2026-11-08)

S4–S8 and S10 done; S9 (real VS Code) not written or run, as briefed.

- S4: `media-src/src/editing/front-matter-entry.ts`, `frontMatterOptions` in `media-src/build.mjs`, budget row in
  `scripts/check-bundle-size.mjs` (110 KB), `knip.jsonc` entry, manifest id. `front-matter-main.js` = 97 KB (99,480 bytes) of
  110 KB; `yaml` inputs in `main.js`: 0. `main.js` 1082/608 KB still fails (pre-existing on clean `dev`).
- S5 RED: `front-matter-table.test.ts` failed on the missing module. S7 GREEN: 29/29. S10 RED: 6 TOML cases failed; GREEN: 37/37.
  Line coverage of `front-matter-table.ts` 97.6%.
- S6/S8: harness now uses the production observer, copy installer and `main.css` (no hand-built DOM); P1–P4 are untagged
  regression tests; 18 Chromium tests (IR, malformed, WYSIWYG) pass twice in a row. Regression specs `block-handle`, `gap-cursor`,
  `keybugs`, `callouts` + this spec: 73 passed.
- S7: `front-matter-table.ts`, CSS section in `main.css` (collapse variant B), `finish-init.ts` (lazy loader, two observers),
  `boot/main.ts` (copy installer), `media/codicons.LICENSE` sentence, manifest id.
- S10: TOML warning span inside the leading `+++` paragraph (IR, WYSIWYG, Preview); serializers unchanged.
- Codicons `copy`/`check` path data read from a VS Code install's `@vscode/codicons` copy (outside the worktree; read-only).
- Checks: `node build.mjs` 0; full Vitest 389 files / 8755 passed; `typecheck` 0; `lint:ci` 0; `knip` 0.
  `typecheck:strict` exits 1 on `finish-init.ts:476` (`installSectionIndent(innerVditor(), …)`, code this task did not touch).
- Extra behaviour beyond the handoff: Space keyup on a copy button is suppressed so Space copies once.

## Part 2c results (2026-11-08)

S9 written and run: `test/vscode-e2e/front-matter-table.spec.ts` with fixtures `front-matter-table.md` and
`front-matter-malformed.md` (the TOML case is an inline string). It covers the real lazy-bundle load path.

- Final real-VS-Code run (`--repeat-each=2`): 12/12 pass (IR, WYSIWYG, Split preview, Preview, malformed, TOML, each twice).
  Earlier combined run with the regression specs (`front-matter-matrix`, `hljs-colour-timing`, `hljs-initial-stylesheet`,
  `code-copy-button`, `rewrap`; `--repeat-each=2`): every case passed except `rewrap.spec.ts:116` (2/2 failures, "document
  rewrap caret in ir"; that document has no front matter; the same caret-restore family is filed as Task 708).
- Chromium `front-matter-table.spec.ts` 18/18 after the product fixes below; Vitest `front-matter-table.test.ts` 40/40.

Product defects the real webview exposed (both fixed, each with a unit test):
1. A cached IR preview clone was reused in WYSIWYG and survived with the `vditor-ir__preview` class, so Vditor's click rule
   (`vditor-wysiwyg__preview`) never opened the source. `decorateFrontMatter` now treats the mode class as part of "current",
   and the cached clone is used only in the mode it was built in.
2. WYSIWYG opens with the caret at the document start inside the front matter, without Vditor's `showCode`: the source was
   CSS-hidden and the table hidden too (an invisible caret). While the caret is inside, the source is now shown (`display: block`).

Contract finding (design question): the handoff said the saved bytes stay correct through the existing minimal-diff
write-back. Measured: after an edit elsewhere the host text loses the blank line after the closing `---` (`---\n\n# Heading`
becomes `---\n# Heading`). It happens identically for empty front matter (no table injected), so it is the existing edit-sync
behaviour, not the table. The spec pins what holds: the front-matter block is byte-identical and the body changed only by the
typed character. Whether write-back should preserve that blank line is a separate decision.

Quality (`npm run quality`, run twice; the second after the fixes): `check:brand-identifiers`, `lint:ci` (first run failed on
`apply` complexity 17 > 15, fixed by extracting `restoreWhileEditing`), `knip`, `jscpd`, `depcruise`, `audit` PASS.
`test:coverage`: first run PASS (389 files, 8757 passed); later runs fail only on timeouts of unrelated tests under load
(`lute-code-cache`, `toolbar-overflow`), which pass alone (63/63). `check:coverage-modules`: first run FAILED on
`front-matter-entry.ts` at 0% (fixed by a unit test of the entry); it could not be re-run to a clean pass because the
coverage runs timed out under load, so that stage has no passing run after the fix.
`typecheck:strict` stays red on the pre-existing `finish-init.ts` `installSectionIndent(innerVditor(), …)` error (1 error in
files this task touches, unchanged).

## Closure (2026-11-08)

Shipped the properties table (every box in "Properties table rendering" is ticked). The alias and tag scope moved to [Task 709](../709-front-matter-aliases-and-tags-resolution.md); the CMS follow-ups stay separate and open.

- Real VS Code: `front-matter-table.spec.ts` 12/12 with `--repeat-each=2` (IR, WYSIWYG, Split preview, Preview, malformed, TOML).
- Chromium `front-matter-table.spec.ts` 18/18; Vitest `front-matter-table.test.ts` 40/40.
- `npm run quality` on the final tree: all 8 stages pass, including `test:coverage` and `check:coverage-modules` (9 modules at 0%, baseline 9).
- `typecheck:strict` keeps the pre-existing `finish-init.ts` error; it is not part of the quality gate.
- The `rewrap.spec.ts:116` failure in the combined run belongs to the caret-restore family of Task 708; its document has no front matter.
- Follow-up recorded, not in scope: write-back drops the blank line after the closing `---` after an edit elsewhere, with or without the table (existing edit-sync behaviour).
- `media/codicons.LICENSE` keeps its original line endings; only the notice line for the copy and check icons is added.
