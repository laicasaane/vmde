# Task 297 — Link edit popover in IR mode (balloon: Open · Copy · Edit URL · Unlink)

**Status:** ✅ DONE (2026-09-25) · **Impact:** 🟡 med · **Shares overlay primitive with:** 285 · **Origin:** task 192 §12

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

- [x] Build on the 285 overlay primitive (position/focus/dismiss/IME rules — ONE
      implementation). Trigger: caret enters an `a`/link IR node (selectionchange), or a
      dedicated affordance if plain-click must keep today's expand behaviour — decide by
      feel with the user (memory: show partial results).
- [x] Actions: **Open** (existing open-link wire + policy), **Copy URL** (task-53 copy
      wire), **Edit** (input; commit rewrites the href marker span through the normal
      pipeline — one model edit, one undo), **Unlink** (replace node with its text).
- [x] Cover regular links AND images' src (the WYSIWYG img popover stays Vditor's; this
      is the IR gap); wiki chips excluded (they have their own click semantics).
- [x] Preserve existing title metadata through link/image Edit and Unlink. Optional title-input
      editing was evaluated and left out because Task 240 owns its fidelity contract.

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

## Final Part 2 implementation and verification — 2026-09-25

The body-owned IR balloon reuses Task 285's `createFloatingOverlay` and the
shared Task 570 bounds/placement functions. An ordinary primary link/image
pointerdown is consumed before Vditor can expand raw markers; the click then
shows Open, Copy URL, Edit URL and Unlink. Ctrl/Cmd click and legacy plain-click
Open retain the existing link policy, including Vditor's image-source Open for
a link-wrapped image. Other text selections and non-target clicks keep native
caret behavior. The panel remains inside the scrollport, below the toolbar
and clear of the active label at narrow width; it never enters Lute-owned DOM.

For exact source ownership, the hidden destination-marker Range is first mapped
against live rendered `getValue()`. Task 259's source-group resolver proves the
authored exact document against detached and live Lute DOM, even when CRLF, a
padded table or a fence serialize differently. Ordered lexical candidates in
the paired rendered/exact groups and live DOM nodes must agree in kind, visible
label, destination and title. The clicked DOM ordinal selects the exact source
occurrence; equal counts or duplicate URL text alone are insufficient. A
changed owner, title, destination, exact/rendered snapshot, editor, mode,
marker or live editor selection declines. Malformed/protected source and
unprovable groups fail closed for Edit/Unlink; a visible URL can still Open/Copy.

Edit replaces only the proven destination marker; Unlink substitutes the
exact label/alt source. After the Vditor mutation, the rendered value must
equal the shipped Lute projection of the planned exact document or the editor
and native undo state roll back without a host write. `postExact` runs only
after `setApplying(false)`, because edit-sync suppresses messages while its
mutation guard is active. Separate before/after exact and rendered states are
recorded for native/host Undo and Redo. The input observes IME, Escape,
scroll, rebuild, focus, and a later editor-owned selection change. A guarded
ResizeObserver is optional for jsdom/older runtimes. Existing titles are
preserved; no title authoring input was added.

Final focused evidence:

- Exact planner/Open/Copy/shape/host and finish-init units: **56/56** across
  the five targeted files. New red→green cases cover ordered duplicate/title
  identity, escaped quote/parenthesized titles, CR/LF title rejection and
  finish-init without ResizeObserver. The planner's focused V8 report has
  **89.73% line** and **85.46% branch** coverage; controller unit coverage is
  21.78% lines because its live event/transaction paths are covered in
  Chromium and real VS Code. The filtered coverage run passed its 56 tests
  but could not meet the whole-repository threshold (9.08% lines).
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix media-src run
  test:e2e -- link-popover.spec.ts link-popover-noncanonical.spec.ts
  --workers=1 --reporter=line`: **11/11**. This includes default plain-click
  no expansion/reflow, duplicate link/image identity, exact CRLF/table/fence
  Edit→Unlink and rendered Undo/Redo, title mismatch rejection, Open/Copy,
  modifier policy, IME/stale, render-divergence rollback and 520 px bounds.
  A later focused 3/3 rerun verified the pointerdown regression model, image
  edit and modifier behavior; the full affected file was green after the
  selection and exact-post fixes.
- `node build.mjs` passed, followed by no-retry real
  `test/vscode-e2e/link-popover.spec.ts`: **2/2 (20.2 s)**. The real host
  retained authored CRLF/table/fence bytes through Link Copy/Edit/Unlink,
  Undo/Redo, save/reopen; Image Edit/Unlink and explicit local Open passed
  with modifier and legacy click modes. Test-local pointer order confirms
  marker expansion is prevented before click. Numeric real geometry keeps
  the balloon within editor/toolbar bounds and below its label.
- Scoped Biome, webview typecheck and final `npm run typecheck:vscode-e2e`
  passed. Task 571's concurrent `toolbar-order.spec.ts:304` temporarily
  failed the earlier real-spec typecheck, then its test-only correction made
  the final aggregate check green. `node scripts/module-manifest.mjs` still reports only
  pre-existing emoji/list/table/webview-context omissions; both Task 297
  source IDs are registered.
- `npm run quality` ran and failed on existing former-brand identifiers,
  out-of-scope formatting/Knip findings, vendored emoji metadata and
  manifest/probe-tier/vendor aggregate tests. It also exposed three
  Task 297 finish-init jsdom failures from unguarded `ResizeObserver`;
  these were fixed and the focused finish-init file passed **3/3**.
  Aggregate quality was not repeated after that focused repair. `jscpd`
  and dependency-cruiser passed in the aggregate run. The coverage-module
  ratchet lacked a completed aggregate summary.
- The final shared build measured webview `main.js` at **841.9 kB** and CSS
  at **52.9 kB**. The bundle/startup budgets already exceeded their limits
  before Task 297 and the build also contained concurrent Task 571 changes,
  so these sizes are not attributed solely to this task.

The protected local queue files were neither edited nor staged; no push.
