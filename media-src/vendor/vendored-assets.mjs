// ── Vendored-asset sync ─────────────────────────────────────────────────────────────────────────
// Every diagram/render engine we pin lives under media-src/vendor/<dir>/ with a source.json recording
// its provenance + sha256(s). `.vscodeignore` excludes media-src/, so the bytes AND their license text
// must be copied into the shipped media/vditor/dist/js/<dir>/ tree. This single declarative
// VENDORED_ASSETS table + syncVendored() engine replaces the ~15 near-identical per-lib sync functions
// (the same consolidation the esbuild VDITOR_TS_PATCHES registry did for TS patches): one row per
// asset, uniform sha-verify → mkdir → copy bytes → copy LICENSE/NOTICE → consistent log.
//
// Copying the license is NOT optional: d2 (MPL-2.0) and elk (EPL-2.0) are copyleft and legally require
// their license to accompany the shipped binary, and even the permissive ones need attribution. The
// old per-function code copied a license for only 3 of 15 libs — a marketplace-distribution defect
// (tasks/149). The shipped-license invariant is guarded by test/backend/vendored-licenses.test.ts.
//
// Re-pinning (version/CVE bump): lute/mermaid/echarts have media-src/scripts/fetch-*.mjs; d2 is
// rebuilt via media-src/vendor/d2/build/build-d2-wasm.sh; the rest are a manual download → sha256 →
// edit source.json (each vendor dir's source.json `origin`/`source` records where from). The sha gate
// below fails the build loudly on any mismatch, so a wrong manual re-pin can never ship silently.
//
// Entry shape:
//   dir            media-src/vendor/<dir> ⇄ media/vditor/dist/js/<dir>
//   copy           [[srcFile, destFile], …] bytes to ship (sha-verified when source.json lists them).
//                  Empty for elk: its bytes are esbuild-bundled into elk-main.js by the webview build;
//                  syncVendored still sha-GATES the sources + ships the license next to elk-main.js.
//   copyTree       [[sourceDir, destinationDir], …] recursive trees to ship. Every regular file must
//                  have a source.json SHA; symlinks and unrecorded files fail the build.
//   license        license/notice filenames in the vendor dir → shipped as `<dir>.<file>`
//   label          (source) => version string for the log (default `v${source.version}`)
//   installedNote  optional suffix on the success log
//   missingNote    optional suffix on the "no vendored pin" log
export const VENDORED_ASSETS = [
  // Lute (Mulan PSL v2 §4): overwrites Vditor's bundled lute.min.js with our pinned 88250/lute build
  // (tasks/66). shas live top-level: source.sha256 (the blob) + source.mapSha256 (the sourcemap) —
  // both verified by syncVendored (185/3d).
  {
    dir: 'lute',
    copy: [
      ['lute.min.js', 'lute.min.js'],
      ['lute.min.js.map', 'lute.min.js.map'],
    ],
    license: ['LICENSE', 'NOTICE'],
    label: (s) => `${s.commit.slice(0, 10)} (${s.goVersion})`,
    missingNote: 'using Vditor default',
  },
  // Mermaid (MIT) — pinned newer build, same major, API-compatible (tasks/86). Top-level sha.
  {
    dir: 'mermaid',
    copy: [['mermaid.min.js', 'mermaid.min.js']],
    license: ['LICENSE', 'NOTICE'],
    missingNote: 'using Vditor default',
  },
  // ECharts (Apache-2.0) — major bump 5→6, fidelity verified at pin time (tasks/89). Top-level sha.
  {
    dir: 'echarts',
    copy: [['echarts.min.js', 'echarts.min.js']],
    license: ['LICENSE', 'NOTICE'],
    missingNote: 'using Vditor default',
  },
  // PlantUML offline TeaVM — plantuml.js (MIT, plantuml/plantuml-mit). It needs viz-global.js, which
  // now lives in its OWN vendor/viz/ dir (task 144 item 6) since BOTH plantuml and graphviz share it —
  // keeping it under plantuml/ was a hidden coupling (removing plantuml would have broken graphviz).
  {
    dir: 'plantuml',
    copy: [['plantuml.js', 'plantuml.js']],
    license: ['LICENSE'],
    missingNote: 'PlantUML offline disabled',
  },
  // PlantUML stdlib subsets (task 136) — per-lib JSON file-maps so `!include <C4/…>` / `<awslib/…>` /
  // `<azure/…>` resolve OFFLINE (our TeaVM engine ships no stdlib + no include hook; we inline the
  // .puml text before render — see media-src/src/plantuml-stdlib.ts). Packed by
  // scripts/fetch-plantuml-stdlib.mjs (C4-PlantUML MIT, Azure-PlantUML MIT; aws-icons-for-plantuml
  // carries SPDX MIT headers on the .puml macros but its repo LICENSE — the one we vendor as
  // LICENSE-awslib — is CC BY-ND 2.0 for the icon assets, so the icons ship verbatim, never modified).
  // The webview lazy-fetches only the lib(s) a diagram references. Separate flat dir (not
  // plantuml/stdlib) so the `${dir}.${license}` naming has no slash.
  {
    dir: 'plantuml-stdlib',
    copy: [
      ['c4.js', 'c4.js'],
      ['awslib.js', 'awslib.js'],
      ['azure.js', 'azure.js'],
      // task 354 — 7 MIT/Apache icon libs from the plantuml-stdlib aggregator (sha-pinned)
      ['k8s.js', 'k8s.js'],
      ['eip.js', 'eip.js'],
      ['edgy.js', 'edgy.js'],
      ['domainstory.js', 'domainstory.js'],
      ['cloudogu.js', 'cloudogu.js'],
      ['cloudinsight.js', 'cloudinsight.js'],
      ['kubernetes.js', 'kubernetes.js'],
      // task 384 — the 15 material icons domainstory names by default (15 KB), loaded alongside it
      ['material.js', 'material.js'],
    ],
    license: [
      'LICENSE-c4',
      'LICENSE-awslib',
      'LICENSE-azure',
      'LICENSE-k8s',
      'LICENSE-eip',
      'LICENSE-edgy',
      'LICENSE-domainstory',
      'LICENSE-cloudogu',
      'LICENSE-cloudinsight',
      'LICENSE-kubernetes',
      'LICENSE-material',
    ],
    missingNote: 'PlantUML stdlib includes disabled',
  },
  // Viz.js (@viz-js/viz, MIT) — Graphviz→WASM/JS, the shared engine for BOTH plantuml (task 87) and
  // graphviz (task 94). Ships to media/vditor/dist/js/viz/; both renderers load it from there.
  {
    dir: 'viz',
    copy: [['viz-global.js', 'viz-global.js']],
    license: ['LICENSE'],
    missingNote: 'PlantUML + Graphviz offline disabled',
  },
  { dir: 'abcjs', copy: [['abcjs_basic.min.js', 'abcjs_basic.min.js']], license: ['LICENSE'] },
  {
    dir: 'smiles-drawer',
    copy: [['smiles-drawer.min.js', 'smiles-drawer.min.js']],
    license: ['LICENSE'],
  },
  { dir: 'wavedrom', copy: [['wavedrom.min.js', 'wavedrom.min.js']], license: ['LICENSE'] },
  { dir: 'nomnoml', copy: [['nomnoml.min.js', 'nomnoml.min.js']], license: ['LICENSE'] },
  {
    dir: 'leaflet',
    copy: [
      ['leaflet.js', 'leaflet.js'],
      ['leaflet.css', 'leaflet.css'],
    ],
    license: ['LICENSE'],
  },
  {
    dir: 'topojson',
    copy: [['topojson-client.min.js', 'topojson-client.min.js']],
    license: ['LICENSE'],
  },
  { dir: 'vega', copy: [['vega-embed.min.js', 'vega-embed.min.js']], license: ['LICENSE'] },
  { dir: 'threejs', copy: [['three-stl.min.js', 'three-stl.min.js']], license: ['LICENSE'] },
  {
    dir: 'markmap',
    copy: [['markmap.min.js', 'markmap.min.js']],
    license: ['LICENSE'],
    missingNote: 'using Vditor default',
  },
  // D2 (MPL-2.0, copyleft — license MUST ship) — compile-only Go→WASM, rebuilt via
  // media-src/vendor/d2/build/build-d2-wasm.sh.
  {
    dir: 'd2',
    copy: [
      ['d2-compile.wasm', 'd2-compile.wasm'],
      ['wasm_exec.js', 'wasm_exec.js'],
    ],
    // LICENSE = D2 itself (MPL-2.0). The other two are npm libraries whose bytes esbuild bundles INTO
    // d2-main.js, which ships in this same dir: roughjs (the `d2.sketch` hand-drawn look, d2-sketch.ts)
    // and @dagrejs/dagre (the default layout engine, d2-layout.ts). They have no dir of their own —
    // shipping their license next to the bundle that contains them keeps the task-149 invariant true
    // without inventing a vendor dir for bytes we never copy.
    license: ['LICENSE', 'LICENSE-roughjs', 'LICENSE-dagre'],
  },
  // elkjs (EPL-2.0, copyleft — license MUST ship). Its bytes are esbuild-bundled into elk-main.js by
  // the webview build, so copy NOTHING; syncVendored still sha-GATES elk-api.js + elk-worker.min.js and
  // ships the license into the same dir as the generated elk-main.js. See media-src/src/elk-entry.ts.
  {
    dir: 'elk',
    copy: [],
    license: ['LICENSE'],
    installedNote: 'bundled to elk-main.js by the webview build',
  },
  // @mermaid-js/layout-elk (MIT) — the official mermaid ELK layout adapter (task 112). Like elk, its
  // bytes are esbuild-bundled (into mermaid-elk-main.js via mermaid-elk-entry.ts), so copy NOTHING;
  // syncVendored still sha-GATES every .mjs listed in source.json's `files` map and ships the license
  // next to the generated bundle (media/vditor/dist/js/mermaid-layout-elk/). Its `elkjs` import is
  // aliased to elk-bundled-shim.ts → the shared window.__vmdeElk, so NO second elkjs ships here.
  {
    dir: 'mermaid-layout-elk',
    copy: [],
    license: ['LICENSE'],
    installedNote: 'bundled to mermaid-elk-main.js by the webview build',
  },
  // KaTeX (MIT) is an explicit SHA-pinned tree because Vditor's bundled 0.16.9 carries document-
  // reachable advisories. Copy the complete browser dist subset over Vditor after its asset sync.
  {
    dir: 'katex',
    copy: [],
    copyTree: [['dist', '']],
    license: ['LICENSE', 'NOTICE'],
    missingNote: 'using Vditor default',
  },
  // flowchart.js is explicitly pinned because Vditor's bundled copy lags the maintained package.
  {
    dir: 'flowchart.js',
    copy: [['flowchart.min.js', 'flowchart.min.js']],
    license: ['LICENSE'],
  },
  // Emoji 17.0 data (task 566) — emoji-test-17.0.txt (Unicode-3.0) and cldr-47-annotations-en.json
  // (Unicode-3.0) are consumed at build time by media-src/scripts/generate-emoji-catalog.mjs, which
  // writes media/emoji/emoji-catalog.json; like elk/mermaid-layout-elk above, the pinned sources feed
  // a generated artifact rather than shipping verbatim, so copy NOTHING here. The dir's only actual
  // license FILE is OFL-1.1.txt (the Noto Color Emoji fallback font's SIL license) — Unicode-3.0 is
  // recorded as a license identifier in source.json but ships no separate license text upstream, so
  // there is nothing else to list here. The font itself (fallbackFont in source.json) is not vendored
  // through this dir: it already ships directly from media/fonts/NotoColorEmoji.ttf with its own
  // license copy at media/fonts/NotoColorEmoji-LICENSE.txt.
  {
    dir: 'emoji',
    copy: [],
    license: ['OFL-1.1.txt'],
    label: (s) => `Unicode ${s.unicodeEmoji.version} + CLDR ${s.cldrAnnotations.version}`,
    installedNote: 'catalog generated into media/emoji/ by generate-emoji-catalog.mjs',
  },
]
