# Task 297 — Link edit popover in IR mode (balloon: Open · Copy · Edit URL · Unlink)

**Status:** 🚧 in progress · **Impact:** 🟡 med · **Shares overlay primitive with:** 285 · **Origin:** task 192 §12

## What it is & the effect

The CKEditor "link balloon" / Vditor-WYSIWYG pattern: click a rendered link → a small
balloon with Open / Copy URL / Edit / Unlink, with Edit giving a compact input — instead
of exposing the raw `[text](https://very-long-url…)` inline.

**Today in VMDE's default IR mode:** clicking a link EXPANDS the raw markers inline —
for long URLs the paragraph visibly reflows and the caret swims in URL soup; there is no
Unlink or Copy-URL affordance at all (upstream Vditor ships the popover only for WYSIWYG
mode; IR's highlightToolbarIR does nothing selection-local). Editing an URL is the
concrete daily pain.
**After:** click → balloon; Edit rewrites the href in place (markers never need to open
for the common case); Unlink strips to plain text; Open respects the existing
Ctrl+click policy.

## Scope

- [ ] Build on the 285 overlay primitive (position/focus/dismiss/IME rules — ONE
      implementation). Trigger: caret enters an `a`/link IR node (selectionchange), or a
      dedicated affordance if plain-click must keep today's expand behaviour — decide by
      feel with the user (memory: show partial results).
- [ ] Actions: **Open** (existing open-link wire + policy), **Copy URL** (task-53 copy
      wire), **Edit** (input; commit rewrites the href marker span through the normal
      pipeline — one model edit, one undo), **Unlink** (replace node with its text).
- [ ] Cover regular links AND images' src (the WYSIWYG img popover stays Vditor's; this
      is the IR gap); wiki chips excluded (they have their own click semantics).
- [ ] Title attribute editing only if free (the 240 fidelity work touches titles — don't
      collide; coordinate).

## Out of scope

- Hover PREVIEW of the target (210), link autocomplete (32), the WYSIWYG-mode popovers
  (exist upstream; their L2 battery is 191 P1-1).

## Verification

L1: href-rewrite util unit (angle-bracket URLs, titles, escapes). L2: click link →
balloon; each action's `getValue()` outcome exact; long-URL paragraph does NOT reflow on
balloon-edit path; one undo per action. L3 real-VS-Code (mandatory): balloon under
injected CSS + Open respects the modifier policy.

## Part 2 progress (2026-09-24)

The Luna-max checkpoint has completed the source-shape characterization, pure planner, and typed
host routes. The remaining popover/source ownership integration is held for the Sol-high handoff.

- Chromium characterization of the pinned Vditor IR path confirms `[label](url "title")` is a
  `span[data-type="a"]` with separate label, URL-marker, and title spans. A document-capture
  click gate prevents Vditor's editor click handler from expanding the raw markers; trusted
  label clicks keep `getValue()` and paragraph height unchanged. The same capture gate prevents
  image-source marker expansion.
- An image is `span[data-type="img"]` with `--link` and `--title` marker spans plus a real
  `img[src][alt]`. Clicking it selects/expands its source under the unmodified Vditor path. A
  hidden destination-marker Range maps to exact offsets when the Vditor serialization is
  authoritative. A direct DOM text-node replacement plus the normal input/spin event produced
  the planned image-alt Markdown without NBSP; a diagnostic with explicit Vditor snapshots
  restored the source with one Ctrl+Z and reapplied it with Ctrl+Y. This remains a probe, not the
  committed product transaction.
- The exact-source planner and tests cover duplicate inline links, escaped labels/destinations,
  balanced and escaped parentheses, angle-bracket destinations, titles, CRLF, image alt unlink,
  stale spans, references, wiki links, autolinks, raw HTML, inline code, and fenced code. Focused
  planner tests pass 9/9; the planner module is 84.54% line-covered in the focused V8 report.
- Explicit Open now shares the link click handler's same-document fragment scroll and host
  `open-link` route. Copy URL uses a distinct `copy-link-url { href: string }` message routed
  through `vscode.env.clipboard`; required-field validation and a host session test are included.
  Focused Open/Copy/shape/session tests pass 50/50. The Open helper and clipboard wire are in
  the independent checkpoint; the popover actions are not yet wired or accepted.
- `npm run typecheck` and `node build.mjs` pass. Build output was main.js 824.8 KB and CSS
  51.4 KB.

**Unresolved exact-source admission:** a Chromium fixture with valid CRLF plus a table and fenced
block shows Vditor `getValue()` normalizes CRLF to LF, table spacing, and separator width while
the host source retains the original bytes. `captureRewrapSourceRange` against the exact host
source returns `null`; against rendered `getValue()` it maps the clicked URL at offsets 33–54.
The current candidate controller also declines when `exact !== rendered`, before showing the
popover. No ordinal source/rendered alignment change has been applied. The unintegrated link-popover
controller and browser characterization probes remain outside the independent checkpoint commit.
Sol-max Part 1 classified
the admission, marker-range mapping, post-render proof, and exact history bridge as Heavy/Sol-high.
Those acceptance checks, the popover controller, modifier/Open/Copy UI acceptance, fresh-build real
VS Code coverage, and task closure remain open. No push.
