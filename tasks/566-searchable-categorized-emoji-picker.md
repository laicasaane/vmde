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
out of scope. Category shortcut icons and recents are optional future enhancements, not
acceptance requirements for this task.

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

Session result: task creation only. Minimum validation covers task-number uniqueness,
document structure and whitespace; implementation and runtime verification remain open.
