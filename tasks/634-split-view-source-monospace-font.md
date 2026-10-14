# Task 634 — Monospace font setting for the Split View source panel

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner feature request (chat, 2026-10-14).
**Severity:** feature (low risk).
**Tech stack:** extension host configuration (`package.json` contributions, `src/platform/editor-config.ts`, `src/app/markdown-editor-provider.ts`, `src/webview-host/html-builder.ts`), webview CSS (`media-src/src/main.css`), Vitest, Chromium, real VS Code.

## Problem

In Split View (SV) mode, the markdown source panel on the left uses the content font. Source text is easier to read and align in a monospace font. The Owner wants the left source panel to use a monospace font that is configured by a VMDE setting, not by VS Code's `editor.fontFamily`.

## Requested behavior

- The SV source panel (left) uses a monospace font.
- A new VMDE setting configures that font. It does not read or follow VS Code's editor font.

## Default decisions (Project Owner may override)

- Setting `vmde.editor.sourceFontFamily` (string, scope `resource`), placed with the other `vmde.editor.*` settings. Default: `ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace`. An empty value falls back to the default.
- The value is sanitized like the existing font-family settings (`sanitizeFontFamily` in `src/webview-host/html-builder.ts`) and passed to the webview as a CSS custom property (for example `--vmde-source-font-family`).
- It applies only to the SV source panel. The SV preview panel, IR and WYSIWYG keep their current fonts. Font size keeps following `vmde.editor.fontSize`.
- A settings change applies to open editors the same way `vmde.editor.fontSize` does today (live if that setting is live, otherwise on reopen; Part 1 confirms).
- The setting is documented in the README settings list.

## Acceptance

- [ ] `vmde.editor.sourceFontFamily` is contributed, documented and read through `editor-config.ts`; invalid or empty values fall back safely.
- [ ] In SV the left source panel's computed `font-family` is the setting's value; the preview panel, IR and WYSIWYG are unchanged.
- [ ] Changing VS Code's `editor.fontFamily` does not change the SV source panel font.
- [ ] Changing the VMDE setting updates the panel per the confirmed update rule.
- [ ] Caret position, selection and line wrapping in the SV source panel still work (Task 619/614 SV specs stay green).
- [ ] Focused real-VS-Code spec written and run; `npm run quality` passes.

## Tests

- Vitest: config resolution and sanitizing (default, custom, empty, hostile values), HTML/CSS variable output.
- Chromium harness: SV source panel computed font; preview panel unchanged.
- Real VS Code (`test/vscode-e2e/`, related: `sv-split.spec.ts`, `font-parity.spec.ts`): computed font in SV with the default and a custom value, unaffected by `editor.fontFamily`. Run `node build.mjs` first, then the spec under `xvfb-run`.

## Part 1 handoff (2026-10-14)

Read-only review of the source; nothing was run.

- **Entry points (verified).** The SV source panel is `<pre class="vditor-sv vditor-reset">` directly under `.vditor-content` (vendored Vditor `ts/sv/index.ts`, `ts/ui/initUI.ts`); the preview is a separate `.vditor-preview`, so `.vditor-sv` selects the source panel only. Today three `!important` rules compete for its `font-family`: the patched `.vditor-reset` (`build.mjs`, `var(--vscode-editor-font-family)`, specificity 0,1,0), `body[data-use-vscode-theme-color="1"] .vditor .vditor-reset` and `body.markdown-body .vditor .vditor-reset` (`media-src/src/main.css`, both 0,3,1). Font size already follows `vmde.editor.fontSize` through `--me-font-size`.
- **Plumbing to copy.** Initial paint: the `<body style>` string in `src/webview-host/html-builder.ts` (emits `--me-font-size`, `--me-markdown-preview-font-family` through the private `sanitizeFontFamily`). Host config: `HtmlBuildConfig`, call site in `src/app/markdown-editor-provider.ts`, `collectConfigOptions` in `src/platform/editor-config.ts` (resource scope via `cfgFor(uri)`), type `VmdeConfigOptions` in `src/shared/protocol.ts`. Shared resolver pattern: `resolveMarkdownPreviewFontFamily` in `src/shared/theme-registry.ts`. Live path: `onDidChangeConfiguration` (`src/session/editor-session.ts`) → `postLiveConfig` (`src/webview-host/panel-config.ts`) → `handleConfigChanged` (`media-src/src/bridge/message-router.ts`) → `applyBodyOptions` (`media-src/src/boot/live-config.ts`); only `INIT_ONLY_OPTIONS` re-initialise, so a body variable updates live with no reopen. Manifest: no `package.nls*.json`; descriptions are inline English; `vmde.editor.fontSize` has `order: 4`, `4.5` is free; guards in `test/backend/manifest.test.ts` and `test/backend/config-keys.test.ts`. README has no per-setting list (generic Configuration paragraph; the Split bullet describes Split).
- **Contract.**
  1. Setting `vmde.editor.sourceFontFamily`: string, `resource` scope, `order: 4.5`, Editor group, default the record's stack; read only through `collectConfigOptions`.
  2. New shared resolver in `src/shared/theme-registry.ts`: `DEFAULT_SOURCE_FONT_FAMILY` and `resolveSourceFontFamily(value: unknown)`: a non-string, empty or whitespace-only value gives the default; otherwise replace `[;<>{}\r\n]` with a space, trim, and fall back to the default if empty. Used by host and webview so the live `style.setProperty` path is sanitised too; `html-builder.ts` keeps its attribute escaping.
  3. CSS variable `--me-source-font-family` (refined from the record's example name: host-driven body variables use the `--me-` prefix; `--vmde-*` is the theme palette namespace).
  4. CSS in `media-src/src/main.css` next to the font rules, with a reason comment, indicatively `body .vditor .vditor-content > .vditor-sv.vditor-reset { font-family: var(--me-source-font-family, <default>), monospace !important; }` (0,4,1 with `!important`, beating the three competitors in the `auto`, named-theme and plain states). The trailing `monospace` keeps a custom stack without a generic family monospace.
  5. SV source panel only; preview, IR and WYSIWYG unchanged; size still follows `vmde.editor.fontSize`. Update rule: live, no reopen.
- **Part 2.** S1: `package.json` property; resolver and constant; `sourceFontFamily?: string` in `VmdeConfigOptions`; `collectConfigOptions`; `HtmlBuildConfig.sourceFontFamily` and the body-style variable; `BodyOptions` and `setVar('--me-source-font-family', …)` in `live-config.ts`; add the key to `ALL_OPTION_KEYS` and `KNOWN_NON_DIAGRAM_KEYS` in `media-src/src/diagram-kit/diagram-config-delta.test.ts` (compile-forced); update `test/backend/html-builder.test.ts` defaults. Vitest: resolver (default, custom, empty, whitespace, number, array, `a;b`, `}</style><script>`, newline, quotes, `url(x)`, punctuation-only), html-builder emission and escaping, resource-scoped folder override (`test/backend/resource-scoped-config.test.ts`), `applyBodyOptions` (set, empty restores default, unchanged not rewritten), manifest (declared, string, resource scope, default equals the constant, concise-description pin list). S2: the CSS rule; new Chromium spec (e.g. `media-src/e2e/sv-source-font.spec.ts` on the split harness): computed family of `.vditor-sv` equals the value in all three cascade states, `.vditor-preview .vditor-reset` unchanged, every text descendant of `.vditor-sv` reports the same family (probe for a `code` descendant that Vditor's `code:not(.hljs)` rule could restyle), IR/WYSIWYG/preview not matched. S3: new `test/vscode-e2e/sv-source-font.spec.ts` (default family; custom value applied live; VS Code `editor.fontFamily` change does not affect it; preview unchanged; `auto` and a named content theme; clearing restores the default; hostile value leaves the page intact; settings restored in `afterEach`), then rerun real VS Code `cut-selection-sv`, `clipboard-collapsed`, `sv-split`, `sv-source-link-activation`, `sv-streaming`, `mode-roundtrip` (and the SV legs of `rewrap`/`auto-wrap`, known pre-existing failures) and Chromium `copy-cut`, `copy-cut-probes`, `split-scroll`, `auto-wrap`. S4: README sentence, closure.
- **Edge cases.** Empty, whitespace, non-string, stripped-only values give the default; quoted family names survive (assert on the decoded string); an uninstalled family falls back to `monospace`; an invalid computed value (`url(x)`) drops the declaration with no fetch; multi-root folder override wins; the instant-paint overlay renders IR markup and cannot show the font (one-frame change at the swap, visual only, noted for closure); monospace changes wrap points, not the wrap mechanism; SV heading spans use `em` sizes.
- **Owner questions (provisional choices, reversible).** (1) README: one sentence in the Split bullet, no new settings list — adopted. (2) Variable name `--me-source-font-family` — adopted. (3) Trailing `, monospace` in the CSS — adopted. (4) No localization file; inline English description like the sibling settings — adopted.

## Execution progress — 2026-10-14 (S1)

S1 done: the setting, the shared resolver, host config, the initial-paint variable and the live webview path. The CSS rule is not part of S1 (S2).

- **Files.** `package.json` (`vmde.editor.sourceFontFamily`, `order: 4.5`, `scope: resource`, default stack, inline English description); `src/shared/theme-registry.ts` (`DEFAULT_SOURCE_FONT_FAMILY`, `resolveSourceFontFamily`); `src/shared/protocol.ts` (`sourceFontFamily?`); `src/platform/editor-config.ts` (`collectConfigOptions`); `src/app/markdown-editor-provider.ts` and `src/webview-host/html-builder.ts` (`HtmlBuildConfig.sourceFontFamily`, `--me-source-font-family` in the body style through the existing attribute escaping); `media-src/src/boot/live-config.ts` (`BodyOptions`, `setVar`).
- **Tests.** `test/backend/content-theme.test.ts` (resolver: default, custom, empty, whitespace, number, array, `a;b`, markup breakers, newline, quotes, `url(x)`, punctuation-only), `test/backend/html-builder.test.ts` (defaults, emission, hostile value), `test/backend/resource-scoped-config.test.ts` (folder override), `test/backend/manifest.test.ts` (declared, string, resource scope, order, default, description pin), `media-src/src/boot/live-config.test.ts` (set, empty restores default, unchanged not rewritten), `media-src/src/diagram-kit/diagram-config-delta.test.ts` (both key lists).
- **RED first.** The new tests were run before the implementation and failed (resolver missing, no emission, manifest property absent: 12 failures).
- **GREEN.** Vitest (`--config test/vitest.config.mts`) on the seven touched/related files plus `test/backend/config-keys.test.ts`: 7 files, 180 tests passed. `npm run typecheck`, `node build.mjs`, `npx biome check` on the changed files and `npm run knip`: all exit 0.
- **Not done in S1.** The CSS rule, Chromium spec, real-VS-Code spec and README sentence (S2 to S4). No real VS Code was run.

## Execution progress — 2026-10-14 (S2)

S2 done: the Split View source panel now uses the source font setting. No real VS Code was run.

- **Files.** `media-src/src/main.css` (new rule next to the font rules, with a reason comment); `media-src/e2e/sv-source-font.spec.ts` (new Chromium spec on the split harness, plus the mode round-trip harness for the IR/WYSIWYG check).
- **Rule.** `body .vditor .vditor-content > .vditor-sv.vditor-reset { font-family: var(--me-source-font-family, <default stack>), monospace !important; }` (0,4,1 with `!important`). It beats the three competing `!important` rules in the plain, `auto` (`data-use-vscode-theme-color="1"`) and named (`body.markdown-body`) states.
- **RED first.** The spec was run before the rule: 5 failures (the SV family in all three states, the empty-value default, and a synthetic code probe that was then replaced), 7 passed.
- **Descendant probe.** Every text node under `.vditor-sv` in the harness document, which includes a fenced block, reports the panel family in all three states. The real SV DOM contains no `code` or `pre` element, so Vditor's `code:not(.hljs)` stack has nothing to restyle and the rule needs no descendant extension; the spec pins that count at 0.
- **GREEN.** New spec 12 passed; `split-scroll.spec.ts` 6 passed; `copy-cut.spec.ts` 11 passed, 3 failed (`:226`, known, all modes); `auto-wrap.spec.ts` 5 passed, 1 failed (known SV leg). `npm run lint:ci` and `node build.mjs` exit 0.
- **Not done in S2.** Real-VS-Code spec (S3), README sentence and closure (S4).
