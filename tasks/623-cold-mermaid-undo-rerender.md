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

## Part 1 handoff (2026-10-14)

Read-only review of the source; runtime attribute states are inferred and need the probe below. `V` = the vendored Vditor source (`media-src/node_modules/vditor/src/ts`).

- **Cause (verified by reading).** (1) `V/util/processCode.ts` sets the preview's `data-render="1"` at once, while the Mermaid render is asynchronous (`V/markdown/mermaidRender.ts` waits for its script, skips targets with `data-processed="true"`, reads the source from `textContent`). (2) The snapshot (`addCaret`, `V/undo/index.ts`) resets only echarts, plantuml, mindmap and math previews to `"2"`, so a pending Mermaid preview keeps `"1"`; the Task 598 seed uses the same `addCaret`. (3) Restore (`renderDiff`) re-renders only `[data-render='2']`, so a restored, unrendered Mermaid preview is never rendered again. (4) Inference: the VMDE render-cache client (`media-src/src/…/render-cache-client.ts`, `native-offscreen.ts`) reserves native targets at finish-init with `data-processed="true"` and `data-vmde-cache-reserve`; after Undo the reserved node is detached, so a late SVG swap lands off-document, and the reserve attributes would also block a re-render. (5) The cold leg presses its key before finish-init, so the seed may hold `data-render="1"` with or without the reserve; the fix must handle both.
- **Choice: snapshot reset** (not a restore patch): extends upstream's own reset at the same site, lets both existing restore loops (Undo and Redo) render with no `renderDiff` change, and keeps snapshots canonical for `recordFirstPosition`'s comparison.
- **Contract (cloned snapshot DOM only; live DOM untouched).** For each `.vditor-{mode}__preview[data-render='1']` whose first child is `.language-mermaid`, `.language-abc` or `.language-flowchart`, with no `svg` or `.vmde-diagram-error` inside the target and without `data-vmde-hoist-deferred`: remove `data-processed`, `data-vmde-cache-reserve`, `data-vmde-cache-hit` and `data-vmde-render-key`; set the target's `textContent` from the marker source (`previousElementSibling.firstElementChild.textContent` — `textContent`, not upstream's `innerHTML` copy, so a caret `span.vditor-wbr` is not duplicated); keep `data-code`; set the preview to `data-render="2"`. Rendered (warm) and hoist-deferred targets stay as they are. Previews remain invisible to the serializer.
- **Part 2.** S1: new build-time patch in `media-src/esbuild-shared.mjs` (Task 598 pattern: one count-asserted anchor right before `const text = cloneElement.innerHTML;` in `addCaret`, an already-applied marker that throws, chained after the seed-baseline patch in the `undo/index.ts` entry); a row in `docs/vditor-patch-checklist.md`; Vitest in `test/backend/vditor-source-patches.test.ts` (missing or duplicated anchor throws; second application throws; chain equality; on the patched logic or an extracted helper: a pending mermaid/abc/flowchart preview is reset with the attributes stripped; an `svg` or error target is unchanged; a hoist-deferred target is unchanged; a caret marker in the source is not copied). S2: Chromium on the undo-boundaries harness: a snapshot taken while a Mermaid render is pending, then Undo → an SVG with shapes within 10 s; a warm diagram, edit, Undo/Redo → same SVG, no new render, `getValue()` unchanged; one WYSIWYG case. Probe in S2/S3: log the seed preview's `data-render` and the target's `data-processed`, `data-vmde-cache-reserve`, child count and text length. S3: `test/vscode-e2e/undo-first-edit.spec.ts` cold-Mermaid leg: replace the `test.fail` branch with assertions (drawn after Undo within 10 s, the key lands, host clean, caret position, cold window still required). S4: closure.
- **Edge cases.** Undo before the host cache reply (the detached wrapper gets the swap; the restored node renders live — harmless); a local cache hit painting before Mermaid's script (either path draws); a brief source-height flash on live render; WYSIWYG same code path (one Chromium case); a theme change mid-render (old SVG present → left as is).
- **Scope decisions (orchestrator, 2026-10-14; the queue's Part 1 goal delegates "which other async renderers are in scope").** Mermaid, abc and flowchart now (shared reserve, completion marker and SVG output). Graphviz, markmap, smiles, wavedrom, plantuml and the custom/d2 family: a follow-up after a probe (offered to the Owner at queue end). Snapshot reset adopted. One WYSIWYG Chromium case adopted.
- **Risk.** No runtime evidence yet for the reserve attributes in the seed (probe). S1 shares `media-src/esbuild-shared.mjs` and `test/backend/vditor-source-patches.test.ts` with Task 619 S1b — run after 619 S1b is committed.

## Execution progress — 2026-10-14 (S1)

- Added `patchUndoPendingDiagramReset` to `media-src/esbuild-shared.mjs`: one count-asserted anchor right before `const text = cloneElement.innerHTML;` in `addCaret`, an already-applied marker that throws, chained after `patchUndoSeedBaseline` in the `undo/index.ts` registry entry. Behaviour follows the Part 1 contract (cloned DOM only; mermaid/abc/flowchart; reserve attributes stripped; source from `textContent`; `data-render="2"`).
- Added a row to `docs/vditor-patch-checklist.md`.
- Vitest in `test/backend/vditor-source-patches.test.ts` (written first and seen failing, 12 failures): missing and duplicated anchor, second application, chain equality, pending reset with attributes stripped (three engines), svg target, error target, hoist-deferred target, caret marker not copied; the two existing chain-equality tests now include the new patch.
- Checks: the focused Vitest file passes (312 tests), `node build.mjs`, `npm run typecheck`, `npx biome check` on the changed source files and `npm run knip` succeed.
- Open: S2 (Chromium) onward not started; the runtime state of the reserve attributes in the seed is still unprobed.

## Execution progress — 2026-10-14 (S2)

- Chromium cases in `media-src/e2e/undo-pending-diagram.spec.ts`, on the undo-boundaries harness (source-patched Vditor, no render cache). The harness gained a `doc=mermaid` document (a paragraph above one flowchart) and a read-only probe around `addCaret` (`__snapshots()`: the diagram previews in the live DOM when each snapshot starts, and as written into the snapshot). Nothing else in the harness changed.
- Pending state is forced by holding the request for the Mermaid script (`page.route`), so the first render cannot finish. Each case runs in IR and WYSIWYG.
  - Pending: settle the initial snapshot, edit the paragraph with a real click, Home and a typed key, wait for the edit's undo entry, Undo (source equals the opened source), release the script, and an `.language-mermaid svg` with at least 2 `g.node` shapes, nonzero width and no error render appears within 10 s; Redo restores the edit and draws the diagram too.
  - Warm: wait for the drawn diagram, settle, count `mermaid.render` calls, edit the paragraph, Undo, Redo. The diagram markup is byte-identical after each step (the restored node is new but carries the same SVG, so no render ran), `getValue()` equals the opened source after Undo and the edited source after Redo, and the render count stays unchanged through a 1.5 s settle.
- Probe values (identical in IR and WYSIWYG, every snapshot taken while pending): live preview `data-render="1"`, target `.language-mermaid` with `data-processed` absent, `data-vmde-cache-reserve` absent, 0 child elements, text length 31 (the source). In the snapshot: `data-render="2"` with the patch, `"1"` without it. The reserve attributes are not set in this harness (no render cache), so their stripping stays covered by the Vitest cases, not by Chromium; the real-window state at the seed is still for S3.
- Red check: with the registry chain entry for the snapshot reset temporarily disabled, both pending cases fail (no SVG within 10 s; probe shows `data-render="1"` in the snapshot) and both warm cases pass; restored afterwards, `git diff --exit-code media-src/esbuild-shared.mjs` is clean.
- Two harness traps found and avoided: a script request held by `page.route` keeps the `load` event pending (the case navigates with `domcontentloaded`), and a scripted selection placed by `__place` is overwritten by the editor's stale focus range (the case places the caret with a real click).
- Checks: the new spec 4/4 (five consecutive runs green before the final format-only change, one more after it); `undo-boundaries.spec.ts`, `mermaid.spec.ts`, `mermaid-palette.spec.ts` and the new spec together 81/81; `node build.mjs` and `npx biome check` on the two changed files succeed.
- Open: S3 (real VS Code cold leg) and S4 (closure) not started.
