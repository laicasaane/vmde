# Task 648 — IR: arrow keys move through Markdown markers one character at a time

**Status:** open.
**Origin:** Project Owner report.
**Severity:** medium (keyboard editing of inline syntax is blocked; accessibility).
**Tech stack:** webview (`media-src/src/editing/editor-caret.ts`, marker reveal from [Task 286](286-caret-marker-reveal.md), vendored Vditor IR `expandMarker` and keydown handling), Vitest, Chromium, real VS Code with OS-level keys.
**Related:** [Task 286](286-caret-marker-reveal.md) (reveal the node under the caret on every selection change), [Task 609](609-caret-offset-marker-ties.md) (caret offset ties at marker boundaries), [Task 600](600-no-blockless-caret-in-ir.md) and [Task 608](608-remaining-blockless-caret-routes.md) (caret landings).

## Problem

In IR, Markdown markers such as `**` are hidden until the caret enters their node, then revealed as editable text. With the keyboard, the caret cannot move through those markers as ordinary characters: ArrowLeft and ArrowRight stop at the boundary of each `**` and do not step between the two `*` characters, or between a marker and the text next to it.

Example source line:

```markdown
**Confirm**
```

With the node revealed, the source has 12 caret positions (offsets 0 to 11):

```text
offset:  0  1  2  3  4  5  6  7  8  9 10 11
         | *| *| C| o| n| f| i| r| m| *| *|
```

Expected: starting at offset 0, eleven ArrowRight presses visit offsets 1, 2, 3, … 11 in order, one per press, and eleven ArrowLeft presses return through 10, 9, … 0. Today the caret is blocked at the `**` boundaries, so offsets 1 and 10 (between the two `*`) and the steps into and out of the markers cannot be reached by arrow keys.

## Requirements

1. **One character per press.** In IR, while an inline node's markers are revealed, each ArrowLeft or ArrowRight press moves the caret exactly one source character, through marker characters and content alike, in both directions.
2. **Entering and leaving a node.** Moving the caret into a node from the text before or after it reveals the markers and places the caret at the adjacent source position (just inside the outer marker character), not past the marker. Moving out of the node past its last marker character continues into the neighbouring text and hides the markers again (Task 286 behaviour).
3. **All inline markers.** The same applies to every inline construct whose markers IR reveals: strong (`**`, `__`), emphasis (`*`, `_`), strikethrough (`~~`), inline code (`` ` `` and longer runs), links and images (`[`, `](`, URL, `)`, `![`), wiki links (`[[`, `]]`), highlight (`==`), superscript and subscript markers, inline math (`$`), and inline HTML tags shown as source. Part 1 lists the constructs and confirms each.
4. **Shift+Arrow too.** Shift+ArrowLeft and Shift+ArrowRight extend the selection one source character at a time through markers, with the same positions.
5. **Typing where the caret is.** A character typed at any reachable position lands at that source offset; for example, typing `x` at offset 1 of `**Confirm**` gives `*x*Confirm**`. Nothing is silently inserted inside a hidden marker (Task 286's guarantee stays).
6. **No other change.** ArrowUp, ArrowDown, Home, End, Page keys, block-level markers (headings, lists, quotes, fences) and WYSIWYG and Split behaviour are unchanged unless Part 1 finds the same cause there; any such change is recorded.

## Open design points (settled in Part 1)

- Where the stop comes from: Vditor's IR keydown handling, the browser's caret movement across the zero-width hidden spans and the `display` switch on reveal, VMDE's caret normalizer in `editor-caret.ts` (its comment notes that normalizing an Arrow step inside an expanded block "would bounce ArrowLeft/ArrowRight back to the content edge"), or the Task 609 tie rule.
- Whether the fix lets the native caret move and only repairs landings, or moves the caret by source offset per key; the effect on IME, screen readers and RTL text.
- Nested constructs (`***both***`, `**[link](url)**`, `` **`code`** ``) and adjacent nodes (`**a**_b_`).
- Performance on large documents (Task 573 budgets): per-key cost of reveal and caret placement.

## Scope

- In: horizontal arrow navigation and Shift+Arrow selection through inline Markdown markers in IR.
- Out: vertical navigation, block-level markers, WYSIWYG, Split (unless they share the cause).

## Acceptance

- [ ] For `**Confirm**`, ArrowRight from offset 0 visits offsets 1 to 11 in order and ArrowLeft returns through 10 to 0, one per press, in real VS Code with OS-level keys.
- [ ] The same walk works for each inline construct listed in Part 1, including nested and adjacent cases.
- [ ] Shift+Arrow selections through markers cover exactly the expected source ranges.
- [ ] Typing at each reachable offset writes at that offset (host text checked), with one Undo step.
- [ ] Entering and leaving a node reveals and hides its markers as today.
- [ ] Vertical keys, Home/End, block markers, WYSIWYG and Split are unchanged.
- [ ] Large-document key handling stays within the Task 573 budgets.
- [ ] Focused Vitest, Chromium and real-VS-Code specs are written and run; network-free gates pass at closure.

## Tests

- Vitest: any pure caret-step or offset-mapping helper.
- Chromium: offset walks for each construct, both directions, Shift+Arrow ranges, typing at each offset, nested and adjacent cases.
- Real VS Code (`test/vscode-e2e/`): the `**Confirm**` walk and a link and inline-code walk with OS-level XTEST keys, host text after typing, Undo.

## Part 1 handoff (2026-11-01)

Read-only investigation of the source plus small Chromium probes (Playwright keys in the `marker-reveal` harness; probe scripts and raw output are local only under the ignored `tmp/648/probe/`). Probe keys are not acceptance evidence: acceptance uses XTEST in real VS Code.

### Problem and cause

- **Cause (measured in Chromium, source-confirmed).** The stop is VMDE's IR marker normalizer, not Vditor's keydown, not the browser caret and not the Task 609 tie rule. `normalizeMarkerNavigationCaret` (`media-src/src/editing/editor-caret.ts`) ejects every collapsed caret that lands inside an inline `.vditor-ir__marker` (not `--pre`) to the node's outer edge (`{parent, nodeIndex}` or `nodeIndex + 1`) unless `allowVisibleMarkerEdit && previouslyExpanded.has(node)`. The capture `keydown` listener sets `allowVisibleMarkerEdit = false` for every key, so every Arrow landing inside a marker is ejected back to where it started. The result is a trap, worse than the report: with the current code ArrowRight from offset 0 of `**Confirm**` stays at 0 for every press, `a *b* c` stops at 2, and ArrowLeft from after a node that ends a paragraph never re-enters it. The block branch already has the matching exemption (an Arrow step inside an already expanded block "would bounce ArrowLeft/ArrowRight back to the content edge forever"); the inline branch has none.
- **Not the cause.** Vditor's IR keyup Arrow `expandMarker` call is already removed by the Task 286 build patch (`patchIrSelectionMarkerReveal`, `media-src/esbuild-shared.mjs`); its remaining keyup code only handles carets inside `.vditor-ir__preview`. The Task 609 tie rule (`caret.ts` `tiedContentStart`) runs only when a caret is restored from an offset (Undo checkpoints, Turn Into), not on Arrow steps. Marker CSS is fine: expanded markers are `display: inline` (Vditor `_ir.less`), collapsed ones `inline-block; width: 0; overflow: hidden`.
- **Native movement is correct once the eject is skipped (measured).** With the eject bypassed for already expanded nodes, native Chromium ArrowRight/ArrowLeft move exactly one source character per press, both directions, for: `**Confirm**` (0→11→0, including offsets 1 and 10), `__b__`, `*b*`, `_b_`, `~~b~~`, `` `b` ``, ``` ``b`` ```, `[t](u)`, `[t][r]` (link reference), `==m==`, `^s^`, `~s~`, `$x$`, footnote reference `[^1]`, and adjacent `**a**_b_`.
- **Nested constructs need one more rule (measured).** `***both***`, `**[l](u)**` and `` **`co`** `` still stop at the first inner marker with the eject bypassed. The controller tracks reveal state on the outermost IR node (`topIrNode`), while the eject test uses the marker's nearest node (`marker.closest('.vditor-ir__node')`, the inner node), which is never in `previouslyExpanded`. The inner markers are visible because the outer node's `--expand` class reveals all descendant markers.
- **Shift+Arrow (measured).** Selection focus already moves one source character per press (the normalizer returns early for non-collapsed ranges). When the selection starts outside the node, the node is never revealed (`markerTargets` returns an empty set for a non-collapsed range that is not inside one IR node), so presses through hidden `**` show no visible change.

### Constructs (requirement 3, confirmed against the vendored Lute IR DOM)

| Construct | IR node (`data-type`) | Markers | Current walk | Native walk with the fix rule |
| --- | --- | --- | --- | --- |
| Strong `**`, `__` | `strong` | `--bi` spans | stuck | one per press |
| Emphasis `*`, `_` | `em` | `--bi` spans | stuck | one per press |
| Strikethrough `~~` | `s` | plain marker spans | stuck | one per press |
| Inline code `` ` ``, ``` `` ``` | `code` | plain marker spans | stuck | one per press |
| Link `[t](u)` | `a` | `--bracket`, `--paren`, `--link` | stuck | one per press |
| Link reference `[t][r]` | `link-ref` | `--bracket`, `--link` | stuck | one per press |
| Image `![i](u)` | `img` | `!`, `--bracket`, `--paren`, `--link`, then a rendered `<img>` | stuck | one per press except one extra stop at the rendered `<img>` (same source offset) |
| Highlight `==` (setting `markdownMark`) | `mark` | plain | stuck | one per press |
| Superscript `^`, subscript `~` (setting `markdownSupSub`) | `sup`, `sub` | plain | stuck | one per press |
| Inline math `$` | `inline-node` | `$` spans; the source is a `--pre` code marker; a `data-render` preview | stuck at `$` | one per press |
| Footnote reference `[^1]` | `footnotes-ref` | `--bracket`, `--link`, hidden `data-render` label, then a Vditor ZWSP | stuck | one per press (offsets exclude U+200B) |
| Inline HTML `<kbd>k</kbd>` | two `html-inline` nodes around the rendered element | `code.vditor-ir__marker` per tag | stuck | one per press except one extra stop at the rendered `<kbd>` box |
| HTML entity `&amp;` | `html-entity` | `--pre` code marker plus preview | already one per press (the normalizer skips `--pre`) | unchanged |
| Wiki link `[[Page]]` | none: a `span.wiki-link-chip` (`data-wiki-link`) from `custom-renderer.ts`, no IR markers | — | out of scope | out of scope |

Emoji and tag nodes are not enabled by VMDE's options and are not listed.

### Settled decisions

1. **Fix approach — Provisional decision (2026-11-01), reversible.** Keep native caret movement and skip the eject for horizontal Arrow steps inside an already revealed node (approach "native exemption"); do not move the caret programmatically by source offset, and do not add a per-key offset repair. Evidence: the measured native walks above; the block branch precedent; native movement keeps IME, bidi/RTL text, grapheme clusters and screen-reader caret events unchanged. Selected by a recorded decision check (probability 0.85; programmatic stepping 0.02, native plus offset repair 0.10).
2. **Exemption rule.** In the inline branch of `normalizeMarkerNavigationCaret`, return the range unchanged when the frame's step is a horizontal Arrow step and the marker's outermost IR node (`topIrNode(marker)`, falling back to the nearest node) is in `previouslyExpanded`. A horizontal Arrow step is a trusted or untrusted `keydown` of `ArrowLeft` or `ArrowRight` targeting the IR editor, with or without Shift, without Ctrl, Alt or Meta. Ctrl/Alt/Meta word moves, `ArrowUp`/`ArrowDown`, Home/End and Page keys keep today's eject (requirement 6). Landings in a node that was not revealed before the key keep today's eject.
3. **Entry from an element position.** `markerTargets` also treats an inline IR node as adjacent when the collapsed caret is an element position directly before it (child at `offset`, skipping empty text) or directly after it (child at `offset - 1`). This reveals a node that starts a paragraph while the caret sits at `{p, 0}` (the landing that Home and today's eject produce), so the first ArrowRight goes to offset 1 instead of costing a dead press. Provisional decision (2026-11-01), reversible; smallest rule that satisfies requirement 2 at a paragraph edge; Home/End results stay as the Task 286 tests expect.
4. **Shift+Arrow reveal — Provisional decision (2026-11-01), reversible.** For a non-collapsed selection produced by a horizontal Arrow step with Shift, reveal the inline node at the selection focus (the `markerTargets` result for a collapsed range at the focus, including adjacency) and keep the node at the anchor (`topIrNode(anchor)`) revealed. Pointer and programmatic non-collapsed selections keep the Task 286 rule (no reveal when they span nodes). Selected by a recorded decision check (probability 0.51 against 0.41 for keeping the old rule and only documenting the hidden steps); the check warned that this changes the old no-reveal rule for keyboard selections that span nodes, which is why the change is limited to Shift+Arrow frames.
5. **Rendered-element stops — Provisional decision (2026-11-01), reversible.** The extra caret stop before or after a rendered `<img>` inside an expanded image node, and at the rendered `<kbd>` box between two inline HTML tag nodes, are native caret positions at non-marker elements with the same source offset. They are not repaired; the tests assert the measured walk with that one repeated offset. Covered by the same decision check as item 4 (no candidate that skipped them was favoured: probability 0.01).
   - **Amendment (2026-11-01), reversible — Provisional decision.** Equal-source-offset native stops at element boundaries are accepted like the `<img>`/`<kbd>` stops and are not repaired: this covers the nested inline code in strong (`**`co`**`: offsets 2, 3, 5, 6, both directions) and the footnote reference (`[^1]`: offset 6, both directions). Every marker character stays reachable. Selected by a recorded decision check (amend 0.91, fix now 0.05). The tests pin these stops and say so in their comments.
6. **Offset metric for tests.** A source offset is the number of text characters in the block before the selection focus, counting text inside markers and content, excluding text inside `[data-render]` or `.vditor-ir__preview` and excluding U+200B. Inside `--pre` code markers (inline math source, HTML entity source) text counts normally.
7. **Typing expectation.** Typing `x` after walking to offset `k` gives `source.slice(0, k) + 'x' + source.slice(k)` in the host text. If Lute normalizes that string differently on its own (proved in the test by `setValue(expected)` followed by `getValue()` returning the other string), the test compares against that round-trip value and records it; the caret claim is the same. One Ctrl+Z restores the original source.
8. **Names.** New state flags in `installIrMarkerReveal`: `horizontalStep` and `shiftHorizontalStep` (cleared on `pointerdown`, `beforeinput` and at the start of each frame, like `arrowStep`); new `MarkerNormalization` field `horizontalStep: boolean`. No public API, setting, storage format or message changes. Vendored Vditor and `main.css` are not changed.

### Scope, shared interfaces and invariants

- **Changed in Part 2:** `media-src/src/editing/editor-caret.ts` (normalizer exemption, adjacency, Shift reveal). Tests: `media-src/src/editing/editor-caret.test.ts`, new `media-src/e2e/ir-arrow-markers.spec.ts`, new `test/vscode-e2e/ir-arrow-markers.spec.ts`. Not changed: `caret.ts`, `gap-boundary.ts`, `focus-restore.ts`, `callout-nav.ts`, `gap-paragraph.ts`, `main.css`, vendored Vditor, `media-src/esbuild-shared.mjs`.
- **Contracts kept for Task 612 (PageUp near hidden IR markers).** `normalizeMarkerNavigationCaret` still ejects every collapsed Page-key, Home/End, vertical-Arrow, Ctrl/Alt/Meta-Arrow and pointer-free programmatic landing inside a hidden or newly revealed inline marker to the node's outer edge, and still keeps block-marker landings on the block content edge (Task 600) with the fence-info and expanded-block Arrow exemptions. The new exemption is limited to plain and Shift `ArrowLeft`/`ArrowRight` inside a node revealed before the key. Marker CSS is unchanged: collapsed `.vditor-ir__marker` stays `inline-block; width: 0; height: 0; overflow: hidden`, expanded is `display: inline`. `NAV_KEY_DIRECTION`, `normalizeRootNavigation` and the 100 ms dwell are unchanged.
- **Invariants.** Task 286: every caret movement reveals the node under or next to the caret; the previous node collapses only after the dwell; Home then typing on a line starting with `**bold**` still types before the marker. Task 609: restore ties and backward affinity unchanged. Composition: no marker writes during composition (unchanged guard). No new per-key DOM-wide query: the added work per frame is one `topIrNode` walk and one sibling check, so per-key cost stays in the existing frame-coalesced handler.

### Edge cases for the tests

`**Confirm**` alone in a paragraph (0 to 11 and back); a node at the start and at the end of a paragraph; a node at the end of the document (the last offset is the end of the closing marker); adjacent nodes `**a**_b_`; nested `***both***`, `**[l](u)**`, `` **`co`** ``; entry from `{p, 0}` with the node collapsed after the dwell; image and `<kbd>` with their one repeated offset; footnote reference with its trailing ZWSP; inline math whose source is a `--pre` marker; HTML entity (control: already passes).

### Part 2 step plan

Commands run from the worktree root. Chromium: `xvfb-run -a npm --prefix media-src run test:e2e -- <spec>` (fixed port 9123; if busy, a temporary config on a free port in the task scratch folder). Vitest: `npx vitest run --config test/vitest.config.mts <files>`.

**S1 — RED tests (Vitest + Chromium).** Result: failing tests that pin the contract. Owned files: `media-src/src/editing/editor-caret.test.ts` (new cases only), new `media-src/e2e/ir-arrow-markers.spec.ts`. Proves acceptance 2, 3, 4 (Chromium part), 5 and 6, and records the acceptance 7 baseline.
- Vitest cases (in the existing `IR marker reveal controller` describe, same harness pattern as "normalizes one hidden-marker navigation landing"): (a) an `ArrowRight` keydown, then a landing inside the strong marker of a node that was already expanded, leaves the selection untouched (no `removeAllRanges`/`addRange`); (b) same with `ArrowLeft` and with Shift; (c) nested: landing in an inner node's marker while the outer node was expanded is kept; (d) controls that must keep today's eject: `ArrowDown`, `Ctrl+ArrowRight`, `Home`, and an `ArrowRight` landing in a node that was not expanded before; (e) adjacency: a collapsed caret at `{p, 0}` before an inline node expands that node; (f) Shift: a non-collapsed selection after a Shift+ArrowRight keydown, anchor in plain text and focus inside a node's marker, expands that node; a non-collapsed pointer selection across nodes does not.
- Chromium spec on `/marker-reveal.html` (it uses Playwright keys; set the document with `window.vditor.setValue(...)` after `__ready`; enable highlight, superscript and subscript for their cases with `vditor.vditor.lute.SetMark(true)`, `SetSup(true)`, `SetSub(true)` before `setValue`, and say so in a comment). Cases: (1) offset walks for every construct row above (except wiki) plus the nested and adjacent cases, both directions, asserting the exact offset sequence per press with the offset metric of decision 6 and the image/`<kbd>` repeated offset of decision 5; (2) Shift+ArrowRight and Shift+ArrowLeft through `a **b** c` and `**Confirm**`: after each press the selection covers exactly source range `[0, k]` (or `[k, n]`), and the node at the focus is expanded; (3) typing: for `**Confirm**` and each `k` in 0..11, walk `k` presses from 0, type `x`, assert the markdown by decision 7, then one `Control+z` restores `**Confirm**`; also typing at offsets 1 and the middle of the URL in `a [t](u) c`; (4) reveal: entering from `a ` reveals the node, leaving past its last marker into ` c` keeps it expanded during the dwell and collapsed after 150 ms; (5) controls (pass before and after): ArrowDown from a line above into a line with `**b**` lands outside the marker as today; Home and End on `**home-bold** tail` and `tail **end-bold**` behave as the existing Task 286 cases; a heading `# Title` ArrowLeft from content start keeps Task 600 behaviour; WYSIWYG and SV walks on `a **b** c` via `/details.html?mode=wysiwyg` and `?mode=sv` record the per-press offset sequence and must be identical before and after S2 (store the S1 sequence as the expectation); (6) performance baseline: load `test/vscode-e2e/fixtures/large-observable-models-synthetic.md` (as `selection-performance.spec.ts` does) in IR, place the caret on a paragraph with inline markers, press ArrowRight 30 times and Shift+ArrowRight 30 times with `installSelectionPerformanceProbe`, and record full `getValue` calls (budget: at most 1 per keyboard phase, the Task 574 rule), index builds (at most 1) and the longest task during the phase; assert the budgets and write the numbers to the test output.
- Check: run the Vitest file and the new Chromium spec. Expected: (a)–(c), (e), (f) Vitest cases fail on unchanged code, (d) pass; Chromium walks for the stuck constructs, nested cases, Shift reveal and most typing offsets fail; controls, HTML entity walk and the performance case pass. Record each failing test name with its first failing assertion. Do not change product code.

**S2 — GREEN fix.** Result: decisions 2, 3, 4 and 8 implemented in `media-src/src/editing/editor-caret.ts` (owned file; `editor-caret.test.ts` only if an existing case contradicts the settled rule — report it instead of weakening it). Proves acceptance 2–6 in Chromium and Vitest, and acceptance 7 numbers after the change. Follow `.agents/rules/ts.md` for comments. Check: the S1 Vitest file and the S1 Chromium spec all pass; rerun `media-src/e2e/marker-reveal.spec.ts` and `media-src/e2e/caret-marker-ties.spec.ts` (pass); `npm run typecheck` and `npm run lint` (pass). Record the performance numbers beside the S1 baseline. If a walk still fails with the rule implemented as written, stop and report the measured sequence as a design question.

**S3 — real VS Code with XTEST.** Result: new `test/vscode-e2e/ir-arrow-markers.spec.ts` (owned) using `createXtestInput` from `test/vscode-e2e/helpers/xtest-input` and the open-and-focus pattern of `test/vscode-e2e/caret-marker-ties.spec.ts`. Cases: `**Confirm**` walk (ArrowRight 11 presses visits 1..11, ArrowLeft back to 0), a `[t](u)` walk and an inline-code walk in one paragraph, typing `x` at offset 1 of `**Confirm**` with the host text checked (`*x*Confirm**`, or the decision 7 round-trip value), then one Ctrl+Z restores the host text to `**Confirm**`. Proves acceptance 1 and the real-VS-Code part of 4. Check: `node build.mjs`, take the real-VS-Code token, then one combined run `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- ir-arrow-markers.spec.ts marker-reveal.spec.ts caret-marker-ties.spec.ts --workers=1 --retries=0'`; release the token. Expected: all pass (acceptance 5 rerun included). Record start time and result paths.

**S4 — closure.** Owned: the task file. Run `node build.mjs`, `npm run typecheck`, `npm run lint`, the focused Vitest file, the focused Chromium specs (`ir-arrow-markers`, `marker-reveal`, `caret-marker-ties`), confirm the S3 real-VS-Code results (rerun only if code changed after S3), and `npm run quality` (record each stage; known failures listed in the run rules are not regressions). Tick only proven acceptance items, record the performance numbers for acceptance 7, and write the completion report.

### Risks

- The Shift reveal (decision 4) changes the old no-reveal rule for keyboard selections across nodes; if a Task 286 or copy test (triple-click marker-inclusive copy) depends on it, S2 reports it.
- Real VS Code may differ from Chromium at text-node boundaries; S3 measures it with XTEST.
- Lute may normalize some typed strings (decision 7 handles it in the tests).

## Progress

- 2026-11-01: Part 1 complete (cause measured, decisions settled, Part 2 plan above). Next: S1.
- 2026-11-01: S1 (RED tests) done. Added `IR horizontal Arrow steps through revealed markers (Task 648)` cases to `media-src/src/editing/editor-caret.test.ts` (8 fail on unchanged code, the 10 control cases pass) and `media-src/e2e/ir-arrow-markers.spec.ts` (34 tests: 28 fail on unchanged code, 6 controls pass; the `**Confirm**` Shift+Arrow case already passes because the selection starts inside the node). Unchanged-code baseline for acceptance 7 (30 ArrowRight plus 30 Shift+ArrowRight in the large synthetic document, IR): 0 full serializations, 0 index builds, 0 long tasks, about 400 to 670 ms of key workload; the caret did not stop at a marker in that paragraph, so S2 repeats the measurement and compares. WYSIWYG and SV per-press offsets of `a **b** c` are recorded from unchanged code (WYSIWYG 1,2,3,4,5,5,5,5,5; SV 1..9). Next: S2 (fix).

### Implementation checklist
- [x] S1 RED tests written and failing for the missing behaviour
- [x] S2 fix in `editor-caret.ts`
- [x] S3 real-VS-Code XTEST spec written and run
- [x] S4 closure gates

### Verification checklist
- [x] Acceptance 1 (real VS Code, OS keys: `**Confirm**` ArrowRight 1..11, ArrowLeft 10..0, host text unchanged)
- [x] Acceptance 2 (Chromium walks pass after the fix; both directions, nested and adjacent cases)
- [x] Acceptance 3 (Shift+Arrow ranges, Chromium)
- [x] Acceptance 4 (Chromium typing at every offset of `**Confirm**` and in a link URL; real VS Code: `x` at offset 1 gives `*x*Confirm**` in the host text, one Ctrl+Z restores it)
- [ ] Acceptance 5 (reveal/hide: Chromium reveal test, `marker-reveal` and `caret-marker-ties` Chromium pass; real-VS-Code `caret-marker-ties` passes; real-VS-Code `marker-reveal.spec.ts` fails identically on the unchanged `editor-caret.ts`, a race in its own check, see S3 entry)
- [x] Acceptance 6 (Chromium controls: ArrowDown, Home, End, WYSIWYG and SV walks unchanged)
- [x] Acceptance 7 (large-document key phase after the fix: 0 full serializations, 0 index builds, 0 long tasks, 338 ms workload against 404 ms before; budgets at most 1 each)
- [x] Acceptance 8 (gates: typecheck, typecheck:vscode-e2e, lint, focused Vitest/Chromium/real-VS-Code pass; `npm run quality`: brand, lint:ci, knip, jscpd, depcruise pass; `audit` fails on third-party advisories (not fixed); `test:coverage` timed out once in `lute-code-cache.test.ts` at 30 s under load and passes 370 files with `--testTimeout=60000`, then `check:coverage-modules` passes)
- 2026-11-01: S2 (GREEN fix) done. Instrument check first: on unchanged code a plain `abc` walk gives 1,2,3 and back, and from inside `**Confirm**` (offset 5) ArrowRight reaches 6,7,8,9 and ArrowLeft 8,7,6,5; so the keys, focus and offset reader work and the all-zero walk from offset 0 is the marker trap (content offsets are reachable, the marker characters are not). Fix in `editor-caret.ts`: horizontal-step exemption judged on the outermost revealed node, element-position adjacency reveal, and Shift+Arrow focus/anchor reveal. Findings recorded by the tests: (1) the nested `**`co`**` walk has four repeated offsets (2, 3, 5, 6) where inner text nodes meet the outer markers, listed like the image, `<kbd>` and footnote stops; (2) the marker-reveal Chromium harness does not wire Undo (Ctrl+Z leaves even a plain edit in place), so the one-step Undo part of acceptance 4 moves entirely to the real-VS-Code spec in S3. Focused results: Vitest `editor-caret.test.ts` 56 passed; Chromium `ir-arrow-markers`, `marker-reveal`, `caret-marker-ties` 53 passed; `npm run typecheck` and `npm run lint` pass (info hints only). Next: S3.
- 2026-11-01: S3 (real VS Code, OS keys) done. New `test/vscode-e2e/ir-arrow-markers.spec.ts`: 3 tests pass (`**Confirm**` walk both ways; link plus inline code walk, one source character per press; typing `x` at offset 1 gives `*x*Confirm**` in the host text and one Ctrl+Z restores the original). `caret-marker-ties.spec.ts` 5 passed in the same run. `marker-reveal.spec.ts` (real VS Code) fails at its line 165 (`parentClass` still a marker right after Home or End): the check reads the caret once right after a poll that is already true, so it races the frame that moves the caret out of the marker. It fails the same way with the original `editor-caret.ts` (swapped in temporarily, rebuilt, rerun; the fixed file was restored and rebuilt), so it is not caused by this task; the sample that fails differs between runs (bold, link). It is not on the known-failure list and is recorded here as pre-existing and racy. Run start 02:17:36 (combined) and 02:19:36 / 02:19:56 (marker-reveal alone).
- 2026-11-01: R1 (review fixes) done in `editor-caret.ts`, `editor-caret.test.ts`, `ir-arrow-markers.spec.ts`: (1) decision 5 amended (above), no code change; (2) the horizontal-step flags now expire with the same 250 ms window as `navDirection` (a keydown that moves nothing no longer exempts a later programmatic landing; new Vitest case, RED with the window forced off, GREEN with it); (3) `elementPositionNeighbors` skips only empty text nodes (new cases: empty text skipped, `<br>` blocks the reveal); (4) `shiftArrowTargets` reads the runtime document's selection; (5) anchor-node assertions added (Vitest, and a Chromium test where the selection starts inside the node and extends out, node still revealed after the dwell); (6) the real-VS-Code spec asserts the one-step Undo (host text restored after one Ctrl+Z). Home-then-type (Task 286): the element-position reveal does not move the caret (new Vitest case: no Selection writes, caret stays at the element position) and the Chromium `control: Home/End ... before typing` cases and `marker-reveal` Home/End cases pass. Results: Vitest `editor-caret.test.ts` 61 passed; Chromium `ir-arrow-markers`, `marker-reveal`, `caret-marker-ties` 54 passed; `npm run typecheck` pass; real VS Code (start 02:23:04, token held, fresh build) `ir-arrow-markers` 3 and `caret-marker-ties` 5 passed.
- Failure that also occurs on unchanged code: real-VS-Code `test/vscode-e2e/marker-reveal.spec.ts:165` (`parentClass` still contains `vditor-ir__marker` right after Home). Baseline with the original `editor-caret.ts`: run with `env -u ELECTRON_RUN_AS_NODE xvfb-run -a sh -c 'openbox & VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- marker-reveal.spec.ts --workers=1 --retries=0'`, log `tmp/648/s3-run-mr-orig.log` (untracked), same assertion failure (received `vditor-ir__marker vditor-ir__marker--bi`). With the fix it fails the same way (`tmp/648/s3-run-mr1.log`); the failing sample varies between runs. The spec reads the caret once right after a poll that is already true, so it races the frame that ejects the caret from the marker.
- 2026-11-01: S4 closure. Gates recorded in the verification checklist. Acceptance 5 stays unticked only because the real-VS-Code `marker-reveal.spec.ts` fails on unchanged code too (see the R1 entry); the Chromium reveal tests, `marker-reveal` and `caret-marker-ties` Chromium specs and the real-VS-Code `caret-marker-ties` spec pass. A final comment-only reorder in `editor-caret.ts` (helper above its comment) was rechecked with typecheck and the 61 unit cases; no behaviour change, so the real-VS-Code run from R1 stands.
