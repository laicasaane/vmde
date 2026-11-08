// Task 207 S6/S8 — Chromium harness for the front-matter properties table. Real Vditor (IR or
// WYSIWYG via ?mode=) with the PRODUCTION observer, copy installer and CSS (/main.css). ?fm=0 drops
// the front matter, ?doc=bad uses malformed YAML, ?observe=0 leaves the table module off (baseline
// for the saved-bytes check). The lazy parser bundle is replaced by a direct import: the loader path
// (`window.__vmdeFrontMatter`) is wired in finish-init and covered by the real-VS-Code spec.
import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { parseFrontMatterProperties } from '../../src/shared/front-matter'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import {
  installFrontMatterCopy,
  observeFrontMatter,
} from '../src/editing/front-matter-table'
import { installCompositionState } from '../src/util/caret-gesture'

// Production marker reveal (boot/main.ts:162-163): Vditor's stock keyup `expandMarker` is replaced
// by this selection-driven controller, so arrow entry into a node only expands with it installed.
installCompositionState()
installIrMarkerReveal()

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === 'wysiwyg' ? 'wysiwyg' : 'ir'
const withFrontMatter = params.get('fm') !== '0'
const observe = params.get('observe') !== '0'

const goodFrontMatter = [
  '---',
  'title: "Hello"',
  'tags: [a, b]',
  `long: ${'unbroken'.repeat(14)}`,
  'description: A long value that should wrap inside the cell without overlapping the copy button at narrow widths',
  'author:',
  '  name: Ann',
  '---',
  '',
].join('\n')
const badFrontMatter = ['---', 'a: 1', 'a: 2', '---', ''].join('\n')
const frontMatter =
  params.get('doc') === 'bad' ? badFrontMatter : goodFrontMatter
const body = ['# Heading', '', 'paragraph below', ''].join('\n')
const value = (withFrontMatter ? frontMatter : '') + body

const posts: { command: string; content?: string }[] = []
;(window as any).__posts = posts
installFrontMatterCopy(window, (message) => posts.push(message))

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  height: 500,
  cdn: `${location.origin}/vditor`,
  value,
  after() {
    const iv = (editor as any).vditor
    const root = () => iv[iv.currentMode].element as HTMLElement
    ;(window as any).vditor = editor
    ;(window as any).__root = root
    ;(window as any).__getValue = () => editor.getValue()
    ;(window as any).__undoDepth = () =>
      iv.undo[iv.currentMode].undoStack?.length ?? -1
    if (observe) {
      observeFrontMatter(document.getElementById('app'), {
        loadParser: async () => parseFrontMatterProperties,
      })
    }
    ;(window as any).__ready = true
  },
})
