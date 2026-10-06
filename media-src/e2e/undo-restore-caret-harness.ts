import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import {
  findScroller,
  guardToolbarScroll,
} from '../src/chrome/toolbar-scroll-guard'
import {
  installCaretInvalidation,
  installCaretWindowBridge,
} from '../src/editing/caret'
import { caretLineRect } from '../src/editing/nav-geometry'
import { installUndoRestoreCaret } from '../src/editing/undo-restore-caret'
import { installCompositionState } from '../src/util/caret-gesture'

// Task 597 — Vditor built from SOURCE, so the build's undo patches apply (the main harness uses
// the prebuilt dist). The bridges are installed in main.ts order: composition state, caret
// invalidation, the caret authority bridge, then the undo-restore fallback bridge. The real
// toolbar and its scroll guard are wired as finish-init.ts wires them, for the mouse-toolbar
// reveal case.
installCompositionState()
installCaretInvalidation()
installCaretWindowBridge()
installUndoRestoreCaret()

const SMALL =
  '# Probe\n\nAlpha bravo charlie\n\nDelta echo foxtrot\n\nGolf `hotel` india\n\n```js\nlet kilo = 1\n```\n'
const TALL = Array.from(
  { length: 60 },
  (_, i) =>
    `Para ${String(i).padStart(2, '0')} lorem ipsum dolor sit amet consectetur.`,
).join('\n\n')

const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'ir') as 'ir' | 'wysiwyg' | 'sv'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  height: 360,
  cdn: `${location.origin}/vditor`,
  value: params.get('doc') === 'tall' ? TALL : SMALL,
  undoDelay: 800,
  toolbar: createToolbar(),
  after() {
    ;(window as any).vditor = editor
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const root = () => inner[inner.currentMode].element as HTMLElement
    const excluded =
      '.vditor-ir__preview, .vditor-wysiwyg__preview, [data-render], [contenteditable="false"]'
    guardToolbarScroll(editor, inner.toolbar.element)
    ;(window as any).__value = () => editor.getValue()
    ;(window as any).__undo = () => {
      try {
        inner.undo.undo(inner)
        return null
      } catch (error) {
        return String(error)
      }
    }
    ;(window as any).__redo = () => {
      try {
        inner.undo.redo(inner)
        return null
      } catch (error) {
        return String(error)
      }
    }
    ;(window as any).__stack = () => ({
      undo: inner.undo[inner.currentMode].undoStack.length,
      redo: inner.undo[inner.currentMode].redoStack.length,
    })
    ;(window as any).__lastTextHasMarker = () =>
      inner.undo[inner.currentMode].lastText.includes('<wbr>')
    // Collapsed caret `offset` characters into the first editable text node containing `needle`.
    ;(window as any).__place = (
      needle: string,
      offset = 0,
      inPreview = false,
    ) => {
      const el = root()
      el.focus()
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const isPreview = !!node.parentElement?.closest(excluded)
        if (isPreview !== inPreview) continue
        const index = (node.textContent ?? '').indexOf(needle)
        if (index < 0) continue
        getSelection()!.collapse(node, index + offset)
        return true
      }
      return false
    }
    ;(window as any).__collapseAtRoot = () => {
      getSelection()!.collapse(root(), 0)
    }
    ;(window as any).__clearSelection = () => {
      getSelection()!.removeAllRanges()
    }
    ;(window as any).__selection = () => {
      const el = root()
      const selection = getSelection()!
      const node = selection.focusNode
      if (!node || !selection.rangeCount)
        return { inBlock: false, collapsed: false, measurable: false }
      const host =
        node.nodeType === Node.TEXT_NODE
          ? node.parentElement
          : (node as Element)
      const block = host?.closest(
        'p, h1, h2, h3, h4, h5, h6, li, blockquote, td, th, pre, [data-block]',
      )
      const rect = caretLineRect(selection.getRangeAt(0))
      return {
        inBlock:
          node !== el &&
          el.contains(node) &&
          !!block &&
          block !== el &&
          el.contains(block) &&
          !host?.closest(excluded),
        collapsed: selection.isCollapsed,
        measurable: !!rect && rect.height > 0,
        focused: document.activeElement === el,
      }
    }
    // Whether the caret's line box lies inside the editor's scroll viewport.
    ;(window as any).__caretVisible = () => {
      const selection = getSelection()!
      const el = root()
      if (!selection.rangeCount || selection.focusNode === el) return false
      if (!el.contains(selection.focusNode)) return false
      const rect = caretLineRect(selection.getRangeAt(0))
      if (!rect || rect.height <= 0) return false
      const scroller = findScroller(root())
      const view = scroller.getBoundingClientRect()
      return rect.top >= view.top && rect.bottom <= view.bottom
    }
    ;(window as any).__scrollTo = (where: 'top' | 'bottom') => {
      const scroller = findScroller(root())
      scroller.scrollTop = where === 'top' ? 0 : scroller.scrollHeight
      return scroller.scrollTop
    }
    ;(window as any).__scrollTop = () => findScroller(root()).scrollTop
    ;(window as any).__toolbarDisabled = (name: string) =>
      !!inner.toolbar.elements[name]?.children[0]?.classList.contains(
        'vditor-menu--disabled',
      )
    ;(window as any).__ready = true
  },
})
