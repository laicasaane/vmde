# Vditor bump checklist — every source patch, one row each

> Companion to [ADR-0004](adr/0004-patching-vditor.md) (why we patch at build time instead of
> forking) and [task 147](../tasks/done/147-patch-engine-hardening.md) item 5. ADR-0004 explains the
> *mechanism*; this page is the *procedure* — what to re-verify when `media-src/node_modules/vditor`
> is bumped to a new version.
>
> **Source of truth:** `media-src/esbuild-shared.mjs`, `VDITOR_TS_PATCHES` (registry starts
> ~line 1728) and the `patchXxx` functions above it (~line 130 onward). This table was built by
> reading every one of those functions directly (2026-07-28) — treat a mismatch between this table
> and the source as the source winning, and re-sync this page.

## The real count (the task text says 23, then 47 — both are stale)

- **29 registry entries** — one per distinct vendored `.ts` file (a file can only have ONE entry;
  see task 147 item 3, enforced by a test that no two entries' `file` regex match the same path).
- **49 `patchXxx`-named functions** are defined in the file. Of those:
  - **48** are wired into a registry entry's `transform`, directly or as a single-level nested call
    (a few entries chain 2–5 patches over the same file because esbuild only runs the *first*
    matching `onLoad` per file — chaining is how a second patch on an already-patched file works).
  - **1** (`patchNativeDiagramError`) is a private, unexported helper — it is never itself referenced
    by the registry; it is shared logic called *by* two of the 48 (`patchEchartsErrorBox`,
    `patchMindmapErrorBox`). Whether you count it as "a 49th patch" is a matter of taste; it does not
    have its own registry-facing anchor, so it is listed here folded into its two callers.
- `patchDeferGetMarkdown` is used by **two** registry entries (`wysiwyg/afterRenderEvent.ts` and
  `sv/process.ts`) with a `fileLabel` parameter — one function, two call sites, two independent
  anchor checks (one per file).

**When you bump Vditor:** run `node build.mjs`. Every `patchXxx` throws a named
`"… (version drift?)"` error the instant its anchor goes missing (see the Silent? column below for
the handful of documented exceptions) — the build fails at the exact function that needs attention,
so work through the errors one at a time rather than pre-emptively reading all 48. This table is for
when you *are* reading them — to know which anchors are cosmetic (expect to re-pin a version/string)
versus structural (a real drift signal worth investigating), and which of the two non-throwing
exceptions to check by hand.

## Fragility legend

| Tag | Meaning |
|---|---|
| **S** | Structural — anchors on a real, single-line piece of Vditor source (a call, an import, a signature). Most robust; breaks only if Vditor actually changes that code. |
| **WS** | Whitespace-sensitive multiline — anchors on a 2+ line *exact* literal block (baked-in indentation/line breaks). Still real Vditor source, not cosmetic — but a Vditor-side reformat (prettier/biome re-wrap, indent-width change) can trip it even when the logic is unchanged ("false drift"). This category is **much bigger than task 147 item 4 catalogued** (it named only one, `patchMindmapThemeColors`) — see "Beyond item 4" below. |
| **V** | Version-literal cosmetic — anchors a `?v=<version>` cache-buster string. Expected to need re-pinning on every relevant vendor bump; not a real drift signal. |
| **I18N** | Translated/non-ASCII UI text — anchors Chinese copy Vditor never routed through its i18n table. Breaks on any Vditor copy change, not just a version bump. |
| **CHAIN** | Anchors on the *output of another patch in the same chain*, not raw Vditor source — see `patchCutDeleteSync` below. Different risk: it can't drift from a Vditor bump, only from reordering/editing the chain itself. |

## Registry entries and their functions

### 1. `undo/index.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchDmpInterop` | `import * as DiffMatchPatch from "diff-match-patch";` | S | `diff-match-patch`'s CJS export isn't callable as an ES namespace object — `new DiffMatchPatch()` throws "is not a constructor" and undo breaks. Rewrites to a default import. | Yes |

### 2. `ir/index.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchIrLinkClick` | `if (aElement && (!aElement.classList.contains("vditor-ir__node--expand"))) {` | S | Gates link-open on the `linkOpenWithModifier` policy in IR mode; without it every click opens the link regardless of the setting. | Yes |

### 3. `wysiwyg/index.ts` (chained: `patchWysiwygCodeClickCaret(patchWysiwygLinkClick(code))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchWysiwygLinkClick` | 2-line literal, `const a = hasClosestByMatchTag(…);\n            if (a) {` (exact 12-space indent) | WS | WYSIWYG twin of the IR link-open gate. | Yes |
| `patchWysiwygCodeClickCaret` | 3-line literal, `if (previewElement) {\n                showCode(…);\n            }` (exact 16/12-space indent) | WS | Clicking into a WYSIWYG code-block preview lands the caret at block START (Vditor's `showCode` always collapses to the start) instead of the clicked position. | Yes |

### 4. `util/fixBrowserBehavior.ts` (chained: `patchPasteUrlAsLink(patchCalloutArrowNav(patchListToggle(code)))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchListToggle` | `item.querySelector("input").remove()` | S | Null-deref crash toggling a checkbox list item whose sibling `<li>` has no checkbox. | Yes |
| `patchCalloutArrowNav` | 4 anchors: `ARROW_DOWN_ANCHOR` (2-line, exact 8-space continuation indent — **WS**), `ARROW_AFTER_SPLICE_ANCHOR` / `ARROW_BEFORE_SPLICE_ANCHOR` (single-line — **S**), `INSERT_AFTER_EXPORT_ANCHOR = 'export const insertAfterBlock = '` (single-line, real export signature — **S**, the task's own "robust anchor" example) | WS (1 of 4) + S (3 of 4) | Arrow-nav out of a callout (dual-node preview duplicates text so the "last line" check never passes) and across the invisible `#fix-table-ir-wrapper` helper (would otherwise scroll-jump to top). | Yes (any of the 4 missing throws) |
| `patchPasteUrlAsLink` | 3-line literal `PASTE_LINK_ANCHOR` (exact indent) | WS | Pasting a bare URL with nothing selected left it as plain text instead of `[url](url)`. | Yes |

### 5. `toolbar/Outline.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchOutlineCurrent` | `if (vditor.options.outline) {` | S | Outline toolbar button shown "active" (blue) even when the outline panel is disabled — `options.outline` is an always-truthy object, not a boolean. | Yes |

### 6. `util/editorCommonEvent.ts` (chained: `patchCutDeleteSync(patchClipboardCollapsed(patchIrBlurExpand(code)))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchIrBlurExpand` | `expandElement.classList.remove("vditor-ir__node--expand");` | S | Transient blur→refocus (webview OOPIF click) flashes the syntax-highlighted render because `--expand` is dropped on every blur, not just a real one. | Yes |
| `patchClipboardCollapsed` | 3 anchors: `COPY_EVENT_ANCHOR` (single-line — **S**), `CUT_EVENT_ANCHOR` (2-line, exact indent — **WS**), `CUT_DELETE_ANCHOR` (single-line — **S**) | WS (1 of 3) + S (2 of 3) | Ctrl+X with a collapsed caret silently ate one character (`copy()` early-returns on empty selection but the `execCommand("delete")` ran anyway); also expands collapsed copy to the line. | Yes (any of 3 missing throws) |
| `patchCutDeleteSync` | `CUT_SYNC_DELETE_ANCHOR` — the exact replacement text **produced by `patchClipboardCollapsed` above**, not raw Vditor source | **CHAIN** (new finding — not in item 4's catalogue) | Cut with a real selection lost part of it (`execCommand("delete")` silently refused as re-entrant by Chromium inside the VS Code webview); replaces it with `Range.deleteContents()` + manual re-drive of the IR/WYSIWYG input pipeline. | Yes — but note it can only ever drift from **this patch chain being reordered or `patchClipboardCollapsed`'s output text changing**, never from a Vditor version bump. Worth a comment at the call site saying so explicitly (currently undocumented as a general pattern; `patchFlowchartTheme` documents its own ordering dependency, this one doesn't). |

### 7. `util/selection.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchInsertHtmlDelete` | 4-line literal, exact indent | WS | Pasting over a selection inserted before it and ate a trailing character (same re-entrant-`execCommand` root cause as `patchCutDeleteSync`). | Yes |

### 8. `sv/index.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchSvCopyGuard` | 4-line literal, exact indent | WS | Ctrl+C with nothing selected in split view **wiped** the system clipboard (`setData("text/plain", "")` unconditionally). | Yes |

### 9. `markdown/mathRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchMathRender` | `katex.renderToString(math, {` | S | One malformed formula threw and broke the whole render instead of KaTeX's own inline error box. | Yes |

### 10. `markdown/setLute.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchLuteHook` | three single-line checks: `const lute: Lute = Lute.New();`, `lute.SetCallout(options.callout);`, and `    return lute;` | S | Hands every created Lute instance to our code (`__vmdePatchLute`) so the inline-code-gap wrapper is in force for the FIRST render, and disables Vditor 3.11.3's native callout DOM so the repository's cross-mode callout parser/decorator remains the sole owner. | Yes |

### 11. `preview/index.ts` (chained: `patchPreviewComments(patchPreviewMorph(patchPreviewCopyClipboardData(patchPreviewCopyTip(code))))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchPreviewCopyTip` | `已复制到剪切板` (Chinese literal) | **I18N** | Hardcoded Chinese "copied to clipboard" toast shown to English-locale users (not routed through Vditor's i18n table). | Yes |
| `patchPreviewCopyClipboardData` | 2-line literal, exact indent | WS | Split-preview-pane copy silently did nothing (`execCommand("copy")` refused as re-entrant, but `preventDefault()` still ran so the native copy never happened either). | Yes |
| `patchPreviewMorph` | 4-line literal, exact indent | WS | Every debounced preview settle tore down the WHOLE pane via `innerHTML=`, re-initialising leaflet/three.js/echarts on every keystroke-settle. Routes through the block-diff morph when installed. | Yes |
| `patchPreviewComments` | `const markdownText = getMarkdown(vditor);` (asserted) **plus** an unguarded second `.replace('import {getMarkdown} from "../markdown/getMarkdown";', …)` to add its own import | S (asserted half) / **unguarded** (import half — new finding) | Lute's `sanitize:true` preview sanitiser drops HTML comments outright; masks them into a kept `<div>` first. | Yes for the asserted half. The **import-splice has no anchor check of its own** — if that exact import line ever changes shape, the added import silently doesn't land, and `vmMaskCommentsForPreview` would be referenced but undefined. In practice this surfaces as a **ReferenceError at module load** (not a silent no-op — it fails, just without the deliberate `"(version drift?)"` label the rest of the registry gives you), so it's a *lesser* gap than a true silent no-op, but worth tightening to match the pattern. |

### 12. `markdown/codeRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchCodeRenderSkipDiagram` | 4-line literal, exact indent | WS | A diagram's embedded markdown-label code block (d2 `\|md\|`) got a spurious copy button injected into the rendered SVG. | Yes |
| `patchCodeRenderTextContent` | `let codeText = e.innerText;` and `codeText = codeElement.innerText;` | S (exact statements) | Synchronous layout reads in ordinary/highlight-chroma copy extraction; retain ordinary newline trim and highlight line-number removal. | Yes |

### 13. `util/processCode.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchProcessCode` | 3 anchors via `indexOf`: `PC_DETECT_START` (single-line — **S**), `PC_DETECT_END` (`\n    if (isCode) {`, short literal with baked-in newline+indent — **WS**), `PC_FN_ANCHOR` (real export signature — **S**) | WS (1 of 3) + S (2 of 3) | Paste heuristic misclassified markdown-with-HTML / math as a code block from IDE-source markers alone; replaced with content-based detection (ports upstream PR #1921). | Yes |

### 14. `ir/process.ts` (chained: `patchIrLinkSelectedUrl(patchIrInputSerialize(code))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchIrInputSerialize` | 2 anchors via `indexOf`: `IR_INPUT_START` (single-line — **S**), `IR_INPUT_END` (2-line literal with baked-in newline+indent — **WS**) | WS (1 of 2) + S (1 of 2) | Perf: IR re-serialized the WHOLE document to markdown on every keystroke even though nothing consumed the result (counter/cache off). | Yes |
| `patchIrLinkSelectedUrl` | single-line literal (exact indent, one line) | S | Link toolbar button put a selected URL in the label instead of the destination (`[url](https://)` instead of `[url](url)`). | Yes |

### 15. `wysiwyg/toolbarEvent.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchWysiwygLinkSelectedUrl` | `                node.setAttribute("href", "");` | S | WYSIWYG twin of `patchIrLinkSelectedUrl`. | Yes |

### 16. `ir/input.ts` (chained: `patchIrLocalMarkerReconcile(patchIrListMarkerOnSpace(patchIrFenceSpinSkip(patchIrStripPreviewSpin(patchDeferRenderToc(patchIrSpaceSerialize(patchIrDeferDiagramRender(code)))))))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchIrDeferDiagramRender` | 3-line literal (template, exact indent) | WS | Perf: every diagram preview inside IR re-rendered on every keystroke (mermaid ~670 ms/keystroke) instead of deferring to the edit-settle gate. | Yes |
| `patchIrSpaceSerialize` | `vditor.options.input(getMarkdown(vditor));` — count-asserted **exactly 2** occurrences | S | Perf: the space fast-path synchronously serialized the whole doc on essentially every inter-word space, result discarded. | Yes (throws if count ≠ 2, not just "missing") |
| `patchDeferRenderToc` | `renderToc(vditor);` | S | Perf: a second full GopherJS spin + heading-id rewrite ran on every keystroke regardless of whether a ToC/outline exists. | Yes |
| `patchIrStripPreviewSpin` | `html = vditor.lute.SpinVditorIRDOM(html);` — count-asserted **exactly 1** | S | Perf: the per-keystroke spin re-tokenized the already-rendered diagram preview subtree (thousands of nodes) for nothing; strips it first. | Yes |
| `patchIrFenceSpinSkip` | `export const input = (vditor: IVditor, range: Range, ignoreSpace = false, event?: InputEvent) => {` (real signature) | S | Lets a caller predicate skip the entire per-keystroke spin+rebuild for inert keystrokes inside a fenced diagram/code body. | Yes |
| `patchIrListMarkerOnSpace` | `if (endSpace && /^#{1,6} $/.test(blockElement.textContent)) {` | S | Widens Vditor's heading carve-out so ordered and unordered list markers form on the typed space. | Yes |
| `patchIrLocalMarkerReconcile` | the exact 3-line global `.vditor-ir__node--expand` removal loop, count-asserted **exactly 1** | WS | Leaves expanded-marker identity and dwell with `editor-caret.ts` instead of scanning and collapsing the whole editor on every input. | Yes (throws if count ≠ 1) |

### 17. `wysiwyg/afterRenderEvent.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchDeferGetMarkdown` (fileLabel = `wysiwyg/afterRenderEvent.ts`) | `const text = getMarkdown(vditor);` — count-asserted **exactly 1** | S | Perf parity with #21: WYSIWYG computed a full-doc serialize on every input event when nothing consumed it. | Yes |

### 18. `sv/process.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchDeferGetMarkdown` (fileLabel = `sv/process.ts`) | same anchor, independent per-file count assert | S | Same perf fix, SV pane. | Yes |

### 19. `toolbar/Info.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchInfoDialog` | `indexOf` pair `vditor.tip.show(\`` / `` `, 0); `` (structural template-literal delimiters — **S**) **plus** a hard non-ASCII guard `组件版本` ("component version" — **I18N**, newly catalogued by task 147 item 4) | S + I18N | Vditor's About dialog is hardcoded Chinese, points its logo at a CSP-blocked `unpkg` URL, and interpolates a stale `Lute.Version` tag. Replaces the whole dialog body with a translated, corrected one (logo local, version = vendored commit+date). | Yes (either anchor missing throws) |

### 20. `markdown/mermaidRender.ts` (chained: error-box patch, then conditionally the version bump)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchMermaidErrorRender` | 3 checks: `'errorElement.outerHTML'` (literal — **S**), `MERMAID_CATCH_RE` (a **regex** spanning the whole catch block, non-greedy to a specific end call — more reformat-tolerant than an exact literal, still keyed on real method names — **S**), `MERMAID_START_ON_LOAD = 'startOnLoad: false,'` (single-line — **S**) | S | Mermaid's raw "bomb" error SVG + a `.replace(/\n/, "<br>")` bug (no `/g` — only the first newline survives) dumped into a bare `<small>`; also crashes if `errorElement` is null. Replaces with the shared themed `.vmde-diagram-error` box. | Yes |
| `patchMermaidVersion` | regex `/mermaid\.min\.js\?v=[\d.]+/` | **V** | Cache-buster bump so a stale webview can't serve an old vendored mermaid across an extension update. Only invoked when `mermaidPin?.version` is set. | Yes (when invoked) |

### 21. `markdown/markmapRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchMarkmapStatic` | `MARKMAP_CREATE_ANCHOR` / `MARKMAP_SETDATA_ANCHOR` (single-line — **S**), `MARKMAP_RENDER_DIV_ANCHOR` (single-line substring — **S**), `MARKMAP_SCRIPT_ANCHOR` (template-literal fragment, checked only if a version pin exists — **V**) | S (3 of 4) + V (1 of 4, conditional) | (a) markmap's uncontrolled d3-zoom hijacked page-scroll + a jarring init animation — Ctrl-to-interact gate + `duration:0`; (b) idempotence — markmap *checks but never sets* `data-processed`, so a later pass re-rendered onto its own output; (c) SVG height clipped the tree at the bottom; (d) optional `?v=` cache-buster. | Yes throughout — create/setData throw together; the render-div check has its own explicit "idempotence guard not applied" message; the script anchor throws if a version is pinned but the anchor is missing. |

### 22. `markdown/graphvizRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchGraphvizRender` | `` addScript(`${cdn}/dist/js/graphviz/viz.js` `` (single-line — **S**) | S | ⚠️ **Whole-function replacement**, not a surgical patch (task 144 item 1 / task 147 item 2's other flagged case) — once matched, the *entire* vendored `graphvizRender` export is discarded and re-exported from `media-src/src/graphviz-render.ts`. The anchor only proves the file/export still exists; it does not reuse any of the matched logic. Replaces Vditor's Worker-based old `viz.js` (blob `importScripts` hangs cross-origin in the VS Code webview) with a modern `@viz-js/viz` inline renderer. | Yes |

### 23. `markdown/highlightRender.ts` (chained: `patchHighlightLanguageClass(patchHighlightSkipDiagrams(code))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchHighlightSkipDiagrams` | `if (block.parentElement.classList.contains("vditor-ir__marker--pre") ||` | S | hljs descended into rendered diagram SVGs (d2 `\|md\|` labels) and injected code-panel styling onto diagram label text. | Yes |
| `patchHighlightLanguageClass` | `let language = block.className.replace("language-", "");` | S | A SECOND highlight pass over an already-`hljs`-classed block (reachable once the task-187 preview morph reuses live DOM) computed a garbage language (`"js hljs"`) from the whole className and silently lost all syntax colouring. | Yes |

### 24. `markdown/flowchartRender.ts` (chained: `patchFlowchartTheme(patchFlowchartError(code))`)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchFlowchartError` | 4-line literal, exact indent | WS | flowchart.js has NO catch around parse/render — a syntax error propagated uncaught, leaving a blank/broken block. Wraps in try/catch → themed error box. | Yes |
| `patchFlowchartTheme` | `flowchartObj.drawSVG(item);` — matches the **original Vditor line**, which survives verbatim inside `patchFlowchartError`'s new `try` block (documented ordering dependency: registry comment explicitly says `patchFlowchartError` must run first) | S (but registry-order-dependent, documented) | flowchart.js hardcodes `#000` lines/text + white fill, invisible on dark themes; drives colours from the resolved theme via a global hook. | Yes |

### 25. `markdown/plantumlRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchPlantumlRender` | `plantumlEncoder.encode(text)` | S | ⚠️ **Whole-function replacement** (task 144 item 1 / task 147 item 2, same caveat as graphviz above) — replaces Vditor's remote-`<object data="https://plantuml.com/…">` renderer (blocked by `object-src 'none'` + a privacy leak) with the local offline TeaVM engine. | Yes |

### 26. `markdown/abcRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchAbcRender` | `ABC_RENDER_ANCHOR` (single-line, real call — **S**) + `ABC_SCRIPT_ANCHOR` (`` abcjs_basic.min.js`, "vditorAbcjsScript" ``, checked only if a version is pinned — **V**) | S + V (conditional) | (a) abcjs hardcodes black ink, illegible on dark themes — themed `foregroundColor`; (b) missing `?v=` cache-buster. Historical note in the source: the ORIGINAL script anchor used a double quote and never matched the real backtick-quoted line — silently dead until the 185/3c hardening turned that into this throw. | Yes (both halves) |

### 27. `markdown/SMILESRender.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchSmilesVersion` | `smiles-drawer.min.js?v=2.1.7` | **V** | Cache-buster bump; this was task 147 item 1's original silent hole (`if (!code.includes(anchor)) return code`), now fixed to throw. | Yes when a version is pinned. **Legitimately** returns the code unchanged (not a drift hole) when `version` is falsy — there is nothing to bump if no vendor pin exists. |

### 28. `markdown/chartRender.ts` + `markdown/mindmapRender.ts` + `devtools/index.ts` (one filter matches all 3; transform branches per-path)
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchEchartsVersion` | `code.includes('echarts.min.js?v=')` then a global regex replace | **V** | 3 separate ECharts loaders (chart/mindmap/devtools) share one script-id cache-buster; bumps all of them. Only invoked when `echartsPin?.version` is set. | Yes (when invoked) |
| `patchEchartsThemeInit` | `ECHARTS_INIT_ANCHOR` regex `echarts\.init\(e,\s*theme === "dark" \? "dark" : undefined\)` (tolerant of internal whitespace — **S**), **plus** a per-file-guarded `.replace(ECHARTS_ANIMATION_ANCHOR, …)` where `ECHARTS_ANIMATION_ANCHOR = '.setOption(option)'`, gated on `CHART_RENDER_FILE_RE = /[/\\]chartRender\.ts$/.test(path)`, with `path` itself now **required** (throws if falsy) | S | Asserted half: `echarts.init` hardcoded dark/light instead of the VMDE-resolved palette. Animation half: forces `animation:false` on the chart entry animation. **Fixed by [task 418](../tasks/done/418-unguarded-echarts-setoption-rewrite.md) (2026-07-28, two passes same day):** this used to be an unguarded `.replace` whose silence on `mindmapRender.ts` (object-literal `.setOption({…})` never matches the `.setOption(option)` identifier form) was *both* the intended mindmap exclusion *and* an undetectable hole if `chartRender.ts` itself ever reformatted. Pass 1: the function takes `path`, asserts+throws the animation anchor only when `path` is `chartRender.ts`, and explicitly skips the rewrite for every other file — the mindmap exclusion is a named branch, not an incidental non-match. Pass 2 (same-day review caught it): the first pass's own `path || ''` fallback silently skipped the guard if `path` itself were ever missing — the identical failure mode one level up. Now `path` is required (throws a named error if falsy); a registry-level test drives the actual `VDITOR_TS_PATCHES` entry's `transform(code, path)` over real vendored source (not just a hand-called unit) to prove the wire, since `patch-mutation.test.ts`'s "mutates at least one file" check can't see this class of drop. Real-source assertions added both ways (chartRender.ts has the literal, mindmapRender.ts doesn't) in `test/backend/vditor-source-patches.test.ts`. |
| `patchEchartsErrorBox` (→ `patchNativeDiagramError`) | multi-line literal built around the English (not translated) string `echarts render error` | WS | Chart parse/`setOption` failure dumped raw, unstyled error text (`vditor-reset--error` class). Replaces with the shared `.vmde-diagram-error` box. | Yes |
| `patchMindmapThemeColors` | `MINDMAP_COLORS_ANCHOR` — a 12-line exact-whitespace `itemStyle`/`label`/`lineStyle` block | **WS** (already flagged by task 147 item 4) | mindmap `tree` series hardcodes GitHub-light node/label/line colours; ECharts doesn't apply the registered theme's categorical palette to `tree` node symbols, so merely stripping the hardcode would leave grey defaults — drives colours from `window.__vmdeMindmapStyle` instead. | Yes |
| `patchMindmapErrorBox` (→ `patchNativeDiagramError`) | same helper, string `mindmap render error` | WS | Mindmap twin of the echarts error box. | Yes |

### 29. `ui/setContentTheme.ts`
| Function | Anchor | Fragility | Guards | Fail-loud? |
|---|---|---|---|---|
| `patchSetContentTheme` | `vditorContentTheme.getAttribute("href") !== cssPath` | S | Needless stylesheet teardown + re-fetch on init (comparing raw href strings instead of resolved URLs) caused a ~100 ms flash of wrong colours before the content theme applied. | Yes |

## Beyond task 147 item 4's catalogue — new findings from reading all 48 functions

Item 4 (2026-07-27) grepped for three known fragility *signals* (version literals, non-ASCII text,
one specific known whitespace-sensitive block) rather than reading every function body. Having now
read all of them, three things weren't visible to that grep:

1. ~~**`patchEchartsThemeInit`'s second `.replace('.setOption(option)', …)` is genuinely silent**~~
   — **fixed by [task 418](../tasks/done/418-unguarded-echarts-setoption-rewrite.md) (2026-07-28).** It
   now takes `path`, asserts+throws on the animation anchor only for `chartRender.ts`, and
   explicitly (not incidentally) skips the rewrite for every other file — see entry 28 above.
2. **`patchPreviewComments`'s import-splice has no anchor guard of its own** — only the
   `markdownText` rewrite is asserted. A drift here fails as an unlabelled `ReferenceError` at module
   load rather than the deliberate `"(version drift?)"` throw every other patch gives you.
3. **`patchCutDeleteSync` anchors on another patch's OUTPUT, not raw Vditor source** — a chain-order
   dependency (`patchCutDeleteSync` must run after `patchClipboardCollapsed` within the same
   `util/editorCommonEvent.ts` transform). It is fail-loud, but the failure mode it guards against is
   "someone reorders or edits the chain," not "Vditor bumped its version" — worth a comment at the
   call site the way `patchFlowchartTheme`'s ordering dependency already has one.
4. **The whitespace-sensitive-multiline (`WS`) category is far larger than the single anchor item 4
   named** (`patchMindmapThemeColors`). At least a dozen more patches key on 2–4 line *exact*
   literal blocks with baked-in indentation (see the `WS` tags throughout the tables above) — all
   real Vditor source, so not "cosmetic" in item 4's sense, but still capable of "false drift" if
   Vditor's own repo ever reformats without changing logic. None of this needs action now; it's
   listed so a future bump that throws on one of these knows to check "did the logic change, or just
   the whitespace" before assuming real drift.

None of the above are new *bugs* — `patchEchartsThemeInit`'s silence is intentional and documented in
its own comment, and the other two are true edge cases, not observed failures. They're flagged here
because task 147's whole point was surfacing exactly this class of thing before a version bump finds
it the hard way.

## Whole-function-replacement risk (tracked separately, task 144)

Two patches (`patchGraphvizRender`, `patchPlantumlRender`) don't graft a change into the matched
file — they discard the entire matched export and substitute a re-export shim to a real, typed,
unit-tested module (`media-src/src/graphviz-render.ts`, `media-src/src/plantuml-render.ts`). This is
qualitatively different from the other 46: the anchor only proves the file/export still exists, not
that any of its logic survived. Already tracked as its own item — [task 144](../tasks/done/144-plantuml-architecture-hardening.md) item 1 — not duplicated here beyond this cross-reference.
