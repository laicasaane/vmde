import { processToolbar as processIrToolbar } from 'vditor/src/ts/ir/process'
import { toolbarEvent as processWysToolbar } from 'vditor/src/ts/wysiwyg/toolbarEvent'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { toolbarHotkeyGate } from './format-hotkey-context'
import { innerVditor } from '../util/inner-vditor'

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'inline-code'

const MARKERS: Record<InlineFormat, { prefix: string; suffix: string }> = {
  bold: { prefix: '**', suffix: '**' },
  italic: { prefix: '*', suffix: '*' },
  strike: { prefix: '~~', suffix: '~~' },
  'inline-code': { prefix: '`', suffix: '`' },
}

/** Task 596: whether Vditor's click would REMOVE `format` at `range`, decided by the same live
 *  rule the toolbar hotkeys use (`toolbarHotkeyGate`, a synchronous mirror of Vditor's highlight)
 *  instead of a second tag/selector test, so the bubble's pressed state, the detached-button
 *  format run and the hotkey click always agree. */
export function formatIsActive(
  format: InlineFormat,
  range: Range,
  editor: HTMLElement,
  mode: 'ir' | 'wysiwyg',
): boolean {
  const gate = toolbarHotkeyGate(mode, range, editor, format, {
    fullPreview: false,
  })
  return gate !== 'blocked' && gate.current
}

/** Invoke the same Vditor action as MenuItem, including when toolbar: [] is configured. */
export function runSelectionFormat(
  format: InlineFormat,
  owner: { editor: HTMLElement; mode: 'ir' | 'wysiwyg'; range: Range },
): boolean {
  const { editor, mode, range } = owner
  const inner = innerVditor()
  if (
    !inner ||
    inner.currentMode !== mode ||
    !range.startContainer.isConnected ||
    !range.endContainer.isConnected ||
    !editor.contains(range.startContainer) ||
    !editor.contains(range.endContainer)
  )
    return false
  const selection = window.getSelection()
  if (!selection) return false
  const scroller = findScroller(editor)
  const scrollTop = scroller.scrollTop
  editor.focus({ preventScroll: true })
  selection.removeAllRanges()
  selection.addRange(range)
  const button = document.createElement('button')
  button.dataset.type = format
  if (formatIsActive(format, range, editor, mode))
    button.classList.add('vditor-menu--current')
  const marker = MARKERS[format]
  if (mode === 'ir')
    processIrToolbar(inner as never, button, marker.prefix, marker.suffix)
  else
    processWysToolbar(
      inner as never,
      button,
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
  scroller.scrollTop = scrollTop
  return true
}
