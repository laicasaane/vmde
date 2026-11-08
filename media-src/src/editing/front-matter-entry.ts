// Separate, lazily-loaded bundle for the front-matter properties parser (task 207). The `yaml`
// package is ~95 KB minified, so it must stay out of the eager media/dist/main.js: esbuild bundles
// this entry into media/vditor/dist/js/front-matter/front-matter-main.js (media-src/build.mjs) and
// front-matter-table.ts loads it on demand, only when a document actually has front matter, then
// reads `window.__vmdeFrontMatter`. Exposes FUNCTIONS only and injects no DOM (Lute round-trip safe).
import { parseFrontMatterProperties } from '../../../src/shared/front-matter'
;(
  window as unknown as { __vmdeFrontMatter?: Record<string, unknown> }
).__vmdeFrontMatter = { parse: parseFrontMatterProperties }
