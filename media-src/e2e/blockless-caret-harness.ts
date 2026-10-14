import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import { guardToolbarScroll } from '../src/chrome/toolbar-scroll-guard'
import {
  installCaretInvalidation,
  installCaretWindowBridge,
} from '../src/editing/caret'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import {
  runVditorChord,
  VDITOR_CHORD_ACTIONS,
} from '../src/editing/vditor-chord-actions'
import {
  observeGapParagraphs,
  observeTrailingParagraph,
  setupTrailingNav,
} from '../src/editing/gap-paragraph'
import { setupGapNav } from '../src/editing/gap-nav'
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
  // Task 608: top-level block shape — tag (or data-type) labels, how many carry the manufactured
  // gap tag, and how many root-level text nodes carry visible text.
  __shape(): { blocks: string[]; gaps: number; rootText: number }
  // Task 608 S3: the Format: Heading N chord, as the command sends it.
  __chord(action: string): boolean
  // Task 608 S3: Vditor's own history (stack sizes) and one Undo step through its engine.
  __history(): { undo: number; redo: number }
  __undo(): void
  // Task 608 S3: the opening checkpoint the product's undo boundary takes before the first edit.
  __baseline(): void
  // Task 608 S3: drop the history checkpoint a gesture queued, so only the action under test can
  // add one.
  __quiesce(): void
  // Task 608 S3: the empty editor, no child node at all, with the caret on the root (the state
  // Vditor's own empty-editor path in processToolbar handles).
  __empty(): void
  // Task 608 S3: the in-block control. An empty block paragraph at the given root offset with the
  // caret inside it, which is where Vditor's own empty-editor path puts the caret.
  __holder(offset: number): void
  // Task 608 S3: where the live selection starts (root offset, or null inside a block).
  __selection(): {
    collapsed: boolean
    startIsRoot: boolean
    startOffset: number
  }
}

const DOCS: Record<string, string> = {
  heading:
    '# Probe\n\nAlpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n',
  'paragraph-first':
    'Alpha bravo charlie delta.\n\n# Probe\n\nEcho `foxtrot` golf hotel.\n',
  // Task 608: documents whose first block is atomic. `----` (not `---`) so it is a rule, not
  // front matter; `[toc]` renders as a non-editable table of contents when markdown.toc is on.
  'hr-first':
    '----\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n',
  'hr-last': 'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n\n----\n',
  'toc-first':
    '[toc]\n\n# Probe\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n',
  // Task 608 S3: a rule between paragraphs, and two paragraphs (a table between them).
  'hr-middle':
    'Alpha bravo charlie delta.\n\n----\n\nEcho foxtrot golf hotel.\n',
  paragraphs: 'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n',
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
  preview: { markdown: { toc: true } },
  after() {
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const root = inner.ir.element
    ;(window as unknown as { vditor: Vditor }).vditor = editor
    // Wired as boot/main.ts does (after the window.vditor assignment the mover reads the mode from).
    observeGapParagraphs(() => root)
    observeTrailingParagraph(root)
    setupGapNav(() => root)
    setupTrailingNav(() => root)
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
    harness.__shape = () => ({
      blocks: Array.from(root.children).map(
        (child) =>
          child.getAttribute('data-type') || child.tagName.toLowerCase(),
      ),
      gaps: root.querySelectorAll(':scope > [data-vmde-gap]').length,
      rootText: Array.from(root.childNodes).filter(
        (node) => node.nodeType === Node.TEXT_NODE && node.data.trim() !== '',
      ).length,
    })
    harness.__chord = (action) => {
      const entry = VDITOR_CHORD_ACTIONS.find(([name]) => name === action)
      if (!entry) throw new Error(`Unknown chord action: ${action}`)
      return runVditorChord(entry[1])
    }
    harness.__history = () => ({
      undo: inner.undo.ir.undoStack.length,
      redo: inner.undo.ir.redoStack.length,
    })
    harness.__undo = () => inner.undo.undo(inner)
    harness.__baseline = () => inner.undo.addToUndoStack(inner)
    harness.__quiesce = () => {
      clearTimeout(inner.ir.processTimeoutId)
      inner.ir.vmdeAfterRender = undefined
    }
    harness.__empty = () => {
      root.innerHTML = ''
      root.focus()
      window.getSelection()!.collapse(root, 0)
      document.dispatchEvent(new Event('selectionchange'))
    }
    harness.__holder = (offset) => {
      const holder = document.createElement('p')
      holder.setAttribute('data-block', '0')
      root.insertBefore(holder, root.childNodes[offset] ?? null)
      root.focus()
      window.getSelection()!.collapse(holder, 0)
      document.dispatchEvent(new Event('selectionchange'))
    }
    harness.__selection = () => {
      const selection = window.getSelection()!
      const range = selection.rangeCount ? selection.getRangeAt(0) : null
      return {
        collapsed: range?.collapsed ?? true,
        startIsRoot: range?.startContainer === root,
        startOffset: range?.startOffset ?? -1,
      }
    }
    harness.__ready = true
  },
})
