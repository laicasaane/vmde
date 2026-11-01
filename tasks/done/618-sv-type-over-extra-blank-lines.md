# Task 618 — SV type-over of a whole-document selection leaves extra blank lines

**Status:** Closed — merged into [Task 619](619-sv-line-start-delete-joins-previous-line.md) (Owner, 2026-10-08); covered by `sv: type-over of a whole-document selection gives X, with and without a pending snapshot` in test/vscode-e2e/sv-line-start-edit.spec.ts (4317eebc).

The Project Owner decided to handle the selection start and end endpoints together, because both defects come from the SV newline spans. The measured evidence, reproduction, suspected cause, tests and acceptance now live in Task 619 under "Merged from Task 618 (2026-10-08)".
