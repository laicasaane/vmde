# Task 623 — Undo to a first-render snapshot leaves a Mermaid diagram blank

**Status:** planned (2026-10-07). Filed under ruling 598 Q3 (`tmp/queue-part1/596-603-rulings.md` §598): the diagram re-render is tracked separately and not folded into Task 597, and a task is opened only if the defect reproduces with Task 598's chosen design. It reproduced in 4 of 4 runs. Implementation has not started.
**Origin:** Task 598 S4 (2026-10-07), the cold-Mermaid detector leg of `test/vscode-e2e/undo-first-edit.spec.ts`. Before Task 598 the first edit could not be undone at all, so this state was unreachable through the first edit.
**Severity:** medium. After the first Undo on a freshly opened document whose diagram was still rendering, the diagram stays blank until the block is re-rendered by another edit or a reload. The source, the host text, the caret and the next key are correct; no data is lost.
**Scope:** IR (measured). WYSIWYG uses the same Vditor restore path and is likely affected; it was not measured. Mermaid is measured; other asynchronous renderers that keep `data-render="1"` in the snapshot (graphviz, flowchart, markmap, abc, smiles, wavedrom and VMDE custom renders) are unmeasured candidates.

## Problem

Task 598 takes the first undo snapshot (the seed) at the user's first action, before it changes anything. When a document with a Mermaid diagram that is not in the render cache is edited immediately after opening, the seed is taken while the diagram's first render is still in flight. Undo restores that snapshot. The source is right, but the diagram never renders again.

## Measured evidence

Real VS Code 1.129.0, Linux X11, Xvfb + Openbox, OS-level XTEST keys, `--workers=1 --retries=0`, build of `922a0686` (three S4 runs) and of `804b6f3b` (one Task 598 close-out run; the product code is the same). Fixture: a small paragraph document ending `delta.` with a unique 30-pair Mermaid flowchart (`graph TD`) inserted below the edited paragraph, so the render cache cannot supply the result. Session logs `scratchpad/s4/final-a.log`, `final-b.log`, `final-mermaid.log` and `scratchpad/close/mermaid-fail.log` (not committed; the values below are copied from them).

- **Cold window, 4 of 4 runs.** The seed was called by the trusted `X` keydown and found the IR stacks at `0/0` with no snapshot taken. No `.language-mermaid svg` existed at readiness or at the seed.
- **Before Undo** (after the first edit's checkpoint, stacks `2/0`): the diagram had rendered. SVG 688×15 CSS px (687×16 and 528×12 in two runs with a different editor width), 218 shapes, no error render, preview in view.
- **After one Ctrl+Z:**
  - the host text equals the opened bytes exactly, and the host is clean;
  - the caret is collapsed and editable after `delta.`, and the next OS key `Y` lands as `delta.Y`;
  - the IR preview of the diagram exists with `data-render="1"`, its `.language-mermaid` element has no children, its reserved height is 357 px (462 px in the narrower run), and it is in view;
  - no SVG appears within 10 s, nor within 10 more seconds after scrolling the preview into view.
- Two earlier, smaller diagrams had already rendered before the editor accepted input. Those runs were missed cold windows, not passes.
- The rejected init-time seed of the Task 598 investigation showed the same missing re-render (2 of 2 runs, `tmp/task596-603-evidence/t598/results7.json`).

## Reproduction

The detector leg `mermaid:cold` of `test/vscode-e2e/undo-first-edit.spec.ts` (test "cold Mermaid detector"):

```bash
node build.mjs
env -u ELECTRON_RUN_AS_NODE VMDE_XTEST=1 xvfb-run -a npm --prefix test/vscode-e2e test -- undo-first-edit.spec.ts -g "cold Mermaid" --workers=1 --retries=0
```

It needs an Openbox configuration without Shift+Alt+Left/Right grabs (`docs/os-keyboard-testing-setup.md`). The leg reports the exact defect as an expected failure (`test.fail`, annotated with this task). It fails unexpectedly when the window is missed, when anything else breaks, and when the diagram is drawn, so the fix is noticed.

## Suspected cause (unverified)

- Vditor's `processCodeRender` (`vditor/src/ts/util/processCode.ts:59-104`) starts the asynchronous Mermaid render and sets the preview's `data-render="1"` at once (`:103`), before the SVG exists.
- The snapshot (`addCaret`, `vditor/src/ts/undo/index.ts:240-255`) resets `data-render` to `"2"` only for ECharts, PlantUML, mindmap and math previews. A Mermaid preview keeps `"1"`. A snapshot taken after the render holds the SVG, so restoring it works. The seed was taken mid-render: it holds `"1"` with an empty `.language-mermaid`.
- On restore (`undo/index.ts:150-190`), only previews with `data-render="2"` are passed to `processCodeRender`, so the restored empty Mermaid preview is never rendered again.
- To confirm: log the seed snapshot's preview attributes and child count, and check whether VMDE's diagram pipeline (`media-src/src/diagrams/`, `render-cache-client.ts`, `stream-render.ts`) observes the restored preview.

## Constraints

- Do not move the seed back to init time, and do not delay the seed until diagrams render; that reopens the Task 598 first-edit race.
- Task 597 owns the caret restore fallback; this task is about the diagram only.
- A Vditor change is a build-time patch in `media-src/esbuild-shared.mjs` with throwing anchors and a row in `docs/vditor-patch-checklist.md` (`.agents/skills/vmde-lute-features/SKILL.md`). Restored previews must stay Lute-invisible and must not change the serialized source.

## Tests

- **Vitest:** the snapshot or restore treats a Mermaid preview without a rendered SVG as needing a render; already rendered previews are not re-rendered; the patch anchors throw on drift.
- **Chromium (source-patched harness):** an undo snapshot taken while a Mermaid render is pending, then Undo, re-renders the diagram; a warm diagram is not re-rendered.
- **Real VS Code** (build first, `VMDE_XTEST=1`, `--workers=1 --retries=0`): the `mermaid:cold` leg passes. Remove its expected-failure marker in the same change.

## Acceptance

- [ ] After the first-edit Undo on a cold Mermaid document, an `.language-mermaid svg` with nonzero size and rendered shapes, and no error render, appears within 10 s, in a cold window (seed at `0/0`, no SVG at the seed).
- [ ] The source, clean host, caret and next key results of the detector leg are unchanged.
- [ ] Undo and Redo over already rendered diagrams do not re-render them or change the source.
- [ ] The detector leg's `test.fail` marker is removed, and the leg passes in real VS Code.
