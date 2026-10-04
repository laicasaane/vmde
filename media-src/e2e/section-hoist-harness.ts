import '../src/boot/preload'
import Vditor from 'vditor'
import { installSectionHoist } from '../src/nav/section-hoist'
import { scrollToHeadingIndex } from '../src/nav/outline'
import { installHistoryKeybindingShim } from './keybinding-shim'
import { installOutlineKeyboard } from '../src/nav/outline-keyboard'
import {
  applyCacheHits,
  installRenderCache,
} from '../src/diagrams/render-cache-client'

installHistoryKeybindingShim(window)

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
