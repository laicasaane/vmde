import Vditor from 'vditor/src/index'
import { expandMarker } from 'vditor/src/ts/ir/expandMarker'
import {
  configureFindReplaceActions,
  installFindReplace,
  installStructuralSelection,
  openFindReplace,
} from '../src/editing/selection-scope'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import { installCompositionState } from '../src/util/caret-gesture'
import { installCaretInvalidation, requestCaret } from '../src/editing/caret'
import { installEscapeToolbar } from '../src/editing/escape-toolbar'
import { activeModeElement } from '../src/util/source-map'
import { findScroller } from '../src/chrome/toolbar-scroll-guard'

installCompositionState()
installCaretInvalidation()
installIrMarkerReveal()

const value = [
  'alpha **bold scope** omega',
  '',
  '- first item',
  '  - nested item',
  '',
  '| A | B |',
  '| --- | --- |',
  '| cell one | cell two |',
  '',
  '```ts',
  'const fence = true',
  '```',
  '',
  'final paragraph',
].join('\n')

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  height: 440,
  cdn: `${location.origin}/vditor`,
  value,
  after() {
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const surface = inner.ir.element
    ;(window as unknown as { vditor: Vditor }).vditor = editor
    // Match finish-init.ts's listener order: Escape must arm the toolbar route before structural
    // selection consumes the same key with stopImmediatePropagation.
    installEscapeToolbar()
    installStructuralSelection()
    configureFindReplaceActions({
      setApplying: () => {
        /* host suppression is outside this browser-only harness */
      },
      postExact: () => {
        /* getValue assertions cover the browser transaction directly */
      },
      onError: (error) => {
        throw error
      },
    })
    installFindReplace()
    ;(window as any).__openFindReplace = openFindReplace
    ;(window as any).__getValue = () => editor.getValue()
    ;(window as any).__setValue = (markdown: string) =>
      editor.setValue(markdown)
    ;(window as any).__undoFindReplace = () => inner.undo.undo(inner)
    ;(window as any).__mode = () => inner.currentMode
    // Task 196 Checkpoint 1: scrolls the ACTIVE mode's real scroll container (not the window),
    // mirroring `revealCurrent`/`renderOverlays` in selection-scope.ts, which key off the same
    // `findScroller(activeModeElement(...))` pair. Needed to reproduce the large-fixture scroll
    // phase across IR/WYSIWYG/SV without hard-coding a mode-specific container.
    ;(window as any).__scrollEditor = (deltaY: number): number => {
      const root = activeModeElement(editor)
      if (!root) return 0
      const scroller = findScroller(root)
      scroller.scrollTop = Math.max(
        0,
        Math.min(
          scroller.scrollTop + deltaY,
          scroller.scrollHeight - scroller.clientHeight,
        ),
      )
      scroller.dispatchEvent(new Event('scroll'))
      return scroller.scrollTop
    }
    ;(window as any).__switchMode = (next: 'ir' | 'wysiwyg' | 'sv') => {
      if (inner.currentMode === next) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${next}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }

    ;(
      window as unknown as {
        __focusText(needle: string): boolean
      }
    ).__focusText = (needle) => {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.nodeValue ?? '').indexOf(needle)
        if (index < 0) continue
        surface.focus()
        const range = document.createRange()
        range.setStart(node, index + Math.floor(needle.length / 2))
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    }

    ;(
      window as unknown as {
        __focusFenceSource(): Promise<boolean>
      }
    ).__focusFenceSource = async () => {
      const code = surface.querySelector<HTMLElement>(
        '[data-type="code-block"] > .vditor-ir__marker--pre > code',
      )
      if (!code) return false
      surface.focus()
      const place = () => {
        const text = code.firstChild
        if (!(text instanceof Text)) return null
        const range = document.createRange()
        range.setStart(text, Math.min(3, text.data.length))
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        return range
      }
      const range = place()
      if (!range) return false
      expandMarker(range, inner)
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      )
      const text = code.firstChild
      return text instanceof Text
        ? requestCaret({ node: text, offset: Math.min(3, text.data.length) })
        : false
    }

    ;(
      window as unknown as {
        __selectFenceSourceStage(): Promise<boolean>
        __focusFenceSource(): Promise<boolean>
      }
    ).__selectFenceSourceStage = async () => {
      const ok = await (
        window as unknown as { __focusFenceSource(): Promise<boolean> }
      ).__focusFenceSource()
      if (!ok) return false
      const event = new KeyboardEvent('keydown', {
        key: 'a',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      })
      surface.dispatchEvent(event)
      return event.defaultPrevented
    }

    ;(
      window as unknown as {
        __selectionText(): string
      }
    ).__selectionText = () => getSelection()?.toString() ?? ''
    ;(
      window as unknown as {
        __expandedTypes(): string[]
      }
    ).__expandedTypes = () =>
      Array.from(
        surface.querySelectorAll<HTMLElement>('.vditor-ir__node--expand'),
      ).map((node) => node.getAttribute('data-type') ?? '?')
    ;(
      window as unknown as {
        __copySelection(): { plain: string; html: string }
      }
    ).__copySelection = () => {
      const data = new DataTransfer()
      data.setData('text/plain', '__UNSET__')
      data.setData('text/html', '__UNSET__')
      surface.dispatchEvent(
        new ClipboardEvent('copy', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
      return {
        plain: data.getData('text/plain'),
        html: data.getData('text/html'),
      }
    }
    ;(window as unknown as { __ready: boolean }).__ready = true
  },
})
