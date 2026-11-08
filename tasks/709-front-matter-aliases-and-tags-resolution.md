# Task 709 — Front-matter `aliases:` and `tags:` resolution

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 207](done/207-frontmatter-properties-aliases.md) at its closure. Task 207 shipped the properties table; its alias and tag scope moved here unchanged.
**Severity:** medium (estimated). A page reachable in Obsidian through a declared alias shows as a missing page here, and front-matter `tags:` are invisible to any tag index.
**Tech stack:** `src/wiki.ts` (`WikiCache`), `src/shared/front-matter.ts` (the front-matter parser Task 207 added), wiki chip resolution and the `[[` hint list.
**Depends on:** none. Task 205 (tag index) is optional: if it is not shipped, store and expose the tags.

## Problem

`WikiCache` keys come only from file paths (`src/wiki.ts`), so an alias declared in front matter does not resolve, and `tags:` are not read.

## Scope

- [ ] Host: extract `aliases` and `tags` (list or scalar) from the first front-matter block. Reuse the Task 207 parser where it fits. Malformed YAML skips the file's metadata and never errors the scan.
- [ ] `WikiCache`: alias keys join the path-derived keys (normalized with `normalizeWikiLookupKey`). Ambiguity is handled like duplicate filenames (the existing picker). Re-parse on save and watch events.
- [ ] `tags:` feed Task 205's index (if 205 is not shipped, store and expose them; do not block).
- [ ] Chip resolution and the `[[` hint list include aliases (the hint shows `alias → file`).
- [ ] Rename-refactor interplay (Task 202): an alias-resolved link is NOT rewritten on file rename (the alias still resolves). Pin this.

## Out of scope

- Alias write-side tooling, arbitrary property queries (Task 105), Front Matter CMS vault surfaces.

## Verification

- L1 backend: extractor unit (list, scalar, missing, malformed), cache-key merge, ambiguity, incremental update on an alias edit.
- L2: a `[[Some Alias]]` chip renders resolved when a fixture declares the alias.
- L3 real VS Code (mandatory): clicking an alias chip opens the declaring file; the hint offers the alias.
