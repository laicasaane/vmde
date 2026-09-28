# Task 592 — Webview loading robustness and payload on vscode.dev

> **For agentic workers:** Use `superpowers:executing-plans`. Checkboxes track implementation and acceptance.

**Status:** planned (draft, 2026-09-28).
**Goal:** On vscode.dev the webview loads reliably. It reports a load failure instead of showing a blank editor, and it accepts messages from both desktop and web origins. It degrades cleanly when cross-origin isolation blocks a remote resource, and it downloads less on first use. Desktop behavior and timing do not regress.
**Spec:** This file and [Task 581](581-web-extension-support.md) section 4 (review-focus item 5).
**Dependencies:**
- [Task 591](591-web-entry-bundle-and-harness.md) (the web harness).
- Task 582 row P6 (cross-origin isolation and image results).
- Decision D5 for the font subsetter in Checkpoint 2.

**Repository skills:** `.agents/skills/vmde-renderer-theming/SKILL.md` (build and CSP notes) and `.agents/skills/vmde-testing/SKILL.md`.

## 1. Implementation

### Checkpoint 1 — Robustness

- [ ] Change the origin check in `media-src/src/bridge/message-router.ts` (around lines 1050–1067) from `VSCODE_WEBVIEW_ORIGIN_RE` to `e.origin === window.origin`, which holds on both desktop and web.
  - Keep it warn-only.
  - Update the Task 148 comment so a later tightening to a drop cannot break the web.
- [ ] Add a failure path for the Lute script load in `media-src/src/boot/vditor-init.ts` (around lines 566–575). Vditor's `addScript(lute)` promise currently has no rejection handler. On rejection or timeout:
  - show a visible error state in the editor;
  - log it to the host through the existing log message;
  - leave the 8 s overlay failsafe in place.
- [ ] Preload Lute. In `src/webview-host/html-builder.ts`, emit `<script nonce="…" id="vditorLuteScript" src="<exact Vditor lute URL>">` before `main.js`. Follow the existing hljs preload pattern around lines 264–267.
  - Use exactly the URL, including any query string, that Vditor's `addScript` builds for Lute. The hljs preload copies Vditor's `?v=` query for the same reason.
  - Do not add `async` or `defer`: Vditor's `addScript` treats an existing id as loaded.
  - Measure open-to-ready on desktop with the existing startup-cost check (reporting only).
- [ ] Add `crossOrigin: 'anonymous'` to `L.tileLayer` in `media-src/src/diagrams/engines/geojson-topojson.ts:156`. The CARTO and OSM tile hosts send `Access-Control-Allow-Origin: *`.
- [ ] Handle remote Markdown images and D2 `icon:` URLs under cross-origin isolation, using the row P6 evidence.
  - **Part 1 chooses** between (i) documenting that hosts without CORP headers are blocked on vscode.dev, and (ii) adding a render-only `crossorigin="anonymous"` attribute when `self.crossOriginIsolated`. Option (ii) must stay invisible to Lute serialization, and it breaks hosts that send CORP without CORS headers.
  - Record the choice here.

### Checkpoint 2 — Payload

- [ ] Load PlantUML engines through a URL fragment instead of a query string in `media-src/src/diagrams/plantuml/plantuml-render.ts` (around lines 1005–1007). For example, use `#engine=<kind>&rev=N` in place of `?engine=…`. A document with class and non-class diagrams then makes one network fetch while still getting distinct module instances. Verify both in Chromium e2e: one network request, and both diagram kinds render.
- [ ] If D5 approves a font subsetter, subset `NotoColorEmoji` to the codepoints in `media/emoji/emoji-catalog.json`.
  - Add a matching `unicode-range` in `media-src/src/main.css` (around lines 1023–1027 and 1093).
  - Record the size before and after.
  - The subset must be produced by a build or sync script, not committed by hand.
  - If D5 declines, record "skipped" here.

## 2. Scope

- **In scope:** the items above.
- **Out of scope:**
  - The CSP, which needs no change: the review verified `script-src`, `connect-src`, `font-src`, `img-src` and `base-uri` on web origins.
  - hljs eager loading, which stays as it is.
- **Preservation:** desktop first paint, the prerender overlay handoff, diagram rendering, emoji picker glyph coverage, and message routing.

## 3. Verification

- Chromium e2e:
  - origin matching;
  - Lute load failure (block the script request) shows the error state;
  - the preload does not double-load (one request, one `Lute` global);
  - PlantUML makes a single fetch.
- Real VS Code: run `node build.mjs` first. Then run these focused, no-retry specs:
  - `prerender-style-parity.spec.ts`;
  - a diagram render spec;
  - the emoji picker spec.
- Web: run `test:web` for the smoke flow. Tile and image behavior under cross-origin isolation is checked on vscode.dev in Task 595.
- Bundle and startup numbers are reporting-only.
- Changed-line coverage and the network-free quality stages run once on the final candidate.

## Execution progress

Not started.
