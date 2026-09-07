import {
  findNamedAnchor,
  parseNamedAnchorsFromMarkdown,
} from '../../../src/shared/named-anchor'
import { innerVditor } from '../util/inner-vditor'
import { requestCaret } from './caret'
import { checkpointEditorUndo } from './rewrap-command'
import { activeModeElement, getCursorSourceOffset } from '../util/source-map'

const EVENT = 'vmde-insert-named-anchor'
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/u

export interface NamedAnchorInsertion {
  markdown: string
  caret: number
}

interface NamedAnchorInsertionDeps {
  setApplying(applying: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

let configured: NamedAnchorInsertionDeps | undefined

export function configureNamedAnchorInsertion(
  deps: NamedAnchorInsertionDeps,
): void {
  configured = deps
}

/** Validate and plan the literal source insertion used by the toolbar dialog. */
export function planNamedAnchorInsertion(
  markdown: string,
  offset: number,
  rawName: string,
): NamedAnchorInsertion | null {
  const name = rawName.trim()
  if (!Number.isInteger(offset) || offset < 0 || offset > markdown.length)
    return null
  if (!NAME_RE.test(name)) return null
  if (findNamedAnchor(parseNamedAnchorsFromMarkdown(markdown), name))
    return null
  const source = `<a name="${name}"></a>`
  return {
    markdown: `${markdown.slice(0, offset)}${source}${markdown.slice(offset)}`,
    caret: offset + source.length,
  }
}

function selectionRange(): Range | null {
  const outer = window.vditor
  if (!outer) return null
  const mode = outer.getCurrentMode()
  const editor = activeModeElement(outer)
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : undefined
  if (range && editor?.contains(range.commonAncestorContainer))
    return range.cloneRange()
  return (
    (outer.vditor?.[mode]?.range as Range | undefined)?.cloneRange() ?? null
  )
}

function restoreCollapsedRange(range: Range | null): void {
  if (!range?.startContainer.isConnected) return
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
  const outer = window.vditor
  const modeState = outer?.vditor?.[outer.getCurrentMode()]
  if (modeState) modeState.range = range.cloneRange()
}

function previewIsOpen(): boolean {
  return (
    innerVditor()?.toolbar?.elements?.preview?.children[0]?.classList.contains(
      'vditor-menu--current',
    ) === true
  )
}

function openDialog(): void {
  const outer = window.vditor
  if (
    !outer ||
    previewIsOpen() ||
    document.querySelector('[data-vmde-anchor-dialog]')
  )
    return
  const range = selectionRange()
  // This is captured while the editor still owns the selection; toolbar/menu focus can replace
  // the live DOM Range before Apply, but Lute's source offset remains the transaction authority.
  const sourceOffset = getCursorSourceOffset(outer)
  const returnFocus =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
  const dialog = document.createElement('form')
  dialog.dataset.vmdeAnchorDialog = '1'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Insert anchor')
  dialog.className = 'vmde-anchor-dialog'
  dialog.innerHTML =
    '<label>Anchor name <input name="anchor-name" autocomplete="off" required></label>' +
    '<p data-vmde-anchor-error aria-live="polite"></p>' +
    '<button type="submit">Apply</button><button type="button" data-vmde-anchor-cancel>Cancel</button>'
  document.body.append(dialog)
  const input = dialog.elements.namedItem('anchor-name') as HTMLInputElement
  const error = dialog.querySelector<HTMLElement>('[data-vmde-anchor-error]')!
  const close = () => {
    dialog.remove()
    returnFocus?.focus({ preventScroll: true })
  }
  dialog
    .querySelector('[data-vmde-anchor-cancel]')
    ?.addEventListener('click', close)
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  dialog.addEventListener('submit', (event) => {
    event.preventDefault()
    const markdown = outer.getValue()
    const name = input.value.trim()
    if (!NAME_RE.test(name)) {
      error.textContent =
        'Use letters, numbers, dot, dash, colon, or underscore.'
      return
    }
    if (findNamedAnchor(parseNamedAnchorsFromMarkdown(markdown), name)) {
      error.textContent = 'An anchor with this name already exists.'
      return
    }
    outer.focus()
    restoreCollapsedRange(range)
    // Vditor's insertValue treats an HTML `<a>` as a link and reserializes it to `[]()`.
    // Replace from the canonical markdown snapshot instead, so Lute receives the target as
    // source input and keeps its HTML-node representation in the visual surface.
    const offset = sourceOffset >= 0 ? sourceOffset : markdown.length
    const plan = planNamedAnchorInsertion(markdown, offset, name)
    if (!plan) return
    const inner = innerVditor()
    if (!configured || !inner) return
    try {
      configured.setApplying(true)
      checkpointEditorUndo(inner)
      outer.setValue(plan.markdown)
      checkpointEditorUndo(inner)
      requestAnimationFrame(() => requestCaret({ textOffset: plan.caret }))
      configured.postExact(plan.markdown)
    } catch (reason) {
      configured.onError(reason)
      return
    } finally {
      configured.setApplying(false)
    }
    close()
  })
  input.focus()
}

/** Wire one toolbar command handler per init; its disposer prevents re-init duplicates. */
export function installNamedAnchorInsertion(): () => void {
  const listener = () => openDialog()
  document.addEventListener(EVENT, listener)
  return () => document.removeEventListener(EVENT, listener)
}
