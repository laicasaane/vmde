import { processToolbar as processIrToolbar } from 'vditor/src/ts/ir/process'
import { toolbarEvent as processWysToolbar } from 'vditor/src/ts/wysiwyg/toolbarEvent'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import { innerVditor } from '../util/inner-vditor'

export type InlineFormat = 'bold' | 'italic' | 'strike' | 'inline-code'

const MARKERS: Record<
  InlineFormat,
  { prefix: string; suffix: string; selector: string }
> = {
  bold: { prefix: '**', suffix: '**', selector: 'strong,[data-type="strong"]' },
  italic: { prefix: '*', suffix: '*', selector: 'em,[data-type="em"]' },
  strike: { prefix: '~~', suffix: '~~', selector: 's,del,[data-type="s"]' },
  'inline-code': {
    prefix: '`',
    suffix: '`',
    selector: 'code,[data-type="code"]',
  },
}

export function formatIsActive(
  format: InlineFormat,
  range: Range,
  editor: HTMLElement,
): boolean {
  const node = range.startContainer
  const element =
    node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement
  const mark = element?.closest(MARKERS[format].selector)
  return Boolean(mark && editor.contains(mark))
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
  if (formatIsActive(format, range, editor))
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
