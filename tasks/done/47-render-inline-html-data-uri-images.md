# Task: Render inline-HTML / data-URI images in the webview

> **Status:** ✅ CLOSED — 2026-09-07. Lute remains sanitized; a source-preserving,
> render-only SVG presentation adapter now restores strictly safe inline-HTML SVG data
> images without widening Lute's parser policy or the webview CSP.
> **Source:** user request (2026-06-01). Surfaced when an MD report using inline
> `<img src="data:image/svg+xml;base64,…">` rendered **blank** in VMDE while
> rendering fine in a browser / VS Code Markdown preview.
> **Value / Risk:** ⚪ niche (most docs use `![](path)` / `https:` images) /
> low–medium (touches the renderer's HTML handling; keep the CSP posture intact).
> **Engines:** none.

## Problem
A markdown document containing **raw inline HTML** image tags with **data-URI**
sources — e.g. inside a table cell:

```html
<img width="24" src="data:image/svg+xml;base64,PHN2Zy…">
```

can render as an **empty cell** in VMDE. The reported source is specifically an
SVG data URI; it must not be generalized to every data URI. The same file renders
correctly in a browser and in VS Code's built-in Markdown preview.

## Diagnosis — it is NOT the CSP, and it is SVG-specific
The webview CSP **already allows** data-URI images. `src/extension.ts` (task 18
§2c) ships:

```
img-src ${csp} data: blob: https:;
```

So `data:` images are permitted at the policy layer. The blank cells come from
**Vditor's markdown→HTML pipeline**, not the CSP. A privacy-safe runtime probe
against the vendored Lute and the real Vditor Chromium harness established:

| Source and placement | `data:image/png` | `data:image/svg+xml` |
| --- | --- | --- |
| Raw `<img>` paragraph | preserved and loads | `src` removed |
| Raw `<img>` GFM table cell (Preview render) | preserved and loads | `src` removed |
| Markdown `![](...)` | preserved and loads | `src` removed |

`SetDataImage` is a Markdown parse option, not an SVG-sanitizer exception; the
default Vditor configuration already accepts PNG data images. Setting
`SetSanitize(false)` does retain SVG URLs, but is a blanket sanitizer bypass and
is not an acceptable fix. Fenced `html` remains literal source in every path.

The pinned Lute artifact is commit `8928f1866da3269aed613288afb3554985df94e1`
(`media-src/vendor/lute/source.json`). Its compiled `sanitizeAttrs` branch lowercases
and trims URL attributes, then explicitly rejects `data:image/svg+xml`,
`data:text/html`, and `javascript`. The callable API exposes only the boolean
`SetSanitize`; neither Vditor's `setLute.ts` nor the artifact exposes a safe
SVG-specific allow-list callback or option. The probe also confirmed the retained
sanitizer removes `on*` attributes. Removing the hard-coded SVG branch would require
a vendored Lute/parser change and a maintained SVG sanitizer; it is not a host/Vditor
configuration change.

This is a **renderer sanitization boundary**, independent of CSP. The live
Vditor/Lute dependency has recently had sanitizer advisories, so widening this
boundary without a dedicated, maintained SVG sanitizer would be a material
security regression.

## Goal
Decide whether VMDE should render inline-HTML images (and inline HTML more
generally) the way VS Code's Markdown preview does — and if so, enable it without
weakening the CSP/nonce model (task 18).

## Approach (investigate)
1. **Confirm the stripper.** Render a minimal doc with (a) `<img src="data:…">`
   outside a table, (b) the same inside a table cell, (c) a normal
   `![](https://…)` and `![](relative.png)`. Determine exactly what Vditor drops
   and where (table cell vs paragraph; data: vs https:).
2. **Find the Vditor knob.** Check Vditor render options for HTML passthrough /
   sanitize configuration (e.g. `preview.transform`, `preview.markdown.sanitize`,
   or a custom `renderers` hook). Vditor historically uses Lute for rendering —
   the sanitize step may be in the IR/SV/WYSIWYG render path. Identify the option
   that allows `<img data:…>` through the whitelist.
3. **Keep CSP intact.** Whatever is enabled must stay within the existing CSP
   (`img-src … data: blob: https:` already covers it). Do **not** relax
   `script-src`; this is about HTML/img sanitize, not script execution.
4. **Scope the risk.** Allowing arbitrary inline HTML can reintroduce XSS-ish
   surface (e.g. `<img onerror=…>`). Prefer a **narrow** allow (img with safe
   `src` schemes) over a blanket "disable sanitize". The CSP (`script-src` by
   nonce, `default-src 'none'`) is the backstop, but don't lean on it alone.

## 2026-09-07 probe, implementation, and regression

- [x] Confirmed the exact boundary with 1×1 self-contained PNG/SVG fixtures:
  sanitized Vditor preserves raster `data:` sources and strips SVG `data:` sources.
- [x] Added a presentation-only adapter that temporarily masks raw inline HTML SVG
  data URIs for Preview, while IR/WYSIWYG source markers remain the authored bytes.
  It creates a `blob:` URL only after strict base64/UTF-8 bounded decoding, restricted
  SVG validation, and pinned DOMPurify **3.4.13** sanitization; the URL lives only in
  a non-editable `data-render="1"` node and is revoked when that node disappears.
- [x] Kept `sanitize: true`, the vendored Lute source, and CSP unchanged. The local
  DOMPurify asset loads only when a candidate exists and inherits the document nonce.
- [x] Rejected before blob creation: scripts, event attributes, `style`,
  `foreignObject`, external references, `DOCTYPE`, malformed/oversize data, and
  non-SVG URIs. Fenced HTML remains literal.
- [x] Candidate identity probe: sanitized Preview intentionally lacks the original
  URI; IR/WYSIWYG round-trips, IR/WYSIWYG spin, and host IR all retain the raw
  inline-HTML URI. The adapter therefore never changes authored Markdown bytes.
- [x] Focused coverage: 232 unit/source-patch tests, Chromium 2/2, and focused
  no-retry real-VS-Code 1/1 passed after `node build.mjs`. Root and VS-Code spec
  typechecks plus the module manifest passed.

## Decision notes
- Most real markdown uses `![alt](path-or-url)` images, which already work. This
  task only matters if users paste **inline-HTML** images or **data-URI** assets
  (self-contained docs, generated reports, some export formats).
- If the risk/benefit doesn't justify it, **document the limitation** (README /
  known-limitations) instead of changing the renderer, and close this as wontfix.

## Reported upstream (repro + verify these)
- Vditor **#1923** — "Render inline HTML-Code". **Manifests (feature request):** users want the HTML inside a ```` ```html ```` fenced block to be **rendered as a live preview** (to see how it looks), not just shown as syntax-highlighted source. Confirms the demand; verify our outcome (render vs documented limitation) against this case. https://github.com/Vanessa219/vditor/issues/1923

## Verify
Open a `.md` that embeds a restricted-safe
`<img src="data:image/svg+xml;base64,…">` (in a table or paragraph) → the image
renders in VMDE through a revocable render-only blob URL, matching VS Code's Markdown
preview. Normal raster `data:` images still render; hostile SVG stays blank. The
CSP/nonce posture from task 18 is unchanged (no `unsafe-inline` script or broadened
`script-src`).

## See also
- `18-security-hardening.md` — the CSP/nonce model (§2c). The CSP already permits
  data: images; this task is about Vditor's sanitize, not the policy.
