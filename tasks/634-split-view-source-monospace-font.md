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
