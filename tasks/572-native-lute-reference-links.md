# Task 572 — Lossless reference-style links through a native Lute repair

**Status:** deferred — future queue; Part 1 interrupted · **Impact:** 🟠 common technical-document authoring gap · **Origin:** Project Owner supersession of [Task 550](done/550-reference-style-link-editing.md), 2026-09-25 · **Related:** Tasks 32, 62, 240, 297, 542, and 570

## Queue state

Moved to `LOCAL_AGENT_TASK_FUTURE.md` by Project Owner direction on 2026-09-25. A newly started Sol-max reasoning lane was interrupted before a handoff; no implementation or acceptance has occurred. Resume only when explicitly requested.

## Goal and inherited acceptance

Complete the reference-style link feature left unaccepted by Task 550. Its [reported C# fixture, implementation contract, toolbar requirements, and verification checklist](done/550-reference-style-link-editing.md) are incorporated here as acceptance criteria. A completed Task 550 source-definition index (`6a9f4ba6`) may be reused, but its uncompleted checkboxes are not evidence of delivery. Preserve exact full `[text][label]`, collapsed `[label][]`, and shortcut `[label]` forms, rich label formatting, authored definitions and title bytes, caret/IME, source mode behavior, one-step history, and the secure modifier-open route. Deliver IR and WYSIWYG presentation, caret-driven reveal/editing, shared-definition Link action, Chromium and focused real-VS-Code checks. Do not silently narrow this task to an engine spike.

## Native Lute investigation and gate

The Astra-xhigh read-only Task 550 handoff found that pinned Lute's parser loses full/collapsed/shortcut source form, WYS `renderLink` reads only the first `NodeLinkText`, its reverse reader reads `FirstChild.Data`, and native Spin owns caret markers. Two distinct Sol-max proposed JS repairs failed direct probes: a first-text carrier lost rich labels through Spin, and paired token substitution still rerendered the formatted label empty and dropped `<wbr>`. The failed probes were removed; see Task 550 for evidence.

- [ ] Make an isolated, reproducible candidate against pinned Lute commit `8928f1866da3269aed613288afb3554985df94e1`. Record checkout, source diff, compiler/toolchain provenance, old/new artifact hashes, and an artifact reproduction command. Determine whether the checked-in Go 1.26 module and shipped Go 1.21.13 blob can be reproduced locally before selecting a delivery path. Do not replace the pinned vendor blob on inference alone.
- [ ] Scope native parser AST retention of authored reference form, rich WYS renderer and DOM-to-Markdown reader, IR/format renderers as needed, definitions/title bytes and Lute's internal Spin caret path. Keep ordinary links and source/Preview semantics intact.
- [ ] Prove direct old/new native-Lute behavior through two Spins, DOM-to-Markdown, caret markers before/inside uses, full/collapsed/shortcut forms, code/emphasis/strong/escaped labels, duplicate and missing definitions, edited destinations, quote/angle title forms, CRLF, malformed/tampered/stale inputs, and host prerender parity. Fail closed on any unproved identity or source change.
- [ ] Present the concrete candidate, provenance, artifact delta, and options for a maintained local fork versus an upstream commit to the Project Owner if that material delivery choice remains. Integrate only the approved or otherwise established delivery path.

## Product implementation and validation

- [ ] Complete every still-open Task 550 implementation and toolbar requirement: a single linked rich label in inactive IR/WYS state, source-faithful definition treatment, caret-driven syntax reveal, reference-aware shared-definition editing, ordinary Link action elsewhere, and exactly one secure host activation under the configured modifier policy.
- [ ] Cover the Task 550 required unit, Chromium, and no-retry real-VS-Code fixture journey, including destination edit, save/reopen, exact Markdown and Undo/Redo; run `node build.mjs` before real VS Code. Preserve Task 240 title/order/case and Task 542 source activation regressions.
- [ ] Run applicable typechecks, focused changed-line coverage, size/budget measurement, lint, and final `npm run quality`; report unrelated or environmental failures precisely. Update this record and `tasks/README.md` only when acceptance is actually complete. Make focused local commits; do not push.

## Dependencies and scope

Tasks 297, 570 and 571 are complete; reuse their link UI, placement and toolbar layout. Task 220 is complete; preserve its Preview checkbox and real-VS-Code behavior while implementing this independent reference-link work. Task 32 and optional GitHub-link work depend on this task's reference semantics. Reference/path autocomplete, hover previews, and unrelated link redesign remain out of scope.
