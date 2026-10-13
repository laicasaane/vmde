# Task 636 — Slow open of a local markdown file under the Owner's real VS Code profile

**Status:** planned (2026-10-14). The Project Owner requested this task on 2026-10-14. Implementation has not started.
**Origin:** Project Owner report (chat, 2026-10-14).
**Severity:** high (estimated). Opening one ordinary file takes a very long time in daily use.
**Tech stack:** extension host (`src/app/`, `src/session/`, `src/webview-host/`), webview boot (`media-src/src/boot/`), Lute host prerender, real VS Code with the Owner's own profile.
**Local material:** environment details, absolute paths, the file under test, profile settings, extension lists and raw logs/profiles live in an untracked local companion file under the ignored `tmp/` folder. That file is never committed. This record holds only redacted findings.

## Problem

With the repository folder open in VS Code, opening one untracked local markdown file in the workspace root (about 60 KB, about 600 lines of headings, lists, tables and long lines) with VMDE takes a very long time. Earlier performance tasks (for example Tasks 529, 534, 538, 573, 574, 578) measured with the isolated test profile and synthetic fixtures; the Owner reports that they did not improve this daily experience as much as expected.

## Owner decisions (2026-10-14, chat)

- Investigate with a real VS Code instance that uses the Owner's own profile, settings and extensions intact. Do not use the isolated test profile for this investigation or for its acceptance measurements.
- The task's material is split in two:
  - Public (this record, committed): redacted findings, relative repository paths, timings, cause and fix. No absolute paths, user or machine names, profile contents, or third-party extension lists.
  - Local (untracked companion file and raw evidence under `tmp/`, ignored by the tracked `.gitignore`): anything machine-specific or sensitive.

## Constraints for real-profile runs

- Use the real profile read-only: do not change settings, keybindings, extensions, extension state, workspace trust or recent-files history beyond what opening the folder and file does.
- Comparison legs use launch flags only (for example disabling other extensions for one run); never uninstall, disable permanently or edit the profile.
- A run on the real profile shares VS Code's single-instance lock with any window the Owner has open. Ask the Owner before a run that would need their windows closed, and batch runs to keep interruptions short.
- Raw profiles, logs and screenshots stay under `tmp/`. They are never sent to external services; only redacted numbers and code locations may be.

## Acceptance

- [ ] Open time measured on the real profile (several runs; cold and warm), split into phases: command/editor resolution, extension activation, host document read and prerender, webview HTML and boot, first paint, editor ready, post-ready work.
- [ ] The dominant cause or causes are attributed with evidence (CPU profiles, phase timings, comparison legs), and recorded here in redacted form.
- [ ] A fix (VMDE-side) is implemented with regression tests, or, if the cause is outside VMDE, the evidence and a recommendation are reported to the Owner.
- [ ] The same real-profile measurement after the fix shows the improvement; the target is agreed with the Owner from the measured baseline.
- [ ] Repository gates: the focused real-VS-Code regression spec required by `AGENTS.md` runs in the test harness (it is not evidence of the real-profile improvement); `npm run quality` passes.
- [ ] The public record and every commit are checked for absolute paths, user or machine names and profile contents before committing.
