# Task 662 — Verify link underline for visited links and forced colors

**Status:** open.
**Origin:** Project Owner request (known issue from Task 647).
**Severity:** low.
**Tech stack:** webview Preview and IR link styling; theme CSS.
**Related:** [Task 647](done/647-ir-inline-code-in-link-underline.md) (IR inline code in link underline).

## Problem

The `a:visited` state and forced colors (Windows high contrast) were not verified for the new link underline in Preview and IR, which Task 647 introduced.

## Requirements

1. The link underline is present and legible for `a:visited` in Preview and IR.
2. The link underline is present and legible under forced colors in Preview and IR.
3. If either state fails, fix it.

## Open design points

- To be settled in Part 1.

## Scope

- In: link underline in Preview and IR for `a:visited` and forced colors.
- Out: link styling not related to the underline.

## Acceptance

- [ ] The underline is present and legible for visited links in Preview.
- [ ] The underline is present and legible for visited links in IR.
- [ ] The underline is present and legible under forced colors in Preview.
- [ ] The underline is present and legible under forced colors in IR.

## Tests

- Verification of the four states above in the webview. Exact specs are to be specified in Part 1.

## Part 1 handoff (2026-10-18)

Read-only design pass at HEAD `1985ceb2` (branch `dev`). No browser, build or VS Code was run; every browser-behaviour claim is labelled "verified by reading" (repo or VS Code files read) or "unverified" (external Chromium behaviour, decided by a Part 2 probe).

### Verified facts (file:line, each verified by reading)

The shipped underline (Task 647):
1. `media-src/src/main.css:1338-1349`: `.vditor-reset :is(a[href], span[data-type='link-ref']):not(.footnotes-ref a, .vditor-footnotes__goto-ref, .vditor-linkcard a, .vditor-ir__node--expand)` sets `text-decoration-line: underline; -style: solid; -color: currentcolor; text-underline-offset: 2px`. The selector has no `:link`, `:any-link` or `:visited` part: it matches a visited and an unvisited anchor alike.
2. `main.css:1357-1367`: IR outer node `.vditor-ir .vditor-reset span[data-type='a']:not(.vditor-ir__node--expand)` has the same look but `text-decoration-color: var(--vmde-link, var(--vscode-textLink-foreground, #4493f8))` (not `currentcolor`). The element is a `span`, never an anchor.
3. `main.css:1372-1376`: a code reference inside a link drops its own hover/focus line.
4. `main.css:131` (`body[data-use-vscode-theme-color="1"]`): `--vmde-link: var(--vscode-textLink-foreground)` in `auto`. Named themes set `--vmde-link` at `media/markdown-themes/github-markdown-dark.css:48`, `github-markdown-light.css:48`, `vscode-dark-2026.css:104`, `vscode-light-2026.css:104`, `material-dark.css:53`.
5. IR link text colour: `build.mjs:455-459` rewrites Vditor's `.vditor-ir__link` to `color: var(--vmde-link, ...)`, `text-decoration: none`; generated `media/vditor/dist/index.css:1723-1726`.

`:visited` inventory (grep over `media-src/src`, `media/markdown-themes`, Vditor `src/` and the generated Vditor css):
6. No author rule in `main.css` or any file of `media/markdown-themes/` uses `:visited`, `:link` or `:any-link` (grep: no hit).
7. The only `:visited` rule anywhere is Vditor's link card: `media-src/node_modules/vditor/src/assets/less/_reset.less:492` (`a:visited .vditor-linkcard__abstract { color }`), generated at `media/vditor/dist/index.css:1250`, `css/content-theme/dark.css:115`, `light.css:96`. It recolours a child of a link card and sets no decoration; link cards are already excluded from the 647 rule (`main.css:1343`).
8. Content themes colour links with `.markdown-body a { color; text-decoration: none }` (group B: `github-markdown-light.css:25`, `github-markdown-dark.css:24`, `vscode-light-2026.css:27`, `vscode-dark-2026.css:27`) or `.markdown-body a { color }` (group A `material-dark.css:19-21`). These have no state pseudo-class, so they apply to visited links too; the 647 rule (specificity 0,3,2) beats the `none`. Vditor's `content-theme/dark.css:41-43` `.vditor-reset a { color: #4285f4 }` likewise; `light.css` sets no anchor colour.
9. VS Code's injected default sheet (1.129.0 `.vscode-test/worker-0/.../webview/browser/pre/index.html:104-135`, identical in 1.135.0 `test/vscode-e2e/.vscode-test/worker-0/.../index.html:104-133`) is wrapped in `@layer vscode-default` and holds `a, a code { color: var(--vscode-textLink-foreground) }`, `p > a { text-decoration: var(--text-link-decoration) }`, `a:hover { color }`, `a:focus { outline }`. It has no `:visited` rule and no forced-colors rule. Unlayered author CSS (all of VMDE's) wins over any layered rule.
10. A visited link cannot be produced by clicking in the extension webview: VS Code's host script cancels every anchor click (`index.html:535-562`, `event.preventDefault()` at 560, listener at 1175 in 1.129.0), and the webview cancels it again (`media-src/src/links/link-click-fix.ts:208-216`, `e.preventDefault()` at 212). Task 647 recorded the same limit ("no visited link can be produced in the webview", `tasks/done/647-...md` Not covered).
11. IR has no anchor for a rendered link: the node is `span[data-type=a]` with `span.vditor-ir__link` (`tasks/done/647-...md` IR DOM section; `main.css:1357-1359`). A `span` never matches `:visited`. The only real `<a href>` in IR can be inside a rendered HTML block (`.vditor-ir__preview` of `data-type="html-block"`, `node_modules/vditor/src/ts/util/processCode.ts:63-66`); 647 did not measure it.

Forced colours:
12. The only forced-colours code is `main.css:2982-3016` (`@media (forced-colors: active)`): borders to `CanvasText`, `:is(.wiki-link-chip, .vmde-code-ref-chip, code.vmde-code-ref) { color: LinkText; box-shadow }` (3002-3005), focus to `Highlight`. Nothing sets `forced-color-adjust` anywhere in `media-src/src` or `media/markdown-themes` (grep: no hit). The body-class path (`main.css:2964-2980`, VS Code high-contrast themes) is ordinary CSS and not forced colours; 647 already measured it (configurations `auto/hc`, `auto/hc-light`, `github-light+hc`, `material-dark+hc`: `media-src/e2e/link-underline.spec.ts:60-72`).
13. The underline line properties (`text-decoration-line/-style/-thickness`, `text-underline-offset`) are not colour properties; the 647 rules set no `!important` and no colour that would need to stay. The only colours in play are `text-decoration-color` and the link text `color`.
14. Test precedent: Chromium `page.emulateMedia({ forcedColors: 'active' })` is used at `media-src/e2e/high-contrast.spec.ts:124` (it asserts only `matchMedia` and the `!important` border rules, not that system colours replace author colours). Real VS Code `workbox.emulateMedia({ reducedMotion: 'reduce' })` reaches the webview iframe: `test/vscode-e2e/reduced-motion.spec.ts:11` and its assertion `preference: true` in the webview. The same call with `forcedColors` is therefore the plausible route (unverified until run).
15. Reusable test code: `media-src/e2e/link-underline.spec.ts` has `CFGS` (60-72), `LINKS` (83-102), `HTML_LINK` (104), `CONTROLS` (106-112), `LOOK` (134-139), page helpers `measure`/`find`/`point` (143-198), `openMode` (221), `applyCfg` (283), `measure` (305), `hoverMeasure` (312). `test/vscode-e2e/link-underline.spec.ts` has `DOC` (13), `LINKS` (45), `makeDoc` (80), `setContentTheme` (89), `measureIn` (109), `hoverText` (193), `expectAllUnderlined` (225), `expectControlsPlain` (246), three tests (258, 304, 390). The spec is not in `SMOKE_SPECS`/`FAST_SPECS` (grep of `playwright.config.ts`), so it runs only in the full tier and when named.
16. The web-design-guidelines source (fetched 2026-10-18) has no rule on link underline, forced colours or non-colour cues; nothing from it changes the design.

External browser facts, all unverified here (each is settled or made irrelevant by the Part 2 probes P1-P3):
- U1 Chromium applies only colour-type properties from `:visited` rules and drops the rest (so no theme can remove the line through `a:visited { text-decoration: none }`), and `getComputedStyle` reports the unvisited style for a visited link. Consequence: a computed-style test can never observe a visited link; only painted pixels can.
- U2 Whether `text-decoration-color: currentcolor` paints in the visited text colour (expected yes).
- U3 In forced colours, author `color`/`text-decoration-color` values that are not system colours are replaced by the UA value (anchors: `LinkText`, visited `VisitedText`; other text: `CanvasText`; decoration colour: `currentcolor`); system colours chosen by the author are kept; the line itself is kept.
- U4 Whether Playwright's `emulateMedia({ forcedColors: 'active' })` applies that colour replacement or only flips the media feature.
- U5 Chromium partitions `:visited` by (link URL, top-level site, frame origin) and records a visit only from a link click; headless-shell may have no visited-link store at all.

### Decisions

D1. Visited, Preview: no CSS change. By construction (facts 1, 6-9) the line is state-independent and the colour follows the link colour (VS Code `a` rule, theme `a` rule). Evidence: a Vitest guard on the shipped stylesheets (S1.3) plus a Chromium pixel check only if a visited state can be produced (probe P3).
D2. Visited, IR: vacuous for rendered links (fact 11): the node is a `span`, so `:visited` cannot apply. Evidence: the guard plus a structural Chromium assertion (no `a[href]` among the fixture's IR link nodes; `matches(':visited')` false). The IR HTML-block anchor is measured and recorded, not added to the pass criteria (it is a Task 647 coverage gap if it fails).
D3. Forced colours: expected to pass by cascade (U3: line kept, decoration colour follows text colour). The contract tested is an invariant, not a hypothesis about which system colour is used: line = `underline solid auto 2px`; decoration colour equals the link text colour; decoration colour has contrast at least 3:1 against the resolved `Canvas`. Expected observations (labelled unverified): Preview `LinkText`, IR `CanvasText` (IR text is not an anchor).
D4. Contingent fix, pre-approved, applied only if a forced-colours case is RED for the decoration colour: add to the existing `@media (forced-colors: active)` block (`main.css:2984`) one rule after line 3011, same selector as `main.css:1357-1359`, with `text-decoration-color: currentcolor;` (later in source order beats the (0,4,1) rule; no `!important`). Comment per `.agents/rules/css.md`. No other CSS change is allowed in Part 2.
D5. Real VS Code: needed once, for forced colours only (VS Code's injected layer and the OOPIF emulation are real-webview facts). One test block appended to the existing `test/vscode-e2e/link-underline.spec.ts`. Visited gets no real-VS-Code test: it cannot be produced there (fact 10) and the guard covers it.
D6. Tests extend existing files; no new Chromium or real-VS-Code spec file (avoids duplicating the 650 lines of fixture and helpers; jscpd).
D7. WYSIWYG and Split preview pane are out of the acceptance (Preview and IR only); Split preview shares the Preview DOM and is not added.

### State/DOM/messages

None. CSS-only; no message, no DOM change. Part 2 must keep `getValue()`, dirty state and Undo history untouched (assert `getValue()` before/after in the Chromium forced-colours case; the real-VS-Code block asserts the document text, as the 647 blocks do).

### Part 2 steps

Worker:  one worker, steps serial; S2 starts after S1 settles and holds the machine-wide real-VS-Code token. Background-work rules and the "software-engineering wording only" rule go verbatim into the brief.

**S1. Probes, guard, Chromium tests, contingent fix.**
Owned files: `test/backend/link-underline-css-states.test.ts` (new); `media-src/e2e/link-underline.spec.ts` (append only); `media-src/src/main.css` (only under D4); private untracked `tmp/662/` (probe scripts and raw output; not committed).
1. Probes (private scripts, serve the harness with `node media-src/e2e/serve.mjs`; use `playwright-core` from `media-src/node_modules`; run under `xvfb-run -a`):
   - P1 calibration: with `emulateMedia({ forcedColors: 'active' })` open the fixture in Preview and IR; record resolved `LinkText`, `VisitedText`, `CanvasText`, `Canvas` (probe elements with those `color` keywords) and, per link kind, text colour, decoration line/colour. Question: do author colours get replaced (U3, U4)?
   - P2 forced-colours table for the 18 `LINKS` + `HTML_LINK` in Preview and IR for `auto/light`, `auto/dark` (with `colorScheme: 'dark'`), `github-light`, `material-dark`, plus the IR html-block `<a href>`.
   - P3 visited recipe, in both Playwright's default headless-shell and `channel: 'chromium'`. Detector: a page-local colour-only rule `a:visited { color: rgb(255,0,0) }` plus a screenshot pixel scan (decode the PNG in-page through `Image` and canvas `getImageData`; no new dependency). Recipes in order: R1 CDP `CSS.forcePseudoState` with `['visited']`; R2 a plain anchor outside the editor with a `window` capture listener calling `stopImmediatePropagation` (so `link-click-fix.ts` does not cancel it), real click to a served page (`/prerender.html?visited=1`), `page.goBack()`, re-wait for the editor; R3 `location.assign` then `goBack`. Record which recipe (if any) turns the detector red.
   - Decision gate: if P3 finds no recipe, the Chromium visited pixel case is not written and the task records "visited cannot be produced in Chromium here; guard plus construction". If P1 shows the emulation does not replace colours (U4 false), the Chromium forced-colours colour assertions are replaced by the line-only assertions and the real-VS-Code block carries the colour evidence; if it also fails there, report to the main thread (do not tick the forced-colours items).
2. RED first (show each failing or, for a pure guard, show the guard detecting a synthetic violation):
   - Chromium cases below run against unchanged `main.css`. A case that is green at once is kept (it is verification, not a fix); only a RED decoration-colour case triggers D4.
3. Vitest guard `test/backend/link-underline-css-states.test.ts` (`npx vitest run --config test/vitest.config.mts test/backend/link-underline-css-states.test.ts`): reads `media-src/src/main.css` and every `media/markdown-themes/*.css` (tracked sources, no build needed), strips comments, splits into rules, and asserts: (a) no selector contains `:visited` (the Vditor link-card rule is generated output and not scanned; fact 7 records it); (b) no file contains `forced-color-adjust`; (c) every rule that declares `text-decoration-line: underline` for `a[href]` or `span[data-type` selectors has no `:link`/`:any-link`/`:visited` in its selector; (d) a negative case runs the same scanner on a synthetic string with `a:visited { text-decoration: none }` and `.x { forced-color-adjust: none }` and expects detection (proves the guard is not vacuous). Put the scanner in the test file itself (no new source module).
4. Chromium cases appended to `media-src/e2e/link-underline.spec.ts` (run: `xvfb-run -a npm --prefix media-src exec playwright test link-underline.spec.ts -g "forced colors|visited"`; if the repo's `test:e2e` script forbids args use `xvfb-run -a npm --prefix media-src run test:e2e -- link-underline.spec.ts -g "forced colors|visited"`):
   - C1 `forced colors: every link kind keeps the one underline in a legible colour (${mode})` for `ir` and `preview`. `page.emulateMedia({ forcedColors: 'active' })` before `openMode`; configurations: `auto/light`, `auto/dark` (also `colorScheme: 'dark'`), `github-light` (group B), `material-dark` (group A). Per config, first a calibration assertion from P1 (`matchMedia('(forced-colors: active)').matches`, and the plain link text colour equals one resolved system colour). Then for every `LINKS` entry (+ `HTML_LINK` in Preview): rest `line/style/thick/offset` equal `LOOK`; decoration colour equals the effective text colour (code-text targets: equals the plain link's decoration colour, as in the 647 case at line 360-365); decoration colour has contrast at least 3:1 against resolved `Canvas` (helper `contrast(a, b)` in the spec); hover keeps the same line for `inline` and `code-in-link`. Controls `N-code` and `N-em` stay `none`. `getValue()` unchanged and no `edit` message posted. Reuse `measure`, `hoverMeasure`, `applyCfg`.
   - C2 `visited links keep the underline (preview)` only if P3 found a recipe: make the `L-inline` anchor visited, scan the clip of its text for an underline row (a row below the baseline where at least 90% of the text-width columns are not the background colour; text chosen without descenders by temporarily setting its text to `HHHH` in the page), assert the row exists and its colour equals the painted link colour; also assert the line in `getComputedStyle` is `underline solid auto 2px` (it is the unvisited value, kept as a sanity check only). Do not add an IR visited case here.
   - C3 `visited cannot apply to an IR link` (structural, always written): for the IR fixture, none of the elements found for `LINKS` is or has an `a[href]` ancestor inside `.vditor-ir > .vditor-reset` (except the HTML-block preview), and `document.querySelectorAll(':visited')` over the IR link nodes matches none. Record the IR HTML-block anchor's line and colour as an annotation (`test.info().annotations`), not an assertion.
5. If and only if a C1 decoration-colour case is RED: apply D4, re-run C1 until GREEN, and run once the 647 neighbours that read this rule (`link-underline.spec.ts` full, `content-theme.spec.ts`, `high-contrast.spec.ts`). If nothing is RED: no source change and no neighbour re-run (acceptance-scoped tests).
6. Checks: `npx biome check` on the changed files; `npm run typecheck`; the guard run; the focused Chromium run above.

**S2. Real-VS-Code spec** (`node build.mjs` first; `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test -- link-underline.spec.ts -g "forced colors" --workers=1 --retries=0`).
Owned file: `test/vscode-e2e/link-underline.spec.ts` (append one `test()`, reuse `makeDoc`, `setContentTheme`, `measureIn`, `expectAllUnderlined`-style helpers; do not export new modules).
- T1 `forced colors: Preview and IR links keep the one underline in a legible colour`: `await workbox.emulateMedia({ forcedColors: 'active' })` (reset to `'none'` in a `finally`), content theme `auto`, open the fixture (IR rendered), assert in the webview `matchMedia('(forced-colors: active)').matches` and the calibration from P1 (link text colour equals a resolved system colour; if the emulation does not reach the webview, fail loudly with that message), then for the 10 `LINKS` of the existing spec: line `underline solid auto 2px`, decoration colour equals text colour, contrast at least 3:1 against `Canvas`; controls `none`. Toggle Preview (the existing test at line 390 shows the toggle and remembered-mode handling), repeat for `LINKS` plus `html-a-href`; also assert `a:focus-visible` keeps the underline. Finally `docText` equals `DOC` and the document is not dirty.
- Real-webview facts this confirms (unverified before): the `@layer vscode-default` `a`/`a code` colour under forced colours, `--vmde-link` resolution, and that the OOPIF webview receives the emulation.
- Not covered (recorded, not tested): `a:visited` in real VS Code; Windows OS-level forced colours (Playwright emulation only).

**S3. Closure** (main thread owns the queue table in `LOCAL_AGENT_TASK.md` §1 and §7.28 in the same edit as any progress change). Files: `tasks/662-link-underline-visited-forced-colors.md` (fill "Open design points" from Decisions D1-D7, tick the four acceptance items with real results, and a closure section); `tasks/README.md` only if the task is fully complete; `CHANGELOG.md` only if D4 changed shipped CSS. Gates once for the closure batch: `npm run lint:ci`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, the guard, the two focused specs, and `npm run quality` per AGENTS.md at batch level; record unrelated pre-existing failures separately.

### Tests mapped to the record's Acceptance items

| Acceptance item | Cheapest layer | Test |
|---|---|---|
| Underline present and legible for visited links in Preview | Vitest guard (all themes, no state-dependent rule) + Chromium pixel check if P3 yields a recipe | S1.3 (a)(c); C2 |
| Underline present and legible for visited links in IR | Vitest guard + Chromium structural | S1.3; C3 (rendered IR links are spans, `:visited` cannot apply) |
| Underline present and legible under forced colours in Preview | Chromium (invariants) then one real-VS-Code block | C1 (`preview`); S2 T1 (Preview part) |
| Underline present and legible under forced colours in IR | Chromium then real VS Code | C1 (`ir`); S2 T1 (IR part) |

Edge cases: code inside a link (`code-in-link`, `mixed-code`, `coderef-in-link-code`) in C1 and T1; reference and collapsed links (`span[data-type=link-ref]`); wiki chip (system colour `LinkText` kept by `main.css:3002`); hover; `auto` dark with `colorScheme: 'dark'`; group A and group B themes; VS Code high-contrast body class is already covered by 647 and is not repeated; IR expanded state (underline absent by design, 647) not repeated; IR HTML-block `<a href>` recorded; footnote markers excluded as in 647 (Owner ruling); no `edit` message and unchanged `getValue()`.

### Owner questions

1. IR link text colour under forced colours. In Preview an anchor is `LinkText`; in IR the link text is a `span`, so it is expected to be `CanvasText` (same as body text) with a `CanvasText` underline, so the underline is the only cue. Underline legibility is not affected.
   - A (recommended): leave; the task is the underline, and the underline is present and legible (scope "Out: link styling not related to the underline").
   - B: add inside the `@media (forced-colors: active)` block a rule giving `.vditor-ir__link` and the `link-ref` spans `color: LinkText` (and the underline then follows `currentcolor`), matching Preview and the wiki chips (`main.css:3002`). One more rule and one more assertion; changes IR look only in forced colours.
2. Evidence standard for the two visited items if probe P3 finds no way to produce a visited link in Chromium (likely; the extension webview cannot produce one either).
   - A (recommended): tick them with the recorded wording "by construction, no state-dependent rule in shipped CSS (guard test), IR links are spans; not observable in a browser here".
   - B: leave the two visited boxes unticked and keep the task open as "not verifiable".

### Residual risks

- Every browser-behaviour claim in U1-U5 is unverified until P1-P3 run; the plan is built so that a wrong guess shows as a failing or skipped case, not a false pass.
- `getComputedStyle` cannot show a visited link's colour (U1); a visited pixel case may be impossible or fragile (headless-shell, partitioned history), hence the gate and Owner question 2.
- Playwright forced-colours emulation may flip only the media feature (U4); the real-VS-Code block is the second chance, and a double failure leaves forced colours unverified (the main thread must be told).
- Real forced colours (Windows contrast themes) differ from emulation in palette values and in how Electron/VS Code applies them; the invariants (line kept, decoration colour equals text colour, contrast at least 3:1) are chosen to hold for any palette, but real Windows is not covered.
- If the D4 fix is needed, the `@media` rule relies on source order after `main.css:1357`; moving the block earlier would break it (comment says so).
- The IR HTML-block anchor is only recorded; if it is not underlined it is a Task 647 gap needing a separate decision.
- The Part 2 plan names the queue's single  step as two serial steps (S1 Chromium/Vitest, S2 real VS Code) because S2 needs the real-VS-Code token; same worker, no parallelism.

**Owner answers (2026-10-18, chat):** Q1 — leave the IR link colour under forced colours as is. Q2 (visited evidence) — not asked; the recommended default applies (tick by construction plus the guard test if no visited state can be produced, and say so).
