# Task 564 — Fix undefined Undo toolbar label

**Status:** 🚧 IN PROGRESS · **Origin:** user screenshot, 2026-09-06
**Related:** Tasks 505 and 563

## Evidence

The screenshot shows `undefined (Ctrl+Z)` in the overflow menu while Redo is named correctly.
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
- [ ] Final quality validation before task closure. Attempted, but incomplete: `npm audit` could
      not resolve `registry.npmjs.org` (`EAI_AGAIN`). The escalated audit retry was automatically
      rejected because it would send dependency metadata to the registry. The changed translation
      module is 100% line/statement/function-covered; focused escalated reruns cleared each
      sandbox-only coverage failure.

## Session result

Added English Undo and Chinese 撤销 entries; Japanese/Korean continue to use the English
fallback. The strengthened toolbar test reproduced `undefined (Ctrl+Z)` before the fix and
passed afterward. The focused real-VS-Code regression adds a condition-based opening-undo-stack
readiness check, then proves the overflowed control's complete label and its actual host-document
undo effect. `typecheck:vscode-e2e`, targeted Biome, `git diff --check`, and the build passed.
Quality remains blocked only by the audit network/egress gate, so the task remains open and
`tasks/README.md` is unchanged.
