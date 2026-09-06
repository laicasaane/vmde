import Vditor from 'vditor/src/index'
import {
  ensureFoldTargetVisible,
  installSectionFold,
  toggleFoldAtCaret,
  type SectionFoldState,
} from '../src/nav/section-fold'

const initial = [
  '# One',
  '',
  'one body',
  '',
  '## Child',
  '',
  'child body',
  '',
  '# Two',
  '',
  '- parent',
  '  - nested a',
  '  - nested b',
  '',
  'tail paragraph',
  '',
  '# Geometry H1',
  '',
  'geometry body 1',
  '',
  '## Geometry H2',
  '',
  'geometry body 2',
  '',
  '### Geometry H3',
  '',
  'geometry body 3',
  '',
  '#### Geometry H4',
  '',
  'geometry body 4',
  '',
  '##### Geometry H5',
  '',
  'geometry body 5',
  '',
  '###### Geometry H6',
  '',
  'geometry body 6',
  '',
  '# Geometry End',
].join('\n')

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  height: 420,
  cdn: `${location.origin}/vditor`,
  value: initial,
  toolbar: ['edit-mode'],
  customWysiwygToolbar: () => {
    /* Vditor calls this while building WYSIWYG controls. */
  },
  after() {
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    ;(window as any).vditor = editor
    let foldState: SectionFoldState = { headings: [], lists: [] }
    installSectionFold(editor, undefined, (state) => {
      foldState = state
    })

    const surface = () => inner[inner.currentMode].element as HTMLElement
    const place = (needle: string) => {
      const root = surface()
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.nodeValue ?? '').indexOf(needle)
        if (index < 0 || node.parentElement?.closest('[data-render]')) continue
        const range = document.createRange()
        range.setStart(node, index)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        return true
      }
      return false
    }

    ;(window as any).__initial = initial
    ;(window as any).__getValue = () => editor.getValue()
    ;(window as any).__foldState = () => foldState
    ;(window as any).__toggleAt = (needle: string) =>
      place(needle) && toggleFoldAtCaret()
    ;(window as any).__foldKeyAt = (needle: string) => {
      if (!place(needle)) return false
      const event = new KeyboardEvent('keydown', {
        key: '[',
        code: 'BracketLeft',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      })
      surface().dispatchEvent(event)
      return event.defaultPrevented
    }
    ;(window as any).__ensureText = (needle: string) => {
      const root = surface()
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>('[data-block], li, ul, ol'),
      )
      const target = candidates.find((element) =>
        (element.textContent ?? '').includes(needle),
      )
      return target ? ensureFoldTargetVisible(target) : false
    }
    ;(window as any).__foldView = () => {
      const root = surface()
      return {
        mode: inner.currentMode,
        foldedHeadings: Array.from(
          root.querySelectorAll<HTMLElement>('[data-vmde-folded]'),
        ).map((element) => ({
          text: element.textContent?.trim() ?? '',
          count: element.dataset.vmdeFoldCount,
        })),
        foldedLists: root.querySelectorAll('[data-vmde-list-folded]').length,
        hiddenTexts: Array.from(
          root.querySelectorAll<HTMLElement>('[data-vmde-fold-hidden]'),
        ).map((element) => element.textContent?.trim() ?? ''),
      }
    }
    ;(window as any).__switchMode = (next: 'ir' | 'wysiwyg') => {
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
    ;(window as any).__respin = () => editor.setValue(editor.getValue())
    ;(window as any).__ready = true
  },
})
