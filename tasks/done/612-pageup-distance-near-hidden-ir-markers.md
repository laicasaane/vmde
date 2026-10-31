# Task 612 — Restore page-sized navigation near hidden IR markers

**Status:** planned (2026-09-29); Part 1 reconciled 2026-11-01 at `88cc673d`; P2-1 (measurement) and P2-2 (paging handler, Chromium tests) and P2-3 (real VS Code) done 2026-11-01, P2-4 (closure) next. The Project Owner decided the reference behavior and the repair order on 2026-10-08 (see Owner decisions); implementation has not started.
**Origin:** [Task 286](286-caret-marker-reveal.md) maintenance note at commit `c89b46f9`; coordinate with [Task 369](369-table-inline-code-row-height-delta.md)'s inline layout findings.
**Scope:** PageUp/PageDown travel distance in IR. Preserve Task 286's completed marker reveal and delimiter-safe typing behavior.

## Problem

In a document with hidden link or code markers, a native PageUp can travel only one line. Task 286's maintenance verification adapted its test anchor to reach a marker regardless of page distance; it did not repair the short navigation distance.

## Measured evidence

`tasks/done/286-caret-marker-reveal.md` §Maintenance records the first PageUp from a bottom anchor landing in `real-end-code`, one line above, below the intended hidden link-marker line. The result occurred on dev `01b12c63` and Task 286 commit `e2beed52`, in VS Code 1.129.0 and 1.110.0, at default Xvfb and 1600×1000 sizes. The exact environmental change was not identified. The note attributes the variation to Chromium page navigation near Vditor marker boxes and says a VMDE PageUp/PageDown handler or marker CSS change is needed. Vditor's collapsed IR markers use `display:inline-block; width:0; height:0; overflow:hidden`; Task 286 kept marker CSS out of scope. Task 369 separately documents inline-block marker line-break effects, so a CSS candidate needs layout checks.

## Affected modes

- **IR:** short PageUp travel was observed near hidden link/code markers.
- **WYSIWYG/SV:** no equivalent observation; use them as controls, not assumed defects.

## Candidate approaches

1. Handle PageUp/PageDown in VMDE using measured viewport geometry and a source-safe target caret, preserving native selection extension, scroll and focus behavior.
2. Change collapsed marker CSS so Chromium's native paging sees stable line boxes, while retaining hidden delimiters, copy behavior and Task 369's line layout.

## Owner decisions (2026-10-08)

Approved in chat by the Project Owner.

- The reference is VS Code's text editor: PageUp/Down travel about one viewport, Shift+PageUp/Down extend the selection, and wrapped lines count visually.
- Try a marker CSS/layout change first. Use a VMDE paging handler only if CSS cannot meet the reference without breaking Tasks 286 and 369.

## Tests

- Measure caret line, viewport, scroll offset and page travel in Chromium and real VS Code across link/code/strong markers, different caret x positions, font metrics, wrapping and viewport sizes. Compare plain-text and WYSIWYG/SV controls.
- Add focused Chromium coverage for PageUp/PageDown, Shift selection, marker visibility, copy and typing; include Task 369's inline-code wrapping/row-height controls for any CSS change.
- Build first, then focused real-VS-Code XTEST coverage with exact caret line and host text after native keys. Rerun Task 286's marker-reveal spec without retries.

## Acceptance

- [x] PageUp/PageDown move by the Owner-approved page distance near collapsed IR markers, including wrapped lines and Shift selection, without one-line stalls. (Chromium `ir-page-navigation.spec.ts`, real-VS-Code `ir-page-navigation.spec.ts` with OS keys.)
- [x] Landing remains paintable and delimiter-safe; marker reveal, copy, inline layout, scroll and exact host text remain correct. (Typing-after-landing tests in both layers, Task 369 CSS unchanged and covered by `ir-inline-code-line.spec.ts`, `marker-reveal.spec.ts` PageUp part; its Home/End line 165 is the known racy check.)
- [x] Chromium and real-VS-Code tests pass at representative viewport/font conditions, with any environment-dependent result recorded explicitly. (Default and 1600×1000 viewports in Chromium, default and serif fonts in both layers; real VS Code on the default and the 1600×1000 Xvfb screens, whose webview height did not change.)

## Part 1 handoff (2026-10-14)

Read-only review of the source; the cause is an inference until the S1 probe runs.

- **Entry points (verified).** VMDE has no PageUp/PageDown handler in IR, WYSIWYG or SV; native Chromium paging runs unchanged. The single scroller is the contenteditable `.vditor-reset` (`media-src/src/main.css`). Stock collapsed markers are `display:inline-block; width:0; height:0; overflow:hidden` (Vditor `_ir.less`). Task 369 takes collapsed inline-code markers out of flow (`position:absolute; display:block; 0×0`, `main.css`, earlier than Task 286's pass — not the unidentified environment change). Task 286 reacts after the move (selectionchange-driven reveal plus `normalizeMarkerNavigationCaret`, `media-src/src/editing/editor-caret.ts`). IR copy is DOM-based (`cloneContents` then `VditorIRDOM2Md`), so marker CSS changes only the selection range that layout produces, not copied text.
- **Cause (inference).** Blink's page move steps line by line at a fixed goal x and stops when the next position is null, unchanged, has no caret y, or is beyond about one viewport. A goal x hitting a 0×0 atomic inline-block marker (link `[`/`](url)`) or an absolute code marker can put the candidate inside the marker's own formatting context, so the next step stalls after one line. Fits the recorded dependence on caret x and font metrics.
- **Contract (Owner 2026-10-08).** Match the VS Code text editor: PageUp/PageDown moves the caret about one viewport of visual lines (wrapped lines count) and scrolls by about a page; the goal x is kept across repeated presses; Shift+PageUp/PageDown extends from a fixed anchor; nothing stalls next to collapsed link, code or strong markers. Task 286 still holds (reveal on landing, caret normalized out of hidden delimiters, typing lands outside them, exact host text unchanged). Task 369 still holds (collapsed inline code stays in the text line; markers 0 wide collapsed, visible expanded).
- **Part 2.** S1 (measure): Chromium harness `media-src/e2e/marker-reveal.html` plus a `@probe` (or `*spike*`) spec — native PageUp/PageDown and separate `Selection.modify('move', …, 'line')` steps, recording per step the container class, the caret range's client rects, y change, scrollTop change, line count and which stop condition fired; vary link/code/strong/em lines, caret x (start, middle, end, over a marker), two font stacks, wrapped lines, default and 1600×1000 viewports; controls: plain text, WYSIWYG, SV. Then try live: (a) the Task 369 out-of-flow rule extended to all collapsed inline markers, (b) a link-marker-only rule, (c) no CSS route (record why). S2 (repair + Chromium): CSS in `main.css` next to the Task 369 rule with a reason comment (`.agents/rules/css.md`); fallback handler only if CSS cannot meet the contract without breaking Tasks 286/369 — a new `media-src/src/editing/` module (capture-phase keydown, IR only, skipped during composition; moves by the scroller's client height of visual lines at the goal x, Shift extends, scrolls by the same amount, landing left to the Task 286 normalizer; manifest + boundary test). Tests in `media-src/e2e/marker-reveal.spec.ts` or a new `ir-page-navigation.spec.ts`: page distance ≥ N lines from anchors under link, code and strong lines; three or more presses in a row (goal-x drift after the normalizer's selection write); Shift+PageUp selection text and copy output; typing after landing; the Task 369 inline-code line geometry and no new break opportunity or row-height change; the triple-click marker-inclusive copy check (Task 191 P0-11). S3: real-VS-Code `test/vscode-e2e/ir-page-navigation.spec.ts` (exact caret line and host Markdown after native keys at the default size and 1600×1000), reruns of `marker-reveal.spec.ts` and `ir-inline-code-line.spec.ts`. S4: closure.
- **Edge cases.** Goal-x drift over repeated presses; the 100 ms dwell expansion re-wrapping the landing line; document top and bottom; a page smaller than one line; code-block and math previews with collapsed markers; table cells; IME composition; links with an empty URL marker.
- **Decisions (within the Owner rule of 2026-10-08, "try marker CSS/layout first, a VMDE paging handler only if CSS cannot meet it without breaking Tasks 286/369").** (1) CSS candidate (a) would contradict Task 369's recorded scope guard ("every other collapsed marker type keeps stock inline-block") and may affect triple-click copy (inline-block markers make it include the markers); the guard may be rewritten only if S1/S2 show triple-click copy, wrapping and row heights unchanged — otherwise the handler. (2) "Viewport travel" includes the scroll offset moving by about a page, as VS Code does, measured as a scrollTop change within a tolerance.
- **Risks.** Cause unproven until S1; results depend on font and environment (record each); a handler must reproduce Shift-extend direction and anchor exactly.

## Part 1 reconciliation (2026-11-01)

Read-only re-verification of the 2026-10-14 handoff against dev `88cc673d`. No product code changed. The cause is still an inference until step P2-1 measures it.

### Handoff claims re-checked

| Claim (2026-10-14) | State at `88cc673d` | Evidence |
| --- | --- | --- |
| No VMDE PageUp/PageDown handler in IR, WYSIWYG or SV | Still true for the move itself. **Changed:** Task 608 added `PageUp`/`PageDown` to `NAV_KEY_DIRECTION`, so a trusted page key that leaves a collapsed caret on the bare editor root is re-landed by `normalizeRootNavigation` (key window `NAV_KEY_WINDOW_MS = 250`). The host's prerender scroll script (`src/webview-host/html-builder.ts:232`) only counts scroll intent before the editor is live. | `media-src/src/editing/editor-caret.ts:360-371`, `:440-470`, `:508-512` |
| Landing repaired by `normalizeMarkerNavigationCaret` after the move | Still true. **Changed by Task 648:** the ejection is skipped only for a plain or Shift ArrowLeft/ArrowRight inside a node revealed before the key (`horizontalStep`, judged on the outermost node, inside the 250 ms window). A PageUp/PageDown landing is never horizontal, so it is still ejected to the node edge. A non-collapsed (Shift) range is still never normalized. | `editor-caret.ts:296-350`, `:498-505`, `:612-621` |
| Reveal is selection-driven | Still true. **Changed by Task 648:** `markerTargets` also reveals an inline node next to an element-position caret (`elementPositionNeighbors`). The ejection writes exactly such an element position, so after a page landing the neighbouring inline node now expands in the same frame, which can re-wrap the landing line. `shiftArrowTargets` applies only to Shift+ArrowLeft/ArrowRight, not to Shift+PageUp/PageDown. | `editor-caret.ts:150-190` |
| Stock collapsed markers are `inline-block; width:0; height:0; overflow:hidden` | Still true (Vditor `_ir.less`). | — |
| Task 369 out-of-flow rule for collapsed inline code | Still true, unchanged: `.vditor-ir .vditor-reset .vditor-ir__node:not(.vditor-ir__node--expand)[data-type='code'] > .vditor-ir__marker { position:absolute; display:block; … }`. Task 369's scope guard (every other collapsed inline marker type keeps stock `inline-block`) still stands in `tasks/done/369-table-inline-code-row-height-delta.md`. | `media-src/src/main.css:356-365` |
| Task 645 block at the end of `main.css` | Appended at `main.css:3153-3277`. Every selector is scoped to `.vditor-sv` or `.vmde-sv-gutter`; nothing touches IR markers. No effect on this task. | `main.css:3153-3277` |
| **New coupling:** Task 647 link underline | `.vditor-reset :is(a[href], span[data-type='link-ref']):not(… .vditor-ir__node--expand)` underlines collapsed IR links; its specs walk ancestors and treat `inline-block`/`position:absolute` as decoration boundaries. A CSS route that changes collapsed link markers must keep `link-underline.spec.ts` (both layers) green. | `main.css:1331-1345`, `media-src/e2e/link-underline.spec.ts:170-173` |
| Single scroller `.vditor-reset`; IR copy is DOM-based | Unchanged. | — |
| Existing PageUp coverage | Chromium `marker-reveal.spec.ts:123` (harness height 320, 18 bold page lines, asserts reveal and 18 intact markers, not distance). Real VS Code `marker-reveal.spec.ts:275` (24 bold page lines, anchor above the link/code end lines, asserts landing in a page line, not distance). Real VS Code `marker-reveal.spec.ts:165` still fails on unchanged code (Task 648 record). | as cited |
| Probe conventions | Real VS Code excludes `@probe` titles by default (`test/vscode-e2e/playwright.config.ts:178`) and `*spike*` files. The Chromium config has no exclusion; the precedent for Chromium measurements is a separate `*-probes.spec.ts` file (`copy-cut-probes.spec.ts`). Chromium harness pages are registered in `media-src/e2e/harness-entries.mjs` (checked by `test/backend/harness-registry.test.ts`). | as cited |
| Font settings | VMDE has no content font-family setting (`vmde.editor.fontSize` only; `sourceFontFamily` is SV-only). Fonts available on the test machine include DejaVu Sans/Serif/Sans Mono and Liberation. | `package.json:850-870` |

The root-cause inference (Blink page move stepping lines at a fixed goal x and stalling at a 0×0 atomic marker) is unchanged by these commits. Task 648's changes add one new failure mode to check: after the ejection, the adjacent node expands and its markers become visible, so the caret's line can re-wrap and the next PageUp starts from a different x and line.

### Decisions re-settled

The two 2026-10-14 decisions stand: (1) the CSS route may extend beyond Task 369's code-only rule only if triple-click copy, wrapping and row heights are unchanged, otherwise the paging handler; (2) "viewport travel" includes the scroll offset moving by about a page.

- **Provisional decision (2026-11-01), reversible — page-distance pass criterion.** Near markers, one PageUp/PageDown must move the caret by at least the plain-text control's native travel minus one line height and at least half of `.vditor-reset.clientHeight`, and must change `scrollTop` by at least `clientHeight − 2 × lineHeight`, unless the move is clamped at the document top or bottom. Shift+PageUp/PageDown must meet the same distance with the anchor unchanged. Evidence: Owner contract of 2026-10-08 (VS Code reference); the plain-text control gives an environment-independent baseline. Chosen by the step owner (rule 4, smallest reversible option).
- **Provisional decision (2026-11-01), reversible — Chromium harness.** Add a new harness entry `ir-page-navigation` (`media-src/e2e/ir-page-navigation.html`, `media-src/e2e/ir-page-navigation-harness.ts`) that reads `doc`, `mode` (`ir`, `wysiwyg`, `sv`), `height` and `font` from the query string, loads `main.css` and installs the real `installIrMarkerReveal` and `installCompositionState`. The `marker-reveal` harness and its spec stay unchanged. Selected by a recorded decision check (probability 0.63 against 0.36 for extending the `marker-reveal` harness); both candidates kept `marker-reveal.spec.ts` unchanged.
- **Provisional decision (2026-11-01), reversible — names and placement.** Chromium measurements: `media-src/e2e/ir-page-navigation-probes.spec.ts` (titles tagged `@probe`). Chromium regression tests: `media-src/e2e/ir-page-navigation.spec.ts`. Real VS Code: `test/vscode-e2e/ir-page-navigation.spec.ts`, with the measurement test tagged `@probe` and the acceptance tests untagged. Fallback handler only: module `media-src/src/editing/ir-page-navigation.ts`, export `installIrPageNavigation(): () => void`, manifest name `ir-page-navigation` next to `editor-caret` in `scripts/module-manifest.mjs`, unit file `media-src/src/editing/ir-page-navigation.test.ts`. Chosen by the step owner (rule 4).
- **Provisional decision (2026-11-01), reversible — environment matrix.** Viewports: the harness default (800×600 Chromium page, harness height 320) and 1600×1000; real VS Code: the default Xvfb size and 1600×1000. Font stacks: the content theme default and `"DejaVu Serif", serif`, applied in tests through CSSOM (`element.style.fontFamily` on `.vditor-reset`, which the webview CSP allows). Chosen by the step owner (rule 4); no setting exists for a content font.
- **Provisional decision (2026-11-01), reversible — fallback handler coexistence.** If the handler is needed it listens on `keydown` in the capture phase, IR only, skips composition and modified keys other than Shift, calls `preventDefault`, and writes the caret only through `requestCaret` (ADR-0007). It must leave `editor-caret.ts`'s `onKeyDown` untouched, so the page key still arms the Task 608 root re-landing and the marker ejection for the handler's own selection write. Chosen by the step owner (rule 4).
- **Provisional decision (2026-11-01), reversible — CSS route regressions.** Any CSS candidate that changes collapsed link markers adds `link-underline.spec.ts` (Chromium and real VS Code) to the regression set, besides Task 369's `ir-inline-code-line.spec.ts` and the triple-click copy checks in `structural-selection.spec.ts:226` and `mouse-selection.spec.ts` (P0-11). Evidence: Task 647 rule and its spec boundary walk above.

### Invariants (amended)

Task 286: reveal on landing, caret ejected out of hidden delimiters, typing lands outside them, exact host text unchanged. Task 369: collapsed inline code stays in its text line, markers 0 wide collapsed and visible expanded, row height equal to Preview. Task 608: a page key that lands on the bare root is re-landed in its direction. Task 647: collapsed IR links stay underlined, revealed links keep Vditor's look. Task 648: plain and Shift ArrowLeft/ArrowRight still step one source character through revealed markers.

### Edge cases (added)

Re-wrap of the landing line when the ejected caret's neighbour expands (Task 648); a page key over a rule or TOC that lands on the root (Task 608); repeated presses within 250 ms of each other; a page landing next to a link at the start or end of a paragraph (element-position reveal). The 2026-10-14 list still applies.

### Part 2 step plan (replaces the 2026-10-14 S1–S4 list)

Common to every step: build with `node build.mjs` before any real-VS-Code run; run real VS Code only through the run wrapper with `--workers=1 --retries=0`; Chromium specs with `xvfb-run -a npm --prefix media-src run test:e2e -- <spec>`; record the viewport, font and VS Code version of every measured result.

**P2-1 — Measure (Light, measurement; real-VS-Code probe included).**
- Result: a measured table of page travel per case, the confirmed or replaced cause, and the route choice (CSS candidate or handler) recorded in this task file.
- Owned files: `media-src/e2e/ir-page-navigation.html`, `media-src/e2e/ir-page-navigation-harness.ts`, `media-src/e2e/harness-entries.mjs` (one entry), `media-src/e2e/ir-page-navigation-probes.spec.ts`, `test/vscode-e2e/ir-page-navigation.spec.ts` (the `@probe` test only), this task file.
- Cases: link, code, strong and em page lines; caret x at start, middle, end and over a marker; wrapped lines; both viewports and both font stacks; plain-text, WYSIWYG and SV controls. Per press record the caret container class, client rect y, `scrollTop`, visual line count and whether the line stalled; also separate `Selection.modify('move', dir, 'line')` steps. Then try live in the probe: (a) Task 369's out-of-flow rule for every collapsed inline marker; (b) a link-marker-only rule; (c) no CSS route, with the reason.
- Acceptance proved: none (it sets the baseline for items 1 and 3).
- Checks: `xvfb-run -a npm --prefix media-src run test:e2e -- ir-page-navigation-probes.spec.ts` exits 0 and prints the table; `npx vitest run --config test/vitest.config.mts test/backend/harness-registry.test.ts` passes; `node build.mjs` exits 0, then the wrapper with `VMDE_PROBES=1 … npm --prefix test/vscode-e2e test -- ir-page-navigation.spec.ts --grep @probe` exits 0 and prints the table.
- Stop rule: if no case stalls in either layer, record that, keep the tests of P2-2 as regression guards and continue; if the measured cause differs from the inference, record it and stop for a design turn.

**P2-2 — Repair with Chromium tests (merged RED+fix, Light).**
- Result: the route chosen in P2-1 implemented, with Chromium tests that fail before the fix and pass after it.
- Owned files, CSS route: `media-src/src/main.css` (a rule next to the Task 369 rule at `main.css:356`, with a reason comment per `.agents/rules/css.md`), `media-src/e2e/ir-page-navigation.spec.ts`; if the rule widens Task 369's scope, also the scope-guard assertion in `test/vscode-e2e/ir-inline-code-line.spec.ts`. Handler route: `media-src/src/editing/ir-page-navigation.ts`, `media-src/src/editing/ir-page-navigation.test.ts`, its install call site `media-src/src/boot/main.ts` (next to `installIrMarkerReveal()` at line 153), `scripts/module-manifest.mjs`, `media-src/e2e/ir-page-navigation-harness.ts`, `media-src/e2e/ir-page-navigation.spec.ts`.
- Tests: the page-distance criterion above from anchors under link, code and strong lines; three presses in a row without goal-x drift; Shift+PageUp/PageDown selection text, fixed anchor and copy output; typing after landing keeps markers intact; Task 369's inline-code line geometry and row height unchanged; triple-click marker-inclusive copy unchanged; collapsed link underline unchanged.
- Acceptance proved: item 1 and item 2 (Chromium layer).
- Checks (expected all pass except listed pre-existing failures): `xvfb-run -a npm --prefix media-src run test:e2e -- ir-page-navigation.spec.ts marker-reveal.spec.ts ir-arrow-markers.spec.ts structural-selection.spec.ts mouse-selection.spec.ts` (add `link-underline.spec.ts` for a link-marker CSS change); handler route also `npx vitest run --config test/vitest.config.mts media-src/src/editing/ir-page-navigation.test.ts media-src/src/editing/editor-caret.test.ts test/backend/module-boundaries.test.ts`; `npm run typecheck` and `npm run lint` exit 0. Pre-existing: `structural-selection.spec.ts:242` (load-dependent).

**P2-3 — Real VS Code (real-VS-Code step).**
- Result: real-VS-Code acceptance tests with OS keys, run and passing at both sizes and both font stacks.
- Owned files: `test/vscode-e2e/ir-page-navigation.spec.ts` (untagged tests).
- Tests: exact caret line and host Markdown after native PageUp/PageDown and Shift variants near link, code and strong lines; scroll offset criterion; typing after landing.
- Acceptance proved: items 1, 2 and 3 (real-VS-Code layer).
- Checks: `node build.mjs` exits 0; then through the wrapper `npm --prefix test/vscode-e2e test -- ir-page-navigation.spec.ts marker-reveal.spec.ts ir-inline-code-line.spec.ts ir-arrow-markers.spec.ts --workers=1 --retries=0` (add `link-underline.spec.ts` for a link-marker CSS change). Expected: all pass except `marker-reveal.spec.ts:165` (pre-existing).

**P2-4 — Closure (closure step).**
- Result: verified gates, honest checklists, completion report with commit message and path list.
- Owned files: this task file; `tmp/612/completion-report.md` (untracked).
- Acceptance proved: confirms items 1–3 with the recorded environment results.
- Checks: `node build.mjs`, `npm run typecheck`, `npm run lint`, the focused Vitest files, the P2-2 Chromium specs, the P2-3 real-VS-Code specs, `npm run quality` (record each stage; network audit failures recorded, not fixed), one final decision-gate check on the diff.

### Checkpoint (2026-11-01)

Part 1 reconciled at `88cc673d`; working tree clean except this record. Next action: P2-1.

### P2-1 result (2026-11-01) — measurement

Measured on dev `88cc673d` plus the new probe files only (no product change). Chromium rows come from the new `ir-page-navigation` harness (real `main.css` and `installIrMarkerReveal`) driven by `media-src/e2e/ir-page-navigation-probes.spec.ts` (`VMDE_PROBES=1`; the title tag is `@probe`, and the file is skipped without that variable so the default suite stays fast). Real-VS-Code rows come from the `@probe` test in `test/vscode-e2e/ir-page-navigation.spec.ts` with OS keys. Rows were stored as local scratch files (not committed). Machine load (1-minute average) was 1.1–2.1 across the Chromium runs and 1.4–1.6 across the two real-VS-Code runs, so no run was starved.

**Conditions.** Chromium: Playwright's 1280×720 page with a 320 px editor (scroller `clientHeight` 282) and a 1600×1000 page with a 900 px editor (`clientHeight` 862); fonts: content-theme default and `"DejaVu Serif", serif`; Linux headless Chromium bundled with Playwright. Real VS Code (downloaded test build, same one the suite uses): Xvfb screens 1280×1024 and 1600×1000, window 1280×1024 default; the webview was 632×786 and 792×786 and the scroller `clientHeight` was 725 in both runs, so the larger Xvfb screen did not enlarge the editor height; recorded as an environment limit. Line height 21 px. Documents: 60 (Chromium default), 90 (Chromium large) or 80 (real VS Code) page lines of one kind between two plain anchor lines. Kinds: link, code, strong, em, plain, mixed (link/code/strong/em in turn), wrapped link, wrapped code. Starts: end of the bottom anchor, and start/middle/end of a middle page line (PageUp); end of the top anchor and the same middle starts (PageDown). Three presses per case. Travel is measured as the caret line's document y change per press, relative to the scroller `clientHeight`.

**Results.**

| Case | Chromium (default and large) | Real VS Code |
| --- | --- | --- |
| plain, WYSIWYG, SV controls | page key moves the caret 0.79–0.87 of `clientHeight` per press (10.6 lines at 282 px); SV first PageUp from the last line moves 0.17 (document end) | plain: 0.87 PageUp, 0.82–0.87 PageDown |
| link, strong, em markers | same as plain; strong PageDown first press 0.65 (8.7 lines, default viewport only) | same as plain |
| collapsed inline code (`code`, `wcode`, `mixed`) PageUp | **no caret movement at all (0.00)** from the middle or end of a code line and from the bottom anchor under code lines (1.8 lines); starts at a code line's start move normally; same for Shift+PageUp (0.00) | **same: 0.00–0.05 of `clientHeight`**, 3 of 3 PageUp starts and 2 of 2 Shift+PageUp starts per kind, default font and serif |
| collapsed inline code PageDown | one short first press (0.12) from a code line's start; otherwise normal | normal for `code` and `wcode`; `mixed` stalls on the second press (0.05) |
| both fonts, both viewports | identical per kind, so the stall does not depend on the font stack or viewport size | identical for both fonts |

Press 3 in the large Chromium viewport and in real VS Code is shorter for every kind including plain because the caret reaches the document top or bottom; those are boundary clamps, not marker effects.

`Selection.modify('move', dir, 'line')` stepping (Chromium, default viewport): link, strong, em and plain advance a constant 37 px (one block); code lines advance 22 px backward and alternate 37 px / 0 px forward (one position per line pair is a dead step with no vertical change); wrapped lines advance 21 px per visual row. So the code lines contain a caret position that does not move vertically, and the page move stops there.

**Cause (now measured, narrowed).** The stall is caused by Task 369's rule that takes collapsed inline-code markers out of flow (`position:absolute; display:block; 0×0`). Evidence: only code-bearing lines stall; link, strong and em markers (stock inline-block) page normally; replacing only the code rule with stock `inline-block` markers restores normal travel in every code case (candidate `d`, all six Chromium kind/font entries 0.73–0.81, no stall). The original handoff guess (a 0×0 atomic marker for link/strong) is not supported: link and strong markers do not stall. Task 286's `[real-end-code]` landing in the original maintenance note is a code line, which fits.

**Candidate CSS routes tried live (Chromium, default viewport, both fonts):**

| Candidate | Result |
| --- | --- |
| (a) out-of-flow for every collapsed inline marker | worse: PageUp now stalls (0.00) for link, strong and em too; rejected |
| (b) out-of-flow for link markers only | link PageUp now stalls (0.00); code unchanged; rejected |
| (c) no CSS route | not needed to conclude: a CSS change to the existing code rule fixes paging (below) |
| `d` (diagnostic) stock inline-block markers for code | paging normal; reintroduces the break opportunity Task 369 removed, so not acceptable by itself |
| `h` stock inline-block markers for code plus a word joiner (`content:'\2060'`) in the collapsed code node's `::before`, to keep a non-breaking junction | paging normal in all six Chromium kind/font entries; Task 369 row height, narrow-cell wrap and copy behaviour are **not yet verified** |
| `i` Task 369 rule plus `user-select:none` on the markers | no effect (still stalls); also risky for marker-inclusive copy; rejected |

**Route choice (provisional decision 2026-11-01, reversible).** Try candidate `h` first in P2-2: it keeps the Owner's "marker CSS/layout first" order and the marker stays 0×0 and hidden. P2-2 must prove it against Task 369 (collapsed code stays in its text line in a narrow table cell, row height equals Preview, markers 0 wide collapsed and visible expanded) and the copy checks; if it breaks any of them, the paging handler (P2-2 fallback as already planned) is used. Candidates (a), (b) and `i` are closed. Chosen by the step owner: smallest reversible option supported by the measurements (the rule edit is one selector pair in `main.css` next to the Task 369 rule). The 2026-10-14 scope-guard decision (rewriting Task 369's "every other collapsed marker stays stock" guard) is now not needed, because the change is confined to the code rule.

**Pass-criterion amendment (provisional decision 2026-11-01, reversible).** The scroll clause of the 2026-11-01 criterion does not hold for the plain control: the first press from the document end moves the caret about 0.8 of `clientHeight` but `scrollTop` stays 0 (the caret was already visible). Amended: (1) caret travel on every press that is not clamped by the document top or bottom must be at least 0.7 of `clientHeight`, and within 1.5 lines of the plain control measured in the same run; (2) after three presses the cumulative `scrollTop` change must be within 1.5 lines of the plain control's; (3) Shift keys must meet (1) and (2) with the anchor unchanged. Evidence: control values above (0.79–0.87).

**Pass criterion, final form (provisional decision 2026-11-01, reversible).** The comparison with a plain-text control is replaced by a comparison with the native move in the same document, because plain and code documents have different line pitch (native paging lands 19 blocks in one and 20 in the other: 719 px against 740 px at the 1600×1000 viewport). Single-height code documents are compared press by press at 1.5 lines against same-document native paging with Vditor's stock markers and no repair, the cumulative scroll offset after three presses must be within 1.5 lines of the same reference, and the caret column must not drift between presses 2 and 3. Mixed and wrapped-code documents keep page bounds only (each press 0.7 to 1.0 of the view height, caret in view), because their later presses diverge from the reference by whole blocks. Selected by a recorded decision check (same-document native reference 0.98, widened plain-text tolerance 0.01, leaving it open 0). `ir-page-navigation.spec.ts` asserts exactly this. The real-VS-Code tests keep their own bound against a plain-text control (0.15 of the view height), recorded in the P2-3 section.

**Environment-dependent results.** Strong PageDown 0.65 first press (Chromium default viewport only; not seen in real VS Code, where strong PageDown is 0.82 like link); recorded, not in scope. SV's first PageUp from the last line (0.17) is a control artifact at the document end.

**Process note.** An earlier probe run was started before `node build.mjs` had produced the generated Vditor assets in this worktree, so the harness never became ready and a leftover Chromium server held port 9123; both leftover server processes (PIDs 311355 and 311356 at the time) were stopped by PID.

### Checkpoint (2026-11-01, after P2-1)

P2-1 done: probe harness, probe specs and measurements recorded; cause narrowed to Task 369's out-of-flow code marker; route chosen: candidate `h` first, handler fallback. No product code changed; acceptance items 1–3 remain open (they are proven by P2-2 and P2-3). Next action: P2-2.

### P2-2 result (2026-11-01) — repair with Chromium tests

**Route change (provisional decision 2026-11-01, reversible): the CSS route is closed; the paging handler is used.** P2-1 recommended candidate `h` (stock inline-block code markers plus a word joiner as generated content) because it restored paging. P2-2 first built the Task 369 layout checks the plan asks for, with a fixture that glues the code to the word before it (the case Task 369 fixed) and widths from 110 to 300 px, and compared the layout against Task 369's rule. It differs: with `h` the code drops to its own line at widths where Task 369's rule keeps it on the text line (code top 45 px against 24 px at 130 px width, block height 107 against 86). Further variants all measured identical to stock inline-block markers, so none removes the break opportunity: a word joiner before the node, before the `code` element, or both; the joiner after the node; `white-space: nowrap` on the markers, on the node, and `white-space: pre`. The break opportunity is between the opening marker (an atomic inline-block) and the code text, so only taking the marker out of flow (Task 369's rule) removes it, and that is what stalls the native page move. Task 369's layout and the paging contract therefore cannot both be met by CSS. Selected by a recorded decision check in Part 1 and the measured fallback rule of the plan (the handler is used when CSS cannot meet the criterion); no new design choice.

**Repair.** New module `media-src/src/editing/ir-page-navigation.ts` (`installIrPageNavigation()`, wired once in `media-src/src/boot/main.ts` next to `installIrMarkerReveal()`, listed in `scripts/module-manifest.mjs`). The native page move still runs. A capture-phase `keydown` handler records the starting caret (and anchor for Shift) and its geometry in scroller content coordinates; two animation frames later, if the press moved less than 75% of the distance it should have (87.5% of the visible height, Blink's own page step, limited by the room to the document edge), the press is redone from the start position: the scroller is set to the target offset, a caret hit test at the stored goal x on the target line picks the position, and the caret (or, with Shift, the selection keeping its original anchor) is written through `requestCaret`, followed by `invalidateCaret()` as the Task 286 normalizer does for its own write. The landing is left to the Task 286 normalizer, and the Task 608 root re-landing and Task 648 reveal rules still see the page key because the handler only reads the event. It does nothing for untrusted or composing keys, modifier chords other than Shift, other modes, a caret outside the editor, or a press that already travelled a page. Goal x is kept across consecutive page presses and reset by any other key, pointer press or text input. Task 369's CSS and markers are unchanged; no U+2060 or other character is added to the DOM, host text, copy payload or generated content.

**Tests.**
- `media-src/e2e/ir-page-navigation.spec.ts` (7 tests, new Chromium harness): page travel from the middle, end and bottom anchor (PageUp) and top anchor and middle (PageDown) of documents with `code`, `mixed` and wrapped-code lines, 2 presses each, at the default viewport (default and serif fonts) and the 1600×1000 viewport; each press must travel at least 0.7 of `clientHeight` and within 2.5 lines of the plain-text control measured in the same run; Shift+PageUp/PageDown from a code line extend the selection a page with the anchor unchanged and no U+2060 in the copy payload; typing after a landing changes the Markdown by exactly the typed character; Task 369's collapsed code marker is still out of flow and 0 wide; an expanded code node still shows its backticks. RED: without the repair (`P612_NOPATCH=1`) 5 of the 7 fail (the page tests and the Shift and typing tests; the two Task 369 tests are controls that pass before and after). GREEN: 7 of 7 pass with the repair. The tolerance is 2.5 lines because native paging quantizes to whole blocks (37 px for 21 px lines) and a native press landed one block longer than the control (43 px against a 42 px bound).
- `media-src/src/editing/ir-page-navigation.test.ts` (Vitest, 8 tests): the page geometry (distance, clamping, edge, tiny viewport), the stall rule, and install/removal without an IR editor.
- Not yet covered (P2-3): real VS Code with OS keys, and the real-VS-Code Task 369 net (`ir-inline-code-line.spec.ts`).

**Task 648 and Task 369 interplay.** An earlier CSS attempt changed the nested-code walk in `ir-arrow-markers.spec.ts` (four native repeated stops disappeared when the markers were in flow); that attempt was reverted with the CSS, and the file is unchanged.

**Checks run.** Vitest `ir-page-navigation.test.ts`, `editor-caret.test.ts`, `test/backend/module-boundaries.test.ts`, `test/backend/harness-registry.test.ts`: 81 passed. Chromium `ir-page-navigation.spec.ts`: 7 passed. Chromium regression set `marker-reveal`, `ir-arrow-markers`, `caret-marker-ties`, `blockless-caret`, `prepaint-scroll`, `table-hotkey`, `shortcut-negative`: 157 passed, 2 failed (`shortcut-negative.spec.ts:509`, ir and wysiwyg, pre-existing). `npm run lint` and `npm run knip` clean apart from existing info hints; `npm run typecheck` passes. The shared Chromium port was in use by another task, so these Chromium runs used a scratch config on a free port (same specs and harness).

### Checkpoint (2026-11-01, after P2-2)

P2-2 done with the handler route. Acceptance item 1 and the Chromium layer of item 2 are proven for the default and large Chromium viewports and both fonts; real-VS-Code proof of items 1–3 and the Task 369 net remain for P2-3. Next action: P2-3 (write the untagged real-VS-Code tests in `test/vscode-e2e/ir-page-navigation.spec.ts`, run it with `ir-inline-code-line.spec.ts`, `marker-reveal.spec.ts`, `ir-arrow-markers.spec.ts` through the wrapper at the default and 1600×1000 screens).

### P2-3 result (2026-11-01) — real VS Code

**Product change found by the real-VS-Code run.** Task 286's real PageUp scenario (`marker-reveal.spec.ts`, typing after PageUp must land outside the line's bold markers) failed with the handler: the hit-test landing at the goal x beyond the end of a bold-only line is the end of the strong's text, so a typed `P` went inside the formatting (`**real-page-bold-7P**`). Without the handler the native landing is the closing marker and the Task 286 normalizer puts the caret after the node. Fix in `ir-page-navigation.ts`: `landingOutsideInlineNode` moves a landing at the very start or end of an inline IR node's content (only markers beyond it) to the outer edge of the outermost such node, the position `End`/`Home` leave. Unit tests added (4 cases: end, start, content/plain/other-content unchanged, nested).

**New real-VS-Code tests** (`test/vscode-e2e/ir-page-navigation.spec.ts`, untagged, OS keys through XTEST): for `code`, `mixed` and wrapped-code documents at the default and serif fonts, PageUp (bottom anchor, middle, end of a middle line) and PageDown (top anchor, middle), 2 presses each, must travel at least 0.7 of the scroller height and within 0.15 of it of the plain-text control measured in the same test (native paging snaps to whole blocks, and `mixed` lines differ in height: 65 px apart at a 725 px scroller); Shift+PageUp/PageDown extend a selection a page with the anchor unchanged; typing once after a landing changes the Markdown by exactly the typed character and adds no U+2060 (webview value and host document). The `@probe` measurement test from P2-1 stays excluded from the default run.

**Results** (real VS Code 1.129.0, `--workers=1 --retries=0`, through the run wrapper; specs `ir-page-navigation`, `marker-reveal`, `ir-inline-code-line`, `ir-arrow-markers`):
- Default Xvfb screen (scroller height 725): 7 of 7 passed (3 `ir-arrow-markers`, `ir-inline-code-line`, 2 `ir-page-navigation`, `marker-reveal` including its PageUp part).
- 1600×1000 Xvfb screen (the webview height stayed 725, so this entry only changes the width): 6 of 7 passed; `marker-reveal.spec.ts` failed at its line 165 (`parentClass` still a marker right after Home or End), the failure Task 648 recorded as racy and present on unchanged code. The same spec passed in the default run and in an isolated run without the handler, and its PageUp part (line 310) passed in the runs that reached it with the landing fix.
- Environment-dependent: the larger Xvfb screen does not enlarge the editor height; strong PageDown first press 0.65 of the height in Chromium only.

**Other checks after the landing fix.** Chromium `ir-page-navigation.spec.ts` and `marker-reveal.spec.ts`: 21 passed. Vitest (`ir-page-navigation`, `editor-caret`, module boundaries, harness registry): 85 passed. `npm run lint`, `npm run typecheck`, `npm run typecheck:vscode-e2e` and `npm run knip` pass (existing info hints only).

### Checkpoint (2026-11-01, after P2-3)

P2-3 done. Acceptance items 1–3 are proven in Chromium and in real VS Code (default and two-font matrix; the 1600×1000 screen run recorded with its environment limit and the known racy `marker-reveal` Home/End line). Not yet run: `npm run quality` and the final diff review (P2-4). Next action: P2-4 (closure).

### R1 repair (2026-11-01) — review findings

Fixes in `ir-page-navigation.ts`, its Vitest file, the Chromium spec and harness (all six review findings addressed; one point is open as a design question, see 1):

1. **Native reference instead of the plain control (OPEN design question).** A comparison of 1.5 lines against a plain-text document cannot hold: the documents have different line pitch (a code line is a pixel taller), and native paging lands a whole block either side. Measured with Vditor's stock inline-block code markers (the native move with Task 369's rule undone): at the large viewport native travel is 719 px for code (19 blocks) against 740 px for plain text (20 blocks); at the default viewport 227 against 222. After the first press the starts of the repaired and the native sequences also differ, so later presses can land a whole block (37 px, 1.8 lines) apart even in a `mixed` document. The tolerance was not widened. Instead the test compares each press with the native move in the same document (stock markers, no repair, same start, 1.5 lines) for the single-height `code` document, which holds on every entry; `mixed` and wrapped-code documents keep the page bounds (at least 0.7 and at most 1.0 of the view height per press, caret in view afterwards) because their later presses diverge by whole blocks. The orchestrator should confirm or replace this reference.
2. **Scroll and goal x.** Three presses; the cumulative scroll change is compared with the native reference (code document, 1.5 lines) and the caret column must not drift between presses 2 and 3 (24 px). Measured native rule (plain text, caret at every row of the view, both directions): the landing line is aligned with the top of the view, limited to the scrollable range (`alignScrollTop`); the earlier full-step scroll is gone.
3. **Element positions.** `caretClientRect` measures the child an element-position caret sits before or after before falling back to the container (exported; the harness uses it). New Chromium test places the caret at the end of a wrapped paragraph; without the child lookup it measures the paragraph top (confirmed RED, travel 0 rows), with it the last row.
4. **Root hits.** `isUsableHit` rejects a hit on the editor root (3 unit cases). 
5. **Shift test.** Asserts the anchor position (block and characters before it) unchanged and balanced backticks in the copy payload. Node identity is not asserted: the editor splits the anchor's text node when the repaired selection is written (same position, new node), measured in the PageDown case.
6. **Unit tests.** An `isTrustedKey` runtime seam; tests for the mode guard, untrusted/composing/chorded keys and listener removal.

Hit-test landing also changed: a hit in the gap between two lines picks the lower line, which can overshoot the page step by most of a line, so an overshoot is retried one line back toward the start; native paging never overshoots (found while comparing with the native reference).

**Checks.** Vitest `ir-page-navigation` (19), `editor-caret`, `module-boundaries`: 87 passed. Chromium `ir-page-navigation.spec.ts` 8 passed; `marker-reveal.spec.ts` and `ir-arrow-markers.spec.ts` 51 passed. `npm run lint`, `typecheck`, `typecheck:vscode-e2e` pass. Real VS Code (default Xvfb, through the wrapper): `ir-page-navigation`, `marker-reveal`, `ir-inline-code-line`, `ir-arrow-markers` 7 of 7 passed.

### P2-4 closure (2026-11-01)

The R1 reference decision is recorded next to the pass criterion in the P2-1 section ("Pass criterion, final form"). The real-VS-Code page-navigation helpers moved to `test/vscode-e2e/helpers/ir-page-navigation.ts` and the `@probe` measurement to `ir-page-navigation-probe.spec.ts`, because the repository convention requires `@probe` tests to live in `*-probe.spec.ts` files (found by `npm run quality`).

**Gates.** `node build.mjs`, `npm run typecheck`, `npm run typecheck:vscode-e2e`, `npm run lint`: pass. Vitest `ir-page-navigation` (19), `editor-caret`, `module-boundaries`, `harness-registry`, `probe-tier-convention`: pass. Chromium `ir-page-navigation.spec.ts` 8 passed, `marker-reveal.spec.ts` and `ir-arrow-markers.spec.ts` 51 passed. Real VS Code (wrapper, default screen, after the helper move): `ir-arrow-markers` 3, `ir-inline-code-line` 1 and `ir-page-navigation` 2 passed; `marker-reveal.spec.ts` failed at its line 165 (Home/End timing race recorded by Task 648 as failing on unchanged code); the same spec passed in the other default-screen runs of this task. `npm run quality`: `check:brand-identifiers`, `lint:ci`, `knip`, `jscpd`, `depcruise`, `test:coverage`, `check:coverage-modules` pass; `audit` fails on a high-severity advisory in a transitive dependency of the extension host (not touched by this task).

**Checklists.** Implementation: handler, wiring, manifest entry, harness, unit/Chromium/real-VS-Code tests done. Verification: all three acceptance items ticked above; open note: the plain-text comparison of the 2026-10-14 criterion was replaced by the same-document native reference (decision recorded).

### Checkpoint (2026-11-01, closure)

Ready to close. Nothing staged or committed.
