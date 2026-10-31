import {
  type SlugifyMode,
  parseHeadingsFromMarkdown,
  resolveFragment,
} from '../../../src/shared/heading-slug'
import {
  findIdTarget,
  idTargetsInTag,
  parseIdTargetsFromMarkdown,
} from '../../../src/shared/id-target'
import { getSlugifyMode } from '../links/same-doc-anchor'
import { innerVditor } from '../util/inner-vditor'
import { requestCaret } from './caret'
import {
  captureRewrapSourceRange,
  checkpointEditorUndo,
  mapOffsetToExact,
  replaceSvMarkdownRange,
  sameRenderedText,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import { activeModeElement } from '../util/source-map'

const EVENT = 'vmde-insert-id'
const NAME_RE = /^[A-Za-z][A-Za-z0-9_.:-]*$/u

export interface IdInsertion {
  markdown: string
  caret: number
}

interface IdInsertionDeps {
  setApplying(applying: boolean): void
  /** Task 630: settle typing and pull the host-exact bytes (`null`: no proof, the insertion declines). */
  acquireExactAuthority(): Promise<{ exact: string; rendered: string } | null>
  /** `rollback` restores what the insertion changed besides the DOM when the host refuses the edit. */
  postExact(markdown: string, opts?: { rollback?: { restore(): void } }): void
  onError(error: unknown): void
}

interface RetainedEditorEndpoints {
  editor: HTMLElement
  mode: string
  anchorNode: Node
  anchorOffset: number
  focusNode: Node
  focusOffset: number
}

let configured: IdInsertionDeps | undefined

export function configureIdInsertion(deps: IdInsertionDeps): void {
  configured = deps
}

export type IdValueRefusal = 'invalid' | 'duplicate' | 'heading'

/**
 * Why a value cannot become a new ID target, in a fixed order: unsafe characters, a value already
 * used by an `id` or `name` target, then a value a heading anchor already owns.
 */
export function idValueRefusal(
  markdown: string,
  rawValue: string,
  mode: SlugifyMode,
): IdValueRefusal | undefined {
  const value = rawValue.trim()
  if (!NAME_RE.test(value)) return 'invalid'
  if (findIdTarget(parseIdTargetsFromMarkdown(markdown), value))
    return 'duplicate'
  if (
    resolveFragment(parseHeadingsFromMarkdown(markdown), value, mode) !==
    undefined
  )
    return 'heading'
  return undefined
}

const REFUSAL_MESSAGE: Record<IdValueRefusal, string> = {
  invalid: 'Use letters, numbers, dot, dash, colon, or underscore.',
  duplicate: 'An anchor with this name already exists.',
  heading: 'A heading already uses this ID.',
}

/** Validate and plan the literal source insertion used by the toolbar dialog. */
export function planIdInsertion(
  markdown: string,
  offset: number,
  rawValue: string,
  mode: SlugifyMode = getSlugifyMode(),
): IdInsertion | null {
  const value = rawValue.trim()
  if (!Number.isInteger(offset) || offset < 0 || offset > markdown.length)
    return null
  if (idValueRefusal(markdown, value, mode)) return null
  const source = `<a id="${value}"></a>`
  return {
    markdown: `${markdown.slice(0, offset)}${source}${markdown.slice(offset)}`,
    caret: offset + source.length,
  }
}

/** Return the target value on the source line owning a preserved toolbar caret. */
export function idTargetValueAtSourceOffset(
  markdown: string,
  offset: number,
): string | undefined {
  if (!Number.isInteger(offset) || offset < 0 || offset > markdown.length)
    return undefined
  const start = markdown.lastIndexOf('<', offset)
  const end = markdown.indexOf('>', start)
  // A post-insertion caret sits immediately after `>`, not on the target. Only inspect a caret
  // within the opening tag itself, so repeated insertions at the retained caret stay possible.
  if (start < 0 || end < 0 || offset < start || offset >= end) return undefined
  const declared = idTargetsInTag(markdown.slice(start, end + 1))[0]
  if (!declared) return undefined
  // Count only characters before the caret: an offset on a line ending still belongs to the
  // line it terminates, which matches the source-map caret convention.
  const line = (markdown.slice(0, offset).match(/\r\n|\n|\r/gu) ?? []).length
  return parseIdTargetsFromMarkdown(markdown).some(
    (target) => target.line === line && target.value === declared.value,
  )
    ? declared.value
    : undefined
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

function svMarkdownWithoutTrailingCaretLine(
  editor: HTMLElement | null,
): string {
  if (!editor) return ''
  // Vditor owns one final editable newline in SV. Remove that node structurally so authored EOF
  // blank lines survive unchanged and the anchor plan cannot persist a caret-only line.
  const clone = editor.cloneNode(true) as HTMLElement
  clone
    .querySelector(
      ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
    )
    ?.remove()
  return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
}

function openDialog(
  returnFocusOverride?: HTMLElement | null,
  rangeOverride?: Range | null,
): void {
  const outer = window.vditor
  if (
    !outer ||
    previewIsOpen() ||
    document.querySelector('[data-vmde-anchor-dialog]')
  )
    return
  const range = rangeOverride ?? selectionRange()
  // The toolbar can replace the live WYSIWYG Range before its click callback runs. The endpoint
  // snapshot is reconstructed after menu focus, then this production mapper establishes the only
  // source authority used by the insertion transaction.
  const editor = activeModeElement(outer)
  // SV's Vditor serializer appends its editable trailing paragraph. Its raw source surface is the
  // only pre-serialization authority here; host writeback preserves the document's existing EOL.
  // IR/WYSIWYG retain the exact edit-sync snapshot when it is available.
  const markdown =
    outer.getCurrentMode() === 'sv'
      ? svMarkdownWithoutTrailingCaretLine(editor)
      : outer.getValue()
  const sourceOffset =
    (range
      ? captureRewrapSourceRange(window, range, {
          authoritativeMarkdown: markdown,
          // The SV editable trailing paragraph may serialize after the caret. Its marker offset
          // remains valid for this source transaction, while requiring whole-document equality
          // would discard the exact host snapshot that preserves the user's EOF bytes.
          requireExactMarkdown: false,
        })?.startOffset
      : undefined) ?? -1
  const capturedInner = innerVditor()
  const capturedMode = capturedInner?.currentMode
  const inspectedName = idTargetValueAtSourceOffset(markdown, sourceOffset)
  const focusCandidate =
    returnFocusOverride ??
    (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null)
  // Selecting a More-menu row closes its panel, making that row unfocusable. Return to the visible
  // More trigger instead; a direct toolbar invocation remains its own focus destination.
  const returnFocus =
    focusCandidate
      ?.closest('.vmde-toolbar-more')
      ?.querySelector<HTMLElement>(':scope > [data-type="more"]') ??
    focusCandidate
  const dialog = document.createElement('form')
  dialog.dataset.vmdeAnchorDialog = '1'
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', 'Insert ID')
  dialog.className = 'vmde-anchor-dialog'
  dialog.innerHTML =
    '<label>ID <input name="anchor-name" autocomplete="off" required></label>' +
    '<p data-vmde-anchor-error aria-live="polite"></p>' +
    '<button type="submit">Apply</button><button type="button" data-vmde-anchor-cancel>Cancel</button>'
  document.body.append(dialog)
  const input = dialog.elements.namedItem('anchor-name') as HTMLInputElement
  const error = dialog.querySelector<HTMLElement>('[data-vmde-anchor-error]')!
  if (inspectedName) {
    // Inspection is deliberately read-only: changing a target could leave incoming links stale,
    // so rename/refactor remains a separately-designed action rather than an accidental dialog edit.
    input.value = inspectedName
    input.readOnly = true
    input.setAttribute('aria-readonly', 'true')
    error.textContent = 'Existing anchor target. Incoming links are unchanged.'
    const submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!
    submit.type = 'button'
    submit.textContent = 'Close'
    submit.dataset.vmdeAnchorCancel = '1'
    dialog.querySelector('[data-vmde-anchor-cancel]')?.remove()
  }
  const close = () => {
    dialog.remove()
    // Vditor restores editor focus while its toolbar click is still bubbling. Defer the dialog's
    // focus return one frame so keyboard users land back on the visible More trigger.
    requestAnimationFrame(() => returnFocus?.focus({ preventScroll: true }))
  }
  for (const cancel of dialog.querySelectorAll('[data-vmde-anchor-cancel]'))
    cancel.addEventListener('click', close)
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  let submitting = false
  const isLive = () =>
    dialog.isConnected &&
    window.vditor === outer &&
    innerVditor() === capturedInner &&
    capturedInner?.currentMode === capturedMode &&
    editor?.isConnected === true &&
    activeModeElement(outer) === editor
  const toLf = (text: string): string => text.replace(/\r\n|\r/gu, '\n')
  /** Task 630: acquire, prove, splice into the host-exact text, apply and post with a rollback.
   * SV keeps its LF source text; the exact plan must equal it up to line endings. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps acquisition, liveness, mapping, apply, rollback handle and post together.
  async function insertExact(
    deps: IdInsertionDeps,
    inner: NonNullable<ReturnType<typeof innerVditor>>,
    name: string,
  ): Promise<void> {
    const pair = await deps.acquireExactAuthority()
    if (!pair) {
      error.textContent = 'The document could not be confirmed. Try again.'
      return
    }
    if (!isLive()) return
    if (!sameRenderedText(pair.rendered, markdown)) {
      error.textContent =
        'The document changed while this dialog was open. Cancel and try again.'
      return
    }
    const mapped =
      sourceOffset >= 0
        ? mapOffsetToExact(markdown, pair.exact, sourceOffset)
        : pair.exact.length
    const plan =
      mapped === null ? null : planIdInsertion(pair.exact, mapped, name)
    if (!plan) {
      error.textContent = 'The insertion point could not be confirmed.'
      return
    }
    const sv = inner.currentMode === 'sv'
    const shown = sv
      ? planIdInsertion(
          markdown,
          sourceOffset >= 0 ? sourceOffset : markdown.length,
          name,
        )
      : plan
    if (!shown || (sv && toLf(shown.markdown) !== toLf(plan.markdown))) {
      error.textContent = 'The insertion point could not be confirmed.'
      return
    }
    const undoSnapshot = snapshotTableUndoForRollback(inner)
    outer.focus()
    restoreCollapsedRange(range)
    try {
      deps.setApplying(true)
      checkpointEditorUndo(inner)
      if (sv) {
        if (
          !editor ||
          !replaceSvMarkdownRange(editor, editor.textContent ?? '', {
            markdown: shown.markdown,
            caretOffset: shown.caret,
          })
        )
          throw new Error('Insert ID SV source transaction could not apply')
      } else outer.setValue(plan.markdown)
      checkpointEditorUndo(inner)
      if (!sv)
        requestAnimationFrame(() => requestCaret({ textOffset: plan.caret }))
    } catch (reason) {
      deps.onError(reason)
      return
    } finally {
      deps.setApplying(false)
    }
    deps.postExact(plan.markdown, {
      rollback: {
        restore: () => restoreTableUndoForRollback(inner, undoSnapshot),
      },
    })
    close()
  }
  dialog.addEventListener('submit', (event) => {
    event.preventDefault()
    if (submitting) return
    const name = input.value.trim()
    const refusal = idValueRefusal(markdown, name, getSlugifyMode())
    if (refusal) {
      error.textContent = REFUSAL_MESSAGE[refusal]
      return
    }
    const inner = innerVditor()
    if (!configured || !inner) return
    submitting = true
    error.textContent = ''
    insertExact(configured, inner, name)
      .catch((reason) => configured?.onError(reason))
      .finally(() => {
        submitting = false
      })
  })
  input.focus()
}

/** Wire one toolbar command handler per init; its disposer prevents re-init duplicates. */
export function installIdInsertion(): () => void {
  let toolbarInvoker: HTMLElement | null = null
  let retained: RetainedEditorEndpoints | null = null
  let morePointerPending = false

  const clearRetained = () => {
    retained = null
  }
  const toolbarOwnsFocus = () => {
    const toolbar = innerVditor()?.toolbar?.element
    return Boolean(toolbar?.contains(document.activeElement))
  }
  const validOffset = (node: Node, offset: number) =>
    Number.isInteger(offset) &&
    offset >= 0 &&
    offset <=
      (node.nodeType === Node.TEXT_NODE
        ? (node.textContent?.length ?? 0)
        : node.childNodes.length)
  const retainedRange = (): Range | null => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    if (
      !retained ||
      !outer ||
      !editor ||
      retained.mode !== outer.getCurrentMode() ||
      retained.editor !== editor ||
      !retained.editor.isConnected ||
      !retained.editor.contains(retained.anchorNode) ||
      !retained.editor.contains(retained.focusNode) ||
      !validOffset(retained.anchorNode, retained.anchorOffset) ||
      !validOffset(retained.focusNode, retained.focusOffset)
    ) {
      clearRetained()
      return null
    }
    try {
      const range = document.createRange()
      range.setStart(retained.anchorNode, retained.anchorOffset)
      range.setEnd(retained.focusNode, retained.focusOffset)
      return range
    } catch {
      clearRetained()
      return null
    }
  }
  const retainEditorSelection = () => {
    const outer = window.vditor
    const editor = outer ? activeModeElement(outer) : null
    const selection = document.getSelection()
    if (
      !outer ||
      !editor ||
      !selection?.anchorNode ||
      !selection.focusNode ||
      !editor.contains(selection.anchorNode) ||
      !editor.contains(selection.focusNode) ||
      !validOffset(selection.anchorNode, selection.anchorOffset) ||
      !validOffset(selection.focusNode, selection.focusOffset)
    )
      return false
    retained = {
      editor,
      mode: outer.getCurrentMode(),
      anchorNode: selection.anchorNode,
      anchorOffset: selection.anchorOffset,
      focusNode: selection.focusNode,
      focusOffset: selection.focusOffset,
    }
    return true
  }
  const isMoreTarget = (target: EventTarget | null) =>
    target instanceof Element && target.closest('[data-type="more"]') !== null
  const anchorInvoker = (target: EventTarget | null) =>
    target instanceof Element
      ? target.closest<HTMLElement>('[data-type="insert-anchor"]')
      : null
  const onPointerDown = (event: PointerEvent) => {
    const invoker = anchorInvoker(event.target)
    if (isMoreTarget(event.target)) {
      // Pointerdown precedes the browser's focus/selection reset. Keep raw DOM endpoints now;
      // serializing here is both too late in some WYSIWYG paths and too costly for every click.
      retainEditorSelection()
      morePointerPending = true
      return
    }
    if (invoker) {
      toolbarInvoker = invoker
      if (!morePointerPending && !retainEditorSelection()) clearRetained()
      return
    }
    morePointerPending = false
  }
  const onPointerCancel = () => {
    morePointerPending = false
  }
  const onSelectionChange = () => {
    if (morePointerPending || toolbarOwnsFocus()) return
    if (!retainEditorSelection()) clearRetained()
  }
  const onInput = () => {
    // Any editor DOM input invalidates raw endpoints; the next menu activation must capture a
    // fresh selection rather than applying a source offset from the preceding document revision.
    clearRetained()
    morePointerPending = false
  }
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ returnFocus?: unknown }>).detail
    const range = retainedRange()
    morePointerPending = false
    openDialog(
      detail?.returnFocus instanceof HTMLElement
        ? detail.returnFocus
        : toolbarInvoker,
      range,
    )
  }
  // Window capture is intentionally earlier than Vditor's document-capture toolbar handler. A
  // document listener can observe the reset Range it is meant to protect when More takes focus.
  window.addEventListener('pointerdown', onPointerDown, true)
  window.addEventListener('pointercancel', onPointerCancel, true)
  document.addEventListener(EVENT, listener)
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('input', onInput, true)
  onSelectionChange()
  return () => {
    window.removeEventListener('pointerdown', onPointerDown, true)
    window.removeEventListener('pointercancel', onPointerCancel, true)
    document.removeEventListener(EVENT, listener)
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('input', onInput, true)
    clearRetained()
  }
}
