---
name: vmde-testing
description: Use when adding or changing Visual Markdown Editor functionality, selecting a test layer, writing unit, Chromium, real-VS-Code, or visual tests, exercising WASM in tests, checking coverage, or running verification gates.
---

# Visual Markdown Editor testing

How to test a Visual Markdown Editor change properly — which layer, how to write it, how to RUN it headless, how to
prove coverage. The companion doc is `DEVELOPMENT.md` (build layout + all commands); the mandate lives
in `AGENTS.md` (always loaded). This skill is the on-demand HOW.

## ⭐ THE RULE (non-negotiable)

- Every new piece of functionality ships **unit tests AND e2e tests**, and you **verify coverage**
  (run the report, confirm the new lines are exercised). Not done until tests pass + cover the behaviour.
- **Any webview / renderer feature** (anything that renders or behaves in the editor surface — diagrams,
  themes, caret, links, decorations) **MUST ship a real-VS-Code e2e in `test/vscode-e2e/`, and you MUST
  WRITE IT AND RUN IT yourself before calling the work done.** Do NOT defer real-webview verification to
  the user.
- **`xvfb` IS installed** (`/usr/bin/xvfb-run`) → use `xvfb-run -a` for browser and VS Code tests;
  do not substitute the ambient `DISPLAY`. Prefix real-VS-Code commands with
  `env -u ELECTRON_RUN_AS_NODE`. If a managed Codex sandbox reports that `/tmp/.X11-unix` is owned
  by `nobody` or cannot create listening sockets, rerun the same command with escalated/unsandboxed
  execution. Do not reinstall/extract Xvfb, modify `/tmp`, or invent a manual display fallback.
  `DEVELOPMENT.md` owns the exact smoke command and troubleshooting sequence.

## The four layers (pick by what you're proving)

| layer | command | use for | can't do |
|---|---|---|---|
| **vitest unit** | `npm test` | pure logic + DOM-string output (e.g. `toSVG` markup), WASM marshalling via a vm-context | no real DOM/CSS/webview |
| **chromium harness e2e** (`media-src/e2e`) | `xvfb-run -a npm --prefix media-src run test:e2e` | fast real-browser net: Vditor IR/WYSIWYG, renderers including D2's real render gate in `media-src/e2e/custom-diagrams.spec.ts`, caret in an iframe | real-VS-Code-only behaviour (injected CSS, custom-editor pipeline, SVG-anchor routing) |
| **real-VS-Code e2e** (`test/vscode-e2e`) | `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <spec>.spec.ts` | the MANDATE: prove a webview/renderer feature in actual VS Code (resource URIs, CSP, injected CSS, link routing) | slow first run (downloads VS Code ~270 MB, then cached) |
| **@visual golden** | `npm run test:visual` (media-src) | pixel regressions; **local-only, excluded from CI** | not a logic check |

Coverage: `npm run test:coverage`. The complete current gate set is summarized below; use
`DEVELOPMENT.md`, `package.json`, and the workflow files as the command authorities.

## Real-VS-Code e2e — the recipe

`extensionDevelopmentPath: repoRoot` (see `test/vscode-e2e/playwright.config.ts`) → the suite loads
the manifest's bundled `dist/extension.js` + `media/`, **NOT** the installed `.vsix`. So
**`node build.mjs` FIRST**, every time. Config:
`workers:1`, local `retries:1`, CI `retries:2`, `timeout:90s`. VS Code downloads once into
`test/vscode-e2e/.vscode-test/`.

```ts
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')
// the custom-editor webview is a nested iframe:
const wf = (workbox: import('@playwright/test').Page) =>
  workbox.frameLocator('iframe.webview').frameLocator('iframe[title="Visual Markdown Editor"], #active-frame')

test('my feature renders in the real VS Code webview', async ({ workbox, evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode, [uri]) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(uri), 'vmde.editor')
  }, [FIXTURE] as [string])

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame.locator('.language-d2 svg').first().waitFor({ timeout: 60_000 }) // wait for async render

  // Poll for the CONDITION the assertion itself reads, don't add a fixed sleep on top of the
  // waitFor above (task 451 — a blind settle after "the element exists" was how ~16 min of
  // hardcoded sleep spread across the suite; this file is where the pattern started).
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const html = [...document.querySelectorAll('.language-d2 svg')].map((s) => s.outerHTML).join('\n')
        return /something/.test(html)
      }),
    )
    .toBe(true)

  // Query the real DOM inside evaluate(); return a plain object and assert outside.
  const info = await frame.locator('body').evaluate(() => {
    const html = [...document.querySelectorAll('.language-d2 svg')].map((s) => s.outerHTML).join('\n')
    return { hasFeature: /something/.test(html) }
  })
  expect(info.hasFeature).toBe(true)
})
```

**A fixed sleep is still correct in three shapes** (task 451) — don't force a poll onto these:
- **Negative assertions** ("nothing re-renders in the next N ms", "no second render fires") — there
  is no condition to poll for. Comment it as a negative-assertion wait so the next reader doesn't
  retry the conversion.
- **Geometry/position quiescence across several engines** (a cross-pane drift or bounding-box
  comparison on a document with many diagrams still settling) — a poll can declare "stable" on a
  transient plateau mid-reflow, which is a **false pass**, worse than a slow test. Leave the sleep,
  comment why (see `wysiwyg-parity.spec.ts`, `mode-switch-parity.spec.ts`).
- **A genuine engine floor with no observable marker** (e.g. a cold PlantUML/D2 compile where the
  DOM gives no signal until the whole render lands) — poll for the render's own marker
  (`.language-d2 svg`, a `data-*` attribute, a specific element) rather than shortening the timeout
  blindly; if truly no marker exists, keep the sleep and say so.

Patterns that matter:
- **Drive a real fixture**, don't inject markup. Add a block to `test/vscode-e2e/fixtures/all-renderers.md`
  (the canonical all-renderer fixture; §18 = D2) and assert against the rendered output. This also
  documents the feature.
- **Interaction** (clicks, keys): dispatch inside `evaluate` and assert the effect. For "is this link
  intercepted?", dispatch a `MouseEvent('click',{bubbles,cancelable})` on the element and check
  `ev.defaultPrevented` — `fixLinkClick` preventDefaults when it catches an `a[href]` (this is how the
  SVG-`<a>` routing fix was verified without mocking the host).
- **Images**: CSP allows `data:`/`blob:` always, `https:` only with `image.allowRemoteImages` — use
  `data:` URIs in fixtures so they load offline.
- Console errors: attach `page().on('console', …)` and log them; structural asserts beat screenshots here.

## Unit recipes

- **Pure render output** (`media-src/src/diagrams/d2/d2-render.test.ts`): build a hand-made
  `Layout`/`D2Graph` literal, call
  `toSVG`/`renderD2Graph(graph, sizer)` with a deterministic `Sizer`, assert on the SVG string
  (`toContain('<tspan')`, regex counts). No browser.
- **Compile-only WASM** (`media-src/src/diagrams/d2/d2-wasm.test.ts`): boot in a Node `vm` context —
  read `wasm_exec.js` + the
  `.wasm`, `vm.createContext({…, globalThis: ctx})`, **also set `ctx.global = ctx`** (TinyGo's
  `wasm_exec.js` exports `Go` onto `global`/`window`/`self`, not `globalThis` like stock Go — without it
  the loader throws "cannot export Go"), `new ctx.Go()`, `WebAssembly.instantiate`, `go.run(instance)`,
  then **poll** for the registered global (TinyGo registers it asynchronously under asyncify).
- **D2 visual sanity** (not a test, a tool): `media-src/scripts/d2-render-harness/render.mjs` renders
  `.d2` through dagre/elk/vmde to a PNG. Run `node build.mjs` first: the harness bundles the source
  renderer but consumes the generated D2 WASM and vendored ELK from `media/vditor`. Use it to eyeball
  layout/routing (the user steers D2 by eye). Output under `tmp/` (gitignored).

## Coverage

```bash
COLUMNS=2000 npx vitest run --config test/vitest.config.ts --coverage \
  --coverage.include='media-src/src/FILE.ts' --coverage.reporter=text FILE.test.ts
```
Confirm your new line numbers are NOT in the "Uncovered Line #s" ranges (`COLUMNS=2000` stops the table
truncating the list). Whole-file % is dominated by unrelated branches — check YOUR lines, not the %.

## Gates before "done"

Run the gates that apply to the changed surface, using the exact commands in `DEVELOPMENT.md` and
`package.json`:

1. `npm run audit` for the root and webview dependency trees; when the isolated VS Code harness is
   installed or changed, also run `npm run audit:vscode-e2e`.
2. `npm run lint:ci` for the whole-tree Biome gate. Format changed files first when needed.
3. `node build.mjs`, then `npm run check:bundle-size` and `npm run check:startup-cost`; these enforce
   the eager-bundle size and startup module/evaluation budgets.
4. `npm run typecheck`, `npm run typecheck:strict`, and `npm run typecheck:vscode-e2e` for the
   webview, strict-subset, and real-VS-Code spec type checks.
5. `npm run test:coverage` and `npm run check:coverage-modules`, plus the Chromium e2e and focused
   real-VS-Code spec required for the feature.
6. At the end of implementation, run `npm run quality`. It runs every stage even after a failure:
   `lint:ci`, `knip`, `jscpd`, `depcruise`, `audit`, `test:coverage`, and
   `check:coverage-modules`, then exits non-zero if any stage failed. The type checks and
   bundle/startup budgets remain separate gates and are not implied by `npm run quality`.

## Gotchas

- **A theme-flip spec must scroll its target into view — the failure mode is silent** (task 412/475).
  Task 412's viewport gate (`media-src/src/diagrams/diagram-retheme.ts`'s `gateAndRender`) defers a
  diagram's re-render —
  ECharts/mindmap, the mono SVG group (plantuml/graphviz/abc/wavedrom/nomnoml), geo, and D2 — for
  anything more than ~200px outside the window, queuing it on a shared `IntersectionObserver` instead
  of rendering it immediately. A spec that flips the theme and reads a diagram's post-flip state
  WITHOUT scrolling it into view gets the STALE pre-flip render if that diagram sits below the fold —
  nothing errors, no timeout fires, the assertion just reads a value that never updated.
  `all-renderers.md` is long enough that everything past its first couple of sections sits outside a
  ~786px window at document-top, so this bites any flip spec built on it that doesn't scroll. Fix:
  `scrollIntoView({ block: 'center' })` on every target AFTER the flip (before the flip it's too
  early — the gate partitions candidates at flip time). If scrolling MULTIPLE diagram instances, do it
  ONE AT A TIME with a short pause (~100-200ms) between each — a bulk pass of back-to-back
  `scrollIntoView` calls does not give the observer time to fire on the earlier elements before the
  viewport moves past them (measured: a bulk pass got a 12-block D2 fixture's compile counter to only
  4, the per-element loop got it to 14). See `retheme-preview-surface.spec.ts` (the original pattern),
  `echarts-theme.spec.ts`, `d2-content-theme-flip.spec.ts`, `retheme-flip-matrix.spec.ts` for the shape.
- **Test a REALISTIC multi-item document, not just isolated blocks** (task 347). Isolated PlantUML
  blocks hid two concurrency races: a second caller could observe a stdlib `<script>` before it loaded,
  and concurrent renders could overlap on the shared TeaVM engine. Current guards are the in-flight
  promise map in `media-src/src/util/load-script.ts` and the module-level serialized render queue in
  `media-src/src/diagrams/plantuml/plantuml-render.ts`. Keep
  `test/vscode-e2e/plantuml-multiblock.spec.ts` as the five-block verification that every distinct
  C4/AWS/Azure diagram renders without an error SVG. When a feature renders N things, add a fixture
  with several together.
- **A text-only assertion can FALSE-PASS on a renderer.** PlantUML (and others) render an ERROR as an
  `<svg>` that ECHOES the source text — so `expect(svg.textContent).toMatch(/MyLabel/)` passes even when
  the block *errored*, because the label is in the echoed source. Always ALSO assert "no error render":
  match `/Fatal parsing error|Syntax Error|Assumed diagram type/`, not just `/Fatal/`. Prefer asserting a
  rendered-shape signal (element counts, geometry) over label text alone.
- **Actually render the demo/artifact you hand the user.** A demo shipped with an *unverified* icon name
  (`AzureSQLDatabase` vs the real `AzureSqlDatabase` — case matters) broke its block; a stdlib-path/name
  check + a real render would have caught it. Verify generated example files, don't assume.
- **`node build.mjs` before any e2e** (and after any source change you want the real-VS-Code suite to
  see) — the suite uses the manifest's `dist/extension.js` + `media/`, not the `.vsix`.
- First real-VS-Code run is slow (downloads VS Code); subsequent runs are fast (cached in
  `.vscode-test/`). Budget for it; run a single `-- <spec>.spec.ts` while iterating.
- The chromium harness is the fast first net but is **not a substitute** for real-VS-Code on
  webview-only behaviour. Don't claim real-webview coverage from a harness pass.
- Vendored WASM rebuild (when a feature needs new compiled fields):
  `media-src/vendor/d2/build/build-d2-wasm.sh` (TinyGo); set `GOCACHE_DIR=<persistent dir>` for fast
  iterative rebuilds, then update `media-src/vendor/d2/source.json` sha + `build.mjs`.

## File map

- Unit config + suite: `test/vitest.config.ts`; `media-src/src/**/*.test.ts`, `test/backend/*.test.ts`.
- Chromium harness: `media-src/e2e/*.spec.ts` (+ `*-harness.ts`); `media-src/playwright.config.ts`.
- Real-VS-Code: `test/vscode-e2e/*.spec.ts`, `test/vscode-e2e/playwright.config.ts`,
  `test/vscode-e2e/fixtures/all-renderers.md`. Reference specs:
  `test/vscode-e2e/custom-diagrams-render.spec.ts` and `test/vscode-e2e/d2-render-sweep.spec.ts`
  (full pattern + the link-click `defaultPrevented` check).
- @visual goldens: `media-src/e2e/*` tagged `@visual`.
- Commands: root `package.json` (`test`, `test:coverage`, `test:vscode{,:fast,:smoke,:visual}`, `test:visual`),
  `media-src/package.json` (`test:e2e`, `test:visual`). Details: `DEVELOPMENT.md`.

## Related

Skill: `vmde-visual-debugging` (the perceptual layout/CSS/caret debugging loop — overlaps on the
real-VS-Code suite but for *debugging pixels*, not *writing feature tests*).
