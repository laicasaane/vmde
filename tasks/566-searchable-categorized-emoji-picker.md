# Task 566 — Searchable, categorized Emoji 17.0 picker

**Status:** 📋 TODO · **Origin:** user screenshot and requirements, 2026-09-06
**Related:** Tasks 492, 505 and 563

## Problem

The existing Emoji toolbar panel lists only the eight entries from Vditor's default
`hint.emoji` map. `media-src/node_modules/vditor/src/ts/toolbar/Emoji.ts` enumerates that map
without a search field or category sections. Typing a shortcode can query Lute's larger
collection, but that does not make the toolbar a complete, browsable picker.

## Emoji regression transferred from Task 563

The Project Owner explicitly assigned the current picker opening/closing and keyboard/focus
issue to this task, to resolve together with the searchable Emoji 17.0 picker. Task 563 may
close independently while retaining direct Emoji placement in Row 1.

- [ ] Reproduce and resolve premature closing: in the Task 563 real-VS-Code browser-input
      trace, Space reaches the exact focused live Emoji button, a trusted click opens its
      owned panel (`display:none` to `block`, `aria-expanded=true`), and another writer hides
      it about 12 ms later. Only one activation click was observed; the closer is unconfirmed.
- [ ] Verify opening, grid/search interaction, Escape dismissal and the intended focus return
      using OS-level keyboard input in the focused VS Code window, as required by the Project
      Owner. The earlier trusted browser-input trace is diagnostic evidence, not a passing
      OS-keyboard acceptance result. Preserve actual selection and exact insertion/undo behavior.
- [ ] Integrate the regression with the new picker rather than adding a competing activation
      bridge to the old picker. Keep the existing Emoji control visible outside More under the
      owner's Task 563 placement instruction; validate normal and narrow split layouts.

The previous focused reproduction is in `test/vscode-e2e/toolbar-overflow.spec.ts` (the popup
semantics/Emoji keyboard journey). Preserve its essential failing sequence and diagnostic
facts when moving the picker-specific regression into this task's focused spec. Pointer opening
and panel bounds in an actual narrow split already passed after closing a test-instance chat
welcome overlay through normal workbench commands; that overlay failure was test setup.

## Requested experience

Use the supplied Windows emoji-panel screenshot as a layout reference: a prominent search
field at the top, visible category headings, and evenly spaced emoji tiles in a scrollable
grid. Implement this inside VMDE's existing Emoji toolbar entry.

- [ ] **Search box:** focus it on opening; filter by emoji name and keywords, case-insensitively.
      Support useful aliases where available and direct emoji input. Provide a clear-search
      action, accessible label, result count and explicit empty-result state. Clearing restores
      the categorized browser. Search is local and does not send text to a service.
- [ ] **Grid:** consistent tile/hit-target sizes, responsive column count, visible hover/focus,
      and a bounded scroll area. Keep search available while scrolling. Fit narrow split editors
      and zoomed text without clipping or horizontal page scrolling; anchor the panel correctly
      whether the Emoji entry is in a toolbar row or overflow.
- [ ] **Grid background (Project Owner addition, 2026-09-08):** emoji slots have a
      transparent idle background so the existing emoji panel supplies their visible background
      in both light and dark mode. Apply this to category, search, variant and recent tiles;
      grid wrappers and fallback artwork must not introduce opaque tile-shaped backplates.
      Preserve theme-aware hover, pressed and keyboard-focus feedback (including high-contrast
      focus visibility), using the panel's existing theme tokens rather than fixed light/dark
      colors. Switching theme with the picker open updates these surfaces without reopening it.
- [ ] **Recently used (Project Owner addition, 2026-09-08):** show a labeled “Recently used”
      region directly below the search box and before category/search-result sections. Reuse
      the same tile size, transparent idle background, accessible names and insertion behavior.
      Keep it within the bounded scroll layout; search remains available while scrolling and
      recents must not cause horizontal overflow or make the main catalog unreachable.
- [ ] **Categories:** group tiles under visible text headings using Unicode/CLDR group order
      (for example Smileys & Emotion, People & Body, Animals & Nature, Food & Drink,
      Travel & Places, Activities, Objects, Symbols, and Flags). Keep headings associated with
      their tiles for screen readers. Filtered results retain meaningful category labels.
- [ ] **Emoji 17.0:** provide the full recommended emoji repertoire for that version, including
      its newly added emoji and supported modifier, flag, keycap and ZWJ sequences. Variants
      must be discoverable through search and an accessible variant selector or equivalent
      grid treatment; do not silently reduce the catalog to base characters.

The reference is for structure and interaction, not copying Windows artwork or its entire
“Emoji and more” application. GIFs, stickers, clipboard history and non-emoji symbol tabs are
out of scope. Category shortcut icons remain an optional future enhancement. Recently used
emoji are required by the Project Owner's 2026-09-08 addition.

## Recently used behavior and implementation guidelines — 2026-09-08

The following defaults make the requested region concrete and testable:

- [ ] Keep at most 24 distinct exact Unicode sequences, newest successful picker insertion
      first. Selecting an existing recent moves it to the front without duplication; evict the
      oldest when full. Preserve modifiers, variation selectors and ZWJ sequences, treating
      separately selected variants as distinct entries. Ordinary typing/shortcode completion,
      browsing, search, cancellation and rejected/stale/read-only insertion do not add recents.
      Undoing a successful insertion does not erase its usage history.
- [ ] Keep the region visible when empty with “No recently used emoji yet.” Do not seed it
      with popular emoji. With an active search, filter recents using the same matching rules
      as the catalog; show “No matching recently used emoji.” when none match. Clearing search
      restores all recents and categorized browsing. Recents may also appear in their normal
      categories, but the announced catalog result count counts each matching sequence once.
- [ ] Persist the bounded list locally per VS Code profile across picker closure, document
      changes and editor/window restart; do not put it in Markdown, workspace files, telemetry
      or Settings Sync. Store only catalog sequence identifiers in recency order, with a storage
      schema version; no document paths, source text, search terms or timestamps are needed.
      Reuse host-managed extension state and the existing validated host/webview message path;
      do not assume webview localStorage survives editor recreation. Validate and deduplicate
      stored values against the pinned catalog, discard unknown entries and recover safely from
      corrupt data. Storage failure must not prevent insertion or in-session recents.
- [ ] Give the region an accessible heading and use the picker’s existing grid keyboard model.
      Keyboard users can reach recents and continue into catalog results without a trap;
      Enter/Space selects once, Escape dismisses and restores focus. Empty regions introduce
      no tile tab stops. Keep search focus on opening and preserve the saved document selection.
      Reuse tile rendering and the successful insertion path so recents cannot bypass stale
      selection guards, exact Unicode insertion or one-step undo/redo.

These additions extend the open acceptance criteria; the earlier implementation evidence below
does not establish transparent tile backgrounds or recently used behavior as complete.

## Data and rendering contract

- [ ] Pin Unicode Emoji 17.0 data and a compatible, explicitly versioned CLDR annotation source.
      Generate a deterministic local catalog of sequences, names, keywords, groups and variants;
      record provenance, checksums, licenses and a reproducible update command. Do not depend
      on a moving `latest` URL or scrape chart artwork as the production dataset.
- [ ] Derive catalog completeness from the official fully-qualified recommended sequences;
      avoid duplicate entries for alternate qualification forms or standalone components.
      Keep variation selectors, modifiers, regional indicators, tag sequences and ZWJ bytes intact.
- [ ] Separate dataset coverage from font support. An Emoji 17.0 entry must be recognizable in
      the picker even on a host with older emoji fonts. Select and license a bundled local
      fallback artwork/font strategy during implementation; validate its actual 17.0 coverage.
      Preserve platform-independent search names and accessible descriptions.
- [ ] Insert the selected Unicode sequence as text, never an image URL, HTML asset or guessed
      shortcode. Picker fallback artwork must not enter Markdown. Document that document glyph
      appearance can still depend on the reader's installed fonts; do not change document-wide
      emoji rendering as a hidden side effect.
- [ ] Keep runtime operation offline. Lazy-load catalog/artwork and avoid rendering the entire
      catalog eagerly if measurement shows it harms startup, opening or search responsiveness.
      Preserve keyboard/search semantics if using virtualization; record measured costs.

Official sources checked when creating this task:

- [Unicode Emoji 17.0 charts](https://www.unicode.org/emoji/charts-17.0/)
- [Versioned Emoji 17.0 data directory](https://www.unicode.org/Public/17.0.0/emoji/)
- [Emoji 17.0 test repertoire](https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt)

## Toolbar and editing integration

- [ ] Replace the current eight-item panel behind the existing Emoji control. Do not add another
      toolbar button. Coordinate its anchoring and overflow behavior with Task 563, but do not
      require the two-row layout to ship first.
- [ ] Preserve the document selection before moving focus to search. Clicking or pressing Enter
      on a tile replaces that selection once, or inserts at the saved caret; close the picker,
      return editor focus and place the caret after the complete sequence. Do not append an
      unrequested trailing space. Escape/outside dismissal makes no document edit.
- [ ] Support source, IR and WYSIWYG, including inline/code-block text insertion. Keep mutations
      disabled in read-only Preview and handle document/editor changes while the picker is open
      without inserting into a stale selection or a different document.
- [ ] Use accessible search, category and tile names, logical Tab navigation, arrow navigation
      within the grid, Enter/Space activation, Escape dismissal, and reliable focus return.
      Announce search results without excessive updates; ensure light/dark contrast.
- [ ] Keep existing typed-shortcode behavior intact. If sharing the new catalog with autocomplete
      is useful, do not expand this task into a separate shortcode/parser rewrite.

## Verification

- [ ] Unit coverage for recents ordering, deduplication, the 24-entry cap, exact variants,
      filtering, persisted-data validation and storage-failure fallback. Verify that only
      successful picker insertions update history and that undo leaves usage history intact.
- [ ] Chromium coverage for the recents region's position, empty/populated/filtered states,
      unique result counts, keyboard traversal and insertion, clear-search restoration, and
      narrow/zoomed scrolling. Assert transparent idle tile/wrapper backgrounds and inspect
      hover/focus feedback across category, search, variant and recent tiles.
- [ ] Build first and run a focused real-VS-Code spec under xvfb for recent selection through
      pointer and OS-level keyboard input, exact source insertion/undo/redo, cross-document
      reuse and persistence after editor/window recreation. Inspect light/dark screenshots,
      a live theme switch with the picker open and high-contrast focus visibility; include
      fallback artwork to catch opaque backplates. Record these as new evidence separately
      from the earlier picker checks.
- [ ] Catalog checks compare exact sequence sets against the pinned official data, validate
      categories/annotations and variants, and include representative additions from 17.0.
- [ ] Unit coverage for search/ranking, aliases, no results, variant lookup and exact insertion
      strings; ensure sequences are never split by code-point or UTF-16 indexing mistakes.
- [ ] Chromium coverage for categorized browsing, search/clear, scrolling, narrow widths,
      keyboard/variant selection, focus restoration, cancellation and one-step undo/redo.
- [ ] Build first, then a focused real-VS-Code spec under xvfb opens the real toolbar picker,
      searches and selects an Emoji 17.0 entry, replaces a selection, saves/reopens and asserts
      exact Markdown bytes. Cover overflow placement, supported modes and undo/redo.
- [ ] Inspect light/dark screenshots against the supplied layout reference and verify fallback
      glyph rendering on a host without native 17.0 font coverage.
- [ ] Record catalog/artwork size and startup/open/search cost; run applicable focused gates and
      final quality validation per DEVELOPMENT.md before closure.

## Implementation record — 2026-09-07

Part 1 used Astra medium for investigation; Part 2 used Terra high for implementation and
validation. The tracked feature base is `5993d12`; the Part 2 follow-up deliberately preserved the
existing dirty picker/CSS/e2e work and did not alter either local queue file.

- [x] The original Vditor `Emoji.ts` panel listeners were confirmed as the concrete hover/Clear
      failure: replacing only children left its mouseover listener reading the removed tip and its
      click listener reading a missing `data-value`. VMDE now replaces the panel node shallowly,
      retaining its placement/CSS hooks while owning all picker events.
- [x] The cloned node is now observed locally for `style` changes, so overflow's generic panel
      dismissal also updates the Emoji trigger's `aria-expanded` state.
- [x] Selection replacement records pre- and post-insertion Vditor history around literal Unicode
      insertion and follows Vditor's mode-specific post-render/writeback path. Chromium covers one
      undo and redo transaction.
- [x] Real VS Code evidence: focused `workbox.keyboard.press('Space')` opened the picker, focused
      search, and recorded precisely one panel style writer (`block`), with no immediate `none`
      writer in that journey.

Focused evidence actually run:

- `node build.mjs` (pass), `npm run typecheck`, `npm run typecheck:strict`, and
  `npm run typecheck:vscode-e2e` (pass).
- Focused Chromium picker checks (hover/Clear ownership; overflow ARIA; categorized/search/arrow;
  selection and toolbar undo/redo) (pass).
- `env -u ELECTRON_RUN_AS_NODE xvfb-run -a npm --prefix test/vscode-e2e test --
  toolbar-overflow.spec.ts --grep "emoji/headings/edit-mode advertise"` (pass; real VS Code Space
  input trace).

## Recents and keyboard follow-up — 2026-09-08

- [x] Recent selections now post only their exact sequence after the literal editor insertion has
      completed. The host validates it against the shipped pinned catalog, promotes/deduplicates
      the canonical 24-entry list in a serialized profile-store transaction, then sends the state
      to every ready editor. Invalid messages, stale/read-only/rejected insertions, typing and
      cancellation do not promote history; a profile-store failure leaves the completed editor edit
      and in-session recent list intact.
- [x] Backend coverage validates corrupt/unknown persisted data, exact variants, canonical ordering,
      concurrent editor promotions and ready-editor synchronization.
- [x] The picker now applies host recent updates while open, maintains transparent idle recent tiles,
      enters the first catalog tile from a short recent grid without skipping a row, scrolls the
      bounded results region for Arrow/Home/End focus, and resets a previous narrow-view transform
      before reopening measurement.
- [x] Focused Chromium evidence: `toolbar-overflow.spec.ts --grep "emoji owns a searchable
      dialog|transparent tiles and promotes|retains its narrow viewport correction"` (3 passed).
      This covers keyboard focus visibility, recents empty/populated/filter states, transparent
      idle tiles, recent-to-catalog traversal, storage-failure fallback, narrow scrolling and reopen
      bounds.
- [x] Focused real-VS-Code evidence after `node build.mjs`: `toolbar-overflow.spec.ts --grep
      "emoji/headings/edit-mode advertise"` passed with real Electron `workbox.keyboard.press('Space')`;
      `--grep "Emoji 17 pointer"` passed exact insertion, save/reopen, focused OS-keyboard recent
      selection and one-step undo/redo. These needed escalated Xvfb because the managed sandbox
      denies Electron's sandbox-host shutdown operation.
- [x] Focused backend (`emoji-recents` and `editor-session`, 17 tests), Biome checks for touched
      files, and `typecheck` / `typecheck:strict` / `typecheck:vscode-e2e` passed.

This task remains **TODO**. The required exhaustive exact catalog-integrity backend check, full
categorized code-block/source-IR-WYS real-VS-Code matrix, fallback-font Emoji 17 coverage evidence,
visual light/dark/high-contrast inspection, and package/startup budget resolution remain open.
Current builds report `media/dist/main.js` at 692.6 KB and the existing startup budget remains
unresolved, so no aggregate quality claim is made.

## Blocker — 2026-09-08

The focused real-VS-Code WYSIWYG code-block journey selects `replace`, opens the picker, and then
inserts the chosen sequence before the document instead of replacing that selection. The diagnostic
first exposed mode, fixture-reuse, selection-setup, and async-search-focus races; the corresponding
test-only corrections were made separately. The remaining symptom persisted after three isolated
capture-lifetime hypotheses (preserving the earliest pointer capture, retaining it through picker
open, and mutating its clone directly), so the experiments were discarded rather than shipped.
Resolve the Vditor WYSIWYG range/toolbar focus ownership architecture before resuming the full mode
matrix. This does not invalidate the existing IR pointer/save-reopen and OS-keyboard recent evidence.

## WYSIWYG code-source range regression — 2026-09-08

- [x] The focused real-VS-Code WYSIWYG code-block regression is restored. It switches through
      Vditor's edit-mode control, enters the editable `pre.vditor-wysiwyg__pre > code` source
      instead of its `data-render` preview, selects the exact plain-JavaScript `replace` text,
      and verifies `🫪` replaces only that source range.
- [x] One temporary target-scoped `innerHTML` setter trace identified VMDE's WYSIWYG syntax
      highlighter as the first source writer after the selection change; the diagnostic was removed.
      The highlighter had used token-span presence as its cache proof, but highlighting a plain
      identifier produces no span, so it rewrote equivalent source DOM and degraded retained live
      ranges. Its cache now compares the exact markup it applied alongside language and text; a
      Vditor raw-DOM rebuild still differs and is re-highlighted.
- [x] The focused unit regression was red before the correction (two writes after one selection
      change) and green after it (one write). The focused Chromium emoji suite and focused real
      VS Code WYSIWYG regression pass after a fresh build.

Remaining TODO acceptance remains unchanged: the exhaustive all-mode prose/inline/code-block
real-VS-Code matrix, fresh fallback-glyph and light/dark/high-contrast visual inspection, measured
catalog opening/search costs, and a completed packaged-asset validation are not claimed by this
targeted fix. Current size/startup ceilings are still exceeded and were not raised.

## Closure round 1 — 2026-09-08

- [x] A focused real-VS-Code IR journey now covers exact literal picker replacement for prose,
      inline code, and fenced-code source individually, with host-byte assertions and one undo/redo
      step after each selection, followed by save/reopen.
- [ ] The equivalent WYSIWYG/SV real-VS-Code matrix remains blocked by the test harness before any
      picker assertion. Two programmatic edit-mode routes stayed in IR for 20 seconds; the final
      trusted-click route caused the worker to terminate after launch with Playwright
      `status: failed` and no failed-test payload. The check was stopped after three attempts for
      Astra-low investigation rather than treating a harness outcome as a product failure.
- [ ] Fresh light/dark/live-switch/high-contrast/fallback screenshots, timing measurements, and a
      completed fresh VSIX archive validation remain unverified in this closure round. Keep this
      task active; do not move it to `tasks/done` or update the task index.

## Astra-low matrix setup repair — 2026-09-08

- [ ] The matrix now asserts the original value before switching, uses the documented 1500 ms
      pre-click EditMode settle, focuses the active editor before range construction, finds fenced
      source blocks by their exact target instead of first-match order, and enters the matching WYS
      preview source before selection. Scoped format/type checks and a fresh build pass.
- [ ] The repaired WYS/SV runner did not yield a completed test result in the managed execution
      window: after Electron launch, the wrapper left a stale lock and `.last-run.json` reported
      `failed` with no individual failure. Do not count this as product evidence or retry blindly;
      complete it in a runner that can retain the real-VS-Code process to completion, then resume
      OS-XTEST, visual, timing, and VSIX acceptance.
