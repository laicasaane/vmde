import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installEditorCaretTracking } from '../src/editing/editor-caret'
import { installEscapeToolbar } from '../src/editing/escape-toolbar'
import { installFocusRestore } from '../src/editing/focus-restore'
import { installStructuralSelection } from '../src/editing/selection-scope'
import { createToolbar } from '../src/chrome/toolbar'

// Real Vditor (IR) with the REAL toolbar (createToolbar — same composition as main.ts) and the
// task 456 Escape→Tab wiring installed exactly like finish-init.ts does. `tab: '\t'` matches
// production (vditor-init.ts) — this harness exists specifically to drive real keyboard events
// against the real toolbar DOM in a plain Chromium page (no real-VS-Code webview / no shared
// `.vscode-test` state), so it can prove or disprove the escape-toolbar.ts focus-move logic in
// isolation from anything real-VS-Code-specific.
const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: ['a paragraph', '', 'second paragraph'].join('\n'),
  tab: '\t',
  toolbar: createToolbar(),
  toolbarConfig: { pin: true },
  after() {
    ;(window as any).vditor = editor
    installEscapeToolbar()
    // finish-init.ts installs this right after escape-toolbar; its Escape step-out must not widen
    // the caret that the toolbar return restores (Task 659).
    installStructuralSelection()
    // main.ts also wires this (task 389/445 focus repair). Included here to test whether it
    // races with escape-toolbar's focus move: its `focusout` listener defers a
    // requestAnimationFrame restore whenever the EDITOR loses focus, which is exactly what
    // happens when escape-toolbar.ts moves focus to a toolbar button.
    installFocusRestore(window)
    // main.ts also wires this (task 389/390): continuously snapshots the last in-editor caret on
    // `selectionchange`. escape-toolbar.ts's returnFocusToEditor() depends on it (restoreEditorCaretIfLost)
    // to put the caret back after focusing a toolbar button collapses the browser's Selection —
    // without this wired, the harness can't exercise (or catch a regression in) that fix.
    installEditorCaretTracking()
    ;(window as any).__ready = true
  },
})
