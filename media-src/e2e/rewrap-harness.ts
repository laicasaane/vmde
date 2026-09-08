import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import {
  runRewrapCommand,
  runRewrapDocumentCommand,
  runHeadingLevelShift,
  setupHeadingLevelShiftKeybind,
  setupRewrapKeybind,
} from '../src/editing/rewrap-command'
import { setupHistoryKeybind } from '../src/editing/undo-keybind'
import { createAutoWrapController } from '../src/editing/auto-wrap'
import { createEditSync, type EditSync } from '../src/bridge/edit-sync'
import { installEditActivity } from '../src/editing/edit-activity'
import { getCursorSourceOffset } from '../src/util/source-map'
import {
  captureTableFormatSvSelection,
  configureTableFormatCommand,
  runTableFormatCommand,
} from '../src/editing/table-format-command'
import { findScroller } from '../src/chrome/toolbar-scroll-guard'

const params = new URLSearchParams(location.search)
const requestedMode = params.get('mode')
const mode =
  requestedMode === 'sv' || requestedMode === 'wysiwyg' ? requestedMode : 'ir'
const auto = params.get('auto') === '1'
const wholeDocument = params.get('whole') === '1'
const headingShift = params.get('heading') === '1'
const requestedColumn = Number(params.get('column') ?? 12)
const column =
  Number.isFinite(requestedColumn) && requestedColumn > 0 ? requestedColumn : 12
const requestedDelay = Number(params.get('delay') ?? 500)
const delay =
  Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : 500
let syncs = 0
let exacts = 0
let lastExact = ''
let exactMarkdown = ''
let error = ''
let editSync: EditSync | undefined

const run = (authoritativeMarkdown?: string) =>
  runRewrapCommand(
    window,
    {
      column,
      setApplying: () => {
        // Harness has no competing host update to suppress.
      },
      invalidate: () => editSync?.invalidate(),
      scheduleSync: () => {
        syncs++
      },
      syncExact: () => {
        syncs++
      },
      onError: (reason) => {
        error = String(reason)
      },
    },
    authoritativeMarkdown,
  )

const runDocument = () =>
  runRewrapDocumentCommand(window, {
    column: 18,
    setApplying: () => {
      // Harness has no competing host update to suppress.
    },
    invalidate: () => {
      // Harness does not install the production incremental serializer.
    },
    scheduleSync: () => {
      syncs++
    },
    syncExact: () => {
      syncs++
    },
    onError: (reason) => {
      error = String(reason)
    },
  })

const shiftHeading = (direction: -1 | 1, section = false) =>
  runHeadingLevelShift(
    window,
    {
      column,
      setApplying: () => {
        // Harness has no competing host update to suppress.
      },
      invalidate: () => editSync?.invalidate(),
      scheduleSync: () => {
        syncs++
      },
      syncExact: () => {
        syncs++
      },
      onError: (reason) => {
        error = String(reason)
      },
    },
    direction,
    section,
  )

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn: `${location.origin}/vditor`,
  value: headingShift
    ? [
        '# Root',
        '',
        'intro',
        '',
        '## Child',
        '',
        'body',
        '',
        '### Grandchild',
        '',
        '## Sibling',
        '',
        '# Next',
        '',
        'Setext',
        '------',
        '',
      ].join('\n')
    : wholeDocument
      ? [
          '---',
          'title: protected alpha beta gamma',
          '---',
          '# Heading',
          '',
          'first alpha beta gamma delta epsilon',
          '',
          'middle alpha beta gamma delta epsilon',
          '',
          '> quote alpha beta gamma delta',
          '',
          '- list alpha beta gamma delta',
          '',
          'hard alpha  ',
          'hard beta gamma',
          '',
          '```js',
          'const protected = "alpha beta gamma delta"',
          '```',
          '',
          '| alpha | beta |',
          '| --- | --- |',
          '',
          '$$',
          'alpha beta gamma',
          '$$',
          '',
          'tail alpha beta gamma delta epsilon',
        ].join('\n')
      : auto
        ? [
            'alpha beta gamma delta epsilon',
            '',
            'two-space alpha  ',
            'two-space beta',
            '',
            'backslash alpha\\',
            'backslash beta',
            '',
          ].join('\n')
        : 'alpha beta gamma delta epsilon\n\nTail paragraph.\n',
  toolbar: ['edit-mode', 'undo', 'redo'],
  customWysiwygToolbar: () => {
    // Vditor 3.11 requires the hook even when the harness adds no custom controls.
  },
  after() {
    ;(window as unknown as { vditor: Vditor }).vditor = editor
    let captures = 0
    let getValueCalls = 0
    let fullIrSerializes = 0
    let spins = 0
    const originalGetValue = editor.getValue.bind(editor)
    editor.getValue = () => {
      getValueCalls++
      return originalGetValue()
    }
    const originalIrSerialize = editor.vditor.lute.VditorIRDOM2Md.bind(
      editor.vditor.lute,
    )
    editor.vditor.lute.VditorIRDOM2Md = (html: string) => {
      if (html.length > 50_000) fullIrSerializes++
      return originalIrSerialize(html)
    }
    const originalIrSpin = editor.vditor.lute.SpinVditorIRDOM.bind(
      editor.vditor.lute,
    )
    editor.vditor.lute.SpinVditorIRDOM = (html: string) => {
      spins++
      return originalIrSpin(html)
    }
    editSync = createEditSync({
      isSuppressed: () => false,
      docMode: {
        cvActive: false,
        streamActive: false,
        docChars: editor.getValue().length,
      },
    })
    configureTableFormatCommand({
      snapshotExactMarkdown: () => exactMarkdown || editor.getValue(),
      setApplying: () => {
        // Harness has no competing host update to suppress.
      },
      postExact: (markdown) => {
        exacts++
        lastExact = markdown
        exactMarkdown = markdown
      },
      onError: (reason) => {
        error = String(reason)
      },
    })
    setupHistoryKeybind(window)
    installEditActivity(document.getElementById('app'))
    setupRewrapKeybind(window, run)
    setupHeadingLevelShiftKeybind(window, shiftHeading)
    if (auto) {
      const controller = createAutoWrapController({
        captureTarget: () => {
          captures++
          const inner = editor.vditor
          const root = inner[inner.currentMode].element as HTMLElement
          const selection = window.getSelection()
          if (!selection?.anchorNode || !root.contains(selection.anchorNode)) {
            return null
          }
          return {
            mode: inner.currentMode,
            root,
            node: selection.anchorNode,
            offset: selection.anchorOffset,
            markdown: editSync?.snapshotMarkdown() ?? editor.getValue(),
          }
        },
        isTargetCurrent: (target) => {
          const inner = editor.vditor
          const selection = window.getSelection()
          return (
            inner.currentMode === target.mode &&
            inner[inner.currentMode].element === target.root &&
            target.root.isConnected &&
            selection?.anchorNode === target.node &&
            selection.anchorOffset === target.offset
          )
        },
        apply: (target) => run(target.markdown),
        onError: (reason) => {
          error = String(reason)
        },
      })
      controller.updateConfig({ enabled: true, delayMs: delay, column })
      document.addEventListener('input', (event) => {
        const input = event as InputEvent
        controller.handleInput({
          inputType: input.inputType,
          isComposing: input.isComposing,
        })
      })
      document.addEventListener('compositionstart', () => {
        controller.handleCompositionStart()
      })
      document.addEventListener('compositionend', () => {
        controller.handleCompositionEnd()
      })
      document.addEventListener('keydown', () => controller.cancel(), true)
      document.addEventListener('pointerdown', () => controller.cancel(), true)
    }
    ;(window as any).__rewrap = {
      editor,
      initial: editor.getValue(),
      run,
      runDocument,
      shiftHeading,
      state: () => ({
        syncs,
        error,
        captures,
        getValueCalls,
        fullIrSerializes,
        spins,
      }),
      invalidateSnapshot: () => editSync?.invalidate(),
      warmSnapshot: () => editSync?.snapshotMarkdown(),
      resetCounts: () => {
        captures = 0
        getValueCalls = 0
        fullIrSerializes = 0
        spins = 0
        syncs = 0
      },
      cursorOffset: () => {
        if (editor.vditor.currentMode !== 'sv') {
          return getCursorSourceOffset(editor)
        }
        const root = editor.vditor.sv.element
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0) return -1
        const caret = selection.getRangeAt(0)
        const before = caret.cloneRange()
        before.selectNodeContents(root)
        before.setEnd(caret.startContainer, caret.startOffset)
        return before.toString().length
      },
    }
    ;(window as any).__tableFormat = {
      editor,
      setExactMarkdown: (markdown: string) => {
        exactMarkdown = markdown
      },
      capture: () => captureTableFormatSvSelection(),
      setScrollTop: (value: number) => {
        findScroller(editor.vditor.sv.element as HTMLElement).scrollTop = value
      },
      run: () => runTableFormatCommand(window),
      state: () => {
        const root = editor.vditor.sv.element as HTMLElement
        const node = getSelection()?.anchorNode
        const cell = node instanceof Text ? node.data : node?.textContent
        return {
          exacts,
          lastExact,
          caretText: cell?.includes('longer') ? 'longer' : '',
          scrollTop: findScroller(root).scrollTop,
        }
      },
    }
    ;(window as any).__ready = true
  },
})
