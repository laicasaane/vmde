# Task 207 — Front-matter properties: `aliases:` + `tags:` resolution, properties table rendering

**Status:** planned · **Impact:** 🟡 med · **Origin:** task 192 §3; properties table added by the Owner on 2026-11-08

## Problem

Zero host-side front-matter parsing. `WikiCache` keys come only from file paths
(`src/wiki.ts:58-64`), so a page reachable in Obsidian via a declared alias shows as a
*missing* page here; front-matter `tags:` are invisible to any tag index. (Rendering-wise
front matter round-trips as an editable yaml block, verified. The Owner asked on 2026-11-08 for
a rendered properties table; see "Properties table rendering" below.)

## Scope

- [ ] Host: lightweight front-matter extractor (first `---` block, YAML subset:
      `aliases`/`tags` as list or scalar; tolerate malformed YAML by skipping the file's
      metadata, never erroring the scan).
- [ ] `WikiCache`: alias keys join the path-derived keys (normalized via
      `normalizeWikiLookupKey`); ambiguity handling identical to duplicate filenames
      (existing picker). Incremental: re-parse on save/watch events.
- [ ] `tags:` feed task 205's index (if 205 unshipped, store and expose; don't block).
- [ ] Chip resolution + `[[` hint list include aliases (hint shows `alias → file` hint text).
- [ ] Rename-refactor interplay (task 202): alias-resolved links must NOT be rewritten on
      file rename (the alias still resolves) — pin this.

## Follow-ups (added 2026-07-03 — the Front Matter CMS slices worth having natively)

Front Matter CMS (eliostruyf, ~74.5K installs) is whole-vault CMS tooling that coexists
fine with VMDE — do NOT reimplement its dashboard/taxonomy/media surfaces. The three
slices that fit a document editor, as extensions of this task's parsing:
- [ ] `draft: true` / future-`date` badge in the status bar + a toggle-draft command.
- [ ] Optional title/description length hints (SEO-style) on the front-matter block.
- [ ] `Open on local site` command: map slug/permalink → a configured localhost URL
      pattern (the honest answer to "docusaurus/hugo preview helpers").

## Properties table rendering (Owner request, 2026-11-08)

Render YAML front matter as a vertical two-column table instead of a YAML code block.

- [ ] Column 1 holds the front-matter property (key) names. Column 2 holds the matching values,
      shown without their YAML quotes (`title: "Hello"` shows `Hello`).
- [ ] Each cell (key and value) has a copy button that copies that cell's content to the
      clipboard. The copied text is the displayed text (no quotes).
- [ ] The copy button is an icon only, with no text label. Use a common copy icon: Codicons
      `copy` (CC BY 4.0, same set as the toolbar). Record its use in the notice at
      `media/codicons.LICENSE` and in a source comment, like the existing toolbar icons in
      `media-src/src/chrome/toolbar-icons.ts`. Give the button an accessible name
      (`aria-label`, `title`) because it has no visible label.
- [ ] The copy button always shows on every cell (not only on hover or focus).
- [ ] The copy button is aligned to the right edge of its cell.
- [ ] Both columns reserve enough space (for example right padding at least the button width
      plus a gap) so the copy button never overlaps the cell content, also for long or wrapped
      values and narrow editor widths.
- [ ] The copy button is highlighted on hover (and on keyboard focus).
- [ ] After a click, the button icon changes to a checkmark for 1.5 seconds to confirm the copy,
      then changes back. Use Codicons `check` (CC BY 4.0); record it in the same notice. A second
      click during the 1.5 s restarts the timer.
- [ ] Round-trip safety: the table is a rendered view only. The saved markdown keeps the original
      front-matter bytes unchanged (apply the `vmde-lute-features` skill before injecting DOM).

Decisions (all settled by the Owner on 2026-11-08; ready to plan):

- D1 Modes — SETTLED (Owner, 2026-11-08): the table shows in every rendered surface (IR,
  WYSIWYG, Split preview, Preview pane). In IR and WYSIWYG, the YAML source shows when the caret
  enters the block (click or arrow keys) and the table shows again when the caret leaves, like
  mermaid and math blocks. Source mode stays raw. A click on a copy button must not move the caret
  into the block (for example `preventDefault` on `mousedown`); a real-VS-Code test pins this.
- D2 Non-scalar values — SETTLED (Owner, 2026-11-08): a list shows each item as a chip (or
  line) inside column 2. A nested map shows as a small inner key/value table inside the cell, with
  no copy buttons on the inner cells. A block scalar (`|`, `>`) shows as plain text with its line
  breaks kept. The value copy button copies the whole value without its key: the YAML text of a
  list or map (for example `[a, b]` or the map lines), the plain text of a scalar or block scalar.
- D3 Malformed YAML — SETTLED (Owner, 2026-11-08): when the front matter does not parse (or is
  not YAML, for example TOML between `+++` lines), the block shows as the current YAML code block,
  with a small in-place warning at the block, for example "Front matter could not be parsed:
  <parser message>". Editing works as before. No table, no partial table.

Tests for this section: L1 unit for key/value extraction and quote removal (single, double,
plain, block scalars, lists, malformed); Chromium for layout (no overlap at narrow widths, button
right-aligned, hover style, icon swap and restore after 1.5 s); L3 real-VS-Code (mandatory) for
the table render, clipboard content of a key and a value cell, the checkmark swap, and an
unchanged saved file.

## Out of scope

- A properties editor UI (the properties table is read-only display plus copy), arbitrary property queries (task 105 dataview epic), alias
  WRITE-side tooling, Front Matter CMS's vault surfaces (see above).

## Verification

- L1 backend: extractor unit (list/scalar/missing/malformed), cache-key merge, ambiguity,
  incremental update on alias edit.
- L2: `[[Some Alias]]` chip renders resolved when a fixture declares it.
- L3 real-VS-Code (mandatory): click alias chip opens the declaring file; hint offers the
  alias.
- Properties table: see the tests listed in "Properties table rendering".
