# Task 564 — Fix undefined Undo toolbar label

**Status:** ✅ DONE · **Origin:** user screenshot, 2026-09-06 · **Closed:** 2026-09-06
**Related:** Tasks 505 and 563

## Evidence

The screenshot showed `undefined (Ctrl+Z)` in the overflow menu while Redo was named correctly.
`media-src/src/chrome/toolbar.ts` constructs Undo's tip from `t('undo')`.
`media-src/src/util/lang.ts` has no Undo entry in either its English fallback or Chinese table.
The existing toolbar test checks only the shortcut substring, so it misses the broken label.

## Scope

Add the missing Undo translations and assert the complete Undo/Redo toolbar labels. Retain the
existing keyboard handlers and overflow behavior. This fix is independent of the two-row layout.

## Verification

- [x] Strengthened label assertion fails before the translation fix and passes afterward.
- [x] Focused toolbar suite passes (10 tests); changed TypeScript files pass Biome.
      No separate translation test file matched the requested test filter.
- [x] Build and focused real-VS-Code verification confirm Undo text in overflow and tooltip,
      plus working Undo activation. `node build.mjs` passed; the focused real-VS-Code test passed
      with one worker, asserting `Undo (Ctrl+Z)` inside More, its hovered `::after` tooltip
      content, and that a toolbar click removes a marker from the host `TextDocument`.
- [x] Final network-free quality validation completed: changed translation coverage is 100% for
      lines/statements/functions; the coverage ratchet, Knip, jscpd, and dependency-cruiser
      completed. The Project Owner explicitly waived all dependency and vendor audits for this
      local queue, so audits are intentionally omitted rather than passed.

## Session result

Added English Undo and Chinese 撤销 entries; Japanese/Korean continue to use the English
fallback. The strengthened toolbar test reproduced `undefined (Ctrl+Z)` before the fix and
passed afterward. The focused real-VS-Code regression adds a condition-based opening-undo-stack
readiness check, then proves the overflowed control's complete label and its actual host-document
undo effect. `typecheck:vscode-e2e`, targeted Biome, `git diff --check`, and the build passed.
Task 563 subsequently moved Undo and Redo out of More, so its direct-control test now owns the
current placement and history assertion. This task retains the historical overflow regression
evidence that reproduced the reported label defect. The reviewed candidate is commit `ef81a0a`;
no new commit or push was made during tracker closure.
