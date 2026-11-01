# Task 694 — PlantUML loads a third engine instance where at most two are allowed

**Status:** planned (2026-11-02). Filed from the full real-VS-Code gate of queue run 2026-11-01d.
**Origin:** Gate suite on `dc622900` (2026-11-01), confirmed by a rerun of the spec files alone (2026-11-02).
**Severity:** medium (estimated; each extra engine load costs time and memory on documents with mixed PlantUML types).
**Tech stack:** `test/vscode-e2e/plantuml-typeswitch.spec.ts`, `test/vscode-e2e/plantuml-family-matrix.spec.ts`; the PlantUML engine routing (class versus non-class engine, `renderedIsClass`) in `media-src/src/diagrams/plantuml/plantuml-render.ts`.
**Depends on:** none.

## Problem

Four cases fail alone and in the suite:

- `plantuml-typeswitch.spec.ts:17`: 3 engine instances after class and non-class type switches; at most 2 are allowed.
- `plantuml-family-matrix.spec.ts:46`: 8 of 9 diagram families rendered within the wait (2.1 min run).
- `plantuml-family-matrix.spec.ts:161`: the C4 block no longer trips the safety net from a wrapped `A` in its label (expected `true`, received `false`).
- `plantuml-family-matrix.spec.ts:273`: 3 engines where 2 are expected after keywords in note, legend or title bodies.

The cases may share one cause (an extra engine import). Not measured. The first bad commit is unknown.

## Proposed work

1. Find the first bad commit by running both spec files alone on earlier `dev` revisions.
2. Measure which block triggers the third import and why.
3. Fix with a failing test first, or update the test if the expected behavior changed on purpose (cite the task that changed it).

## Acceptance

- [ ] The cause and the first bad commit are recorded.
- [ ] The four cases pass in real VS Code, or a case is updated with a recorded reason.
- [ ] Any product fix has a Vitest regression test.

## Tests to write

- A Vitest case on the engine routing for the triggering block.
