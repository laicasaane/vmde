// esbuild driver for the webview bundle (task 20). Replaces the bare CLI so we
// can import Vditor from *source* (`vditor/src/index`) and tree-shake it, which
// the pre-bundled `vditor/dist/index.js` can't do. The Vditor-source specifics
// live in esbuild-shared.mjs (reused by the e2e harness server).
import * as esbuild from 'esbuild'
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vditorSourceConfig } from './esbuild-shared.mjs'

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: ['./src/boot/main.ts'],
  bundle: true,
  outfile: '../media/dist/main.js',
  sourcemap: true,
  minify: !watch,
  // Emit a metafile so the bundle-size budget check (scripts/check-bundle-size.mjs, task 145 item 3)
  // — and ad-hoc `esbuild --analyze` inspection — can see WHAT landed in main.js (catches an engine
  // accidentally bundled in instead of lazy-loaded). Written to media/dist/main.meta.json (gitignored).
  metafile: true,
  logLevel: 'info',
  // (woff2 external lives in vditorSourceConfig — shared with the e2e harness server.)
  ...vditorSourceConfig,
}

// Optional ELK D2 layout engine (vmde.diagram.d2Layout=elk) — a SEPARATE bundle so the ~1.5 MB
// of vendored elkjs stays out of main.js and is fetched only when that engine is active (loaded on
// demand by elk-layout.ts → window.__vmdeElk). Bundles elk-api.js + the main-thread "fake worker"
// (elk-worker.min.js) via elk-entry.ts — NO Web Worker (see elk-entry.ts for why). Output lands in
// media/vditor/dist/js/elk/, which already exists (syncVditorAssets ran before this build) and is
// NOT wiped by the rmSync below (that only clears media/dist). Source-min already, so no re-minify
// / sourcemap. The elk SHAs are gated separately by build.mjs `syncElk`.
/** @type {import('esbuild').BuildOptions} */
const elkOptions = {
  entryPoints: ['./src/diagrams/d2/elk-entry.ts'],
  bundle: true,
  outfile: '../media/vditor/dist/js/elk/elk-main.js',
  format: 'iife',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
  // Benign warning inside the vendored GWT-compiled worker (`x == -0`); we don't own that source.
  logOverride: { 'equals-negative-zero': 'silent' },
  tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
}

// D2 layout+render pipeline (task 165) — a SEPARATE bundle so the ~109 KB cluster (dagre + d2-render
// + d2-refine + elk-layout + astar + d2-geometry) stays out of the eager main.js and is fetched only
// when a `.language-d2` block actually renders (loaded on demand by custom-diagrams.ts →
// window.__vmdeD2 via d2-entry.ts). Output lands in media/vditor/dist/js/d2/ (already created by
// syncVditorAssets, alongside d2-compile.wasm) and is NOT wiped by the rmSync below. IIFE, main-thread.
/** @type {import('esbuild').BuildOptions} */
const d2Options = {
  entryPoints: ['./src/diagrams/d2/d2-entry.ts'],
  bundle: true,
  outfile: '../media/vditor/dist/js/d2/d2-main.js',
  format: 'iife',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
}

// Optional ELK layout for mermaid graph diagrams (vmde.diagram.mermaidLayout=elk, task 112) — a
// SEPARATE lazy bundle (mermaid-elk.ts loads it on demand → window.__vmdeMermaidElkLayouts →
// mermaid.registerLayoutLoaders). Bundles the vendored @mermaid-js/layout-elk adapter (mermaid-elk-
// entry.ts). Its ONLY heavy import, `elkjs/lib/elk.bundled.js`, is ALIASED to elk-bundled-shim.ts so it
// reuses the ONE shared main-thread elkjs (window.__vmdeElk) already shipped for D2 — no second
// ~1.5 MB engine, no blob Web Worker (CSP-safe). d3's curveLinear tree-shakes from node_modules. Output
// lands next to the vendored license (media/vditor/dist/js/mermaid-layout-elk/); esbuild creates the
// dir. A dagre-only mermaid doc never fetches it.
/** @type {import('esbuild').BuildOptions} */
const mermaidElkOptions = {
  entryPoints: ['./src/diagrams/mermaid/mermaid-elk-entry.ts'],
  bundle: true,
  outfile: '../media/vditor/dist/js/mermaid-layout-elk/mermaid-elk-main.js',
  format: 'iife',
  sourcemap: false,
  minify: !watch,
  logLevel: 'info',
  alias: {
    'elkjs/lib/elk.bundled.js': fileURLToPath(
      new URL('./src/diagrams/d2/elk-bundled-shim.ts', import.meta.url),
    ),
  },
}

rmSync(new URL('../media/dist', import.meta.url), {
  recursive: true,
  force: true,
})

// Task 47: DOMPurify is the pinned SVG-only sanitizer, kept out of main.js so ordinary documents
// do not pay its parser cost. The adapter loads this same local asset only for SVG data images.
const domPurifyOut = new URL(
  '../media/vditor/dist/js/dompurify/purify.min.js',
  import.meta.url,
)
mkdirSync(new URL('../media/vditor/dist/js/dompurify/', import.meta.url), {
  recursive: true,
})
copyFileSync(
  new URL('./node_modules/dompurify/dist/purify.min.js', import.meta.url),
  domPurifyOut,
)

if (watch) {
  const ctx = await esbuild.context(options)
  await ctx.watch()
  console.log('[build.mjs] watching…')
  await Promise.all([
    esbuild.build(elkOptions),
    esbuild.build(d2Options),
    esbuild.build(mermaidElkOptions),
  ])
} else {
  const [mainResult] = await Promise.all([
    esbuild.build(options),
    esbuild.build(elkOptions),
    esbuild.build(d2Options),
    esbuild.build(mermaidElkOptions),
  ])
  // Persist the metafile next to the bundle for the size-budget check + analysis.
  writeFileSync(
    new URL('../media/dist/main.meta.json', import.meta.url),
    JSON.stringify(mainResult.metafile),
  )
}
