import Vditor from 'vditor/src/index'
import {
  registerEditorActionRunner,
  runEditorAction,
} from '../src/bridge/editor-actions'
import { installBlockHandleLayer } from '../src/nav/block-handle'
import {
  ensureFoldTargetVisible,
  foldAtCaret,
  installSectionFold,
  toggleFoldAtCaret,
  unfoldAtCaret,
  type SectionFoldState,
} from '../src/nav/section-fold'
import { installKeybindingShim } from './keybinding-shim'

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
    let foldPersistCount = 0
    installSectionFold(editor, undefined, (state) => {
      foldState = state
      foldPersistCount += 1
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
    ;(window as any).__foldPersistCount = () => foldPersistCount
    ;(window as any).__toggleAt = (needle: string) =>
      place(needle) && toggleFoldAtCaret()
    ;(window as any).__place = place
    // Task 580 CP2-4 — Fold, Unfold and Toggle Fold run from their default keys through the test
    // keybinding shim, the way VS Code resolves them: Fold/Unfold as editor actions through the
    // production dispatcher, Toggle Fold through its `toggle-section-fold` message.
    registerEditorActionRunner('fold', () => {
      foldAtCaret()
    })
    registerEditorActionRunner('unfold', () => {
      unfoldAtCaret()
    })
    installKeybindingShim(window, {
      commands: ['vmde.fold', 'vmde.unfold', 'vmde.toggleSectionFold'],
      platform: navigator.platform.toLowerCase().includes('mac')
        ? 'mac'
        : 'win-linux',
      dispatch: (route) => {
        if (route.command === 'editor-action') runEditorAction(route.action)
        else if (route.command === 'toggle-section-fold') toggleFoldAtCaret()
      },
    })
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
    installBlockHandleLayer(surface, {
      snapshot: () => ({
        exact: editor.getValue(),
        rendered: editor.getValue(),
      }),
      move: () => undefined,
      delete: () => undefined,
      duplicate: () => undefined,
      turnInto: () => undefined,
    })
    ;(window as any).__respin = () => editor.setValue(editor.getValue())
    ;(window as any).__ready = true
  },
})
