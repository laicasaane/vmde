import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { setupSaveFlushKeybind } from '../src/bridge/save-flush'
import { setupCalloutArrowNav } from '../src/editing/callout-nav'
import { installCaretInvalidation } from '../src/editing/caret'
import {
  installCompositionState,
  isCompositionActive,
} from '../src/util/caret-gesture'
import { fixTableIr } from '../src/editing/fix-table-ir'
import { setupFormatHotkeyGuard } from '../src/editing/format-hotkey-guard'
import {
  observeGapParagraphs,
  setupTrailingNav,
} from '../src/editing/gap-paragraph'
import { setupGapNav } from '../src/editing/gap-nav'
import { installHistoryKeybindingShim } from './keybinding-shim'
import {
  ensureHljsLoaded,
  observeWysiwygCodeHighlight,
  wrapLuteFlatten,
} from '../src/editing/wysiwyg-code-highlight'
import { activeModeElement } from '../src/util/source-map'

type TargetKind = 'prose' | 'code' | 'table'

function targetForKind(
  kind: TargetKind,
  host: Element | null | undefined,
): Element | null {
  if (kind === 'code')
    return host?.closest('pre.vditor-wysiwyg__pre > code') ?? null
  if (kind === 'table') return host?.closest('td, th') ?? null
  return host?.closest('p') ?? null
}

function surfaceHasFocus(surface: HTMLElement | undefined): boolean {
  if (!surface || !document.activeElement) return false
  return (
    document.activeElement === surface ||
    surface.contains(document.activeElement)
  )
}

const params = new URLSearchParams(location.search)
const mode = params.get('mode') === 'wysiwyg' ? 'wysiwyg' : 'ir'
const cdn = `${location.origin}/vditor`

installCompositionState()
installCaretInvalidation()

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn,
  value: '',
  preview: { hljs: { style: 'github', lineNumber: false } },
  // `hotkey: ''` as in chrome/toolbar.ts: the keybinding shim owns Ctrl/Cmd+Z and +Y.
  toolbar: [
    { name: 'undo', hotkey: '' },
    { name: 'redo', hotkey: '' },
  ],
  customWysiwygToolbar: () => {
    /* Vditor calls this unconditionally while constructing WYSIWYG. */
  },
  after() {
    ;(window as any).vditor = editor
    const activeEditor = () => activeModeElement(editor)
    installHistoryKeybindingShim(window)
    setupSaveFlushKeybind(window, () => undefined)
    setupFormatHotkeyGuard(window)
    setupGapNav(activeEditor)
    setupTrailingNav(activeEditor)
    setupCalloutArrowNav(activeEditor, () => editor.vditor)
    observeGapParagraphs(activeEditor)
    fixTableIr()

    let highlightReady = Promise.resolve()
    if (mode === 'wysiwyg') {
      wrapLuteFlatten(editor)
      observeWysiwygCodeHighlight(
        document.getElementById('app'),
        () => (window as any).hljs,
      )
      highlightReady = ensureHljsLoaded(cdn).then(() => {
        document.dispatchEvent(new Event('selectionchange'))
      })
    }

    let targetKind: TargetKind = 'prose'
    ;(window as any).__imePrepare = async (
      markdown: string,
      needle: string,
      nextTarget: TargetKind,
    ) => {
      targetKind = nextTarget
      editor.setValue(markdown)
      const canonical = editor.getValue()
      await highlightReady
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )

      if (targetKind === 'code') {
        document
          .querySelector<HTMLElement>(
            '.vditor-wysiwyg__block[data-type="code-block"]',
          )
          ?.click()
        document.dispatchEvent(new Event('selectionchange'))
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        )
      }

      const surface = activeEditor()
      if (!surface) throw new Error('active editor not found')
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      let target: Text | null = null
      let offset = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(needle)
        if (index < 0) continue
        target = node as Text
        offset = index + needle.length
        break
      }
      if (!target) throw new Error(`caret needle not found: ${needle}`)
      const range = document.createRange()
      range.setStart(target, offset)
      range.collapse(true)
      const selection = getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      surface.focus({ preventScroll: true })
      return canonical
    }

    ;(window as any).__imeState = () => {
      const surface = activeEditor()
      const selection = getSelection()
      const anchor = selection?.rangeCount ? selection.anchorNode : null
      const host =
        anchor?.nodeType === Node.ELEMENT_NODE
          ? (anchor as Element)
          : anchor?.parentElement
      const target = targetForKind(targetKind, host)
      let textBeforeCaret = ''
      if (target && anchor && selection) {
        const prefix = document.createRange()
        prefix.selectNodeContents(target)
        prefix.setEnd(anchor, selection.anchorOffset)
        textBeforeCaret = prefix.toString()
      }
      return {
        composing: isCompositionActive(),
        collapsed: selection?.isCollapsed === true,
        focused: surfaceHasFocus(surface),
        target: target ? targetKind : null,
        textBeforeCaret,
      }
    }
    ;(window as any).__ready = true
  },
})
