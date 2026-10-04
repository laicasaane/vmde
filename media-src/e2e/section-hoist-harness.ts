import '../src/boot/preload'
import Vditor from 'vditor'
import { exitHoistForFind, installSectionHoist } from '../src/nav/section-hoist'
import { scrollToHeadingIndex } from '../src/nav/outline'
import {
  installHistoryKeybindingShim,
  installKeybindingShim,
} from './keybinding-shim'
import { installOutlineKeyboard } from '../src/nav/outline-keyboard'
import {
  applyCacheHits,
  installRenderCache,
} from '../src/diagrams/render-cache-client'

installHistoryKeybindingShim(window)
// Task 580 CP2-13: Find opens through VS Code's keybinding, so the shim maps the default keys and
// a user remap (Ctrl+Alt+J) to `open-find-replace`. The harness has no Find widget; it counts the
// opens and runs the router's hoist exit (message-router.ts handleOpenFindReplace).
;(window as any).__vmdeFindOpens = 0
installKeybindingShim(window, {
  commands: ['vmde.find', 'vmde.findReplace'],
  platform: navigator.platform.toLowerCase().includes('mac')
    ? 'mac'
    : 'win-linux',
  userKeys: { 'ctrl+alt+j': 'vmde.find' },
  dispatch: (route) => {
    if (route.command !== 'open-find-replace') return
    exitHoistForFind()
    ;(window as any).__vmdeFindOpens++
  },
})

const value = [
  'Preamble remains in the full document.',
  '',
  '# Chapter',
  '',
  'Chapter introduction.',
  '',
  '## Child',
  '',
  'Editable child detail.',
  '',
  '## Sibling',
  '',
  'Sibling detail.',
  '',
  '```mermaid',
  'graph TD; Hidden --> Diagram',
  '```',
  '',
  '# Next chapter',
  '',
  'Hidden find target VMDE_HOIST_FIND_TARGET.',
  '',
].join('\n')

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value,
  height: 420,
  outline: { enable: true, position: 'right' },
  customWysiwygToolbar: () => {
    /* Vditor 3.11 requires the callback while constructing its WYSIWYG toolbar. */
  },
  after() {
    ;(window as any).vditor = editor
    // Vditor's default toolbar binds Undo/Redo to ⌘Z/⌘Y; clear them as chrome/toolbar.ts does so
    // the keybinding shim is the only owner of those keys (its fallback reads options.toolbar).
    for (const item of editor.vditor.options.toolbar ?? [])
      if (item.name === 'undo' || item.name === 'redo') item.hotkey = ''
    ;(window as any).vditorTest = editor
    ;(window as any).__vmdeOriginalMarkdown = editor.getValue()
    installOutlineKeyboard(editor)
    ;(window as any).__vmdeSectionHoist = installSectionHoist(editor)
    installRenderCache(document.getElementById('app'), (message) => {
      if (message.command === 'diagram-cache-get') {
        applyCacheHits(message.requestId, {})
      }
    })
    ;(window as any).__vmdeRevealHeading = (index: number) =>
      scrollToHeadingIndex(editor, index)
    ;(window as any).__ready = true
  },
})
