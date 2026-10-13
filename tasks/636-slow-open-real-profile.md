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

## Measurement plan (2026-10-14)

- Measure on the real profile, with the installed build as the baseline and a development-build leg to check build drift.
- Phases: window ready; extension activation; editor resolution; host read and prerender; webview created; first paint; editor ready; interactive; a 5 s post-ready window.
- Instrumentation, with no code change: the editor's built-in startup timings; CPU profiles of the extension host, workbench and webview over the debugger protocol; webview paint and long-task observers; VMDE trace-level log lines enabled per session by a launch flag. The test-only performance seams are not used, because they also clear the render cache.
- Control: the same file in the plain text editor, with VMDE disabled for that launch only.
- Comparison legs, by launch flags only: VMDE alone; other extensions disabled in groups and then halved; selected built-in features disabled; copies of the file split in halves and with a simplified shape.
- Cold means the first open after a fresh launch; warm means repeat opens in the same session. Five runs per main leg and three per bisect leg; report median, min and max.
- Stop when a leg moves the baseline median by 30% or more beyond the run spread, or when the bisect narrows to two candidates or one file half. Stop and ask if the slow open does not reproduce. Budget: two short sessions with the Owner.
- Raw profiles and logs stay in the ignored local folder. Only phase medians, leg labels and relative VMDE code locations are published.
- The runs are scripted. The Owner closes the editor windows for each batch, approves the debug-port flags, and does one stopwatch run with the usual gesture.

## Owner decisions (2026-10-14, chat, after the plan)

- The Owner opens the file from the Explorer panel; the estimated open time today is over 20 s, up to over a minute.
- **Target:** under 5 s in the best case and under 10 s in the worst case on the Owner's machine.
- A safety backup of the editor's state database is allowed before scripted runs.
- Temporary setting changes are allowed only after a proper backup of the settings and with Settings Sync turned off first; the settings leg still runs only if the other legs leave more than 30% of the time unexplained.
- The debugger-protocol launch flags are approved for the real profile.
- Measuring the installed version as the baseline and building local versions to measure and fix are approved.

## Execution progress — 2026-10-14 (E3a, first real-profile runs)

- The measurement harness drives a real editor window in a private display (Explorer click by OS-level input, phase timings and CPU profiles over the debugger protocol). Every instrument's deliberate positive control fired, except a named-function control inside the webview's own profile, which the frame layout does not separate.
- Cold open of the file from the Explorer, installed build, full profile: editor tab 61 ms, webview created 530 ms, first paint 965 ms (prerender teaser), **editor ready 24.9 s** after the click. The same file in the plain text editor (VMDE disabled for that launch): **0.27 s**. One earlier run was void (a tab restored at startup was reopened).
- Lead, not yet an attribution: after the webview reports ready (0.9 s), the next host log line comes about 23 s later, and both the extension host and the webview are mostly idle in between — the time looks like waiting, not computation.
