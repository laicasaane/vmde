# Task 622 — Move Block returns `stale` after an edit and its Undo

**Status:** Closed — merged into [Task 607](607-exact-actions-after-trusted-edit.md) (Owner, 2026-10-08); covered by `Move Block Down and Up move after an edit and its Undo, fresh moves are unchanged, a real mismatch stays stale` in test/vscode-e2e/exact-actions-after-trusted-edit.spec.ts (31c38fee).

The Project Owner decided to fold this into Task 607's exact-source authority recovery, because Move Block's `stale` result has the suspected same cause (a trusted edit drops the exact transaction). The measured evidence, reproduction, suspected cause, tests and acceptance now live in Task 607 under "Merged from Task 622 (2026-10-08)".
