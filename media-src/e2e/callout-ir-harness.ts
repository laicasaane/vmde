// Real-Vditor (IR) harness for the callout dual-node (task 106 v2). A `> [!NOTE]` blockquote +
// surrounding paragraphs so the caret can move in/out. Runs the production `observeCallouts` so the
// callout is tagged `vditor-ir__node` + gets its injected preview, then exposes helpers to drive
// the caret + Vditor's `expandMarker` and read the markdown back (round-trip).
import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { expandMarker } from 'vditor/src/ts/ir/expandMarker'
import {
  calloutWysiwygToolbar,
  configureCalloutActions,
  installCalloutAuthoringControls,
  observeCallouts,
} from '../src/editing/callouts'
import { createToolbar } from '../src/chrome/toolbar'
import { installEditorCaretTracking } from '../src/editing/editor-caret'
import { installNativePopoverPlacement } from '../src/chrome/native-popover-position'

const value = `# doc

before paragraph

> [!NOTE]
> body text of the note

after paragraph
`
const authoring = new URLSearchParams(location.search).get('authoring') === '1'
const showToolbar = new URLSearchParams(location.search).get('toolbar') !== '0'

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  height: 500,
  cdn: `${location.origin}/vditor`,
  value,
  ...(authoring
    ? {
        toolbar: showToolbar ? createToolbar() : [],
        customWysiwygToolbar: (type: string, popover: HTMLElement) =>
          calloutWysiwygToolbar(type, popover),
      }
    : {}),
  after() {
    const iv = (editor as any).vditor
    const el = () => iv.ir.element as HTMLElement
    ;(window as any).vditor = editor
    ;(window as any).__el = el
    ;(window as any).__bq = () =>
      el().querySelector('blockquote') as HTMLElement
    ;(window as any).__getValue = () => editor.getValue()

    let exactPosts = 0
    let lastExact = ''
    if (authoring) {
      configureCalloutActions({
        setApplying: () => undefined,
        postExact: (markdown) => {
          exactPosts++
          lastExact = markdown
        },
        onError: (error) => {
          throw error
        },
      })
    }
    // Production wiring: stable observer + shared toolbar/IR/WYS controls and caret snapshot.
    observeCallouts(authoring ? document.getElementById('app') : el())
    if (authoring) {
      installEditorCaretTracking()
      installCalloutAuthoringControls()
      installNativePopoverPlacement()
    }

    const caretAndExpand = (node: Node, offset: number) => {
      const range = document.createRange()
      range.setStart(node, offset)
      range.collapse(true)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      expandMarker(range, iv) // what Vditor calls on a real caret move (linchpin proven separately)
    }

    // Caret into the callout's source <p> → Vditor expands it.
    ;(window as any).__caretInside = () => {
      const p = el().querySelector(
        'blockquote[data-callout] > p',
      ) as HTMLElement
      caretAndExpand(p.firstChild as Node, 1)
    }
    // Caret into the trailing paragraph → callout collapses.
    ;(window as any).__caretOutside = () => {
      const paras = el().querySelectorAll(':scope > p')
      const after = paras[paras.length - 1] as HTMLElement
      caretAndExpand(after.firstChild as Node, 1)
    }

    // Task 179 — focus the IR surface + put the caret at the END of the callout body so a real
    // Playwright keystroke burst types into it (exercises SpinVditorIRDOM + observeCallouts).
    ;(window as any).__focusBodyEnd = () => {
      const p = el().querySelector(
        'blockquote[data-callout] > p',
      ) as HTMLElement
      const t = p.firstChild as Text // "[!NOTE]\nbody text of the note"
      el().focus()
      caretAndExpand(t, t.data.length)
    }
    // Live snapshot of the callout's editing state — re-queried fresh (the re-spin replaces nodes).
    ;(window as any).__state = () => {
      const bq = el().querySelector(
        'blockquote[data-callout]',
      ) as HTMLElement | null
      const src = bq?.querySelector(':scope > p') as HTMLElement | null
      const sel = window.getSelection()
      const anchor = sel?.rangeCount ? sel.anchorNode : null
      const host = anchor
        ? anchor.nodeType === 1
          ? (anchor as Element)
          : anchor.parentElement
        : null
      return {
        srcText: src?.textContent ?? null,
        // caret still inside the callout's editable source (not ejected, not in the preview)
        caretInCallout: !!(
          anchor &&
          bq?.contains(anchor) &&
          !host?.closest('.vmde-callout__preview')
        ),
        expanded: !!bq?.classList.contains('vditor-ir__node--expand'),
        editing: !!bq?.hasAttribute('data-callout-editing'),
        srcVisible: src ? getComputedStyle(src).display !== 'none' : false,
        value: editor.getValue(),
        exactPosts,
        lastExact,
      }
    }
    ;(window as any).__setValue = (markdown: string) =>
      editor.setValue(markdown)
    ;(window as any).__placeCaret = (
      needle: string,
      offset = needle.length,
    ) => {
      const root = iv[iv.currentMode].element as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(needle)
        if (index < 0) continue
        const range = document.createRange()
        range.setStart(node, index + offset)
        range.collapse(true)
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`${needle} not found in ${iv.currentMode}`)
    }
    ;(window as any).__switchMode = (next: 'ir' | 'wysiwyg' | 'sv') => {
      if (iv.currentMode === next) return
      iv.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${next}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }
    ;(window as any).__ready = true
  },
})
