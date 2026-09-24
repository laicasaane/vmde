import { findScroller } from '../chrome/toolbar-scroll-guard'
import { requestCaret } from './caret'
import { currentBlockProjection } from '../nav/block-handle'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import {
  captureRewrapSourceRange,
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import {
  planSelectedLink,
  type SelectedLinkKind,
  type SelectedLinkPlan,
  uniqueAtxHeadingTextRange,
} from './selection-link-plan'

export interface SelectionLinkDeps {
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

function uniqueLinkMarker(markdown: string): string {
  let marker = 'VMDE_LINK_CARET'
  while (markdown.includes(marker)) marker += '_'
  return marker
}

function clearLinkMarker(editor: HTMLElement, marker: string): HTMLElement {
  const matches = Array.from(
    editor.querySelectorAll<HTMLElement>('.vditor-ir__marker--link'),
  ).filter((element) => element.textContent === marker)
  if (matches.length !== 1)
    throw new Error('inserted link URL marker is ambiguous')
  const url = matches[0]
  url.textContent = ''
  return url
}

function linkUrlPath(editor: HTMLElement, url: HTMLElement): number[] | null {
  if (!url.isConnected || !editor.contains(url)) return null
  const path: number[] = []
  let node: Element = url
  while (node !== editor) {
    const parent = node.parentElement
    if (!parent) return null
    const index = Array.prototype.indexOf.call(parent.children, node) as number
    if (index < 0) return null
    path.unshift(index)
    node = parent
  }
  return path
}

function focusEmptyLinkUrl(editor: HTMLElement, path: number[]): void {
  let node: Element = editor
  for (const index of path) {
    const child = node.children.item(index)
    if (!child) return
    node = child
  }
  if (!node.classList.contains('vditor-ir__marker--link')) return
  editor.focus({ preventScroll: true })
  // Vditor re-spins this link after the exact host post; a structural caret
  // intent follows the empty URL marker while the active editor stays the same.
  requestCaret({
    blockPath: path,
    offsetInBlock: 0,
  })
}

interface LinkOwner {
  outer: NonNullable<Window['vditor']>
  editor: HTMLElement
  mode: 'ir' | 'wysiwyg'
  range: Range
  exact: string
  rendered: string
}

function validOwner(owner: LinkOwner, inner: InnerVditor | null): boolean {
  return Boolean(
    inner &&
      window.vditor === owner.outer &&
      inner.currentMode === owner.mode &&
      activeModeElement(owner.outer) === owner.editor &&
      owner.editor.isConnected &&
      owner.range.startContainer.isConnected &&
      owner.range.endContainer.isConnected,
  )
}

function liveSelection(
  owner: LinkOwner,
  selected: string,
): { selection: Selection; range: Range } | null {
  const selection = window.getSelection()
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (
    !selection ||
    !range ||
    range.toString() !== selected ||
    !owner.editor.contains(range.startContainer) ||
    !owner.editor.contains(range.endContainer)
  )
    return null
  return { selection, range }
}

function headingLevelForRange(owner: LinkOwner): number | null {
  if (owner.mode !== 'ir') return null
  const start =
    owner.range.startContainer.parentElement?.closest('h1,h2,h3,h4,h5,h6')
  const end =
    owner.range.endContainer.parentElement?.closest('h1,h2,h3,h4,h5,h6')
  if (!start || start !== end || !owner.editor.contains(start)) return null
  return Number(start.tagName[1])
}

function sourcePlan(
  owner: LinkOwner,
  before: string,
  kind: SelectedLinkKind,
): Extract<SelectedLinkPlan, { status: 'changed' }> | null {
  const selected = owner.range.toString()
  const mapped = captureRewrapSourceRange(window, owner.range, {
    authoritativeMarkdown: before,
  })
  // Some re-spun IR headings drop synthetic source markers. Only a unique,
  // same-level ATX heading text span may use an exact-source fallback.
  const offsets =
    mapped?.markdown === before
      ? mapped
      : uniqueAtxHeadingTextRange(
          before,
          selected,
          headingLevelForRange(owner) ?? 0,
        )
  if (!offsets) return null
  const plan = planSelectedLink(
    before,
    offsets.startOffset,
    offsets.endOffset,
    selected,
    kind,
  )
  return plan.status === 'changed' ? plan : null
}

interface LinkTransaction {
  owner: LinkOwner
  inner: InnerVditor
  before: string
  renderedBefore: string
  plan: Extract<SelectedLinkPlan, { status: 'changed' }>
  projection: NonNullable<ReturnType<typeof currentBlockProjection>>
  live: { selection: Selection; range: Range }
  marker: string | null
  scrollTop: number
}

function applyLinkTransaction(transaction: LinkTransaction): void {
  const {
    owner,
    inner,
    before,
    renderedBefore,
    plan,
    projection,
    live,
    marker,
    scrollTop,
  } = transaction
  checkpointEditorUndo(inner)
  owner.editor.focus({ preventScroll: true })
  live.selection.removeAllRanges()
  live.selection.addRange(live.range)
  const insertion = marker
    ? `${plan.insertion.slice(0, -1)}${marker})`
    : plan.insertion
  if (!document.execCommand('insertText', false, insertion))
    throw new Error('text-only selection insertion was rejected')
  const url = marker ? clearLinkMarker(owner.editor, marker) : null
  const urlPath = url ? linkUrlPath(owner.editor, url) : null
  const afterRendered = owner.outer.getValue()
  if (projection.serialize(projection.render(plan.markdown)) !== afterRendered)
    throw new Error('selection insertion changed unrelated rendered content')
  checkpointEditorUndo(inner)
  const native = (inner.undo as any)?.[owner.mode]?.undoStack?.at(-1)
  if (!native) throw new Error('selection insertion undo checkpoint missing')
  recordRewrapDocumentHistory({
    owner: inner,
    mode: owner.mode,
    nativeState: native,
    beforeRendered: renderedBefore,
    beforeExact: before,
    afterRendered,
    afterExact: plan.markdown,
  })
  findScroller(owner.editor).scrollTop = scrollTop
  owner.editor.focus({ preventScroll: true })
  if (urlPath) focusEmptyLinkUrl(owner.editor, urlPath)
}

/** Replace only a validated live selection with text; publish exact bytes after Lute agrees. */
export function runSelectedLink(
  kind: SelectedLinkKind,
  owner: LinkOwner,
  deps: SelectionLinkDeps,
): boolean {
  const inner = innerVditor()
  if (!validOwner(owner, inner) || !inner) return false
  const before = deps.snapshotExactMarkdown()
  const renderedBefore = owner.outer.getValue()
  if (before !== owner.exact || renderedBefore !== owner.rendered) return false
  const projection = currentBlockProjection()
  if (
    !projection ||
    projection.serialize(projection.render(before)) !== renderedBefore
  )
    return false
  const plan = sourcePlan(owner, before, kind)
  if (!plan) return false
  const live = liveSelection(owner, owner.range.toString())
  if (!live) return false
  const scroller = findScroller(owner.editor)
  const scrollTop = scroller.scrollTop
  const undoSnapshot = snapshotTableUndoForRollback(inner)
  const marker =
    kind === 'link' && owner.mode === 'ir' ? uniqueLinkMarker(before) : null
  deps.setApplying(true)
  try {
    applyLinkTransaction({
      owner,
      inner,
      before,
      renderedBefore,
      plan,
      projection,
      live,
      marker,
      scrollTop,
    })
  } catch (error) {
    try {
      owner.outer.setValue(before)
      restoreTableUndoForRollback(inner, undoSnapshot)
      scroller.scrollTop = scrollTop
    } catch {
      // A failed rollback must never publish a speculative exact source edit.
    }
    deps.onError(error)
    return false
  } finally {
    deps.setApplying(false)
  }
  deps.postExact(plan.markdown)
  return true
}
