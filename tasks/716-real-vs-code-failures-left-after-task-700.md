# Task 716 — Real-VS-Code failures that already exist on dev (after Task 700)

**Status:** in progress (2026-11-09). Split out of Task 700 (decision D18).
**Origin:** Task 700 full real-VS-Code run, one spec file per call, compared with the base `d6859ac4`.
**Severity:** medium (estimated). The full real-VS-Code suite is not green, so new regressions are harder to see.
**Depends on:** none.

## Problem

These cases fail when run alone on the Task 700 result and on the base `d6859ac4`:

- `html-link-display.spec.ts:235` (WYSIWYG HTML link): `locator.click` times out after 30 s.
- `toolbar-overflow.spec.ts:702` (Emoji 17 pointer selection): an equality check fails.
- `wiki-front-matter-aliases.spec.ts:124` (alias chip): `locator.waitFor` times out after 15 s, or a focus check fails.
- `turn-into-non-round-trip.spec.ts:395` (R9, SV): the QuickPick opens. Timing race: base fails 1 of 5 with `--repeat-each=5`. Diagnosis from Task 700: the spec's `selectTarget` arms the caret authority (`__vmdeRequestCaret`), which places the text caret back over the element caret the test sets. A verified test fix passes the `addRange` placement to `selectTarget` (6 of 6).
- `contextual-panel-clearance.spec.ts:25` (line 194): after Escape in the callout panel `select`, the IR editor is not focused. Timing race: base fails 2 of 5. Diagnosis from Task 700: the structural Escape handler in `selection-scope.ts` takes the Escape (focuses the editor, leaves the panel open), and the 50 ms refocus in `callouts.ts` moves focus back to the `select`. Cancelling the refocus on a trusted key did not fix it (3 of 6 still fail). Untested proposal: skip the structural Escape when the event target is inside `.vmde-callout-context-panel`, like the Task 659 toolbar exclusion.

## Decisions

- D1 (provisional, 2026-11-09, orchestrator, R3): R9 gets the test-only fix A: R9 calls `selectTarget(ctx, smallTarget, '', false, 'addRange')`, so no caret intent is armed over the element caret the test sets. Option B (change the caret authority) rejected.
- D2 (provisional, 2026-11-09, orchestrator, R3): contextual panel gets fix P-B: `selection-scope.ts` skips the structural Escape when the event target is inside `.vmde-callout-context-panel`, like the Task 659 toolbar exclusion. If P-B alone still fails, measure again before adding a second change.
- Split: Part 2a implements D1 and D2 (RED first). Part 1b measures the other three cases.

## Proposed work

1. For each case, measure the cause and find whether the test or the product is wrong. Find the first bad commit where the product is wrong.
2. Fix each cause with a failing test first.

## Acceptance

- [ ] Each case has a measured cause, and the first bad commit where it is a product defect.
- [ ] Each case passes alone 5 of 5 (`--repeat-each=5`) and in the full suite.
- [ ] `npm run quality` passes.
