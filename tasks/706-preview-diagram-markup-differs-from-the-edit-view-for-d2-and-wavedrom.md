# Task 706 — Preview diagram markup differs from the edit view for d2 and wavedrom

**Status:** planned (2026-11-08).
**Origin:** Split from [Task 697](done/697-preview-and-diagram-renders-do-not-settle-in-the-preview-pane.md). After the Task 697 test fix, three real-VS-Code cases still fail on markup comparison only; the cause is in product code, not in the specs.
**Severity:** low-medium (estimated). Markup and render-reuse parity between the Preview and the edit view. Likely invisible to the reader unless a d2 mask id collides, or the missing wavedrom reuse costs time on large documents.
**Tech stack:** Preview route `renderHeavyBlock` in `media-src/src/editing/preview-render.ts` against the IR render; render cache in `media-src/src/diagrams/render-cache-client.ts` (`data-vmde-cache-hit`); d2 mask id suffix in `media-src/src/diagrams/d2/d2-svg-paths.ts` (comment at line 532); wavedrom engine in `media-src/src/diagrams/engines/wavedrom.ts`; specs `test/vscode-e2e/mode-switch-render-reuse.spec.ts` and `test/vscode-e2e/wysiwyg-parity.spec.ts`.
**Depends on:** none.

## Problem

Run of 2026-11-08 after the rebase onto `dev` `5559608c`: 9 spec files, `--workers=1 --retries=0`, 15 cases passed and 3 failed (7.2 min). The failing cases are the same as in the Part 2 GREEN run of Task 697:

- `mode-switch-render-reuse.spec.ts:210`
- `mode-switch-render-reuse.spec.ts:361`
- `wysiwyg-parity.spec.ts:160`

All three fail on the markup comparison only. Render-ready waits and pair counts pass. Two diffs, measured but not explained:

1. **d2 mask id.** The mask id differs by the `-vm` suffix between the compared renders (`d2#10`, `d2#11`). The Preview side shows `data-vmde-cache-hit=1`. `d2#11` (IR against WYSIWYG) already fails at `32d6bf84`, the parent of Task 643, so this diff is older than the Preview render rewrite. `d2#10` (WYSIWYG against Preview) appears only after the Preview render is complete.
2. **wavedrom (`#0` to `#3`).** The Preview markup has no `<div>` wrapper that the edit view output has. `data-vmde-cache-hit` is null, so the Preview does not reuse the cached render.

These are measured locations. The causes are not known.

## Proposed work

1. Write a failing test first for each diff (see "Tests to write").
2. Find why the d2 mask id suffix differs between the renders: compare the suffix source in `d2-svg-paths.ts` with the Preview `renderHeavyBlock` call and with the cache-hit path that restores stored markup.
3. Find why the wavedrom Preview output has no wrapper and skips reuse: compare the `renderHeavyBlock` route with the IR render route and with the wavedrom engine and cache key.
4. Fix the product cause. Change a spec only if the specs, not the product, are wrong (state which, with evidence).

## Acceptance

- [ ] `mode-switch-render-reuse.spec.ts:210` and `:361` and `wysiwyg-parity.spec.ts:160` pass in one real-VS-Code run.
- [ ] A focused test fails before and passes after the fix, for the d2 mask id and for the wavedrom wrapper and reuse.
- [ ] `npm run quality` passes.

## Tests to write

- Vitest: the d2 mask id for a Preview render equals the id of the same source rendered by the IR route, or the exact difference is specified.
- Vitest: the wavedrom Preview render has the same wrapper and takes the cache hit that the IR render takes.
- The three real-VS-Code cases above are the acceptance tests.
