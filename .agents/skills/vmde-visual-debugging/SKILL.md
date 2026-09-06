---
name: vmde-visual-debugging
description: Use when debugging Visual Markdown Editor layout, CSS, geometry, caret, focus, visual regressions, or behavior that reproduces only in the real VS Code webview.
---

# Visual Markdown Editor visual debugging

How to debug LAYOUT / CSS / caret bugs in Visual Markdown Editor without flying blind. These bugs are the
expensive ones (a few px off, "jumps", "squished", "kursor za ```") because the symptom is
perceptual and the cause is one property buried in a cascade — and many reproduce ONLY in the
real VS Code webview, not the Playwright harness. Three tools, cheapest first.

## 1. playwright-cli — interactive loop on the harnesses (daily driver)

`@playwright/cli` (in `media-src/node_modules/.bin`, also `npm run pw:cli`) drives a PERSISTENT
browser from the shell and writes snapshots/screenshots to `.playwright-cli/` (gitignored) — so
it costs ~0 conversation tokens (read only what you need) and replaces the old "write a throwaway
spec → run → parse logs" loop.

```bash
npm run harness:serve &                 # serves harnesses on :9124 (separate from the :9123 the
                                        # e2e webServer owns — never share the port with a test run)
npm run pw:cli -- open http://localhost:9124/blockbg.html
npm run pw:cli -- eval "() => { const n=[...document.querySelectorAll('.vditor-ir__node')].find(x=>x.querySelector('code.language-js')); return { nodeH:n.getBoundingClientRect().height, previewH:n.querySelector('.vditor-ir__preview').getBoundingClientRect().height } }"
npm run pw:cli -- screenshot --filename /tmp/before.png   # then Read the PNG
# try a fix live, re-measure:
npm run pw:cli -- eval "() => { const s=document.createElement('style'); s.textContent='…candidate CSS…'; document.head.appendChild(s) }"
npm run pw:cli -- screenshot --filename /tmp/after.png
npm run pw:cli -- close
```

The harness loads the SOURCE `media-src/src/main.css` live, so editing main.css + reloading the page
shows the change without a rebuild. The diagnosis pattern that works: **screenshot says WHERE,
`eval`'d geometry/computed-styles say HOW MUCH, CSS knowledge says WHY** — a screenshot alone
mis-measures pixel distances; numbers alone miss where to look.

Gotcha that recurs (see renderer-theming skill): phantom geometry often comes from things with NO
DOM rect — `::before`/`::after` content, h:0 inline-block markers, line-box struts, unitless
`line-height` inheritance. When `getBoundingClientRect` differences don't add up, dump
`getComputedStyle(el, '::before')` and the node's child line boxes, not just the elements.

## 2. Golden screenshots — catch "a few px" before the user does

`media-src/e2e/visual.spec.ts`, tagged `@visual`. Element-scoped goldens of the surfaces whose
bugs were perceptual (collapsed code block, callout). Baselines in `visual.spec.ts-snapshots/`
(committed, `-linux` suffix). Tolerance (`maxDiffPixelRatio: 0.005` in playwright.config) catches
any ≳3 px shift; a height change fails as a dimension mismatch outright.

```bash
npm run test:visual            # run the goldens (local pre-flight)
npm run test:visual:update     # regenerate AFTER a deliberate visual change — then eyeball the PNGs
```

EXCLUDED from CI / `test:e2e` (`--grep-invert @visual`): goldens only hold in a consistent
environment, and the ubuntu-latest runner's fonts may differ from the dev machine. They are a
LOCAL net — run them before declaring a visual change done. The numeric layout guards
(blockbg/codenav/width specs) are what gate CI. Add a golden only when a NEW visual bug class
appears; keep it element-scoped (full-page shots multiply font drift).

## 3. real-vscode suite — the harness↔real gap (when "repro only in the editor")

`test/vscode-e2e/` (`vscode-test-playwright`). Launches a real VS Code
(downloaded to `.vscode-test/`, gitignored), loads the built extension, opens a fixture in the
`vmde.editor` custom editor, and reaches the double-nested webview iframe
(`iframe.webview` → `#active-frame`) to measure the REAL render — with VS Code's injected default
CSS and the real custom-editor pipeline. This is where the "only reproduces in the real editor"
class (VS Code default CSS leak, focus/blur, prerender→live swap) is finally observable by me
instead of only by the user.

- **Run YOUR spec, not the suite.** The whole thing is on the order of an hour to two — the boot is
  per `test()`, not per spec (task 448: `vscode-test-playwright`'s `electronApp` fixture has no
  `scope: 'worker'`), and the test count (moves with every merge/new spec — `npx playwright test
  --list` for today's number, don't trust a figure written on a specific date) adds up. Routine
  work:
  `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <your>.spec.ts` plus
  `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode:fast`. Get the current test count with
  `npx playwright test --list`
  from `test/vscode-e2e`; tier membership is defined in
  `test/vscode-e2e/playwright.config.ts`. Keep the full
  `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode` for handing work over. Timing guidance lives in
  `DEVELOPMENT.md`.
- One-time setup: `npm --prefix test/vscode-e2e install` (its deps are a SEPARATE, gitignored
  node_modules — see the version-pin note below for why they're isolated from the root manifest).
- Requires a prior `node build.mjs` (it loads `dist/extension.js` + `media/dist/`). Always use `xvfb-run -a` rather
  than an ambient display; follow `DEVELOPMENT.md` if a managed sandbox blocks its X socket. Open the editor only AFTER
  `extensions.getExtension('Laicasaane.vmde').activate()` — `openWith` before activation races
  the custom-editor provider registration and the webview stalls.
- Geometry / computed-style assertions by default — goldens ONLY behind the `@visual` tag, skipped
  unless `VMDE_VISUAL=1` (linux-electron fonts differ; the nightly gate must not go red on a
  runner with different fonts). It's a PARITY smoke; the harness specs remain the primary regression
  net (they're the ones proven to fail when a fix is reverted). The config uses one retry locally
  and two in CI to absorb transient cold-boot stalls without tripling the local failure loop.
- **Diagram pixels — `npm run test:vscode:visual`** (`diagram-visual.spec.ts`, task 375). The one
  surface that needs pixels HERE and not in the harness: both the 373 (arrowheads) and 374 (black
  mermaid) regressions lived in the paint-a-copy path, which the harness has no cross-pane reuse to
  reproduce. Per engine it asserts (a) the Preview render is pixel-equal to the edit-pane render it
  was copied FROM — no baseline, so font-drift-immune and valid anywhere — and (b) a committed
  golden, which catches both panes breaking identically. The comparison tolerates a ONE-PIXEL
  displacement: the two panes place the same SVG at a different sub-pixel phase (measured: 0.9–1.3%
  of pixels differ with a strict diff, all of it edge outlines), and absorbing that is what keeps
  the threshold at a useful 0.5%. Regenerate with `-- --update-snapshots` and LOOK at every changed
  PNG — a baseline refreshed on autopilot bakes in a broken render.
- **Version pin + compatibility patch:** the suite's deps live in their OWN
  `test/vscode-e2e/package.json` (not the root manifest). `@playwright/test` is pinned exactly to
  `1.62.1`; `vscode-test-playwright@0.0.1-beta2` still depends on the removed private
  `playwright._toImpl` API, so the workspace's `postinstall` runs
  `scripts/patch-vscode-test-playwright.mjs`. That anchor-checked patch replaces the private-API
  server discovery and must be re-verified whenever either dependency changes. Keep the workspace
  isolated from the root dependency tree and run `npm run audit:vscode-e2e` for it.

## When to reach for which

- Tweaking CSS / diagnosing a harness-reproducible layout bug → **playwright-cli** (interactive).
- About to land a visual change → run **golden screenshots** first; update + eyeball if intended.
- User says "only in the real editor", or the bug touches VS Code default CSS / focus / the
  custom-editor pipeline → **real-vscode suite**, and still verify the final fix WITH THE USER
  (caret/scroll-class bugs especially).
- Always: a NEW numeric guard in the harness spec (blockbg/codenav/width/…) is the durable net —
  the goldens and real-vscode suite are aids, not replacements.
