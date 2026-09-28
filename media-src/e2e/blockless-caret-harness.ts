import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import { guardToolbarScroll } from '../src/chrome/toolbar-scroll-guard'
import {
  installCaretInvalidation,
  installCaretWindowBridge,
} from '../src/editing/caret'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import { installFormatWordExpand } from '../src/editing/selection-scope'
import { installCompositionState } from '../src/util/caret-gesture'

export interface BlocklessCaretSnapshot {
  isRoot: boolean
  inEditor: boolean
  anchorText: string | null
  anchorOffset: number
  inHeading: boolean
  inMarker: boolean
  blockText: string | null
}

export interface BlocklessCaretHarness {
  __ready: boolean
  __caret(): BlocklessCaretSnapshot
  __seedRoot(offset: number): void
  __placeText(needle: string, offset: number): void
  __fresh(): { rangeCount: number; hasIrRange: boolean }
  __value(): string
}

const DOCS: Record<string, string> = {
  heading:
    '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n',
  'paragraph-first':
    'Alpha bravo charlie delta.\n\n# Probe\n\nEcho `foxtrot` golf hotel.\n',
  code: 'Alpha\n\n```js\nalpha\nbeta\n```\n\nOmega\n',
}
const doc = new URLSearchParams(location.search).get('doc') ?? 'heading'
if (!(doc in DOCS)) throw new Error(`Unknown blockless-caret document: ${doc}`)

// Match boot/main.ts ordering: real gestures retire stale caret intents before marker reveal.
// This harness deliberately leaves production normalization and Vditor toolbar code untouched.
installCompositionState()
installCaretInvalidation()
installCaretWindowBridge()
installIrMarkerReveal()

const editor = new Vditor('app', {
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  cache: { enable: false },
  toolbar: createToolbar(),
  toolbarConfig: { pin: true },
  value: DOCS[doc],
  after() {
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const root = inner.ir.element
    ;(window as unknown as { vditor: Vditor }).vditor = editor
    guardToolbarScroll(editor)
    installFormatWordExpand()
    const harness = window as unknown as BlocklessCaretHarness
    harness.__caret = () => {
      const selection = window.getSelection()
      const anchor = selection?.anchorNode ?? null
      const element = anchor instanceof Element ? anchor : anchor?.parentElement
      return {
        isRoot: anchor === root,
        inEditor: !!anchor && root.contains(anchor),
        anchorText: anchor instanceof Text ? anchor.data : null,
        anchorOffset: selection?.anchorOffset ?? -1,
        inHeading: !!element?.closest('h1,h2,h3,h4,h5,h6'),
        inMarker: !!element?.closest('.vditor-ir__marker'),
        blockText: element?.closest('[data-block]')?.textContent ?? null,
      }
    }
    harness.__seedRoot = (offset) => {
      root.focus()
      window.getSelection()!.collapse(root, offset)
      document.dispatchEvent(new Event('selectionchange'))
    }
    harness.__placeText = (needle, offset) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node as Text
        if (!text.data.includes(needle)) continue
        // Code has source and preview copies. Only place into editable source, never a render.
        if (text.parentElement?.closest('[data-render]')) continue
        root.focus()
        window
          .getSelection()!
          .collapse(text, text.data.indexOf(needle) + offset)
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`No editable text containing ${JSON.stringify(needle)}`)
    }
    harness.__fresh = () => ({
      rangeCount: window.getSelection()?.rangeCount ?? 0,
      hasIrRange: !!inner.ir.range,
    })
    harness.__value = () => editor.getValue()
    harness.__ready = true
  },
})
