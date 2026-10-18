import '../src/boot/preload'
import Vditor from 'vditor'
import { setupOutlineFlash } from '../src/nav/outline'
import { installOutlineKeyboard } from '../src/nav/outline-keyboard'
import { installOutlineViewportSync } from '../src/nav/outline-viewport-sync'
import { setupOutlineResize } from '../src/nav/outline-resize'
import { installOutlineState } from '../src/nav/outline-state'
import { buildVditorOptions } from '../src/boot/vditor-options'
import { installOutlineReorder } from '../src/nav/outline-reorder'
import {
  moveMarkdownSection,
  scanSourceHeadings,
} from '../../src/shared/section-move'

// Real Vditor (IR) with headings + the outline panel enabled on the right, and
// the outline-click flash wired up — mirrors how main.ts sets it for tasks
// 07/08/13. Globals let the spec read/drive the outline and headings.
const sectionFill = (name: string) =>
  Array.from(
    { length: 12 },
    (_, index) => `${name} paragraph ${index + 1} keeps the editor scrollable.`,
  ).join('\n\n')

const value = [
  sectionFill('Preamble'),
  '',
  '# First heading',
  '',
  '## Second heading',
  '',
  sectionFill('First section'),
  '',
  '### Third heading',
  '',
  '## Fourth heading',
  '',
  sectionFill('Middle section'),
  '',
  '## Fifth heading',
  '',
  sectionFill('Last section'),
  '',
].join('\n')

// Task 650: init values for the Outline open state come from the query string
// (`?outlineOpen=1|0` = the remembered value, `?defaultOpen=1` = vmde.outline.defaultOpen), resolved
// by the real buildVditorOptions rule.
const query = new URLSearchParams(location.search)
const outlineInit = buildVditorOptions({
  options: {
    showOutlineByDefault: query.get('defaultOpen') === '1',
    ...(query.has('outlineOpen')
      ? { outlineOpen: query.get('outlineOpen') === '1' }
      : {}),
    outlinePosition: 'right',
  },
}).outline

// Task 656: `?outlineVar=<px>` sets the stored width var before Vditor is built, mirroring
// applyBodyOptions in the real boot, so the initial aria-valuenow can be checked with a stored width.
if (query.has('outlineVar')) {
  document.body.style.setProperty(
    '--me-outline-width',
    `${query.get('outlineVar')}px`,
  )
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value,
  height: 360,
  outline:
    query.has('outlineOpen') || query.has('defaultOpen')
      ? outlineInit
      : { enable: true, position: 'right' },
  // Vditor 3.11 calls this unconditionally while rendering the wysiwyg
  // toolbar; without it init throws (see main.ts).
  customWysiwygToolbar: () => {
    /* required stub — see comment above */
  },
  after() {
    ;(window as any).vditor = editor
    ;(window as any).vditorTest = editor
    setupOutlineFlash(editor)
    const oel = (editor as any).vditor?.outline?.element as
      | HTMLElement
      | undefined
    // Spec reads the persisted width off this global (mirrors main.ts's real onResize, which
    // posts `save-outline-width` to the host — nothing to intercept in a page context).
    ;(window as any).__lastOutlineWidth = undefined
    // Task 656: every onResize value in order, so a spec can prove a gesture posted nothing.
    ;(window as any).__outlineWidthPosts = []
    if (oel) {
      setupOutlineResize(oel, 'right', (w) => {
        ;(window as any).__lastOutlineWidth = w
        ;(window as any).__outlineWidthPosts.push(w)
      })
    }
    installOutlineKeyboard(editor)
    ;(window as any).__outlineOpenPosts = []
    const outlineBtn = (editor as any).vditor?.toolbar?.elements?.outline as
      | HTMLElement
      | undefined
    if (outlineBtn) {
      installOutlineState(outlineBtn, {
        readEnabled: () =>
          (editor as any).vditor.options.outline.enable === true,
        remember: () => {
          /* the session-state copy is covered by the Vitest suite */
        },
        api: {
          postMessage: (m: unknown) =>
            (window as any).__outlineOpenPosts.push(m),
        } as any,
      })
    }
    installOutlineViewportSync(editor)
    ;(window as any).__outlineReorderCount = 0
    installOutlineReorder(editor, ({ sourceIndex, targetIndex, placement }) => {
      const before = editor.getValue()
      const headings = scanSourceHeadings(before)
      const result = moveMarkdownSection(
        before,
        headings[sourceIndex],
        headings[targetIndex],
        placement,
      )
      if (result.status !== 'ok') return
      editor.setValue(result.markdown)
      ;(window as any).__outlineReorderCount++
    })
    ;(window as any).__ready = true
  },
})
