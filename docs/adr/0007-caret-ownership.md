# ADR-0007 — Caret ownership: the caret is a re-asserted intent, not a one-shot write

- **Status:** Accepted
- **Date:** 2026-07-30
- **Tags:** caret, selection, focus, architecture, vditor
- **Related:** task 446 (this ADR's task), task 439 (the bug that forced it), task 445 (the sibling
  symptom), task 389 (`media-src/src/focus-restore.ts`), task 100 (`hr-nav.ts`, retired into `gap-nav.ts` by task 292), task 428
  (`list-backspace.ts`), ADR-0004 (patching Vditor), `media-src/src/gap-paragraph.ts` (the existing,
  working "declare an invariant and re-assert it" precedent).

## Context

Vditor rebuilds the IR/WYSIWYG DOM constantly — on every edit it re-spins the affected block, and it
creates some structure lazily (an empty document's editable has **zero element children** until the
user types). Anything we write into the DOM has to survive that; the codebase learned this years ago
for *structure* — `observeTrailingParagraph` re-asserts its paragraph after every rebuild precisely
because a one-shot insert does not survive.

**The caret never got the same treatment**, and the cost showed up twice in one day:

- **Task 439.** We placed a caret at document start on open. It was measurably in the right place —
  collapsed, right container, right offset — and **invisible**, because the Range was anchored on an
  empty container and a collapsed Range in an empty container has a **zero-height client rect**.
  Three test layers passed against a build that did not work, because all three asked *"is the Range
  there?"* and none asked *"can a caret be drawn?"*.
- **Task 445.** The user reports the first click into the editor loses the caret and only the second
  one sticks. Four rounds of probing have failed to reproduce it in the harness. It is unowned: no
  module is responsible for "the caret should be here and should stay here".

Today at least six modules write `window.getSelection()` directly, each with its own rules about when
a write is allowed and none aware of the others: `initial-caret.ts`, `focus-restore.ts`,
`editor-caret.ts`, `caret-preserve.ts`, `gap-paragraph.ts` (`placeCaretInTrailing` + the
keydown/keyup trailing-nav net), `hr-nav.ts` (now `gap-nav.ts`). Three of them independently hand-roll the same idea —
*snapshot the caret, notice it was lost, put it back* — with three different trigger sets and three
different sets of edge cases.

Vditor offers nothing to delegate to: its `focus()` is literally `this.vditor.ir.element.focus()`,
with no caret placement at all.

## Decision

**1. The caret is an INVARIANT, not an event outcome.** A programmatic caret placement declares an
*intent* ("the caret belongs at X"), and the owner re-asserts that intent across DOM rebuilds until
it is consumed or invalidated. One-shot `removeAllRanges()/addRange()` writes into a DOM that Vditor
is about to rebuild are the defect class this ADR exists to close.

**2. A single owner.** One module owns every *programmatic* selection write. Other modules declare
intent through it; they do not touch `getSelection()` themselves. The three hand-rolled re-assert
copies collapse into it. **If they cannot collapse into it, the abstraction is wrong and must be
redesigned rather than bolted on** — that is the acceptance test for the design, not a nice-to-have.

**2a. Deliberate writes are marked (task 664).** A live intent is re-asserted on every frame, so a
selection written elsewhere without `requestCaret` is overwritten while an intent is live. The
authority therefore exports two helpers for the Selection writes that are not intents:
`writeSelection` retires the live intent and then writes (a deliberate selection by VMDE code), and
`writeSelectionKeepingIntent` writes and leaves the intent armed (a save-and-restore of a selection
read earlier in the same operation). Vditor's own undo and spin writes use neither, so they stay
overridden. The helpers live in `util/selection-write.ts` (the authority registers its intent retirer there), so every module can use them without a new module edge. A test over the webview source forbids raw Selection writes outside the authority.

**3. A real user gesture always wins.** The authority yields immediately and unconditionally to the
user: any keydown, any pointer-driven selection change, any input. A caret that fights the user is
strictly worse than the bug this ADR is closing, so the invalidation rule is the safety-critical part
of the design and is written to fail *open* (drop the intent when unsure) rather than closed.

**4. Placement must be PAINTABLE, not merely correct.** An intent resolves to a position whose
collapsed Range has non-zero client-rect height. Where no such position exists, the owner is
responsible for making one — which means document-shape invariants ("there is always at least one
editable block", the leading counterpart to the existing trailing-paragraph invariant) belong with
the shape owner (`gap-paragraph.ts`), **not** as special cases inside caret code.

**5. Every caret test asserts paint, not just position.** `caretHeight > 0` (or an equivalent) is
mandatory in any test that claims a caret is placed. A test that only checks container/offset is
known-insufficient — it passed against a shipped-broken build.

## Consequences

- **Positive.** The "programmatic caret lost because the DOM was rebuilt under it" class disappears
  rather than being patched per site. Three duplicate re-assert implementations become one. New
  caret-moving features (EOF nav, `hr` step-across, list outdent, mode-switch preserve) declare
  intent instead of each re-deriving when a write is safe.
- **Negative / risk.** The migration touches end-of-file navigation, list Backspace, `hr` arrow-nav,
  the table-wrapper jump fix, mode-switch preservation and focus restore — every one of them a bug
  that was expensive to find and is currently pinned by real-VS-Code specs. Those specs are the
  contract: they must pass **unchanged**. This is why the work is staged (invariant first, authority
  second) and why the full real-VS-Code suite is a merge gate for it.
- **Cost.** The authority adds an observer and a small state machine to every open. Both are cheap,
  but the state machine's correctness is where the risk lives, so it carries exhaustive unit tests —
  it is pure logic and does not need a webview to test.

## Alternatives rejected

- **Keep one-shot writes, fix each site as it breaks.** This is the status quo that produced 439 and
  three duplicate repair implementations. It scales with the number of call sites, and each fix is
  invisible to the others.
- **Let Vditor own it.** Nothing to own it with (`focus()` is a bare `element.focus()`), and forking
  Vditor for this would trip ADR-0004's fork trigger for a problem we can solve on our side.
- **Re-assert unconditionally (no invalidation).** Simplest to implement and the worst outcome for
  the user: a caret that returns after they move it. Rejected outright; see decision 3.
