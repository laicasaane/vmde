# Task 661 — Settle the toolbar flow after resize and check placeholder sizing

**Status:** open.
**Origin:** Project Owner request (known issue from Task 642).
**Severity:** low.
**Tech stack:** webview toolbar flow, instant-paint placeholder, and row gap measurement; real VS Code for resize behaviour.
**Related:** [Task 642](done/642-toolbar-layout-follow-ups.md) (toolbar layout follow-ups).

## Problem

1. Right after a resize, the flow may still be placing controls. An icon in a moving control measured 0 px in a real-VS-Code test.
2. The instant-paint placeholder uses the wiki-off one-row threshold (1,076 px). Wiki documents need 1,143 px.
3. The row gap measures 2.0 px at device pixel ratio 1. The target is 2.4 ± 1 px.

## Requirements

1. No visible flash or empty frame appears after a resize. The flow settles before controls are shown.
2. Wiki documents never receive the overlay, or the placeholder is sized per document.
3. The row gap is confirmed at device pixel ratio 2 and meets the target of 2.4 ± 1 px.

## Open design points

- Whether wiki documents are excluded from the overlay or the placeholder is sized per document: to be decided in Part 1.
- To be settled in Part 1 for the other points.

## Scope

- In: the resize flow, the instant-paint placeholder threshold, and the row gap check.
- Out: toolbar behaviour not named above.

## Acceptance

- [ ] After a resize, no visible flash or empty frame appears, and no control measures 0 px because it is still moving.
- [ ] Wiki documents never receive the overlay, or the placeholder size matches their threshold of 1,143 px.
- [ ] The row gap is within 2.4 ± 1 px at device pixel ratio 1 and at device pixel ratio 2.

## Tests

- Real-VS-Code verification for the resize flow, and measurement at device pixel ratio 1 and 2. Exact specs are to be specified in Part 1.
