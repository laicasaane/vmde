# Task 609 — Restore caret offsets on the intended side of marker boundaries

**Status:** planned (2026-09-29). No implementation or interaction policy is approved.
**Origin:** follow-up to [Task 600](done/600-no-blockless-caret-in-ir.md); coordinate with [Task 597](597-undo-restore-caret-without-marker.md) and [Task 608](608-remaining-blockless-caret-routes.md).
**Scope:** caret restoration at text-node boundaries. Preserve Task 600's fence-info exemption and Task 597's separate root/missing-marker restore work unless measurement shows a shared cause.

## Problem

`resolveBlockOffset` and `resolveTextOffset` accept `node.data.length >= remaining`. At a tie between adjacent text nodes, the restore can choose the end of the preceding Markdown marker instead of the start of content. A live caret intent can then keep reasserting that landing.

## Measured evidence

- `tmp/task600-checks/opus-t1-consult.md` traces Vditor's 800 ms opening Undo checkpoint through `addToUndoStack` → `addCaret` → the patched `vmdeCaretBlockOffset` → `resolveBlockOffset` (`media-src/src/editing/caret.ts:186-219`). A heading's `# ` marker and following text both represent block offset 2; the `>=` at line 210 resolves to `# `@2. The writer and cold-versus-warm timing remain a source-based diagnosis, not a completed native attribution probe.
- `tmp/task600-reg-bubble/report.md` reproduces a Turn Into conversion to a code fence with real Lute and the caret authority in jsdom. The content-start flat offset 4 resolves through `resolveTextOffset` to preceding fence-info ZWSP@1. On current code, the live intent reasserts that position after a programmatic selection of the next paragraph; a pointer gesture invalidates it. Browser paint and the user-visible editing effect are unmeasured.

## Affected modes

- **IR:** both supplied routes are measured or diagnosed here; confirm their native behavior.
- **WYSIWYG/SV:** the shared resolver may serve their restore paths, but no equivalent marker-boundary outcome is established. Measure before extending the change.

## Candidate approaches

1. Make boundary ties prefer the following content text when it is a valid, paintable position in the same logical block; retain end-of-block and empty-block behavior.
2. Carry an explicit affinity or node-relative intent from capture to restore, avoiding a guess from a flat or block offset when the boundary has multiple DOM representations.
3. Normalize only confirmed marker landings at the caller, if changing shared offset semantics would disturb existing caret contracts.

## Owner decisions needed

- Should a restore at a marker/content boundary prefer the content start, and which intentional marker-edit gestures must retain marker access?
- Should a programmatic selection without a user gesture supersede an active caret intent? The supplied bubble failure alone does not settle that shared authority rule.
- Which modes and restore writers should be included after the native measurements?

## Tests

- Unit cases for both resolvers at marker/content ties, mid-text positions, empty nodes, empty blocks, final text ends and block paths that clamp after a DOM spin.
- Chromium coverage for heading and fence-info restore, caret paintability, intentional visible-marker editing and selection-intent lifetime.
- Build first, then focused real-VS-Code XTEST coverage for the opening-checkpoint and Turn Into routes. Record the actual writer, selection, next typing result and exact host bytes without retrying placement.

## Acceptance

- [ ] Each reproduced boundary restores to the Owner-approved editable position without inserting text into a hidden marker or changing Markdown during restoration.
- [ ] Intentional visible-marker editing, empty-block landings and existing Undo/root fallback behavior remain intact.
- [ ] Focused Chromium and real-VS-Code results establish the affected modes and exact host/Undo behavior; unmeasured modes remain explicitly open.
