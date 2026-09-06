# Developing

How to build, test, and measure coverage for this extension. Read this first
before adding tests.

## Layout

This repo has **two compilation units**, each with its own `package.json`:

| Path | What | Build | Module system |
|---|---|---|---|
| `src/` | Extension host (runs in VS Code / Node) | `tsc --noEmit` + esbuild | bundled CommonJS |
| `media-src/` | Webview UI (runs in the browser, uses Vditor) | esbuild | ESM/browser |

Built artifacts (`dist/`, `media/dist/`, `media/vditor/dist/`) are generated and
git-ignored. The Vditor assets the webview needs are synced from
`media-src/node_modules/vditor` into `media/vditor/` by the build.

**Maintenance tooling — `media-src/scripts/`** (run by hand, not shipped; outside the
app's lint/typecheck/test surface): `fetch-*.mjs` vendor + sha-pin upstream assets
(lute, mermaid, echarts); `d2-fixtures/` regenerates the d2-quality CI fixture from its
`sources/*.d2` (run after `layoutElk`/ELK-config changes — see its header); `d2-render-harness/`
renders `.d2` through the three layout engines (dagre / raw ELK / vmde) to a PNG grid or
zoomable HTML for by-eye layout/feature checks (`--engine all` to compare). Both d2 tools need
`node build.mjs` first (they drive a headless browser for the WASM + vendored ELK).

**GitHub rendering themes (task 82):** `media/markdown-themes/github-markdown-light.css`
and `github-markdown-dark.css` are the **unmodified** upstream files from
[github-markdown-css](https://github.com/sindresorhus/github-markdown-css) (MIT),
vendored verbatim (only a provenance comment is prepended). The webview ships ALL
content-theme stylesheets as `<link>` tags and enables one via `link.disabled` + the
`markdown-body` class the CSS targets (`CONTENT_THEME_FILES` in `html-builder.ts` +
`applyContentTheme` in `live-config.ts`). To update github, copy the newer upstream
files over these — no transform or build step.

**Adding a content theme (task 84):** the theme metadata is single-sourced in
`src/theme-registry.ts` (`CONTENT_THEMES`). Add **one row** — `value`, `file`, `mode`
(dark/light), `code` (paired hljs style), `fontDefaultPx` (16 for a GitHub-style
reading size, else `null` = follow the VS Code editor size) — then add the value to
the `vmde.theme.content` enum in `package.json` (a manifest↔registry test enforces
they match). Everything else derives from the registry: `CONTENT_THEME_FILES`,
`effectiveThemeKind`, `codeHljsStyle`, `resolveFontSize`. Drop the CSS file under
`media/markdown-themes/` and keep the README acknowledgement. The `material-dark`
theme (adapted from [raycon/vscode-markdown-style](https://github.com/raycon/vscode-markdown-style),
MIT) is the worked example.

### How content themes control the palette (tasks 84/85)

Markdown renders inside Vditor's `.vditor-reset`, and Vditor ships a **full github-ish
palette of its own** (`hr`/`blockquote`/`table`/inline-code colours) in two
always-present layers — its base `vditor/dist/index.css` (bundled into
`media/dist/main.css`) and `content-theme/{light,dark}.css` (the `vditorContentTheme`
`<link>`). To stop themes from having to out-rank those with `!important`/specificity
tricks, the build (`build.mjs` → `varifyVditorPalette`) rewrites those few Vditor
declarations to **`var(--vmde-*, <Vditor default>)`** (and `main.css` does the same
for its blockquote-bg neutraliser + dark inline-code rule). So:

- **`auto`** (follow VS Code) sets the `--vmde-*` on `body[data-use-vscode-theme-color="1"]`
  to the theme-aware `--vscode-*` vars (e.g. `--vmde-code-bg: var(--vscode-textCodeBlock-background)`),
  so content follows the editor through the SAME mechanism as named themes — no separate
  `!important` block. A few non-mappable bits stay explicit (wrapper bg, blockquote
  overlay, code-block bg, cell borders, checkbox). Unset vars fall back to Vditor's
  default, so anything not driven still looks as Vditor intends.
- A **named theme** just sets the variables on `body.markdown-body` — they inherit into
  `.vditor-reset` and Vditor's own rule resolves to the theme's colour. **No
  `!important`, no `.vditor-reset` specificity matching.**

The variables a theme can set (see any `media/markdown-themes/*.css` for the worked
form):

| Variable | Element |
|---|---|
| `--vmde-heading-border` | h1/h2 underline colour |
| `--vmde-hr-bg` | `hr` (Vditor draws it as a `background-color` bar, not a border) |
| `--vmde-blockquote-fg` / `--vmde-blockquote-border` | blockquote text / left bar |
| `--vmde-blockquote-bg` | blockquote panel background (unset → transparent) |
| `--vmde-table-border` | table cell / row borders |
| `--vmde-table-row-bg` / `--vmde-table-stripe` | table rows / even-row striping |
| `--vmde-code-bg` | inline-code background |

Properties **not** in the table are set directly on `.markdown-body` by the theme (and
win ties because the theme `<link>` is emitted **after** Vditor's in `html-builder.ts`;
`setContentTheme` no-ops at runtime so that order holds): canvas `background`, base
`color` (also on `.vditor-reset`, since Vditor sets the reset's colour directly), link
colour, heading colours, inline-code **colour**, the `.hljs` code-block background
(`!important`, to override the paired hljs `theme.code` stylesheet), and
**`color-scheme: light|dark`** (native form controls). Note `color-scheme` does **not**
fix scrollbars — VS Code drives the webview's native scrollbars from the editor theme, so
`main.css` sets the inherited `scrollbar-color` (+ `scrollbar-width: thin`) on
`body.markdown-body` (`!important`) for every named theme; being inherited it recolours
every content scroller incl. nested code blocks (tunable via `--vmde-scrollbar-thumb`).
Font-**size** is never set in theme files — it flows through `--me-font-size` (the
registry default + the `fontSize` setting).

> Why not just strip Vditor's palette? Disabling the `vditorContentTheme` link doesn't
> remove it — the base `index.css` carries it too (structural/bundled). Var-ifying both
> layers in the build is the clean equivalent. See `tasks/85-theme-completeness-contract.md`.

**Webview bundle (task 20):** `media-src/build.mjs` (the `start`/`build` scripts)
imports Vditor from **source** (`vditor/src/index`) so esbuild can tree-shake it.
The source-import specifics live in `media-src/esbuild-shared.mjs` — `define
VDITOR_VERSION`, `useDefineForClassFields:false`, a `.less`→empty loader, a plugin
stubbing 4 unused toolbar buttons (`src/stubs/`), and a `diff-match-patch`
interop rewrite (Vditor's `undo` needs a default import or `new DiffMatchPatch()`
throws — guarded by `e2e/undo-interop.spec.ts`). `e2e/serve.mjs` reuses the same
config so the harnesses bundle Vditor identically.

Beyond that interop fix, `esbuild-shared.mjs` carries a set of **anchored source
patches** to Vditor applied at bundle time (link-open policy gate, list-toggle
null-guard, outline-current highlight, KaTeX resilience, content-based paste-as-code,
IR-input serialize hand-off, English About dialog, …). Each patch throws at build
time if its anchor string drifts on a Vditor bump, so a version upgrade fails loudly
instead of silently no-op'ing; they're unit-covered by
`test/backend/vditor-source-patches.test.ts`. When bumping the vendored Vditor
version, work through **[the Vditor bump checklist](docs/vditor-patch-checklist.md)** —
every `patchXxx` function, its anchor, how fragile that anchor is, what it guards, and
whether it fails loud or (in two documented cases) silently.

## Package manager

**npm only — minimal tooling.** npm installs deps and `node build.mjs` drives the
build directly as plain Node ESM. Do not reintroduce `yarn.lock` /
`pnpm-lock.yaml` / `bun.lock` or a
`packageManager` field — CI installs with `npm ci`. There are two lockfiles:
`package-lock.json` (root) and `media-src/package-lock.json`. The extension host ships as one
Node-targeted CommonJS bundle (`dist/extension.js`); `tsc --noEmit` checks its types and esbuild
produces the runtime file with `vscode` externalized for VS Code to provide. The build toolchain is
dev-time only.

The root `package.json` also owns the install-script policy. Approvals are pinned to the reviewed
`esbuild` and `@vscode/vsce-sign` versions; `keytar` is denied because Marketplace automation uses
Microsoft Entra workload identity instead of a local credential store. Azure runs both clean installs with
`--strict-allow-scripts`, so a new unreviewed dependency script fails before tests or packaging.

## First-time setup

```bash
npm ci                       # root deps (extension host + vitest)
npm --prefix media-src ci    # webview deps (esbuild, vditor, playwright, monocart)
node build.mjs               # typecheck/bundle host + build webview + sync Vditor assets
npm --prefix media-src exec -- playwright install chromium   # e2e browser (once)
```

`node build.mjs` is required before e2e: the table harness serves real Vditor
assets from `media/vditor/`. (The unit suite does not need it.)

---

## Lint, format & types

Biome handles both lint and format; type-checking is a separate `tsc` pass.

```bash
npm run lint:ci     # Biome check, no writes — the exact CI gate (whole tree)
npm run lint:fix    # Biome check --write — apply safe lint + format fixes
npm run format      # Biome format --write — formatting only
npm run typecheck   # tsc -p media-src/tsconfig.typecheck.json (no emit, webview)
```

`lint:ci` runs over the **whole tree**, so a clean local run must pass before you
push — drift in files you didn't touch will still fail CI. `node build.mjs`
type-checks the host (`tsc --noEmit -p ./`) as part of the build; `npm run typecheck`
covers the webview side.

---

## Test layers

| Layer | Runner | Location | What it covers |
|---|---|---|---|
| **Unit / backend** | vitest | `test/backend/*.test.ts`, `media-src/src/*.test.ts` | Extension host logic + pure webview helpers |
| **E2e** | Playwright (chromium) | `media-src/e2e/*.spec.ts` | Webview behaviour in a real browser with Vditor |

The first two are the **gate** (run in CI), and are **disjoint** — different runners,
different layers, separate coverage reports. Neither instruments the other.

Two extra **visual-debugging** layers (NOT in the CI gate — see the `vmde-visual-debugging`
skill) catch the perceptual "a few px / repro only in the real editor" bugs:

| Layer | Runner | Command | What it covers |
|---|---|---|---|
| **Golden screenshots** | Playwright (`@visual` tag) | `npm run test:visual` | Element-scoped pixel baselines (`media-src/e2e/visual.spec.ts`); a local pre-flight, excluded from `test:e2e` (`--grep-invert @visual`) because goldens only hold in a consistent environment |
| **Real-vscode** | `vscode-test-playwright` | `npm run test:vscode:fast` (routine) / `npm run test:vscode` (all) | Geometry/computed-styles in a real VS Code webview (`test/vscode-e2e/`); the harness↔real parity smoke for VS-Code-default-CSS / custom-editor-pipeline bugs. **Three tiers — see below** |
| **Diagram pixels** | `vscode-test-playwright` (`@visual`) | `npm run test:vscode:visual` | Per-engine pixel goldens + edit-pane↔Preview pixel equality for the 8 reusable diagram engines (`diagram-visual.spec.ts`); the paint-a-copy path the harness cannot reproduce. Opt-in (`VMDE_VISUAL=1`), out of the nightly gate — see task 375 |

Two more tags exist purely to keep non-regression-test specs out of the default `test/vscode-e2e`
run (each is a full VS Code boot per `test()`, task 448, so they are not free to leave in):

| Tag | Command | What it covers |
|---|---|---|
| `*spike*` (filename glob) | `npm --prefix test/vscode-e2e run test:spikes` (`VMDE_SPIKES=1`) | Investigative/feasibility specs — excluded via `testIgnore` (audit 185/1c) |
| `@probe` (title tag) | `npm --prefix test/vscode-e2e run test:probes` (`VMDE_PROBES=1`) | Non-asserting measurements/throwaway probes (task 449); get the current total with `npx playwright test --list` under `VMDE_PROBES=1`. A TAG, not a filename glob, because some real regression nets have "probe" in their name (`undo-dirty-probe.spec.ts`, `caret-on-open.spec.ts` — the fix verification, not its `-probe` sibling) — see `playwright.config.ts`'s `grepExcludePatterns` for how `@visual`/`@probe` compose into one `grepInvert` regex without silently un-excluding one when the other's env var flips |

For interactive measure-and-screenshot debugging on the harnesses, `playwright-cli`
(`npm run harness:serve` + `npm run pw:cli`). All three are documented in the skill.

### Real-VS-Code tiers — which one, when

The boot is **per `test()`, not per spec file** (task 448): `vscode-test-playwright`'s
`electronApp` fixture (`test/vscode-e2e/node_modules/vscode-test-playwright/dist/index.js`) is
declared `{ timeout: 0 }` with no `scope: 'worker'`, so it launches and `.close()`s a fresh VS Code
for every `test()` — only `_vscodeInstall` / `_createTempDir` are worker-scoped. A spec with N
`test()` blocks therefore costs N boots; splitting or merging tests moves the wall clock directly.
The full run is **on the order of an hour to two** — it grew well past the old estimate, which came
from counting spec FILES rather than `test()` blocks. Running
it after every edit is not viable. The exact test count is NOT pinned here on purpose: it moves with
every merge and every new spec — run `npx playwright test --list` (from `test/vscode-e2e`) for
today's number rather than
trusting a figure written on a specific date; `VMDE_PROBES=1` adds back the non-asserting probes
task 449 excluded by default (`npx playwright test --list` with and without the flag shows the
delta). The `~1-2h` range is a derivation, not a measurement (nobody should run the full suite just
to time it): the FAST tier's own measured per-test rate (13–29 s, see below — it swings almost 2×
with machine load) times the current full-suite count, plus the full suite's ~16 min of static
sleeps concentrated in specs FAST doesn't run (diagram parity / mode-switch — task 451) plus
PlantUML/D2 engine renders FAST never touches. Pick a tier:

| Tier | Command | Size | When |
|---|---|---|---|
| **smoke** | `npm run test:vscode:smoke` | count moves — inspect the configured tier, **~2 min** | The PR gate (`pr-webview-smoke.yml`). Boot/layout parity, every renderer draws, and the change-stability core: save-to-disk fidelity, undo-to-disk, split editing, scroll preservation, clipboard, upload |
| **fast** | `npm run test:vscode:fast` | count moves — inspect the configured tier, **roughly 8.5–16 min** | **The routine tier — use this while working.** Smoke + document sync, mode switching with observers attached, and the whitespace-fidelity nets. Runtime varies substantially with machine load; budget for a multi-minute run rather than treating it as an after-every-edit check. |
| **full** | `npm run test:vscode` | count moves — `npx playwright test --list`, **~1–2 h** | Before handing work over, and in the nightly/tag gate. Diagram engines, themes, parity matrices — **not** perf probes, task 449 moved those behind `@probe` / `npm --prefix test/vscode-e2e run test:probes` (excluded from every tier including full, by default) |

**Only ONE real-VS-Code run at a time — the tiers refuse to start a second one.** Every script in
`test/vscode-e2e/package.json` goes through `scripts/e2e-lock.mjs`, which takes a PID lock
(`tmp/vscode-e2e.lock`) and **fails loudly and immediately** if a run is already going, rather than
queueing behind it (a silent hour-long wait is indistinguishable from a hang). A lock left by a
killed process is detected as stale via `process.kill(pid, 0)` and cleared, so nothing wedges.

This is not fussiness — two concurrent runs were measured corrupting each other on 2026-07-31, and
**directory isolation would not have been enough**, because two independent mechanisms break:

1. **Shared render cache.** `diagram-cache-host.ts` backs the diagram cache with
   `context.globalStorageUri`, and the suite reuses ONE worker-scoped globalStorage across every
   test. Two runs on `.vscode-test/worker-0` share it, so `plantuml-cache`,
   `diagram-cache-mermaid` and `abc-flip-cache-hit` assert against a cache the other run populated.
2. **CPU contention.** Several specs assert *relative* timings — `plantuml-phase-timing` compares
   cold vs engine-warm vs cache-hit on one fixture. No amount of per-run directory isolation makes
   that meaningful while a second VS Code fights for the machine.

Mechanism 2 is why this is a lock and not an isolation scheme: two timing-sensitive suites cannot
coexist on one box, so the fix is to not try. Note `playwright.config.ts` already sets `workers: 1`
/ `fullyParallel: false`, so there is no *intra*-run parallelism — the only hazard was a second
invocation.

Cheapest possible real-VS-Code test measured ~5 s (boot + open + one assert, `webview.spec.ts`); the
chromium harness (`media-src/e2e`) runs a comparable test in ~1 s — call it an order of magnitude
per test, more for heavier assertions. **Re-measuring these numbers:** `npx playwright test --list`
(from `test/vscode-e2e`) for the current test/file count, optionally with `--reporter=json` to get
machine-readable output (each entry's file/line, useful for verifying tier membership); the same
flag on an actual run (`playwright test --reporter=json`) records each test's `results[].duration`
and `results[].workerIndex`, which is how the "one VS Code per test()" claim above was confirmed
empirically (all tests reporting `workerIndex: 0` under `workers: 1`, and wall clock scaling with
test count, not file count).

Whichever tier you pick, **also run the spec(s) for the surface you actually touched** — the tiers
are a safety net against collateral damage, not a substitute for testing your own change:

```bash
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- <your>.spec.ts   # one spec, ~15-60 s
```

The two membership lists live in `test/vscode-e2e/playwright.config.ts` (`SMOKE_SPECS` /
`FAST_SPECS`) with the reasoning next to them; the tier is selected by `VMDE_SMOKE` /
`VMDE_FAST`. Leaving both unset runs everything — the nightly gate depends on that, so never make
a tier the default.

### Running tests headless (xvfb)

Always use `xvfb-run` for e2e and VS Code tests so they run headless (no GUI
windows popping up). This is required on WSL and CI environments without a display:

```bash
# Playwright e2e (harness-based)
xvfb-run -a npm --prefix media-src run test:e2e

# Real VS Code webview tests
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode

# Golden screenshots (update baselines)
xvfb-run -a npm --prefix media-src run test:visual:update

# Diagram pixel goldens in the real webview (opt-in; add -- --update-snapshots to regenerate)
env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm run test:vscode:visual
```

`-a` auto-picks a free display number. On WSLg with `DISPLAY=:0` already set,
`xvfb-run` is still preferred (avoids fighting the existing X server). Unsetting
`ELECTRON_RUN_AS_NODE` is required for real-VS-Code commands because a value leaked from the host
makes Electron run as plain Node. Do not replace Xvfb with the ambient `DISPLAY`.

Confirm both installation and a usable X socket before diagnosing a headless-test failure:

```bash
command -v xvfb-run
xvfb-run -a sh -c 'test -S "/tmp/.X11-unix/X${DISPLAY#:}"'
```

Both commands must exit zero. In a managed Codex sandbox, `/tmp/.X11-unix` may appear owned by
`nobody` even though it is correctly owned by `root` outside the sandbox. If Xvfb reports
`Owner of /tmp/.X11-unix should be set to root` or `Cannot establish any listening sockets`, rerun
the same smoke or test command with escalated/unsandboxed execution. That error is a sandbox socket
restriction, not evidence that the package is missing. Do not reinstall or temporarily extract
Xvfb, modify `/tmp/.X11-unix`, or force a manual `DISPLAY` value to bypass it.

For other `Xvfb failed to start` errors, inspect the reported server number, `ps -ef | rg '[X]vfb'`,
and the matching `/tmp/.X*-lock` before acting. Stop only an identified stale process owned by the
current user; never use a broad `pkill Xvfb` as the first response.

> **Every new piece of functionality must ship with both layers** — a unit test
> for the host/pure-logic side and an e2e test for the webview behaviour — and you
> must **verify the new code is exercised** in the coverage report (see below). A
> feature is not done until its tests pass and cover the new behaviour.
>
> **Where the new code lives decides the layer.** Pure / host logic → unit
> (vitest). DOM- or Vditor-dependent code → e2e (Playwright). To keep webview code
> e2e-testable, put real logic in a **small importable module** (e.g.
> `media-src/src/outline.ts`) and keep `main.ts` a thin wiring entry — `main.ts`
> is excluded from coverage and is not loaded by any test.

---

## Unit tests (vitest)

Run from the **repo root**:

```bash
npm test                # run once
npm run test:watch      # watch mode
npm run test:coverage   # with coverage (v8) -> coverage/  (text + html)
```

Config: `test/vitest.config.mts`. It aliases the bare `vscode` import to an
in-memory mock so `src/extension.ts` can be tested without an Extension Host:

```ts
resolve: { alias: { vscode: '.../test/backend/vscode-mock.ts' } }
```

- **`test/backend/vscode-mock.ts`** — mock of the `vscode` API surface the
  provider touches (`Uri`/`Range`/`WorkspaceEdit`, `window`/`workspace`/`commands`,
  events, file watcher, webview panel), plus a `mock` control surface to drive
  events and inspect calls. **Extend this file** (don't rewrite it) when a test
  needs API the provider newly uses.
- The migrated `media-src/src/*.test.ts` files are pure-logic unit tests
  (debounce, deep-merge, format-timestamp) and run under the same vitest config.

Coverage HTML report: open `coverage/index.html`.

### Adding a backend test

1. Import what you need from `../../src/extension` (the provider class is
   exported) and `./vscode-mock`.
2. `mock.reset()` in `beforeEach`.
3. Build fixtures with `mock.createExtensionContext()`,
   `mock.createTextDocument(path, text)`, `mock.createWebviewPanel()`.
4. Drive the webview message protocol with `panel._receiveMessage({...})` and
   assert via `mock.calls.*` (postMessage, appliedEdits, executeCommand, …).
5. If the provider calls vscode API the mock lacks, add it to `vscode-mock.ts`.

---

## E2e tests (Playwright)

Run from `media-src/`:

```bash
npm --prefix media-src run test:e2e            # run (no coverage)
npm --prefix media-src run test:e2e:coverage   # run + collect coverage
```

A local server (`e2e/serve.mjs`) bundles the harnesses in-memory with esbuild
(inline source maps) and serves Vditor assets; Playwright starts/stops it.

### Harnesses

Each harness is an esbuild entry in `serve.mjs` with its own HTML page; a spec
drives it. Two kinds: **real-Vditor** harnesses (instantiate Vditor, wire the
feature in `after()`, expose globals) and the **behaviours** harness (helpers
only, no Vditor).

- **`e2e/harness.ts` (`/index.html`)** — real Vditor (IR) with a table. Used by
  `table-hotkey.spec.ts` (table editing: hotkeys + panel).
- **`e2e/outline-harness.ts` (`/outline.html`)** — real Vditor (IR) with headings
  and the outline panel + `setupOutlineFlash`. Used by `outline.spec.ts` (outline
  render/position, click-to-flash, heading-highlight CSS). A good template for a
  new feature that needs a real editor.
- **`e2e/behaviors-harness.ts` (`/behaviors.html`)** — exposes the webview
  helpers as globals, **no full Vditor**. Used by `webview-behaviors.spec.ts`
  (message contract + DOM utils).
- **`e2e/bench-harness.ts` (`/bench.html`)** — init-perf benchmark (`init-bench.spec.ts`,
  opt-in via `BENCH=1`). **Excluded from coverage** (a measurement, not a behaviour test).

### The `window.vscode` stub

In a real webview, `acquireVsCodeApi()` is injected by VS Code. In the browser
harness it does not exist, so message-posting code would crash. The behaviour
spec installs a recording stub **before the bundle runs**:

```ts
await page.addInitScript(() => {
  window.__posted = []
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState(){}, setState(){} })
})
```

`utils.ts` picks it up via `acquireVsCodeApi()`, and tests assert against
`window.__posted`. This mirrors the host side covered by the backend tests, so
together they verify both ends of the same message contract.

### Adding an e2e test

- Helper that posts a message or mutates the DOM → use the **behaviours** harness:
  set a minimal DOM fixture in `page.evaluate`, call the helper via
  `window.__utils` / `window.__createToolbar`, assert `window.__posted` or the
  DOM.
- Behaviour that needs a **real editor** → reuse `harness.ts` (table) or
  `outline-harness.ts` (headings/outline), or add a **new harness** for a distinct
  feature. To add one:
  1. `e2e/<feature>-harness.ts` — `new Vditor(...)`, wire the feature, expose
     globals + `window.__ready = true` in `after()`.
  2. `e2e/<feature>.html` — load `/vditor/dist/index.css`, `/main.css`, and
     `/<feature>.js`.
  3. `serve.mjs` — add the entry to `entryPoints`, read the html, add a route.
  4. **`coverage-options.ts` — add the bundle name to the `entryFilter` regex**,
     or its coverage is silently dropped (this is easy to miss).
- Always import `test`/`expect` from **`./coverage-fixture`** (not
  `@playwright/test`) so V8 coverage is collected.
- Hidden elements (e.g. `.vditor-panel` is `display:none`): dispatch a synthetic
  bubbling event in-page instead of a Playwright actionable `.click()`.

After writing the test, run `npm --prefix media-src run test:e2e:coverage` and
confirm your new source file appears in the report with real coverage.

---

## E2e coverage (opt-in)

E2e coverage is **off by default** (so the normal run stays fast and unchanged)
and gated behind `E2E_COVERAGE`:

```bash
npm --prefix media-src run test:e2e:coverage
# -> media-src/coverage/e2e/index.html   (open in a browser)
```

How it works (`monocart-coverage-reports`):

- `coverage-fixture.ts` — auto fixture; `page.coverage.start/stopJSCoverage`
  per test (chromium V8), feeds entries to monocart.
- `coverage-setup.ts` / `coverage-teardown.ts` — Playwright global setup/teardown
  clean the cache and generate the final report.
- `coverage-options.ts` — shared config: the `entryFilter` is now **derived from
  the harness registry** (`harness-entries.mjs`), so it can't drift from the served
  bundles — **add a new harness to `harness-entries.mjs`, not here** (that single
  list also drives `serve.mjs`'s esbuild entryPoints + HTML routes). It drops vditor
  scripts + the `bench` benchmark; the `sourceFilter` keeps sources under
  `media-src/src/**`. V8 coverage maps back to the original TypeScript via the inline
  source map esbuild embeds. A meta-test (`test/backend/harness-registry.test.ts`)
  asserts every coverage-counted bundle is matched (task 150 item 2).

All four `coverage-*.ts` files are no-ops unless `E2E_COVERAGE` is set.

**Unit coverage is gated** (task 150 item 3): `test/vitest.config.mts` sets
non-regression `thresholds`, and CI runs `npm run test:coverage` so a coverage drop
fails the build. Raise the thresholds as coverage grows; never lower them to go green.

## Vendor advisory audits

`npm run audit:vendor` reads exact package coordinates from each
`media-src/vendor/*/source.json` and sends one OSV query batch. Composite bundles declare every
known nested component. Artifacts that cannot map honestly to a package version must carry a dated
`advisoryAudit.kind: "unscannable"` decision; the command lists those residuals instead of claiming
they are clean. The root `npm run audit` gate combines this with the root and webview npm-tree audits.

`npm run audit:d2-go` is separate because it is intentionally slower and downloads tooling. It
blob-filters the pinned D2 commit into a temporary directory, applies the same fonts/LaTeX/
text-measure stubs and compile-only entrypoint as the WASM build, then uses the pinned Go version to
run govulncheck for the JS/WASM call graph. It never changes repository Go modules or generated WASM.

---

## CI

Five GitHub Actions workflows (`.github/workflows/`):

- **`ci.yml`** — the gate, on every PR and push to `main`. Installs root +
  `media-src`, then runs: `npm run audit` (root/webview npm trees at the `low`
  threshold plus exact-version OSV vendor components) → `npm run lint:ci` → `npm run knip` → `node build.mjs` →
  the bundle-size and startup-cost budgets → both webview type-check gates
  (`npm run typecheck` and `npm run typecheck:strict`) → unit coverage thresholds
  (`npm run test:coverage`) → the zero-coverage-module ratchet → Chromium e2e
  (`npm --prefix media-src run test:e2e`). The e2e suite includes the per-renderer
  **render gate** in `custom-diagrams.spec.ts`; keep it green locally.
- **`pr-webview-smoke.yml`** — on pull requests that touch shipped or real-VS-Code
  test code, audits the npm/vendor trees and the VS Code e2e harness, type-checks it, builds the extension,
  then runs the real-VS-Code smoke tier under xvfb.
- **`nightly.yml`** ("Nightly (real-VS-Code render gate)", task 150 item 1b) —
  audits npm/vendor versions, the D2 compile-only Go call graph, and the VS Code e2e harness, then runs the full **real-VS-Code** suite
  (`test/vscode-e2e/`, incl. `d2-elk` +
  `custom-diagrams-render`) under xvfb, on a nightly schedule + `workflow_dispatch` +
  any `v*` tag. Catches webview-only classes the harness can't (e.g. ELK's
  worker-rejection → silent dagre fallback). Downloads VS Code (pinned via
  `VMDE_VSCODE_VERSION`, cached). A green run is a manual release criterion;
  the current release and package workflows do not wait for or enforce its result.
- **`release.yml`** ("Release") — the one-click cut button: a manual *Run workflow*
  with a `patch` / `minor` / `major` choice. Bumps `package.json` + lock, commits and
  tags `vX.Y.Z` on `main`, then calls `publish.yml`. Use this for 1.0.1 onward.
- **`publish.yml`** ("Package Release VSIX") — the audited package workflow, on `v*` tags, a
  manual run (pick a tag), or a `workflow_call` from `release.yml`. It builds, tests, creates the
  `.vsix`, and attaches it to a GitHub Release. It never uploads to the VS Marketplace or Open VSX;
  the Project Owner uploads the inspected VSIX manually. See [Releasing](#releasing).

`ci.yml` enforces the stages listed above, so run the corresponding focused gates
locally before pushing. `npm run quality` runs lint, knip, jscpd,
dependency-cruiser, the root + webview + exact-vendor audit, unit coverage, and the
zero-coverage-module ratchet, reporting every stage even if an earlier one fails.
Pre-existing drift in untouched files can still fail whole-tree gates.

---

## Azure Marketplace publication

Azure DevOps Services provides a separate Marketplace-publishing path for the Azure Repos mirror;
it does not replace or modify the GitHub Actions workflows documented above. Create one Azure
pipeline for each tracked entrypoint:

- `.azure/pipelines/preview.yml` runs only for branch pushes to `main`; it declares no tag trigger.
- `.azure/pipelines/release.yml` excludes every branch and accepts tag pushes, then rejects any tag
  that is not an exact numeric production version.

The trigger domains are intentionally disjoint. Both pipelines use Node 24 so their bundled npm 11
uses the bulk advisory endpoint without the retired legacy fallback. The root install retains
platform-specific optional dependencies required by native build and test tooling, while both
workspace installs disable their automatic audit because the explicit release audit follows.
The pipelines then run the release audits and unit tests, package one explicitly named VSIX, verify
its archive metadata, retain that file as an Azure Pipeline Artifact, and publish the exact same path
to the Visual Studio Marketplace. Preview runs derive `X.(Y+1).$(Build.BuildId)` from the checked-in
even-minor production baseline `X.Y.Z` and pass `--pre-release` to both VSCE operations. Production
tags have no `v` prefix; the pipeline requires exact tag/package/lock equality, an even minor number,
and reachability of the tagged commit from Azure Repos `main`.

Owner setup in Azure DevOps Services:

1. Create one pipeline from `.azure/pipelines/preview.yml` and one from
   `.azure/pipelines/release.yml`.
2. In **Project settings → Service connections**, create or rename the existing Azure Resource
   Manager workload-identity federation connection to `Visual Studio Marketplace`. Associate it
   with the existing user-assigned managed identity; do not add a client secret or certificate.
3. In that service connection's **Security → Pipeline permissions**, authorize only the preview and
   release pipelines. The YAML deliberately uses the literal connection name because Azure DevOps
   does not allow a protected service connection to be selected through a pipeline variable.
4. Add the managed identity to the Visual Studio Marketplace publisher and grant it **Contributor**
   permission. The identity, federated credential, service connection, and Marketplace membership
   are external infrastructure and are not created or modified by these pipelines.
5. Ensure the self-hosted `U2602` agent has Azure CLI 2.30 or newer so `AzureCLI@2` can use workload
   identity federation.
6. Ensure the external GitHub-to-Azure mirror propagates the production tag as well as the `main`
   commit. Repository mirroring remains external to VMDE.
7. Set an appropriate pipeline-run retention policy. Deleting an Azure pipeline run also deletes
   its retained Pipeline Artifacts.

Only the final `AzureCLI@2` task authenticates through the service connection. It publishes the
already-built, verified, and retained VSIX with
`npx @vscode/vsce publish --azure-credential --packagePath ...`; build, audit, test, packaging, and
artifact creation run before that privileged task. No Marketplace PAT or other long-lived
credential is stored in pipeline variables or repository files.

Two local VS Code tasks support the same release contract without publishing:

- **Release: prepare production version** prompts for an exact greater even-minor production
  version. On a clean tracked `dev`, it commits only `package.json` and `package-lock.json`,
  compare-and-swap fast-forwards local `main` without checking it out, creates the annotated local
  numeric tag, stays on synchronized `dev`, and never pushes.
- **Preview: package local VSIX** defaults to the committed `HEAD` on any branch. Its opt-in
  **Include local edits** mode captures staged, unstaged, and safe non-ignored untracked input once.
  Both modes package in a helper-owned detached temporary worktree, reuse installed dependencies,
  copy the verified prerelease VSIX to ignored `artifacts/`, and never publish.

The Project Owner separately pushes prepared refs and controls GitHub-to-Azure propagation. The
local tasks do not configure Azure, create secrets, push, or publish.

---

## Releasing

Publisher `laicasaane`; Marketplace id `laicasaane.vmde`. Packaging is local and
credential-free. The canonical command runs VSCE's `vscode:prepublish` hook, creates the production
host bundle, and writes the versioned artifact:

```bash
npm run package:vsix    # artifacts/vmde-<version>.vsix
# `npm run pub` is the same local-only command.
code --install-extension artifacts/vmde-<version>.vsix
```

Neither command tags, pushes, signs in, or uploads. Inspect/test the artifact, then the Project Owner
uploads it through the [Visual Studio Marketplace publisher management
page](https://marketplace.visualstudio.com/manage/publishers/). The repository's tag workflow uses
the same package command and attaches the VSIX to a GitHub Release, but performs no registry upload.
Before VSCE runs, the command validates image references in `README.md` and `CHANGELOG.md`: relative
raster images resolve through the repository's explicit HTTPS raw-content base, non-HTTPS images and
local/inline SVG are rejected, and remote SVG badges must use a provider approved by VS Code.

**Before you tag (release checklist):**

- The latest **`nightly.yml`** run is green. This is currently a manual check. The
  routine **Release** workflow pushes its tag with `GITHUB_TOKEN`, which does not
  trigger the tag-push workflows; it calls `publish.yml` directly and never starts or
  waits for nightly. An independently/user-pushed `v*` tag matches both `nightly.yml`
  and `publish.yml`, but those runs are independent and publishing does not wait for
  the real-VS-Code result.
- `npm run test:coverage` is green locally (the threshold gate) and you've eyeballed
  the **e2e coverage** report (`npm --prefix media-src run test:e2e:coverage` →
  `media-src/coverage/e2e/index.html`) — e2e coverage is intentionally **out of the
  CI gate**, so this is the manual check that keeps it honest (task 150 item 3).
- `CHANGELOG.md`'s top heading is set to the version you're shipping.

**Routine GitHub releases (1.0.1+) — one click:** Actions → **Release** →
*Run workflow* → pick `patch` / `minor` / `major`. It bumps the version, commits and
tags on `main`, then runs `publish.yml` for that tag to create/update the GitHub Release asset. Edit
`CHANGELOG.md`'s top heading to the version you're shipping (and push it) **before** clicking. After
the workflow finishes, the Project Owner manually uploads that VSIX to each intended registry.

---

## Quick reference

```bash
# CI and local quality gates
npm run audit                  # root + media-src npm audit + exact-version vendor OSV audit
npm run audit:d2-go            # slower pinned D2 compile-only Go call-graph audit
npm run lint:ci                # Biome gate (whole tree)
npm run lint:fix               # apply safe lint + format fixes
npm run knip                   # unused files, exports, and dependencies
node build.mjs                 # host typecheck/bundle + webview bundle
npm run check:bundle-size      # shipped bundle budgets
npm run check:startup-cost     # eager-module/startup budgets
npm run typecheck              # webview tsc (no emit)
npm run typecheck:strict       # additive strict webview subset

# unit
npm test
npm run test:coverage          # -> coverage/index.html
npm run check:coverage-modules # zero-coverage-module ratchet (after coverage)

# Chromium e2e (from repository root, after `node build.mjs`)
npm --prefix media-src run test:e2e
npm --prefix media-src run test:e2e:coverage   # -> media-src/coverage/e2e/index.html

# real-VS-Code harness static check
npm run typecheck:vscode-e2e

# complete local quality suite (also runs jscpd + dependency-cruiser)
npm run quality

# local manual-upload artifact (no tag, push, credentials, or upload)
npm run package:vsix           # artifacts/vmde-<version>.vsix
npm run pub                    # alias of package:vsix
```
