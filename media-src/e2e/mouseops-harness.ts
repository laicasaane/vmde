// E2e harness for mouse-driven operations (task 191): copy/cut clipboard payloads,
// paste, drag-selection, checkbox toggles. A real Vditor FROM SOURCE (so our esbuild
// patches apply) in the mode named by `?mode=ir|wysiwyg|sv`, wired exactly like main.ts
// for the paths a mouse op exercises:
//   - patchLuteSerialize + the custom wiki renderer, so a copied [[wiki]] chip
//     round-trips to `[[..]]` in the serialized payload (not the chip's DOM text),
//   - fixCut (utils.ts), which defers execCommand('delete') by a tick — the cut path,
//   - the edit-sync message recorder (createPendingEdit → {command:'edit'}), so a
//     cut/paste that mutates the doc posts an observable edit the spec can count.
// The spec installs an acquireVsCodeApi stub (→ window.__posted) BEFORE this bundle
// runs, sets content via setValue, makes a selection (programmatically or by mouse),
// dispatches a synthetic ClipboardEvent / real key, then reads the DataTransfer or
// getValue() back. Shared by copy-cut / paste-pipeline / mouse-selection specs.
import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createPendingEdit } from '../src/bridge/pending-edit'
import { setupSaveFlushKeybind } from '../src/bridge/save-flush'
import { fixCut } from '../src/util/utils'
import { fixLinkClick } from '../src/links/link-click-fix'
import { fixTableIr } from '../src/editing/fix-table-ir' // materializes #fix-table-ir-wrapper on cell click
import { installUndoBoundaries } from '../src/editing/undo-boundaries'
import { setupCustomRenderer } from '../src/links/custom-renderer'
import {
  createUploadHandler,
  uploadedMarkup,
} from '../src/clipboard/upload-handler'
import {
  patchLuteSerialize,
  setKnownPagesRef,
} from '../src/links/wiki-serialize'
import {
  announce,
  installScreenReaderSemantics,
} from '../src/util/screen-reader'
import { observeLinkLikeSemantics } from '../src/links/link-like-semantics'
import { installPreviewTaskCheckboxes } from '../src/editing/preview-task-checkboxes'
import { installPreviewState } from '../src/editing/preview-state'

// preload.ts's initVsCodeApi() call (task 470) picks up the spec's acquireVsCodeApi stub.
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') as 'ir' | 'wysiwyg' | 'sv') || 'ir'
// `?toolbar=1` mounts a real formatting toolbar so specs can drive toolbar commands
// (bold/italic/list/table) on a selection — the primary mouse-editing UI (P1-2/P1-8).
const withToolbar = params.get('toolbar') === '1'

// Wiki targets the torture fixture links to (so [[Home]] renders as a known chip).
const knownPages = new Set<string>(['home', 'target'])

// Canonical mouse-ops torture value — one of each block type the copy/paste/select
// specs need. Kept small + canonical so a copy→paste round-trip is byte-assertable.
const TORTURE = [
  '# Heading One',
  '',
  'Prose with **bold text**, a [link](https://example.com), and a [[Home]] wiki link.',
  '',
  '- First item',
  '- [ ] task unchecked',
  '- [x] task checked',
  '',
  '```js',
  'const answer = 42',
  '```',
  '',
  '> [!NOTE]',
  '> A callout body.',
  '',
  '| Col A | Col B |',
  '| --- | --- |',
  '| a1 | b1 |',
  '',
].join('\n')
;(window as any).__torture = TORTURE

let editor: Vditor
const postEdit = () =>
  (window as any).vscode.postMessage({
    command: 'edit',
    content: editor.getValue(),
  })
// Debounced serialize→post, exactly like main.ts (task 58/68): a mutating mouse op
// (cut/paste) fires input → schedule → one coalesced edit post after the 250ms wait.
const pendingEdit = createPendingEdit({
  wait: 250,
  onIdle: () => postEdit(),
  onFlush: () => postEdit(),
})

// Patch execCommand('delete') to defer a tick BEFORE Vditor's cutEvent runs it.
fixCut()

editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn: `${location.origin}/vditor`,
  value: '',
  ...(withToolbar
    ? {
        toolbar: [
          'bold',
          'italic',
          'strike',
          'inline-code',
          'list',
          'ordered-list',
          'check',
          'table',
          'quote',
        ],
      }
    : {}),
  // Wire the REAL upload handler (task 191 §5.4 extraction) so an image-File paste posts a
  // {command:'upload'} the spec can assert. webp keeps the P0-13 name-suffix assertion honest.
  upload: {
    url: '/fuzzy',
    handler: createUploadHandler(() => ({ imageFormat: 'webp' })),
  },
  input() {
    pendingEdit.schedule()
  },
  after() {
    ;(window as any).vditor = editor
    installScreenReaderSemantics('mouseops-harness.md')
    setupCustomRenderer(editor, { enabled: true, knownPages })
    setKnownPagesRef(knownPages)
    patchLuteSerialize(editor)
    fixLinkClick()
    fixTableIr() // so a table-cell click materializes #fix-table-ir-wrapper (as main.ts does)
    installUndoBoundaries(editor)
    observeLinkLikeSemantics(document.getElementById('app'))
    let cutSelection = { collapsed: true, text: '', plain: '' }
    document.addEventListener(
      'cut',
      () => {
        const selection = getSelection()
        cutSelection = {
          collapsed: selection?.isCollapsed ?? true,
          text: selection?.toString() ?? '',
          plain: '',
        }
      },
      true,
    )
    ;(editor as any).vditor[editor.getCurrentMode()].element.addEventListener(
      'cut',
      (event: ClipboardEvent) => {
        cutSelection.plain = event.clipboardData?.getData('text/plain') ?? ''
      },
    )
    ;(window as any).__cutSelection = () => cutSelection
    // The contenteditable element of the active mode (where a synthetic copy/cut
    // ClipboardEvent must be dispatched — copyEvent/cutEvent bind their listener here).
    ;(window as any).__modeEl = () =>
      (editor as any).vditor?.[editor.getCurrentMode()]?.element as HTMLElement
    ;(window as any).__applyUploaded = (href: string) =>
      editor.insertValue(uploadedMarkup(href))
    ;(window as any).__announce = announce
    // Focused Task 220 net: let the checkbox-click spec install the real delegated handler
    // on this Vditor instance after it manually enters the full Preview overlay.
    ;(window as any).__installPreviewTaskCheckboxes = () => {
      const inner = (editor as any).vditor
      installPreviewState(inner, () => editor.getValue())
      return installPreviewTaskCheckboxes(inner, true)
    }
    ;(window as any).__ready = true
  },
})

setupSaveFlushKeybind(window, () => pendingEdit.flush())
