# Task 215 — Right-click context menu contributions (`webview/context`)

**Status:** ✅ DONE — 2026-09-08 · **Impact:** 🟡 med · **Origin:** task 192 §5

## Part 1 handoff (2026-09-08)

**Reasoning actually performed:** `model=gpt-5.6-terra` · `reasoning_effort=medium`.
Caveman Mode was unavailable, so this is a concise source/test/history audit rather
than a plugin-produced review. No implementation or acceptance command was run.

### Live scope and dependency boundary

- Already shipped: `package.json` contributes `vmde.promoteHeading`,
  `vmde.demoteHeading`, `vmde.rewrap`, and `vmde.rewrapDocument` to
  `webview/context` (groups `2_edit@1`–`@4`). Task 254 shipped the first two in
  `38de443`; the rewrap entries are existing Task 273/520 work. Do not delete,
  duplicate, or replace these entries.
- Those four rows are currently gated only by `webviewId == vmde.editor`; their
  handlers in `src/app/commands.ts` resolve the active panel and act on the live
  caret/selection. They do **not** receive or resolve a right-click target.
- Task 215 owns the reusable native-context plumbing and may narrow existing rows
  to an explicitly stamped editor section without changing their established
  selection-based semantics. It must not claim that they are target-aware.
- Defer menu actions whose backing feature is not shipped: Copy as HTML/Markdown
  remains Task 53 (host receivers exist, but its webview emitters/UI are planned);
  Export diagram remains Task 194; mode switching and outline toggling have no
  current dedicated context-command contract. `copy-code` has a webview button
  sender and host receiver, but no host command that can safely recover the
  clicked code block, so it also needs its owning feature/contract before a menu
  row lands.
- Task 215 precedes Task 222 in the live queue and has no implementation
  prerequisite beyond the shipped commands above. Do not touch Task 566 work.

### Root cause and interfaces

The manifest contribution point is no longer unused, but the webview never stamps
`data-vscode-context`; VS Code therefore has no region discriminator, and the host
has no trustworthy click payload. `resolveActivePanel()` is correct for existing
caret actions but is specifically insufficient for code/image/diagram/wiki actions:
using it would make a menu click act on stale selection rather than the clicked node.

Affected implementation seams:

- `package.json` — preserve the four current rows and gate any Task-215-owned row
  by `webviewId == vmde.editor` plus an exact `webviewSection`.
- New small webview context-stamping helper under `media-src/src/`, installed from
  the normal boot/disposer lifecycle (`media-src/src/boot/finish-init.ts` or the
  nearest existing render-lifecycle seam). It must stamp editor-root, rendered
  diagram (`lang`), image, code-block, and wiki-chip nodes and reapply after
  Vditor/diagram rerenders; serialize only simple JSON data, never authored HTML.
- `src/app/commands.ts` plus `src/shared/protocol.ts` only if a *shipped* action
  genuinely needs a typed target payload. Validate/normalize the command argument
  before use; do not infer a DOM target from selection. The implementation must
  first prove the actual VS Code `webview/context` command-argument shape with the
  L3 proxy before designing a payload schema.
- Tests: helper unit beside the helper; a Chromium harness spec; manifest and
  command-handler tests; one focused `test/vscode-e2e` spec.

### Implementation sequence and invariants

1. Characterize the real command argument using a temporary/test-only L3 proxy;
   confirm which `data-vscode-context` fields VS Code passes before relying on
   `webviewSection`, `lang`, or any target identifier.
2. Add an idempotent helper that assigns exact JSON context to live nodes, using
   observers/render callbacks that survive IR, WYSIWYG, SV, Preview, mode switches,
   incremental edits, and diagram rerenders. Do not attach a `contextmenu` listener.
3. Narrow only the existing four rows to the editor section once the root stamp is
   proven. Add a new command/menu row only when its backing task has shipped and its
   args-based target contract is proven; keep ownership with Task 53/194/etc.
4. For every action that writes or selects text, retain exact source bytes,
   CRLF/newline form, protected syntax, active focus, selection/caret, scroll,
   save/reopen behavior, and one-step history. No right-click may retarget an
   unrelated selection or steal focus before the command runs.
5. Preserve the native Copy/Cut/Paste menu and browser/VS Code behavior:
   `contextmenu` must remain cancelable with `defaultPrevented === false` over
   prose, diagrams, and gated renderers (Task 191 Probe-23).

### Focused acceptance evidence expected (not run in Part 1)

- L1: helper tests prove exact contexts and language values, idempotence, and
  omission of irrelevant nodes; manifest tests pin section-gated rows; any newly
  target-aware command tests reject missing/malformed/foreign args and prove it
  uses the forged target rather than selection. Existing caret commands retain
  their established selection-driven tests.
- L2: Chromium fixture covering prose, code, image, wiki chip, and at least one
  rendered diagram across render/edit and mode-rebuild cycles; assert attributes
  persist and cancelable `contextmenu` is not prevented.
- L3 (mandatory): after `node build.mjs`, use the real VS Code webview to assert
  registration through `vscode.commands.getCommands`, execute only shipped
  contributed commands with the characterized forged context argument, and prove
  effect plus focus/selection/source/save-reopen invariants. Native-menu clicks
  are not Playwright-drivable, so this direct-command proxy is required, not a
  substitute claim about native Copy/Cut/Paste.
- Run the focused unit/Chromium/real-VS-Code checks, changed-line coverage, then
  the applicable gates and `npm run quality` per `DEVELOPMENT.md`; record actual
  outcomes, including any sandbox limitation, rather than treating this handoff
  as validation.

### Unresolved decision / blocker

The exact VS Code command-argument payload has not been empirically characterized
in this repository. That is the first implementation check and a blocker for any
target-specific command. If VS Code supplies only visibility context and not a
safe target identity, keep Task 215 to stamping/gating existing actions and leave
target actions with their owning feature tasks; do not introduce a selection-based
fallback or a custom DOM menu.

## Problem

Right-click inside the editor offers nothing custom — the `webview/context` menu
contribution point is entirely unused (package.json:119-160). It is the natural home for
several features this backlog restores/adds.

## Scope

- [x] Stamp `data-vscode-context` on the relevant webview regions (VS Code reads it to
      decide menu item visibility): editor root (`{webviewSection:'editor'}`), rendered
      diagrams (`{webviewSection:'diagram', lang}`), images, code blocks, wiki chips.
- [x] Gate the four already-shipped rows (`vmde.promoteHeading`, `vmde.demoteHeading`,
      `vmde.rewrap`, `vmde.rewrapDocument`) on `webviewId == vmde.editor &&
      webviewSection == editor`. Copy/export/code/mode/outline actions remain owned by
      their feature tasks until they ship with a safe target contract.
- [x] Confirm the direct-command proxy provides no trustworthy clicked-node identity; retain
      the existing commands' live-selection semantics and add no target-aware handler.
- [x] Keep the native Copy/Cut/Paste items intact — contribute alongside, never
      preventDefault contextmenu (191 Probe-23 guards this).

## Out of scope

- A custom DOM context menu inside the webview (native contribution is the right surface),
  per-item keybindings.

## Verification

- L1: unit for the context-stamping helper (right sections on the right nodes).
- L2: harness — `data-vscode-context` attributes present per region after render/edit
  cycles (survive re-render).
- L3 real-VS-Code (mandatory): execute the contributed commands directly with a forged
  context arg (native menu is not Playwright-drivable — 191 Probe-23 pattern documents
  this proxy) and assert effects; menu registration asserted via `vscode.commands.getCommands`.

## Completion and verification (2026-09-08)

Added an idempotent `installWebviewContext` observer at the stable `#app` mount. It writes
only exact JSON visibility contexts: editor root, code blocks, images, wiki chips and rendered
registry-backed diagrams with their language. The four existing context rows are now limited to
the editor section. No DOM `contextmenu` listener, target payload, new command, or custom menu
was added: the real direct-command proxy established that a forged object is only direct-test
input, not a trustworthy clicked target.

Focused evidence passed: helper unit tests (3/3; changed lines 100%); Chromium harness (2/2,
including rebuild/source fidelity and `defaultPrevented === false`); and fresh built real VS Code
(1/1, `--workers=1 --retries=0`, registration, root stamp, selection-driven forged proxy,
save/reopen). Webview/strict/real-spec type checks passed. The full lint gate is blocked only by
concurrent Task 566 formatting drift in `escape-toolbar.ts` and `emoji-catalog.test.ts`; scoped
Task 215 Biome checks passed. Bundle is 702 KB versus 608 KB and startup is 311 versus 294 eager
modules, both inherited reporting-only excesses. Audits and aggregate quality were intentionally
omitted under the focused network-free queue policy.

### Review repair (2026-09-08)

The observer now reconciles only contexts it previously owned: a removed wiki discriminator or a
rendered `language-mermaid` node that becomes ordinary `language-ts` cannot retain stale context.
Renderer-owned descendants, including Leaflet tiles, receive their enclosing diagram context rather
than an image context. Focused unit coverage verifies both transitions; Chromium now also covers a
nested renderer image and an actual IR → WYSIWYG → SV → IR → Preview cycle with source bytes intact.

The native `webview/context` command-argument shape remains unproven. The L3 proxy only establishes
that the current handlers ignore its forged object and continue to be selection-driven; it cannot
represent a native menu click or establish a safe target contract. Target-aware actions remain with
their owning tasks.

### Final review repair (2026-09-08)

The mode-cycle regression now asserts concrete code, image, wiki and Mermaid diagram contexts in
WYSIWYG, returned IR and Preview—not merely the persistent `#app` context. SV has no rendered
regions, so its editable source surface is explicitly stamped as `editor`. Focused Chromium
coverage passed 3/3 with source bytes unchanged across the complete cycle.

### Real SV verification (2026-09-08)

After a fresh build, the focused real-VS-Code spec switches IR → SV, asserts the live
`.vditor-sv` editor context, returns to IR, and completes its existing save/reopen journey.
The helper unit tests passed 4/4 and the no-retry real spec passed 1/1.
