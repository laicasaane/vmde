# Task 285 — Floating (bubble) toolbar on text selection

**Status:** 🚧 in progress — safe overlay/format/Turn Into checkpoint; Link/Wiki and final UX acceptance pending · **Impact:** 🔴 high — flagged independently by THREE lenses of the WYSIWYG-editor audit · **Origin:** task 192 §12

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

- [ ] Overlay div OUTSIDE the editable DOM (zero serialization risk), positioned from
      `getSelection().getRangeAt(0).getBoundingClientRect()` on debounced selectionchange;
      shown only for non-collapsed selections in ir/wysiwyg (never sv source, never
      Preview).
- [ ] Buttons: bold / italic / strike / inline-code / link / wiki-link + the task-298
      "turn into" dropdown — ALL dispatching the existing toolbar/IR actions
      (`ir/process.ts processToolbar` already handles add/remove on the dual-node DOM),
      so no new serialization surface.
- [ ] Known traps, all with in-repo precedent: `mousedown` preventDefault on the overlay
      (toolbar focus-scroll memory), hide during IME composition and while a node is
      mid-spin, hide on scroll/drag, re-position on selection growth.
- [ ] Setting `vmde.editor.selectionToolbar` (default on); shares the overlay primitive
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

Open acceptance: selected Link and Wiki Link authoring are not yet implemented;
WYSIWYG, Preview/SV, scroll/drag, large scrolled-document focus/position, setting
off, and final shared-overlay behavior still need focused acceptance before
closure. An automatic review rejected a proposed Wiki Link adapter that called
`vditor.updateValue` with only a link string, stating it could replace the
entire document and lose data. No such adapter was written. Source inspection
shows Vditor's method uses `execCommand('insertHTML')` on the selection, but a
future adapter will use a guarded retained source selection and text-only
insertion with exact source and one-undo proof. This checkpoint stays 🚧.
