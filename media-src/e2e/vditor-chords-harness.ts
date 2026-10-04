import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import {
  registerEditorActionRunner,
  runEditorAction,
} from '../src/bridge/editor-actions'
import {
  EDIT_MODE_ACTIONS,
  runVditorChord,
  switchEditMode,
  VDITOR_CHORD_ACTIONS,
} from '../src/editing/vditor-chord-actions'
import { installKeybindingShim } from './keybinding-shim'

// Task 580 CP2-10 — Vditor built from SOURCE, so the build's Vditor patches apply (the table
// harness imports the prebuilt `vditor` dist, which keeps every hard-coded chord). The real
// toolbar matches main.ts. The heading, edit-mode and task runners are registered as main.ts
// registers them, and the keybinding shim gives their unbound commands Ctrl+Alt+Shift user keys:
// the Digit chords require no Shift, so none of these keys is itself a Vditor chord.
const USER_KEYS: Readonly<Record<string, string>> = {
  'ctrl+alt+shift+1': 'vmde.format.heading1',
  'ctrl+alt+shift+2': 'vmde.format.heading2',
  'ctrl+alt+shift+3': 'vmde.format.heading3',
  'ctrl+alt+shift+4': 'vmde.format.heading4',
  'ctrl+alt+shift+5': 'vmde.format.heading5',
  'ctrl+alt+shift+6': 'vmde.format.heading6',
  'ctrl+alt+shift+7': 'vmde.switchToWysiwyg',
  'ctrl+alt+shift+8': 'vmde.switchToInstantRendering',
  'ctrl+alt+shift+9': 'vmde.switchToSplitView',
  'ctrl+alt+shift+j': 'vmde.toggleTaskCheckbox',
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'Para text\n',
  toolbar: createToolbar(),
  after() {
    ;(window as any).vditor = editor
    for (const [action, chord] of VDITOR_CHORD_ACTIONS)
      registerEditorActionRunner(action, () => {
        runVditorChord(chord)
      })
    for (const [action, mode, chord] of EDIT_MODE_ACTIONS)
      registerEditorActionRunner(action, () => {
        switchEditMode(mode, chord)
      })
    installKeybindingShim(window, {
      commands: Object.values(USER_KEYS),
      userKeys: USER_KEYS,
      platform: navigator.platform.toLowerCase().includes('mac')
        ? 'mac'
        : 'win-linux',
      dispatch: (route) => {
        if (route.command === 'editor-action') runEditorAction(route.action)
      },
    })
    ;(window as any).__ready = true
  },
})
