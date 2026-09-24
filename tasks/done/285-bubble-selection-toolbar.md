# Task 285 — Floating (bubble) toolbar on text selection

**Status:** ✅ DONE (2026-09-24) — floating selection toolbar with guarded Link/Wiki, shared Turn Into, and real IR/WYS acceptance · **Impact:** 🔴 high — flagged independently by THREE lenses of the WYSIWYG-editor audit · **Origin:** task 192 §12

## What it is & the effect

The Medium/Notion-style pattern, shipped by every modern editor framework (Tiptap
BubbleMenu, BlockNote Formatting Toolbar, Milkdown Crepe, Lexical playground): the moment
you select text with the mouse, a small toolbar pops up AT the selection with
bold/italic/code/link — you format without travelling to the top of the window.

**Today in VMDE:** selecting text produces NO affordance at all in the default IR mode —
`highlightToolbarIR` merely highlights the pinned top-toolbar buttons. Formatting a word
mid-document means mouse-travel to the top bar (or knowing the hotkey).
**After:** select → format in place; users who prefer a clean surface can hide the top
toolbar entirely (`showToolbar=false` already exists) and lose nothing.

## Scope

- [x] Overlay div OUTSIDE the editable DOM (zero serialization risk), positioned from
      `getSelection().getRangeAt(0).getBoundingClientRect()` on debounced selectionchange;
      shown only for non-collapsed selections in ir/wysiwyg (never sv source, never
      Preview).
- [x] Buttons: bold / italic / strike / inline-code / link / wiki-link + the task-298
      "turn into" dropdown. Formatting dispatches Vditor's existing IR/WYS toolbar actions;
      Link/Wiki use the approved guarded exact-source text insertion and Lute
      equivalence check, with no new serialization surface.
- [x] Known traps, all with in-repo precedent: `pointerdown` preventDefault on the overlay
      (toolbar focus-scroll memory), hide during IME composition and while a node is
      mid-spin, hide on scroll/drag, re-position on selection growth.
- [x] Setting `vmde.editor.selectionToolbar` (default on); shares the overlay primitive
      with task 297 (link popover) — build the primitive once.

## Out of scope

- Right-click menu (215), block drag handles (259), toolbar customization.

## Verification

L1: position/visibility state machine unit. L2: drag-select → bubble appears at the rect,
click bold → `**` in `getValue()`, selection survives, collapsed/sv/Preview → hidden.
L3 real-VS-Code (mandatory): positioning under injected CSS, no focus-scroll jump on a
scrolled large doc (the scroll-guard class of bug), IME suppression.

## Part 2 safe selection-bubble checkpoint — 2026-09-24

A reusable `floating-overlay` manager now owns one body-mounted active surface for
this bubble and the later Task 297 popover. A pure eligibility/position layer
rejects collapsed, non-editor, SV/Preview, composing, spinning and pointer-drag
states and clamps the bubble around the selected range. The default-on resource
setting `vmde.editor.selectionToolbar` is wired through host options and re-init;
`showToolbar=false` retains its existing `toolbar: []` behavior. Four bubble
format buttons call Vditor's existing IR/WYS toolbar engines directly on a
revalidated retained Range, so they work without visible toolbar controls.
The Turn Into dropdown consumes Task 298's source-derived option statuses and
guarded token: current type is checked, lossy/unsupported choices remain disabled,
and a choice uses the shared transform adapter. Incomplete Link/Wiki controls are
not shown in this checkpoint.

Focused evidence: overlay/eligibility/config units passed 41/41; Chromium
`selection-bubble.spec.ts` passed 3/3 for hidden-toolbar Bold, body-owned DOM,
shared Turn Into status/choice, collapsed selection and IME hiding. `node
build.mjs` passed, then the focused real VS Code spec passed 1/1: hidden-toolbar
Bold changed exact host Markdown, native Ctrl+Z/Y restored it, Turn Into changed
one block through the shared menu, and both states saved exactly. The real spec
waits for Vditor's opening undo checkpoint before pressing Ctrl+Z; its first
run reached Bold but the premature Undo was a no-op, and the checkpoint-aware
rerun passed. Scoped Biome and host/webview/real-spec type checks pass.
Module-boundary checks remain 5/7 due to preexisting manifest omissions and
host `markdown->platform`; no Task 285 module ID or webview cycle is missing.
`typecheck:strict` retains seven unrelated diagnostics. The built eager webview
bundle is 800.8 KB versus the 794.0 KB Task 259 baseline (budget 608 KB), and
startup eager modules are 333 versus 329 (budget 294); these budget gates were
already failing before Task 285. The required full quality gate was not rerun
at this in-progress checkpoint.

Open acceptance at this earlier checkpoint: selected Link and Wiki Link authoring were not yet implemented;
WYSIWYG, Preview/SV, scroll/drag, large scrolled-document focus/position, setting
off, and final shared-overlay behavior still need focused acceptance before
closure. An automatic review rejected a proposed Wiki Link adapter that called
`vditor.updateValue` with only a link string, stating it could replace the
entire document and lose data. No such adapter was written. Source inspection
shows Vditor's method uses `execCommand('insertHTML')` on the selection, but a
future adapter will use a guarded retained source selection and text-only
insertion with exact source and one-undo proof. This checkpoint stays 🚧.

## Part 2 selected Link/Wiki authoring checkpoint — 2026-09-24

The bubble now offers selected-text Link and Wiki Link actions. Both retain and
revalidate the editor, mode, Range, exact host snapshot and rendered snapshot,
then map the visible selection to an exact source span. A pure planner changes
only that span. The Link planner keeps the pinned toolbar's leading-space rule
beside prose, but avoids introducing visible whitespace inside an existing
emphasis/strike span. Wiki Link is enabled only for the existing safe wiki
target grammar and emits `[[selected text]]`. Existing link labels, inline code,
multiline/control selections, stale or ambiguous source spans, and unsupported
wiki targets decline without a write. IR headings whose marker-based range map
is dropped by a re-spin use a narrow fallback: one exact selected occurrence in
a same-level ATX heading line, verified again by the full Lute projection.

The action inserts text into the retained DOM selection, checkpoints Vditor
history once before and after, compares the projected exact result with live
serialization, posts exact Markdown once, and rolls back on disagreement. For
IR Link, a temporary unique URL marker identifies the new empty URL span; it is
removed before source verification. A structural caret intent survives Vditor's
spin, and the generic marker reconciler now preserves a caret inside an empty,
expanded Link URL. WYS Link follows the existing pinned toolbar's insertion
contract, which does not open a URL popover. The bubble also retains the
hidden-toolbar formatting and Task 298 Turn Into routes from the first checkpoint.

Focused evidence: `npm test --` passed four relevant unit files 30/30,
including the pure Link planner 6/6 and IR marker reconciler 19/19. The browser bubble spec passed 9/9, including Link/Wiki exact
insertion, formatted text inside `**` becoming `**[text]()**`, existing-link
label decline, WYS hidden-toolbar behavior, and typing into the empty IR URL.
`node build.mjs` passed; the focused real VS Code spec passed 1/1 after the
build, exercising hidden-toolbar Bold, Turn Into, Link and Wiki Link through
exact host bytes, one-step Undo/Redo, exact save, and the URL caret after IR
spin. Scoped Biome, webview typecheck and real-spec typecheck passed. The
module-boundary file passed 5/7; its manifest-totality and host
`markdown->platform` failures are inherited. Verbose manifest output lists no
Task 285 module omission. A direct `vitest` call without the repository config
failed on the vendored `VDITOR_VERSION` global; the documented `npm test --`
rerun passed. An
initial real Link attempt declined because the marker range mapper returned
null after Turn Into; the unique-ATX fallback repaired that path. A second
real failure showed the marker reconciler ejecting the URL caret; its focused
unit was red before the narrow fix and green afterward. Disposable probes
were removed. The full quality gate remains for Task 285 completion.

Remaining acceptance: Preview and setting-off visibility, large scrolled real
VS Code focus/position, drag and IME suppression, and final quality/coverage
review. Source mappings that cannot prove ownership remain disabled or
non-mutating, including ambiguous formatted and existing-link spans. Task 285
stays in progress.

## Part 2 final interaction evidence — 2026-09-24

After the Link/Wiki checkpoint, the focused real VS Code spec passed 3/3 for
IR history and exact save, a 180-paragraph scrolled document (bubble inside the
viewport and away from selected text, scroll position retained after Bold),
IME composition hide/reappear, Preview hide, and the off setting. A separate
fresh-build real WYSIWYG case passed 1/1: hidden toolbar, Italic, selected Link,
one-step host Undo/Redo, and exact save. Its first run linked `alpha` instead of
`beta` because the test installed a synthetic Range without first focusing the
second paragraph; real WYS restored the prior alpha selection. A trusted
paragraph click and explicit live-selection assertion corrected that fixture.
The bubble and source mapper had consistently acted on the actual live alpha
selection; no product WYS mapping fix was needed.

Two browser regressions were red before the final ownership guard: moving a
live selection to identical text before the 32 ms bubble refresh attempted a
Link insertion from the stale bookmark, and moving it to different text let
Bold format the old selection. The shared bubble and Link adapter now compare
exact live Range endpoints with the retained bookmark before any action or
source marker mapping; both tests pass without an editor command. Browser
coverage also proves scroll/drag/Preview suppression and repositioning when a
selection grows. Focused `npm test --` passed 36/36 across eight relevant
unit files, including the new overlay, hidden-toolbar dispatch, and exact
Link-adapter guard units. Webview and real-spec typechecks and scoped Biome
passed. The full Chromium bubble spec subsequently passed 13/13, and the
required aggregate quality run completed with the unrelated residuals below.

## Final verification and quality limits — 2026-09-24

`node build.mjs` passed before each focused real run. The final
`media-src/e2e/selection-bubble.spec.ts` Chromium run passed 13/13. The
focused repository Vitest command passed 36/36 across eight files. Webview and
real-spec typechecks, scoped Biome, and `git diff --check` passed. The real
VS Code spec passed the three IR/scroll/Preview/off cases together (3/3), and
its corrected hidden-toolbar WYSIWYG case passed in a fresh focused run (1/1).
These tests cover exact host Link/Wiki bytes, browser-input Undo/Redo, disk
save, one editable IR URL caret, setting off, IME and drag suppression,
selection growth, and a scrolled 180-paragraph document without focus scroll.

`npm run quality` completed nonzero for repository/concurrent residuals with
no Task 285 diagnostic: `check:brand-identifiers` reports three historical
`vmarkd` markers; `lint:ci` reports Task 569's in-progress real fold spec and
preexisting list/emoji/escape/block-handle formatting; `knip` reports prior
table/emoji/outline exports; `audit:vendor` rejects preexisting emoji metadata
while host/webview npm audits find zero vulnerabilities. `jscpd` and both
`depcruise` stages pass. Aggregate coverage stops on five unrelated tests:
Editor setting order (`vmde.editor.emojiPickerCloseOnSelect`), module-manifest
totality, the host `markdown->platform` edge, the context-menu probe naming
convention, and emoji vendored-license coverage. Therefore the aggregate run
cannot produce a coverage summary for its ratchet.

One filtered coverage run excluding only those four failing test files passed
293/293 files and 4,220/4,220 tests, at 72.96% statements, 65.12% branches,
76.84% functions and 75.07% lines. Every Task 285 source module has nonzero
unit coverage: overlay and eligibility 100% statements, bubble 64.61%,
format dispatch 92.59%, Link planner 92.5%, Link adapter 9.17% (its positive
Vditor/host path is exercised by Chromium and real VS Code). The ratchet then
reports only unrelated `media-src/src/editing/table-format-command.ts` at 0%;
this predates Task 285 and was not added to its baseline. Source spans that
cannot prove ownership continue to decline without a write. No protected
local queue file or generated output is included in the task commits.
