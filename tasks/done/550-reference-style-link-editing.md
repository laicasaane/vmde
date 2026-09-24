# Task 550 — Render and activate reference-style links cleanly in visual edit modes

**Status:** closed — superseded by Task 572; acceptance incomplete · **Impact:** 🟠 common technical-document authoring gap ·
**Origin:** user report, 2026-09-06 · **Related:** Tasks 32, 62, 240, 297, and 542

## Closure decision (2026-09-25)

The Project Owner directed Task 550 to close and the Astra recommendation to become a completely new task. This record is closed as **superseded, with feature acceptance incomplete**. The pure definition-index checkpoint `6a9f4ba6` remains useful; the two failed wrapper investigations are recorded in `bb7a87ca` and `171f2e1f`. No native Lute repair, reference presentation/editing/activation, browser or real-VS-Code acceptance shipped under Task 550. The unchecked requirements below remain unchecked deliberately.

[Task 572](../572-native-lute-reference-links.md) owns a reproducible native-Lute repair gate and all remaining reference-link product acceptance. Do not count this closure as delivered functionality in release notes.

## Reported case

```markdown
- `IsExternalInit.cs`: Enable [`init`][init] of C# 9

[init]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/keywords/init
```

In the visual editor, the inline reference label remains visible as a second raw `[init]` after the
rendered `` `init` ``, and the destination definition occupies its own visible source-like row. The
result reads as duplicated prose instead of the single linked code label produced by Markdown
Preview.

At filing, no existing task owned this presentation and interaction gap. Task 572 now owns its remaining delivery. Task 240 preserves definition titles
and prevents serialization corruption; it deliberately excludes reference-link authoring. Task 542
activates references only in the split-source pane. Task 297 covers ordinary IR-link editing and
currently excludes reference nodes.

## Confirmed engine contract

The pinned Lute recognizes the reported reference but its visual modes differ:

- IR emits a `span[data-type="link-ref"]` containing the code-formatted label plus a
  `.vditor-ir__marker--link` `[init]`, and a separate
  `div[data-type="link-ref-defs-block"]` containing the definition.
- WYSIWYG emits an **empty** `span[data-type="link-ref"][data-link-label="init"]` for this
  code-formatted label. Live Vditor `getValue()` then omits the entire reference use.
- `Md2HTML` resolves the construct to one `<a href="…"><code>init</code></a>`.

The WYS source loss must be repaired and round-tripped before hiding reference syntax or enabling
editing. Preserve the authored reference, definition, and exact source bytes rather than converting
it to an inline link.

## Implementation contract

- In IR and WYSIWYG, present `[text][label]`, `[label][]`, and shortcut `[label]` references as one
  ordinary linked label while the reference is inactive. Do not show a duplicate label suffix in
  reading state.
- Resolve labels case-insensitively against the live document's link-reference definitions, matching
  Markdown semantics. Support inline formatting in the visible label, including the reported code
  span.
- Apply the existing `vmde.editor.linkOpenWithModifier` policy and secure host `open-link` route.
  A reference activation must post exactly once; missing or malformed definitions must fail closed.
- Keep reference syntax editable. When the caret enters a reference or its definition, expose enough
  source UI to change the label or destination without converting it to `[text](url)`. Define and
  test the reveal/dismiss interaction before implementation; coordinate it with Task 297 rather than
  creating a competing link popover.
- Keep definitions available to editing and serialization while preventing inactive definition rows
  from reading as document prose. Any collapse/reveal treatment must preserve caret, selection,
  find/reveal, accessibility, scroll position, mode rebuilds, undo/redo, and all definition order,
  case, destination, and title bytes covered by Task 240.
- Leave split-source mode source-like. Retain Task 542's existing reference activation and exact
  Markdown behavior there.

## Toolbar control requirements

**Decision: extend the existing Link control contextually; no additional top-level button.**

- [ ] When the caret/selection identifies an existing reference hyperlink, the Link action must
      open reference-aware editing rather than insert an inline link. Expose its label and an
      explicit **Edit definition** action, coordinated with Task 297's link UI.
- [ ] Editing a shared destination must explain that the definition is shared and preserve all
      other uses. A missing definition must remain visible as unresolved, with a clear editing path.
- [ ] Keep ordinary Link insertion unchanged outside references. Creating/converting reference
      links is not required by this presentation/activation task.
- [ ] Verify toolbar focus does not lose the reference selection; Escape cancels without edits,
      Apply makes one undoable change, and the modified definition is preserved on save/reopen.

For added or extended controls: use the existing toolbar overflow, localization, tooltip and
keyboard-accessibility conventions (Tasks 492/505). Preserve selection when focus enters a menu,
support keyboard activation and Escape/focus return, and disable mutations in read-only Preview.
Keep new actions in the menu placements above rather than pinning extra buttons by default.
Use a single command handler per action; do not introduce duplicate Vditor/VS Code hotkeys.
Include toolbar interaction in this task's focused Chromium and real-VS-Code verification.

## Progress (2026-09-25)

- A pure exact-source definition index/planner now identifies the first eligible label,
  UTF-16 destination and title spans, angle/quote style, duplicate order, CRLF
  boundaries, and protected-block exclusions. It rejects stale or later-duplicate
  destination edits and characterized source forms that pinned Lute does not recognize.
- `npm test -- media-src/src/links/reference-source.test.ts` passes 9/9;
  `npm test -- test/backend/reference-source-lute.test.ts -t '<ownership cases>'`
  passes 9/9 with the one formatted-WYS case skipped. Targeted Biome and
  `npm run typecheck` pass.
  `reference-source` is registered in `scripts/module-manifest.mjs`;
  `node scripts/module-manifest.mjs` still fails on 15 previously unlisted host/webview
  modules, and the boundary suite still reports inherited `markdown->platform`
  and `editing->links` edges. A separate vendored-Lute regression is
  intentionally red for the reported C#
  fixture: IR retains the code-formatted `init` label, but WYSIWYG renders an
  empty `link-ref` span. A one-shot live Vditor WYS probe confirms the empty
  span and shows `getValue()` omitting the label from source. The temporary
  browser probe was removed.
- **Sol-max attempt 1, unresolved:** The proposed source-bearing first TEXT child
  holding the raw Markdown bytes `` `init` `` plus a
  `data-render="1" contenteditable="false"` visual child
  succeeds only before spin: pinned `VditorDOM2Md` serializes the reported
  full-code reference and comparable emphasis/strong/escaped labels from that
  carrier. On the actual `SpinVditorDOM(block.outerHTML + definition.outerHTML)`
  path, Lute regenerates an empty code reference and strips those other inline
  formats. A second spin remains lossy. Pinned WYS also canonicalizes collapsed
  and shortcut references as full `[init][init]` before this carrier, and an
  angle-bracketed definition title was lost in the probed path. The synthetic
  probe was removed after measurement. Direct pre-spin success does not prove
  safe source round-trip, so no visual-only or vendored-Lute repair was applied.
- **Sol-max attempt 2, unproven paired-adapter hypothesis:** Keep whole authored
  reference-use metadata in a pure source index. A WYS render adapter would
  decorate only source/Lute-proven nodes; a paired DOM-to-Markdown adapter would
  clone those nodes to collision-free first-child tokens, let the pinned reader
  serialize, then replace only verified tokens with the exact authored uses.
  For a WYS spin, derive Markdown through that paired reader and re-render it
  through the paired Markdown-to-DOM adapter; use raw spin when no references
  are present. Host initial WYS prerender must share the same repair. Definition
  lines, including titles, may be restored only after first-winner, order,
  destination, and title identity are proved against Lute.
- **Attempt 2 gate:** Disposable pinned-Lute probes must compare raw
  `SpinVditorDOM(block + definitions)` with the proposed paired route through
  two spins, including `<wbr>` before/inside references, edited definitions,
  all reference forms and inline formats, duplicate uses, title quote styles,
  angle destinations, and CRLF. A collision, caret or IME disruption,
  lossy title/form, stale metadata acceptance, or any mutation/host post after
  tampering ends this route without product edits and returns evidence for
  another reasoning pass. Visual presentation, reference-aware editing, host
  activation, and real-VS-Code acceptance remain open.
- **Attempt 2 probe failed before product mutation:** On actual WYS
  block-plus-definition input, cloning the reference to a collision-free token
  made raw `VditorDOM2Md` emit `[TOKEN][init]`; exact token substitution restored
  the authored `` [`init`][init] `` in the probe. But
  `Md2VditorDOM(restoredMarkdown)` still emitted an empty code-reference span.
  A `<wbr>` placed before or inside the reference disappeared in the paired
  DOM-to-Markdown/rerender path; raw `SpinVditorDOM` retained the inside marker.
  The disposable probe was removed. This leaves no proven source-safe way to
  preserve the formatted use and caret through spin. Title restoration,
  stale/tampered metadata rejection, edited definitions, and the wider
  full/collapsed/shortcut/format/duplicate/CRLF matrix were not run after this
  first caret/render gate failed. A bounded Astra-xhigh assessment is needed
  before any vendored-Go or shared DOM change.

## Required verification

- [ ] RED/GREEN unit coverage against the real vendored Lute DOM for full, collapsed, and shortcut
      references; code-formatted labels; case-insensitive resolution; titles and escaped or
      parenthesized destinations; duplicate, missing, and malformed definitions.
- [ ] Chromium coverage in IR and WYSIWYG for inactive presentation, caret-driven syntax/definition
      reveal and dismissal, editing, modifier-policy activation, exactly one host post, keyboard and
      screen-reader access, and no layout jump when definitions hide or reveal.
- [ ] One focused no-retry real-VS-Code journey opens the reported C# fixture, confirms one linked
      `init` label with no source-like definition row in reading state, edits the destination, follows
      it through the host route, saves/reopens, and proves exact expected Markdown plus one-step
      undo/redo.
- [ ] Regression coverage retains Task 240's title/order/case fidelity and Task 542's split-source
      activation. Run build, applicable typechecks, focused changed-line coverage, budgets, lint, and
      one final quality gate before closure.

## Out of scope

- Reference-label or path autocomplete (Task 32), hover previews (Task 210), or redesigning all link
  editing independently of Task 297.
- Changing Preview output, inlining destinations, rewriting reference definitions, or hiding
  unresolved syntax as if it were a valid link.
