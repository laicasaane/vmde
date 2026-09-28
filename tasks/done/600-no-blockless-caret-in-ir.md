# Task 600 — Keep block-marker IR carets in their blocks and refuse blockless formatting

**Status:** done (2026-09-29), pending the orchestrator's record move and focused local commit. The Project Owner scoped navigation acceptance to the block-marker and heading routes fixed here; the measured hr-first root landing remains a named Task 608 residual.
**Origin:** found during the Task 596 investigation (2026-09-28). The defect predates Task 579.
**Severity:** high. Ordinary keyboard use inserts content into the document.
**Recommended implementer effort:** high.
**Tech stack:** TypeScript webview (`media-src/src/editing/editor-caret.ts`, `media-src/src/bridge/message-router.ts`), optionally a build-time Vditor patch, Vitest, Chromium, real VS Code with XTEST.
**Dependencies:** none; this task can run first.

- **Task 599** (Find close selection) removes one route to this state.
- **Task 597** removes the Undo route (a `<wbr>` at the root level).

**Evidence:** `tmp/task596-603-evidence/t599/results2.json` (S10, S13, S14) in the main checkout. Real VS Code 1.129.0, `VMDE_XTEST=1`, Task 579 build, IR mode.

## Problem

All results below use the document `# Probe\n\nAlpha bravo charlie delta.\n\nEcho \`foxtrot\` golf hotel.\n`. Find is not involved.

| Sequence | Selection | Result |
| --- | --- | --- |
| Caret in body text, Ctrl+Home | `PRE.vditor-reset@0` | Ctrl+B gives `****\n\n# Probe…`; typing `Q` gives `**Q**\n\n# Probe…` |
| Same state, click the toolbar Bold button | `PRE@0` | `****\n\n# Probe…` |
| Same state, press Right once | still `PRE@0` | the caret does not leave this position |

Ctrl+G at `PRE@0` inserts ``` `` ``` in the same way.

Measured cause:

1. **The caret is ejected from the heading.** A native move to the heading marker (`"# "@0`) is followed, about 16 ms later, by `installIrMarkerReveal` → `normalizeMarkerNavigationCaret` (`editor-caret.ts:156-202`, write at `:191-194`). That code treats a **block** IR node (`H1.vditor-ir__node[data-block]`) like an inline node and places the caret in `node.parentNode`, which is the editor root. `isInlineIrNode` (`editor-caret.ts:109`) already tells the two cases apart, but the normalizer does not use it.
2. **Formatting does not refuse such a caret.** IR `processToolbar` (`vditor/src/ts/ir/process.ts:170, 203-221`) inserts `<span>**<wbr>**</span>` at `PRE@0`. `input()` then finds no block (`ir/input.ts:88-91`), re-renders the whole editor (`:179`), and creates a new top-level paragraph. This happens on the hotkey path and on toolbar mouse clicks alike.

## Design

1. **B1 — root fix, in `normalizeMarkerNavigationCaret`.** For a node with `data-block`, put the caret at the start or end of the block's content text, after the heading marker, and never in `node.parentNode`. Keep the ejection of inline nodes unchanged.
2. **B2 — defence in depth: refuse inline formats at a caret outside every block.**
   - **Hotkey route:** in `handleTriggerToolbarHotkey`, after `restoreFormatHotkeySelection`, do not dispatch bold, italic, strike or inline-code when `!hasClosestBlock(range.startContainer)` and the start container is the editor root. Coordinate the placement with Task 596's gate.
   - **Mouse route:** either a capture-phase guard on those toolbar buttons, or a build-time patch to IR `processToolbar` in `esbuild-shared.mjs` that returns early for a caret outside every block.
3. **Audit** the other writers of `requestCaret({node: parent…})` and any other code that can produce a caret at the root, and list them in this record. Check WYSIWYG and SV for the same state; neither was probed.

## Original Owner questions (resolved below)

1. With the caret at the start of a heading's text, should Ctrl+B produce `# **Q**Probe` (Vditor's normal empty-bold insertion inside the heading, recommended), or do nothing?
2. Include B2 for toolbar mouse clicks as well (recommended), or only for the hotkey route?
3. Where should the mouse-route guard live: a capture listener in VMDE, or a Vditor source patch?

## Tests

- **Vitest**
  - `editor-caret.test.ts`: a collapsed caret at a non-expanded `H1[data-block] > .vditor-ir__marker--heading` text@0 normalizes to inside the H1 content, never `H1.parentNode`. Inline-node ejection is unchanged.
  - `message-router.test.ts` (B2): a collapsed selection at the root does not dispatch bold, italic, strike or inline-code.
- **Chromium:** Ctrl+Home, then a toolbar Bold click. The rendered value never starts with `****`. Repeated Right presses move into the heading text.
- **Real VS Code** (XTEST, new spec `test/vscode-e2e/blockless-caret.spec.ts`):
  - Ctrl+Home, then Ctrl+B, then `Q`: the host exactly matches decision 1, and never matches `/^\*\*/`.
  - The same with the toolbar Bold click and with Ctrl+G.
  - A paragraph-first document as a control.
  - IR required. Run WYSIWYG and SV to confirm, and record the results.

## Acceptance

- [x] Keyboard and mouse navigation into the IR block-marker and heading routes fixed by Task 600 stays in the block in the focused acceptance matrix. The original global wording, "No keyboard or mouse navigation in IR leaves the caret at the editor root," was narrowed by the Project Owner on 2026-09-29. The measured hr-first Ctrl+Home native root landing remains a named residual owned by Task 608.
- [x] No inline-format route inserts a new top-level block from a caret outside every block. The four inline formats and the Owner-added list/ordered-list/check family leave the document unchanged at seeded root and fresh-open fallback in the focused Chromium and real-VS-Code runs.
- [x] Exact host text for every leg in real VS Code. The IR pinned strings and paragraph-first control pass; the Find-close result is recorded with its invariant, and the WYSIWYG and SV mode-control host strings are recorded below.

## Owner decisions and final design (2026-09-29)

| Decision | Resolution |
| --- | --- |
| Original Q1: heading-text Ctrl+B | Use Vditor's normal empty-bold insertion inside the heading. The measured host string after one Q is "# **Q**Probe" followed by TAIL, not a new paragraph. |
| Original Q2: toolbar mouse route | Guard it as well as host-dispatched hotkeys. |
| Original Q3: mouse guard layer | Use an anchor-asserted Vditor ir/process.ts source patch rather than a VMDE capture listener. |
| OQ1: list-family data loss | Include list, ordered-list and check in both the router predicate and Vditor add/remove branch guards. |
| OQ2: selection condition | Check the range start even for a noncollapsed selection. |
| OQ3: arrow step | Permit an Arrow key from inside the same already-expanded block to walk its visible syntax. Other landings normalize to content. |
| OQ4: fence info string | Leave its caret under Vditor's IR keydown handling; forcing it into code would trap ArrowUp. |
| OQ5: remaining buttons | Owner assigned Headings, VMDE Link, Code and Table behavior at a blockless caret to planned Task 608. |
| OQ6: hr/TOC-first navigation | Owner assigned the measured hr-first root landing and unproved TOC-start navigation to planned Task 608. |
| OQ7: quality | Run network-free stages; omit the dependency audit by Owner instruction. Report bundle and startup budgets without changing them. |
| Closure scope (Owner, 2026-09-29) | The first acceptance item covers Task 600's block-marker and heading navigation routes. Keep the hr-first native root landing explicit as a Task 608 residual; it does not block Task 600 closure. |

B1 in media-src/src/editing/editor-caret.ts selects the block branch only for a Vditor IR node with data-block. It finds content before or after the marker inside that block; text targets use the content edge and inline/empty shapes use a block-local element offset. The inline branch, the pre-marker/Link-URL exemptions, existing live-intent and pointer guards, and the one-shot caret authority write remain intact. The arrow flag is consumed per frame and cleared by pointerdown or beforeinput.

B2 in media-src/src/editing/format-hotkey-guard.ts and media-src/src/bridge/message-router.ts refuses the seven actions only when an IR range starts inside the editor but has no containing block. The Vditor patch in media-src/esbuild-shared.mjs checks exactly one add-branch anchor and one list remove-branch anchor, then returns before the unsafe actions on toolbar mouse clicks, host hotkeys or other toolbar dispatch. The empty-editor setup precedes the add guard. No new eager module was introduced.

## Root-range writer audit

This updates the Part 1 handoff §5 against the implemented OQ1 decision. [M] means measured in a named run; [C] means code-attributed and not independently measured.

| Route | Evidence/owner | Task 600 coverage or residual |
| --- | --- | --- |
| A. Block-marker ejection after Ctrl+Home, End, Arrow, pointer or focus landing | media-src/src/editing/editor-caret.ts; S10/S13/S14 [M], additional shapes [C]; U1–U13 and S3b L1–L4/L8 | B1 keeps heading content or heading-local offset. The trailing setext/ID edges and nested/empty heading shapes pass unit tests. Fence info remains with Vditor. |
| A. Text-offset restore landing on a marker edge | media-src/src/editing/caret.ts, caret-preserve.ts and list-normalize.ts [C] | B1 normalizes a reached block marker. No independent restore-route e2e pin is claimed. |
| B. A previously recorded root range restored by editor-caret, focus-restore, escape-toolbar, format-hotkey-guard or Vditor blur | Part 1 handoff §5.B [C] | B1 stops its own root writer. B2 refuses seven actions if another path still restores a blockless IR range. |
| C. Vditor getEditorRange synthesizing (editor, 0) on fresh open | Vditor util/selection.ts [C]; S3a L6/T2 [M] | B2 mouse patch protects four inline formats and the list family. Fresh Bold leaves exact DOC unchanged in S3b L6/T2. Headings, VMDE Link, Code and Table remain Task 608 policy/investigation. |
| C. List toggles can erase the first paragraph when blockless | Vditor util/fixBrowserBehavior.ts [C]; S3a L5 list/ordered-list/check [M] | Owner-approved B2 guard covers both Vditor add and remove paths. All three L5 post-fix values equal DOC. |
| D. Undo/input/setValue rebuild can create or retain a root range | Task 597's Undo evidence [M]; Vditor ir/input.ts [C] | Task 597 owns Undo restoration. Task 600 B2 protects inline/list actions meanwhile; it does not repair every root range. |
| E. Explicit parent-node writes from inline handling | media-src/src/editing/selection-scope.ts and editor-caret.ts [C] | Only inline nodes reach that parent writer, so it cannot eject a top-level block to the editor root. |
| F. Native landing with no marker in an hr-first document | S3a OQ6 real-VS-Code probe [M]: four-hyphen thematic break, first IR node HR[data-block="0"], Ctrl+Home → PRE@0 | Not handled by B1; planned Task 608. The TOC-first control remained at Echo@15, which does not prove start navigation. |
| G. WYSIWYG and SV | S3a/S3b T1(f) [M]; Task 597's Undo root states [M] | B1/B2 are IR-specific. The mode strings and SV final-newline mismatch are observations below; Task 597 remains separate. |

## RED-before / GREEN-after evidence

| Layer | Before fix | After fix |
| --- | --- | --- |
| Unit B1 | On HEAD, U1–U10 and U12 failed for root/container landings; U11/U13 and all 19 prior tests passed (tmp/task600-checks/s1/unit-red.log). | S1: 32/32 passed, including U1–U13; all 38 changed executable lines covered (tmp/task600-checks/s1/final-report.md). |
| Unit B2 | Router: seven root-caret actions dispatched clicks; four heading/WYS controls passed. Predicate: 17 new tests failed because the export was absent. Patch: three cases failed because the patch was absent; stock-source control passed (tmp/task600-checks/s2/router-red.log, predicate-red.log, patch-red.log). | S2: four focused files, 369/369 passed; the patch-mutation suite included. All 10 changed executable predicate/router lines covered (tmp/task600-checks/s2/final-report.md). |
| Chromium | S3a on unmodified product HEAD 01b12c63: L1–L8, 14 cases, all reproduced RED. The final L8 expected-failure annotation was verified in relay 2 (tmp/task600-checks/s3a-final-report.md). | S3b relay 1: blockless-caret.spec.ts 14/14 passed, exit 0; marker-reveal, codenav, structural-selection and keybugs 38/38 passed, exit 0, both at one worker and zero retries. Logs: tmp/task600-checks/s3b/chromium-focused.log and chromium-regressions.log. |
| Real VS Code | S3a relay 5 on unmodified product HEAD: T1 XTEST and T2 CDP exited 0 as expected failures. T1(a)–(c), Find leg and T2(a)/fresh toolbar were RED; the paragraph-first and WYSIWYG/SV controls were recorded. One exact Q was acknowledged per edit. Earlier relays 1–4 diagnosed setup or record-only assertion issues, not product GREEN (tmp/task600-checks/s3a-final-report.md). | S3b relay 1, VS Code 1.129.0, isolated Xvfb+Openbox, VMDE_XTEST=1: focused T1/T2 2/2 passed, exit 0, no retries. The marker-reveal/ir-core/format-hotkeys regression group passed 9/10; the sole marker-reveal PageUp failure is a clean-HEAD baseline residual, documented below. Logs and snapshots: tmp/task600-checks/s3b/vscode-focused.log, vscode-regressions.log, observations/real-vscode-T1.json and real-vscode-T2.json. |

The S3b exact focused commands were xvfb-run -a npm --prefix media-src run test:e2e -- blockless-caret.spec.ts --workers=1 --retries=0; xvfb-run -a npm --prefix media-src run test:e2e -- marker-reveal.spec.ts codenav.spec.ts structural-selection.spec.ts keybugs.spec.ts --workers=1 --retries=0; and, inside the isolated Xvfb/Openbox shell, npm --prefix test/vscode-e2e test -- blockless-caret.spec.ts --workers=1 --retries=0 followed by marker-reveal.spec.ts ir-core-interactions.spec.ts format-hotkeys.spec.ts with the same options. All tests used the build from node build.mjs. The separate baseline command and its worktree setup are recorded in tmp/task600-checks/s3b/marker-reveal-diagnosis/diagnosis-and-relay.md.

## Exact real-VS-Code host strings

The shared TAIL is two LF, then "Alpha bravo charlie delta.", two LF, "Echo `foxtrot` golf hotel.", and a final LF. Exact full strings, including the last LF:

| Leg | Host string after one Q | Result |
| --- | --- | --- |
| T1(a) Ctrl+Home, Ctrl+B; T1(b) toolbar Bold; T1(e) Find close then Bold; T2(a) CDP Bold | "# **Q**Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n" | Exact pin for (a)/(b)/T2(a); Find leg uses the no-leading-block invariant and records this observed value. |
| T1(c) Ctrl+G | "# Q``Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n" | Measured content-start inline-code pin. |
| T1(d) paragraph-first control | "**Q**Alpha bravo charlie delta.\n\n# Probe\n\nEcho `foxtrot` golf hotel.\n" | Exact paragraph control pin. |
| T1(f) WYSIWYG | "# QProbe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n" | Record-only: Bold was disabled inside the heading. No new top-level block. |
| T1(f) SV | "**Q**# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n" | Record-only: SV getValue() contained one extra final LF after this host string; no blank-line-separated block was inserted before the heading. |
| T2 fresh toolbar Bold | "# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n" | Original DOC unchanged. |

## Setup and residuals

S3a's initial T1 reference failures came from Vditor's opening Undo checkpoint racing the synthetic content-start placement. The test now waits for a positive Undo stack in the active mode, wraps checkpoint and caret-request calls, and asserts zero extra checkpoint calls between placement/Ctrl+Home and preformat capture. Relay 5 recorded eight clean windows. The S3b focused T1/T2 tests retained the same guard, exact Find-input acknowledgment and exact one-Q beforeinput delivery. No retry or retyping was counted.

The real-VS-Code marker-reveal PageUp poll at test/vscode-e2e/marker-reveal.spec.ts:234 failed in the S3b 9/10 regression run. The same unchanged spec failed at the same line in a clean detached HEAD 01b12c63 worktree (tmp/task600-checks/s3b/marker-reveal-diagnosis/baseline.log), and again on the current tree (current.log), each with one worker and zero retries. It is pre-existing; it was not relaxed or edited in Task 600. Commit a43e6e36 on the separate fix/marker-reveal-pageup branch later fixed it, but that branch is not merged into this candidate. This residual does not turn the recorded 9/10 regression run into a green suite.

The measured hr-first Ctrl+Home root landing remains outside Task 600's Owner-approved block-marker navigation scope and is assigned to Task 608 with the OQ5 toolbar routes. Task 599 still owns exact Find-close caret restoration; Task 597 owns Undo root repair. The original broader wording and the residual are preserved above so this closure is not mistaken for a global root-caret fix.

## Verification and completion state

The network-free quality stages ran on the Task 600 candidate from /home/user/Projects/vmde. Logs and command/exit records for the managed-sandbox attempt are under tmp/task600-checks/s4/quality-results.json. Only Task 604 test files changed when HEAD advanced to 3e125670; Task 600 product and acceptance inputs stayed unchanged. Coverage and its ratchet were then relayed unsandboxed against that final HEAD. The dependency audit is intentionally omitted by Owner instruction. Full Chromium and the broad real-VS-Code fast tier are omitted under the Owner's focused-evidence queue policy.

| Stage | Exit | Measured result |
| --- | ---: | --- |
| npm run lint:ci | 0 | Whole-tree Biome clean. |
| npx --no-install jscpd | 0 | 8.12% duplicated tokens against the 8.8% threshold. |
| npm run depcruise | 0 | No reported boundary violation; dependency-cruiser warned that its current TypeScript support is below this repository's TypeScript version, so this result may miss TypeScript dependencies. |
| npm run knip | 1 | Nine unused exports plus one exported type, the same baseline set recorded for Task 579; no Task 600 path is named. |
| npm run check:brand-identifiers | 1 | Four inherited former-brand findings, none in Task 600 files. |
| npm run typecheck | 0 | No errors. |
| npm run typecheck:strict | 1 | The same 15 diagnostics as the pre-S2 log, byte-identical. |
| npm run typecheck:vscode-e2e | 1 | Only the baseline TS2339 at test/vscode-e2e/preview-task-checkbox.spec.ts:122; diagnostic matches the S3a log. |
| npm run check:bundle-size | 1 | Reporting-only ceiling: media/dist/main.js is 910,955 bytes (889.60 KiB), up 1,631 bytes from Task 579's 909,324-byte baseline. The script rounds it to 890 KB against its inherited 608 KB ceiling. |
| npm run check:startup-cost | 1 | Reporting-only ceiling: 346 eager modules against 294; unchanged count from Task 579. Largest module remains 29.8 KB against 34 KB. |
| npm run test:coverage (managed sandbox attempt on 01b12c63) | 1 | 313 test files passed and five failed: 4,887 passing tests, nine expected failures, 51 failures. Forty-nine failures were child-process spawnSync EPERM. The other two were Task 604 probe-tier and large-fixture V7 test issues. Task 604 repaired those in separate commit 3e125670; the failed attempt remains recorded. |
| npm run test:coverage (unsandboxed network-free relay on 3e125670) | 0 | 318/318 files; 4,938 passed, nine expected failures. Statements 76.36%, branches 69.43%, functions 79.86%, lines 78.57%. Log: tmp/queue-relay/coverage2.log. |
| npm run check:coverage-modules (unsandboxed relay) | 0 | Eleven source modules at 0% against baseline 13; two baseline modules now have coverage and are eligible for later baseline pruning. Log: tmp/queue-relay/ratchet2.log. |
| git diff --check | 0 | No whitespace errors. |

The local Task 604 probe failure identified three @probe titles in a non-probe filename. Its separate commit 3e125670 corrected the probe-file convention and bounded the slow real-Lute unit. The earlier V7 test also passed 1/1 in a focused local diagnostic (3.60 s). The unsandboxed relay now supplies the complete coverage and ratchet result without changing Task 600 product files.

All three acceptance items now hold under the Owner's explicit scope decision. The checked tasks/README.md entry points to this record's requested tasks/done/ location. The orchestrator will perform the Git move before committing; this working copy remains at its original path until then. No staging, move, commit or push occurred in this Codex step.

## Execution routing

Settings below are the orchestrator's verified per-dispatch settings, not inferred from the prose tier label.

| Step | Model / effort |
| --- | --- |
| S3a, r1, r2 | gpt-6-astra / xhigh |
| S3a r3, r4, r5 | gpt-6-sol / max |
| S3a final | gpt-6-sol / high |
| S1 | gpt-6-astra / xhigh |
| S2 | gpt-6-sol / max |
| S3b, r1 | gpt-6-astra / xhigh |
| S4 | gpt-6-sol / high |
