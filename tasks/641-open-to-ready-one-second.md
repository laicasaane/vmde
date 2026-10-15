# Task 641 — Open a Markdown file to ready in about one second

**Status:** planned (2026-10-15).
**Origin:** Project Owner request (chat, 2026-10-15).
**Severity:** performance (every file open).
**Tech stack:** extension host (`src/session/editor-session.ts`, `src/webview-host/html-builder.ts`, host prerender), webview boot (`media-src/src/boot/`), Vditor/Lute initialization, bundle size (`media/dist/main.js`, about 0.96 MB).
**Related:** [Task 636](done/636-slow-open-real-profile.md) (slow open on the real profile; wiki scan no longer blocks `init`), [Task 638](done/638-persistent-wiki-page-cache.md) (stored wiki page list), [Task 573](done/573-large-document-open-scroll-performance.md) (large-document open and scroll).

## Problem

Opening a Markdown file still takes noticeably long before the editor is ready. Example (Project Owner): `LOCAL_AGENT_TASK.md` in this repository (about 150 KB) takes more than 3 seconds. Task 636 measured, on the real profile, a cold open median of about 3.3 s after its fix, with the webview created at about 0.5 s and the first paint (prerender) at about 1 s.

## Requested behavior (Project Owner, verbatim)

"Currently the file open and be ready still take significant amount of time, for example the `LOCAL_AGENT_TASK.md` in this repo take more than 3 seconds. Can we reduce this significantly down, up to 1 second for every files?"

## Constraints

- No change to document bytes, dirty state, Undo or editing behaviour.
- Keep Task 573's visible-only work and Task 636/638's wiki behaviour.
- Measure before changing anything; every claim of a saving needs a before/after number from the same setup.

## Acceptance

- [ ] Open-to-ready split into phases (click/command, extension activation, editor resolution, host read and prerender, webview creation, script load and parse, Vditor/Lute init, first content paint, ready, post-ready work) for a small file, a mid-size file and `LOCAL_AGENT_TASK.md`, cold and warm, in a clean profile; the real-profile numbers if the Owner allows that run.
- [ ] A target per file size agreed with the Project Owner after the measurement (the request is about 1 s for every file; what "ready" means — editable, or content visible — is to be confirmed).
- [ ] Changes reach the agreed target, with before/after numbers from the same setup, and no regression in Task 573's gates.
- [ ] Focused real-VS-Code timing spec written and run; network-free gates pass.
