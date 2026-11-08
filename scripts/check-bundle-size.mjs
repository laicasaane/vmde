// Bundle-size budget gate (task 145 item 3). Fails if the eager webview bundle (or the separate ELK
// bundle) exceeds its budget — catches an engine accidentally BUNDLED into main.js instead of
// lazy-loaded (would balloon it by MBs), plus gradual dependency bloat (main.js + the VSIX doubled
// 5.1→10.3 MB across releases with no gate). Run AFTER `node build.mjs`; wired into CI.
//
// Budgets are a CEILING with headroom over the current size — bump them DELIBERATELY (with a reason)
// when a real addition lands, so an accidental jump fails loudly first.
import { statSync } from 'node:fs'

const BUDGETS = [
  // [ file (relative to repo root), maxKB, what ]
  [
    'media/dist/main.js',
    // Lowered 525→430 when the D2 pipeline was code-split out (task 165: 484→379 KB); keeps the
    // ceiling meaningful so the next eager engine leak fails loudly instead of hiding in old slack.
    //
    // Raised 430→460 on 2026-08-01 (PR #88), deliberately and with the measurement, not to make a
    // red gate go away. The bundle was 445.6 KB; `main.meta.json` says NO engine leaked, which is
    // the failure this gate exists to catch — the top contributors are Vditor's own source
    // (fixBrowserBehavior 27.7 KB, highlightToolbarWYSIWYG 20.2 KB, wysiwyg/index 10.9 KB) plus
    // diff-match-patch 18.7 KB and plantuml-render.ts 12.3 KB, i.e. diffuse growth over the 6.5
    // weeks this branch ran without a PR (CI only runs on PRs and on main, so the gate had not
    // fired since 2026-06-16 — it was already 444.8 KB before the last three commits, which added
    // 0.8 KB between them). 460 leaves ~14 KB of headroom: enough that ordinary feature work does
    // not trip it, far too little to hide a bundled engine, which is what the 18-line jump from a
    // leaked renderer looks like.
    //
    // Raised 460→480 on 2026-08-27 after the eager bundle reached 464.9 KB. A fresh
    // `main.meta.json` analysis found no engine leak: the largest inputs remain Vditor's browser
    // behaviour/toolbar code and diff-match-patch, while post-PR-88 product UI includes the new
    // responsive toolbar-overflow module (5.8 KB). This is measured cumulative glue growth, not a
    // broken lazy-load boundary. 480 restores ~15 KB of headroom without being large enough to hide
    // an eagerly bundled renderer.
    //
    // Raised 480→482 for task 516 after its final SV contract changed the automatic formatter from
    // a whole-document setValue to a source-offset range splice. The final bundle is 481.0 KB;
    // `main.meta.json` still shows only the two small line-wrapping glue modules (controller and
    // Lute identity wrapper), no renderer/engine leak. The separate engine ceilings are unchanged.
    // Raised 482→484 for task 517's persistent outline viewport controller. The final bundle is
    // 482.5 KB, with `outline-viewport-sync.ts` contributing 1.5 KB; `main.meta.json` shows no new
    // renderer/engine input, and every separate lazy-engine ceiling remains unchanged.
    // Raised 484→490 for task 518's Vditor 3.11.3 trial after stubbing its inaccessible optional
    // image-caption module and duplicate native WaveDrom renderer. That restored the eager-module
    // count to 273; the remaining 487.4 KB is measured core editor growth in list/blockquote/
    // heading/reference behavior, with no engine input in main.meta.json. The ~2.6 KB headroom is
    // intentionally tight and cannot hide a renderer leak.
    // Raised 490→493 for task 520's whole-document rewrap transaction. The final bundle is
    // 492.2 KB; `main.meta.json` attributes the addition to rewrap-command/edit-sync/session glue
    // glue for the host-authoritative flush handshake, native undo fidelity, and cross-mode caret
    // mapping. No renderer or engine entered the eager graph, and every lazy-engine ceiling below
    // is unchanged. The remaining sub-KB headroom cannot hide an engine leak.
    // Raised 493→496 for task 188's direct SV large-document stream. The final bundle is 494.4 KB;
    // `main.meta.json` attributes the addition to the SV chunk assembler, boot-mode routing, and
    // stream lifecycle/metrics glue. It reuses the already-eager Lute/Vditor engine; no renderer or
    // engine entered the graph, and every lazy-engine ceiling below remains unchanged.
    // Raised 496→504 for task 289's view-only section hoisting. The final candidate is 501.9 KB;
    // `main.meta.json` attributes 5.6 KB to the controller and 0.7 KB to the shared pure section-
    // range primitive. No renderer/engine entered the graph, and every lazy-engine ceiling remains
    // unchanged. The ~2 KB headroom stays too small to hide an eager renderer leak.
    // Raised 504→508 for task 524's universal Markdown role classifier and source-safe IR/WYSIWYG
    // reflow. The final eager bundle is 505.7 KB; `main.meta.json` attributes 10.9 KB to
    // rewrap-markdown.ts, while the largest inputs remain Vditor core and diff-match-patch. No
    // renderer or engine entered the eager graph, every lazy-engine ceiling below is unchanged,
    // and the remaining ~2.3 KB headroom cannot hide a renderer leak.
    // Raised 508→520 for task 527's complete callout authoring layer. The measured final candidate
    // was 517.8 KB; task 286's marker controller brought it to 520.3 KB, task 288's shared
    // selection scope reached 523.8 KB, task 52's inverse source-block reveal reached 527.4 KB,
    // and task 196's source find/replace engine + widget reached 533.9 KB. main.meta.json attributes
    // all additions to editor glue inside already-eager modules. Task 258's attribute-only heading/
    // list fold controller then reached 539.7 KB and added one focused nav module. No renderer or
    // engine entered the graph, and every lazy ceiling below is unchanged; ~2.3 KB headroom cannot
    // hide an engine leak.
    // Raised 542→546 for task 275's reading-position controller and shared block-anchor primitive.
    // The measured bundle is 543.4 KB; main.meta.json adds only those two editor-navigation modules,
    // with no renderer/dependency input and unchanged lazy-engine ceilings.
    // Raised 546→548 for task 293's 1.9 KB undo-boundary event controller. The measured bundle is
    // 545.3 KB; it adds no dependency/renderer input and leaves every lazy-engine ceiling intact.
    // Raised 548→552 for task 531's renderer-independent control bar and viewport-adapter registry.
    // The measured bundle is 548.7 KB; main.meta.json adds only those two UI/controller modules and
    // reuses every live renderer authority, with no engine/dependency leak.
    // Task 157's custom-overlay lifecycle reuses that bar/controller and brought the bundle to
    // 550.7 KB. Raised 552→555 for task 530's exact Preview revision/snapshot authority; the final
    // measured bundle is 552.0 KB with no renderer/dependency input or lazy-boundary change.
    // Raised 555→558 for task 528's cached fence-aware SV heading scanner and DOM-range mapper.
    // The final measured bundle is 553.4 KB; it extends existing navigation glue only.
    // Raised 558→564 for task 254's fence/HTML-aware ATX/setext heading-level engine and shared
    // cross-mode caret/undo transaction trigger. The measured final bundle is 563.5 KB; the code
    // lives in already-eager section-range/rewrap modules, adds no dependency or renderer input,
    // and leaves every lazy-engine ceiling unchanged.
    // Raised 564→571 for task 257's source-preserving details pairing/controller and minimal shared
    // snippet registry. The final build reports 571.0 decimal KB (571 KiB at this gate);
    // main.meta.json attributes 6.2 KiB to the indexed protected-context controller and 1.0 KiB to
    // the registry/hint undo boundary, with no dependency, renderer, or
    // lazy-boundary change.
    // Raised 571→579 for task 533's shared-parser source transform, exact cross-mode transaction,
    // and source-derived pinned-toolbar state. The final build is 579.1 decimal KB; no dependency,
    // renderer, or lazy-engine boundary changed.
    // Raised 579→580 for task 225's IR-only inline-ToC pointer bridge. The final build is 579.6
    // decimal KB; main.meta.json adds only 0.3 KB to the existing outline navigation module and
    // no dependency, renderer, eager-module, or lazy-engine boundary changed.
    // Raised 580→587 for task 535's shared mutation-impact classifier, local observer routing,
    // and E2E-only deterministic counters. The measured build is 586.6 decimal KB; main.meta.json
    // attributes the increase only to existing fold/table/diagram/cache glue, with no dependency,
    // renderer, eager-module, or lazy-engine boundary change.
    // Raised 587→589 for task 536's structural ToC revision authority and IR/WYSIWYG source hooks.
    // The measured build is 588.8 decimal KB; it adds one 1.3 KB eager product-glue module but no
    // dependency, renderer, or lazy-engine boundary.
    // Raised 589→595 for task 537's complexity-aware admission and atomic time-sliced IR seed.
    // The measured build is 594.2 decimal KB; main.meta.json attributes 1.0 KB to the new shared
    // classifier and the remainder to edit-sync lifecycle glue, with no dependency/engine input.
    // Raised 595→597 for task 538's E2E-gated renderer generation/stage correlation. The measured
    // build is 596.1 decimal KB; it adds no dependency, renderer, or lazy-boundary input.
    // Raised 597→601 for task 542's 3.0 KB source-faithful SV link resolver. main.meta.json adds
    // one links/ product-glue module and no dependency, renderer, or lazy-boundary input.
    // Raised 601→605 for task 265's registry-derived diagram/link semantics and single live-region
    // authority. The measured build is 603.7 decimal KB; main.meta.json adds three small a11y glue
    // modules and no engine, dependency, renderer, or lazy-boundary input.
    // Raised 605→606 for task 267's four-value workbench-theme and high-contrast palette plumbing.
    // The measured build is 605.3 decimal KB; no engine, dependency, or lazy boundary moved eager.
    // Raised 606→608 for Task 541's caret/selection repair and final editor-normalization guards.
    // The measured build is 607.7 decimal KB; all growth is local editor glue, with no eager engine.
    608,
    'eager webview bundle — glue ONLY, every engine must lazy-load (addScript/fetch)',
  ],
  [
    'media/vditor/dist/js/elk/elk-main.js',
    1600,
    'separate ELK layout bundle — lazy, only when vmde.diagram.d2.layout=elk',
  ],
  [
    'media/vditor/dist/js/d2/d2-main.js',
    // Bumped 150→185 when rough.js (~24 KB) landed for the opt-in hand-drawn sketch mode (task 120):
    // it rides THIS lazy chunk (imported by d2-render/d2-entry), NOT main.js, so a non-D2 doc never
    // fetches it. main.js stayed at 380 KB — proof the code-split boundary held.
    185,
    'separate D2 render+layout bundle (dagre + d2-render + elk-layout + rough.js sketch) — lazy, only when a d2 block renders (task 165/120)',
  ],
  [
    'media/vditor/dist/js/front-matter/front-matter-main.js',
    // The `yaml` parser (~95 KB minified) + the pure front-matter model (task 207). Kept out of
    // main.js; a document without YAML front matter never fetches it.
    110,
    'separate front-matter properties parser — lazy, only when a document has YAML front matter',
  ],
  [
    'media/vditor/dist/js/mermaid-layout-elk/mermaid-elk-main.js',
    // ~74 KB thin adapter: the @mermaid-js/layout-elk render chunk + d3's curveLinear. elkjs is ALIASED
    // to the shared window.__vmdeElk (elk-bundled-shim.ts) so it must NOT ship here — this ceiling is
    // FAR below elkjs's ~1.4 MB, so a broken alias (elkjs leaking in) fails loudly (task 112).
    110,
    'separate mermaid-ELK layout adapter — lazy, only when vmde.diagram.mermaid.layout=elk',
  ],
  [
    'media/vditor/dist/js/plantuml-stdlib/awslib.js',
    // The AWS icon file-map (task 136) — 827 self-contained sprite .puml files inlined as a window-global
    // map, lazy-loaded ONLY when a diagram does `!include <awslib/…>`. The `all.puml` category aggregators
    // (~3.4 MB, half the tree) are NOT shipped — the expander synthesizes `<lib/Cat/all>` from the
    // individual icons (plantuml-stdlib.ts); this ceiling catches their accidental re-inclusion.
    4300,
    'separate AWS PlantUML stdlib icon map — lazy, only for !include <awslib/…> (task 136)',
  ],
]

let failed = false
console.log('Bundle-size budget (task 145 item 3):')
for (const [file, maxKB, what] of BUDGETS) {
  let kb
  try {
    kb = Math.round(statSync(new URL(`../${file}`, import.meta.url)).size / 1024)
  } catch {
    console.error(`  ✖ ${file} — MISSING (run \`node build.mjs\` first)`)
    failed = true
    continue
  }
  const ok = kb <= maxKB
  console.log(`  ${ok ? '✓' : '✖'} ${file}  ${kb} KB / ${maxKB} KB  — ${what}`)
  if (!ok) failed = true
}

if (failed) {
  console.error(
    '\nBundle-size budget EXCEEDED. An engine may have leaked into main.js (engines must lazy-load,\n' +
      'not be bundled), or a dependency bloated the glue. Inspect WHAT grew with esbuild analyze on\n' +
      'media/dist/main.meta.json, then fix the leak — or bump the budget deliberately with a reason.',
  )
  process.exit(1)
}
console.log('All bundles within budget.')
