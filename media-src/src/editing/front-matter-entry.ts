// Separate, lazily-loaded bundle for the front-matter properties parser (task 207). The `yaml`
// package is ~95 KB minified, so it must stay out of the eager media/dist/main.js: esbuild bundles
// this entry into media/vditor/dist/js/front-matter/front-matter-main.js (media-src/build.mjs) and
// front-matter-table.ts loads it on demand, only when a document actually has front matter, then
// reads `window.__vmdeFrontMatter`. Exposes FUNCTIONS only and injects no DOM (Lute round-trip safe).
// Task 725: `parse` also returns the edit rows of an editable table, and `edit` applies one table
// edit to the whole document; `yaml` reads a document's front-matter text (front-matter-editor.ts
// reads both once the bundle has loaded).
import { frontMatterYaml } from '../../../src/shared/front-matter'
import {
  editFrontMatterDocument,
  parseFrontMatterTable,
} from './front-matter-edit-model'
;(
  window as unknown as { __vmdeFrontMatter?: Record<string, unknown> }
).__vmdeFrontMatter = {
  parse: parseFrontMatterTable,
  edit: editFrontMatterDocument,
  yaml: frontMatterYaml,
}
