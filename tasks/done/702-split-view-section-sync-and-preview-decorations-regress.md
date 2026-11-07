# Task 702 — Split View section sync and Split-preview bare-URL decorations regress at `f84a4258`

**Status:** ✅ done (2026-11-08). Split from Tasks 697 and 699 (queue run 2026-11-02a) because the causes differ.
**Origin:** Gate rerun at `f84a4258` (Task 695); each spec file failed alone too.
**Severity:** medium (estimated; user-visible Split View position and missing link decorations).
**Tech stack:** `test/vscode-e2e/sv-split.spec.ts`, `test/vscode-e2e/bare-url-autolink.spec.ts`; Split View sync and Preview decoration code in `media-src/src/` (nav, links/bare-url-decorate.ts, editing/preview-render.ts).
**Depends on:** none.

## Problem

These two cases fail in the full suite and again alone at `f84a4258`:

- `sv-split.spec.ts:31` (assertion at `:220`): `previewOffset` is 37.2 where less than 30 is expected. The nearest heading is right ("12. WaveDrom") and `sourceOffset` is 0.19. Split View is not viewport-gated, so the Task 697 cause does not explain it. Last recorded pass: Task 634 (`b13461f6`, 2026-10-14).
- `bare-url-autolink.spec.ts:340`: after the setting returns to on, the Split preview has 8 decorations where at least 10 are expected. Last recorded pass: Task 655 (2026-10-18).

Candidate causes from reading only (not measured): Task 643 (`6dede194`, own Preview renderer, decorating observers wait while a Preview streams) and Task 645 (`88cc673d`, Split pane layout). Whether both cases share one cause is not measured.

## Proposed work

1. Probe both cases at `4e6547d5`, `88cc673d`, `32d6bf84` and `6dede194`; then bisect inside the pair that flips.
2. Measure the mechanism at the first bad commit.
3. Fix each product cause with a failing test first, or fix the test where the test is wrong (state which).

## Acceptance

- [x] Each case has a first bad commit and a measured cause. `bare-url-autolink`: `0d4ba2e4`, hint spans split URL text (Part 2a, 2b). `sv-split`: no regressing commit (fails at `aa9280ec`, which added the assertion); measured cause is a test metric (Part 2b, 2c).
- [x] Each product cause is fixed with a test that fails before and passes after. Product cause: decorator vs hint-split text (Vitest RED 2 failed, GREEN 100 passed, Part 2b). The `sv-split` cause is the spec metric, fixed in the spec (no product change).
- [x] Both cases pass in one real-VS-Code run: 10 passed with `bare-url-autolink`, `sv-split` and `wrap-hints` (Part 2c). Full-suite confirmation is left to the next gate (provisional decision D3).

## Tests to write

- A test per product cause; the two real-VS-Code cases are the acceptance tests.

## Part 2a results (2026-11-08)

Measurement only; no product or test change. Every row is `--workers=1 --retries=0 --repeat-each=2` through the real-VS-Code wrapper (VS Code 1.129.0, Xvfb plus openbox). Logs are under `tmp/702/` (`<rev>-<case>.log`, `build-<rev>.log`, `bisect-*.out`). The spec files are identical across the probed revisions for `sv-split` (`aa9280ec`..`fda90773`) and for `bare-url-autolink` from `8bb87269` on, so each revision ran its own, unchanged spec.

### Case `bare-url-autolink.spec.ts:340`

Still fails on current `dev` (0/2). The candidate revisions of the task record are all already bad, so the flip lies earlier: the bisect ran over the 11 product commits `8bb87269..4e6547d5`.

| Revision | pass/total | Failure |
| --- | --- | --- |
| `fda90773` (dev) | 0/2 | `toBeGreaterThanOrEqual(10)`, received 8 |
| `4e6547d5` | 0/2 | received 8 and 6 |
| `88cc673d` | 0/2 | received 8 |
| `32d6bf84` | 0/2 | received 8 |
| `6dede194` | 0/2 | received 8 |
| `773372a1` | 0/2 | failing |
| `0d4ba2e4` | 0/2 | received 8 |
| `100a6ca1` (parent) | 2/2 | none |
| `8bb87269` | 2/2 | none |

- **First bad commit:** `0d4ba2e4` `feat(640): hint plain text, emphasis, link text, headings, list items and the callout preview`. 0/2 at it, 2/2 at its parent `100a6ca1`. Confidence: high (4 of 4 repeats around the flip). The candidates `88cc673d` and `6dede194` are not the cause.
- **Failure text:** `Expected: >= 10 / Received: 8` after the setting returns to on, polled on the Split preview decorations (`.vmde-bare-url` under `.vditor-preview`). `4e6547d5` once gave 6.
- **Reading (not measured):** the commit makes the wrap-hint engine insert hint spans into plain text, emphasis and link text and remove them with the new `removeWrapHints(parent, spans)`; this splits and re-merges Text nodes and mutates `childList` in the same panes. `bare-url-decorate.ts` rescans through a `MutationObserver` on `childList`/`characterData` and works on Text nodes, so a URL split by a hint span, or a hint add/remove after the setting toggles back on, can leave 2 candidates undecorated. The mechanism needs a probe at `0d4ba2e4` (which two hosts are missing, and whether hint spans exist in the Split preview).

### Case `sv-split.spec.ts:31`

Still fails on current `dev` (0/2), but no good revision exists in the measured range, so there is no first bad commit.

| Revision | pass/total | `previewOffset` (expected < 30) |
| --- | --- | --- |
| `fda90773` (dev), with openbox | 0/2 | 37.21875 |
| `fda90773` (dev), without openbox | 0/2 | 37.21875 |
| `4e6547d5` | 0/2 | 37.21875 |
| `88cc673d` | 0/2 | 37.21875 |
| `32d6bf84` | 0/2 | 37.21875 |
| `6dede194` | 0/2 | 37.21875 |
| `b13461f6` (Task 634, last recorded pass) | 0/2 | 37.03125 |
| `b13461f6`, without openbox | 0/2 | 37.03125 |
| `aa9280ec` (commit that added the assertion) | 0/2 | 34.53125 |

- **First bad commit:** not found. The result is the same (0/2) at the four task-record candidates, at the recorded last pass `b13461f6`, and at `aa9280ec`, which introduced the `< 30` assertion. A bisect started from `b13461f6` as good (`bisect-sv.out`) is therefore invalid: it only reports the oldest list entry and must be ignored. Confidence that the candidates are not the cause: high; confidence in any commit-based cause: none.
- **Failure text:** `Expected: < 30 / Received: 37.21875` at `sv-split.spec.ts:220`; `nearest` is "12. WaveDrom — timing diagrams", `sourceOffset` 0.1875.
- **Reading (not measured):** the offset drifts 34.5 (Aug 31) to 37.0 (Oct 14) to 37.2 (now), a slow change rather than a flip, and it stays above 30 even at the commit that wrote the assertion. This points to the environment of this machine (font metrics or pane geometry under Xvfb with VS Code 1.129.0) or to a threshold that passed only on the earlier recorded setup, not to a single regression. The window manager is not the cause (same value without openbox). Next probe suggestion: run the case at `aa9280ec` on the earlier recorded setup if one still exists, or measure the heading's top offset in the Split preview against the preview pane height at `aa9280ec` and `dev` to see which term moved.

## Part 2b results (2026-11-08)

Logs under `tmp/702/` (`p2b-*.log`; probe specs `probe-bare.spec.ts` and `probe-sv-terms.spec.ts`, run from a temporary copy in `test/vscode-e2e/`, removed afterwards). Real VS Code 1.129.0 through the wrapper. Decisions D1 and D2 (orchestrator, provisional) were the starting hypotheses.

### `bare-url-autolink.spec.ts:340` — product regression, fixed

**Measured mechanism** (probe on `dev`, Split preview after the setting returns to on, `p2b-probe-bare.log`): 8 `.vmde-bare-url` (expected at least 10), 26 `.vmde-wrap-hint` spans present both before and after. Every URL of the fixture that is longer than a pane line has hint spans inside its text and is undecorated: `https://en.wikipedia.org/wiki/Foo_(bar)` (5 hints), `https://cjk.example.com` (2), `https://quote.example.com/path?q=1&r=2#frag` (7), `https://item.example.com` (2), `www.item2.example.com` (2). The short URLs without a hint (`https://example.com` x2, `www.example.com/a_b_c`, `user@example.com`, both table cells, the `<kbd>` URL) are decorated, identical at 3 s and 6 s. So the decorator's observer ran for those blocks (it decorated the siblings in the same panes) and skipped these nodes because no single Text node holds a whole URL: the wrap-hint engine of `0d4ba2e4` cuts plain text at break points with empty hint spans, and `decorateAll` tested `findBareUrls` on each Text node alone. The sub-fragments (`https://`, `en.`, ...) never match. Before `0d4ba2e4` plain text was not hinted, which is why it passed at `100a6ca1`. (Not measured: whether the observer fired once more after the last hint write; the result is the same for any run, since the bug is in the per-node match.)

**Fix (local to the decorator, no contract change):**
- `media-src/src/links/bare-url-decorate.ts`: Text siblings separated only by hint spans (or by nothing) are one run; the match runs on the joined text and a `Range.surroundContents` wraps the URL, moving the hint spans into the wrapper (the engine already hints link text). A lone Text node takes the old path (no join); arrays and the joined string are built only for a multi-node run or when a URL is found, so the typing path does no extra work. Saved Markdown and visible text are unchanged (the wrapper is the same span/anchor as before).
- `media-src/src/util/wrap-hint-mark.ts`: `isHintSpan` is exported (no behaviour change).
- `media-src/src/links/bare-url-decorate.test.ts`: three new cases (`wrap hints inside a URL (task 702)`).

**RED:** `npx vitest run media-src/src/links/bare-url-decorate.test.ts` before the fix: 2 failed | 98 passed (`expected [] to have a length of 1`), `p2b-red.log`. **GREEN:** after the fix 100 passed, `p2b-green.log`.

**Checks:** `npm run lint:ci` exit 0, `npm run typecheck` exit 0, Vitest `media-src/src/links` + `wrap-hint*` (25 files, 560 tests) exit 0. Real VS Code `bare-url-autolink.spec.ts:340` `--repeat-each=2`: 2 passed (`p2b-bare-fixed.log`); the whole spec file `--repeat-each=2`: 10 passed (`p2b-bare-full.log`).

### `sv-split.spec.ts:31` — classified (a) test metric, not a product sync error

Measured twice on `dev` (`p2b-sv-terms.log`), identical and stable from 100 ms to 2.1 s after the scroll:

| Term | Source pane | Preview pane |
| --- | --- | --- |
| pane top / height | 61.375 / 724.625 | 61.375 / 724.625 |
| scrollTop / scrollHeight | 4978 / 25658 | 4767 / 20020 |
| heading top | 411.375 | 416.469 |
| heading height | 25 | 88.875 |
| heading centre minus pane centre | 0.1875 | 37.219 |

The sync does align the section: the Preview heading top is 7.2 px above the pane centre (the source pane centres the heading to 0.19 px). The spec compares heading centres, and the rendered h2 is 88.9 px tall against 25 px in the source, so its centre sits 44.4 px below its top: 44.4 - 7.2 = 37.2 against the threshold 30. The spec's own numbers imply the same: 34.5 at `aa9280ec` (assertion added) means a heading about 82 px tall then. The tolerance only holds for a heading up to about 73 px tall. Reading (not measured): the h2 renders at several line boxes of the content theme in this pane width, so the result moves with font and pane geometry; the line count was not measured. The Preview anchors the heading's top region, not its centre; no position error. No spec change in this step. Option for the next step: compare the heading top with the pane centre (tolerance about 8 px, like the source side), or compare with an allowance of half the measured heading height.

## Part 2c results (2026-11-08)

Logs under `tmp/702/` (`p2c-*.log`). Provisional decision D3 (orchestrator, reversible): `sv-split.spec.ts:31` is a test-metric defect.

- **Spec change** (`test/vscode-e2e/sv-split.spec.ts` only): the Preview-side check now uses the target heading's top offset to the pane centre (`topOffset`), with a comment on tall rendered headings. The 30 px tolerance, the source-side check and the nearest-heading check are unchanged. Measured `previewOffset` is -7.22 px (was 37.22 by centre).
- **Changed spec alone**, `sv-split.spec.ts:31 --repeat-each=2` through the wrapper: 2 passed, exit 0 (`p2c-sv.log`).
- **Build:** `node build.mjs` exit 0.
- **`npm run quality`:** exit 0, all 8 stages PASS (brand identifiers, lint:ci, knip, jscpd, depcruise, audit, test:coverage with 386 files and 8622 tests passed plus 1 expected fail, coverage ratchet 9 modules at 0%, baseline 9). knip reports no finding for the new `isHintSpan` export (it is imported by `bare-url-decorate.ts`); its only output is a pre-existing tag hint for `runCalloutAction` in `callouts.ts`.
- **Combined real-VS-Code run:** `bare-url-autolink.spec.ts sv-split.spec.ts wrap-hints.spec.ts --workers=1 --retries=0`: 10 passed, exit 0 (`p2c-closure.log`). `wrap-hints.spec.ts` is the only real-VS-Code spec that mentions wrap hints.
- **Not done:** the full real-VS-Code suite; it is confirmed at the next gate.
