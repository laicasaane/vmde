import {
  createFloatingOverlay,
  elementPanelBounds,
  elementPanelPosition,
  type AnchorRect,
} from '../chrome/floating-overlay'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { isCompositionActive } from '../util/caret-gesture'
import { shouldOpenLink } from '../links/link-open-policy'
import { openLinkUrl } from '../links/link-click-fix'
import {
  captureRewrapSourceRange,
  checkpointEditorUndo,
  recordRewrapDocumentHistory,
} from './rewrap-command'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
  type BlockProjection,
} from '../nav/block-handle'
import { scanMovableBlocks } from '../../../src/shared/block-move'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import {
  listLinkPopoverCandidates,
  planLinkPopoverAction,
  type LinkPopoverAction,
  type LinkPopoverCandidate,
  type LinkPopoverDestinationSpan,
  type LinkPopoverTargetKind,
  type LinkPopoverPlan,
} from './link-popover-plan'

interface LinkPopoverDeps {
  snapshotExactMarkdown(): string
  setApplying(value: boolean): void
  postExact(markdown: string): void
  onError(error: unknown): void
}

interface LinkPopoverOwner {
  outer: NonNullable<Window['vditor']>
  inner: InnerVditor
  editor: HTMLElement
  target: HTMLElement
  marker: HTMLElement
  kind: LinkPopoverTargetKind
  destination: string
  destinationRange: Range
  selection: Range | null
  exact: string
  rendered: string
  rect: AnchorRect
  sourceSpan: LinkPopoverDestinationSpan | null
  settleImageSelection: boolean
}

function rangeMatches(saved: Range | null): boolean {
  const selection = window.getSelection()
  const live = selection?.rangeCount ? selection.getRangeAt(0) : null
  if (!saved) return !live
  return Boolean(
    live &&
      live.startContainer === saved.startContainer &&
      live.startOffset === saved.startOffset &&
      live.endContainer === saved.endContainer &&
      live.endOffset === saved.endOffset,
  )
}

function editorSelectionMoved(owner: LinkPopoverOwner): boolean {
  const selection = window.getSelection()
  const live = selection?.rangeCount ? selection.getRangeAt(0) : null
  return Boolean(
    live &&
      owner.editor.contains(live.startContainer) &&
      owner.editor.contains(live.endContainer) &&
      !rangeMatches(owner.selection),
  )
}

function rangeRect(range: Range | null): AnchorRect | null {
  if (!range || typeof range.getBoundingClientRect !== 'function') return null
  const rect = range.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
    ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    : null
}

function linkPopoverTarget(node: Node | null): {
  element: HTMLElement
  kind: LinkPopoverTargetKind
} | null {
  const element =
    node?.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node?.parentElement
  const image = element?.closest<HTMLElement>('[data-type="img"]')
  if (image) return { element: image, kind: 'image' }
  const link = element?.closest<HTMLElement>('[data-type="a"]')
  return link ? { element: link, kind: 'link' } : null
}

function pointerPopoverTarget(event: MouseEvent): {
  element: HTMLElement
  kind: LinkPopoverTargetKind
} | null {
  const clicked = event.target instanceof Element ? event.target : null
  if (!clicked) return null
  const target = linkPopoverTarget(clicked)
  const inner = innerVditor()
  const editor = window.vditor ? activeModeElement(window.vditor) : null
  return target &&
    inner?.currentMode === 'ir' &&
    editor?.contains(target.element)
    ? target
    : null
}

function opensLinkByPointerPolicy(
  target: { element: HTMLElement; kind: LinkPopoverTargetKind },
  event: Pick<MouseEvent, 'ctrlKey' | 'metaKey'>,
): boolean {
  // A link-wrapped image keeps Vditor's image-source Open route on the
  // configured modifier/legacy gesture, while a plain image click edits src.
  return Boolean(
    shouldOpenLink(event) &&
      (target.kind === 'link' || target.element.closest('[data-type="a"]')),
  )
}

interface TargetTuple {
  kind: LinkPopoverTargetKind
  label: string
  destination: string
  title: string | null
}

function targetTuple(target: HTMLElement): TargetTuple | null {
  const type = target.getAttribute('data-type')
  const kind = type === 'a' ? 'link' : type === 'img' ? 'image' : null
  if (!kind) return null
  const destination = target
    .querySelector<HTMLElement>(':scope > .vditor-ir__marker--link')
    ?.textContent?.trim()
  const label =
    kind === 'link'
      ? target.querySelector<HTMLElement>(':scope > .vditor-ir__link')
          ?.textContent
      : target.querySelector<HTMLImageElement>(':scope > img')?.alt
  if (!destination || label === undefined) return null
  return {
    kind,
    label,
    destination,
    title:
      target
        .querySelector<HTMLElement>(':scope > .vditor-ir__marker--title')
        ?.textContent?.trim() ?? null,
  }
}

function candidateTuple(
  markdown: string,
  candidate: LinkPopoverCandidate,
  projection: BlockProjection,
): TargetTuple | null {
  const detached = document.createElement('div')
  detached.innerHTML = projection.render(
    markdown.slice(candidate.syntaxStart, candidate.syntaxEnd),
  )
  const nodes = detached.querySelectorAll<HTMLElement>(
    '[data-type="a"], [data-type="img"]',
  )
  if (nodes.length !== 1) return null
  const tuple = targetTuple(nodes[0])
  return tuple?.kind === candidate.kind &&
    tuple.destination === candidate.destination &&
    Boolean(tuple.title) === Boolean(candidate.title)
    ? tuple
    : null
}

function groupCandidates(
  markdown: string,
  start: number,
  end: number,
): LinkPopoverCandidate[] {
  return listLinkPopoverCandidates(markdown).filter(
    (candidate) => candidate.syntaxStart >= start && candidate.syntaxEnd <= end,
  )
}

interface SourceGroupBinding {
  sourceStart: number
  sourceEnd: number
  renderedStart: number
  renderedEnd: number
  members: HTMLElement[]
}

function sourceGroupBinding(
  editor: HTMLElement,
  target: HTMLElement,
  exact: string,
  rendered: string,
  projection: BlockProjection,
): SourceGroupBinding | null {
  const sourceGroups = resolveBlockHandleUnits(
    editor,
    exact,
    rendered,
    projection,
  )
  const renderedGroups = scanMovableBlocks(rendered)
  if (
    !sourceGroups ||
    sourceGroups.length !== renderedGroups.length ||
    sourceGroups.some(
      (group, index) => group.kind !== renderedGroups[index].kind,
    )
  )
    return null
  const index = sourceGroups.findIndex((group) =>
    group.members.some((member) => member.contains(target)),
  )
  if (index < 0) return null
  return {
    sourceStart: sourceGroups[index].start,
    sourceEnd: sourceGroups[index].end,
    renderedStart: renderedGroups[index].start,
    renderedEnd: renderedGroups[index].end,
    members: sourceGroups[index].members,
  }
}

function orderedTargetIdentityMatches(
  exact: string,
  rendered: string,
  source: LinkPopoverCandidate[],
  visible: LinkPopoverCandidate[],
  nodes: HTMLElement[],
  projection: BlockProjection,
): boolean {
  return source.every((candidate, index) => {
    const authored = candidateTuple(exact, candidate, projection)
    const projected = candidateTuple(rendered, visible[index], projection)
    const live = targetTuple(nodes[index])
    return Boolean(
      authored &&
        projected &&
        live &&
        JSON.stringify(authored) === JSON.stringify(projected) &&
        JSON.stringify(projected) === JSON.stringify(live),
    )
  })
}

function sourceSpanFor(
  editor: HTMLElement,
  target: HTMLElement,
  marker: HTMLElement,
  kind: LinkPopoverTargetKind,
  exact: string,
  rendered: string,
): LinkPopoverDestinationSpan | null {
  const range = document.createRange()
  range.selectNodeContents(marker)
  // A hidden IR marker maps against the live Lute serialization. It cannot be
  // mapped directly against authored CRLF or table bytes that Vditor normalizes.
  const mapped = captureRewrapSourceRange(window, range, {
    authoritativeMarkdown: rendered,
  })
  if (!mapped || mapped.markdown !== rendered) return null
  const projection = currentBlockProjection()
  if (projection?.mode !== 'ir') return null
  const group = sourceGroupBinding(editor, target, exact, rendered, projection)
  if (
    !group ||
    mapped.startOffset < group.renderedStart ||
    mapped.endOffset > group.renderedEnd
  )
    return null
  const sourceCandidates = groupCandidates(
    exact,
    group.sourceStart,
    group.sourceEnd,
  )
  const renderedCandidates = groupCandidates(
    rendered,
    group.renderedStart,
    group.renderedEnd,
  )
  const liveNodes = group.members.flatMap((member) =>
    Array.from(
      member.querySelectorAll<HTMLElement>(
        '[data-type="a"], [data-type="img"]',
      ),
    ),
  )
  if (
    !sourceCandidates.length ||
    sourceCandidates.length !== renderedCandidates.length ||
    renderedCandidates.length !== liveNodes.length
  )
    return null
  const index = renderedCandidates.findIndex(
    (candidate) =>
      candidate.start === mapped.startOffset &&
      candidate.end === mapped.endOffset &&
      candidate.kind === kind,
  )
  if (
    index < 0 ||
    liveNodes[index] !== target ||
    !orderedTargetIdentityMatches(
      exact,
      rendered,
      sourceCandidates,
      renderedCandidates,
      liveNodes,
      projection,
    )
  )
    return null
  const candidate = sourceCandidates[index]
  const span = { start: candidate.start, end: candidate.end, kind }
  return planLinkPopoverAction(exact, span, { kind: 'unlink' }).status ===
    'changed'
    ? span
    : null
}

function visibleOwnerRect(
  target: HTMLElement,
  kind: LinkPopoverTargetKind,
): AnchorRect | null {
  const visible =
    kind === 'link'
      ? target.querySelector<HTMLElement>(':scope > .vditor-ir__link')
      : target.querySelector<HTMLElement>(':scope > img')
  if (!visible) return null
  const rect = visible.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
    ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    : null
}

function sameLiveOwner(
  owner: LinkPopoverOwner,
  deps: LinkPopoverDeps,
  checkSelection: boolean,
): boolean {
  const inner = innerVditor()
  return Boolean(
    !isCompositionActive() &&
      window.vditor === owner.outer &&
      inner === owner.inner &&
      inner?.currentMode === 'ir' &&
      activeModeElement(owner.outer) === owner.editor &&
      owner.editor.isConnected &&
      owner.editor.contains(owner.target) &&
      owner.target.isConnected &&
      owner.editor.contains(owner.marker) &&
      owner.marker.isConnected &&
      owner.destinationRange.startContainer.isConnected &&
      owner.destinationRange.endContainer.isConnected &&
      owner.editor.contains(owner.destinationRange.startContainer) &&
      owner.editor.contains(owner.destinationRange.endContainer) &&
      owner.outer.getValue() === owner.rendered &&
      deps.snapshotExactMarkdown() === owner.exact &&
      (!checkSelection || rangeMatches(owner.selection)),
  )
}

interface PreparedLinkAction {
  before: string
  renderedBefore: string
  plan: Extract<LinkPopoverPlan, { status: 'changed' }>
  projectedAfter: string
}

function prepareLinkAction(
  record: LinkPopoverOwner,
  action: LinkPopoverAction,
  deps: LinkPopoverDeps,
  checkSelection: boolean,
): PreparedLinkAction | null {
  if (!record.sourceSpan || !sameLiveOwner(record, deps, checkSelection))
    return null
  const before = deps.snapshotExactMarkdown()
  const renderedBefore = record.outer.getValue()
  if (before !== record.exact || renderedBefore !== record.rendered) return null
  const rebound = sourceSpanFor(
    record.editor,
    record.target,
    record.marker,
    record.kind,
    before,
    renderedBefore,
  )
  if (
    !rebound ||
    rebound.start !== record.sourceSpan.start ||
    rebound.end !== record.sourceSpan.end ||
    rebound.kind !== record.sourceSpan.kind ||
    record.marker.textContent?.trim() !== record.destination
  )
    return null
  const plan = planLinkPopoverAction(before, record.sourceSpan, action)
  if (plan.status !== 'changed') return null
  const projection = currentBlockProjection()
  if (
    projection?.owner !== record.inner.lute ||
    projection.mode !== 'ir' ||
    projection.serialize(projection.render(before)) !== renderedBefore
  )
    return null
  return {
    before,
    renderedBefore,
    plan,
    projectedAfter: projection.serialize(projection.render(plan.markdown)),
  }
}

function mutateLinkDom(
  record: LinkPopoverOwner,
  action: LinkPopoverAction,
  replacement: string,
): void {
  record.editor.focus({ preventScroll: true })
  const selection = window.getSelection()
  if (!selection) throw new Error('link editor selection unavailable')
  if (action.kind === 'edit') {
    selection.removeAllRanges()
    selection.addRange(record.destinationRange)
    if (!document.execCommand('insertText', false, replacement))
      throw new Error('link destination insertion was rejected')
    return
  }
  const range = document.createRange()
  range.selectNode(record.target)
  range.deleteContents()
  const text = document.createTextNode(replacement)
  range.insertNode(text)
  range.setStartAfter(text)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
  record.editor.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: replacement,
    }),
  )
}

function recordLinkHistory(
  record: LinkPopoverOwner,
  prepared: PreparedLinkAction,
  afterRendered: string,
): void {
  checkpointEditorUndo(record.inner)
  const nativeState = (record.inner.undo as any)?.ir?.undoStack?.at(-1)
  if (!nativeState) throw new Error('link action undo checkpoint missing')
  recordRewrapDocumentHistory({
    owner: record.inner,
    mode: 'ir',
    nativeState,
    beforeRendered: prepared.renderedBefore,
    beforeExact: prepared.before,
    afterRendered,
    afterExact: prepared.plan.markdown,
  })
}

/** One body-owned IR link/image panel. Its click gate runs before Vditor expands source markers. */
export function installLinkPopover(deps: LinkPopoverDeps): () => void {
  const overlay = createFloatingOverlay('vmde-link-popover')
  overlay.element.setAttribute('role', 'group')
  overlay.element.setAttribute('aria-label', 'Link actions')
  const targetLabel = document.createElement('div')
  targetLabel.className = 'vmde-link-popover-target'
  targetLabel.setAttribute('aria-live', 'polite')
  const actions = document.createElement('div')
  actions.className = 'vmde-link-popover-actions'
  const makeButton = (action: string, label: string) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.action = action
    button.textContent = label
    button.setAttribute('aria-label', label)
    return button
  }
  const openButton = makeButton('open', 'Open')
  const copyButton = makeButton('copy', 'Copy URL')
  const editButton = makeButton('edit', 'Edit URL')
  const unlinkButton = makeButton('unlink', 'Unlink')
  actions.append(openButton, copyButton, editButton, unlinkButton)
  const edit = document.createElement('div')
  edit.className = 'vmde-link-popover-edit'
  edit.hidden = true
  const input = document.createElement('input')
  input.type = 'text'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'URL')
  const saveButton = makeButton('save', 'Save')
  const cancelButton = makeButton('cancel', 'Cancel')
  edit.append(input, saveButton, cancelButton)
  overlay.element.append(targetLabel, actions, edit)
  let owner: LinkPopoverOwner | null = null
  let timer: number | undefined
  let editing = false
  let inputComposing = false
  let editingSelectionReady = false
  // jsdom and older webviews may lack ResizeObserver; scroll/selection/resize
  // still position the panel, while supported runtimes track its input width.
  const resizeObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          if (owner) position(owner)
        })
      : null
  resizeObserver?.observe(overlay.element)
  const hide = () => {
    overlay.hide()
    edit.hidden = true
    actions.hidden = false
    editing = false
    inputComposing = false
    editingSelectionReady = false
    owner = null
  }
  const position = (record: LinkPopoverOwner) => {
    overlay.show(record.rect)
    const scroller = record.editor
      .closest('.vditor-content')
      ?.getBoundingClientRect()
    const toolbar = document
      .querySelector('.vditor-toolbar')
      ?.getBoundingClientRect()
    const bounds = elementPanelBounds(
      { width: window.innerWidth, height: window.innerHeight },
      scroller,
      toolbar,
    )
    const maxWidth = `${Math.max(0, bounds.right - bounds.left)}px`
    if (overlay.element.style.maxWidth !== maxWidth)
      overlay.element.style.maxWidth = maxWidth
    const panel = overlay.element.getBoundingClientRect()
    const next = elementPanelPosition(
      record.rect,
      { width: panel.width, height: panel.height },
      bounds,
      rangeRect(record.selection),
      'below',
    )
    if (!next) {
      hide()
      return false
    }
    overlay.element.style.left = `${next.left}px`
    overlay.element.style.top = `${next.top}px`
    return true
  }
  const makeOwner = (
    target: HTMLElement,
    kind: LinkPopoverTargetKind,
  ): LinkPopoverOwner | null => {
    const outer = window.vditor
    const inner = innerVditor()
    const editor = outer ? activeModeElement(outer) : null
    if (
      !outer ||
      !inner ||
      inner.currentMode !== 'ir' ||
      !editor ||
      !editor.contains(target)
    )
      return null
    const marker = target.querySelector<HTMLElement>(
      ':scope > .vditor-ir__marker--link',
    )
    const rect = visibleOwnerRect(target, kind)
    const destination = marker?.textContent?.trim() ?? ''
    if (!marker || !destination || !rect) return null
    const selection = window.getSelection()
    const selectionRange = selection?.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : null
    const destinationRange = document.createRange()
    destinationRange.selectNodeContents(marker)
    const exact = deps.snapshotExactMarkdown()
    const rendered = outer.getValue()
    const sourceSpan = sourceSpanFor(
      editor,
      target,
      marker,
      kind,
      exact,
      rendered,
    )
    return {
      outer,
      inner,
      editor,
      target,
      marker,
      kind,
      destination,
      destinationRange,
      selection: selectionRange,
      exact,
      rendered,
      rect,
      sourceSpan,
      settleImageSelection: false,
    }
  }
  const show = (record: LinkPopoverOwner) => {
    owner = record
    targetLabel.dataset.kind = record.kind
    targetLabel.textContent = record.destination
    edit.hidden = true
    actions.hidden = false
    editing = false
    editButton.disabled = !record.sourceSpan
    unlinkButton.disabled = !record.sourceSpan
    position(record)
  }
  const selectedOwner = (): LinkPopoverOwner | null => {
    const inner = innerVditor()
    const editor = window.vditor ? activeModeElement(window.vditor) : null
    const selection = window.getSelection()
    if (
      inner?.currentMode !== 'ir' ||
      !editor ||
      !selection?.isCollapsed ||
      isCompositionActive()
    )
      return null
    const target = linkPopoverTarget(selection.anchorNode)
    return target && editor.contains(target.element)
      ? makeOwner(target.element, target.kind)
      : null
  }
  const refresh = () => {
    timer = undefined
    if (editing) return
    if (owner?.settleImageSelection && sameLiveOwner(owner, deps, false)) {
      // Browser image clicks may relocate the document selection after our
      // capture-phase gate. Retain the source-proven target for this one settle,
      // then make later selection changes invalidate it normally.
      const selection = window.getSelection()
      owner.selection = selection?.rangeCount
        ? selection.getRangeAt(0).cloneRange()
        : null
      owner.settleImageSelection = false
      show(owner)
      return
    }
    const next = selectedOwner()
    if (next) show(next)
    else hide()
  }
  const schedule = () => {
    if (timer !== undefined) window.clearTimeout(timer)
    timer = window.setTimeout(refresh, 32)
  }
  const onSelectionChange = () => {
    if (editing) {
      if (editingSelectionReady && owner && editorSelectionMoved(owner)) hide()
      return
    }
    schedule()
  }
  const onPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (target && overlay.element.contains(target)) {
      if (!target.closest('input')) event.preventDefault()
      return
    }
    const source = pointerPopoverTarget(event)
    const selection = window.getSelection()
    if (
      source &&
      event.button === 0 &&
      !event.shiftKey &&
      !event.altKey &&
      !opensLinkByPointerPolicy(source, event) &&
      (source.kind === 'image' || !selection || selection.isCollapsed)
    ) {
      // Real VS Code expands IR markers from pointerdown/selectionchange before
      // click; consume only an ordinary target press, leaving modifier Open and
      // existing text selection gestures on other content native.
      event.preventDefault()
      event.stopImmediatePropagation()
      hide()
      return
    }
    hide()
  }
  const onClickCapture = (event: MouseEvent) => {
    const target = pointerPopoverTarget(event)
    if (!target) return
    if (opensLinkByPointerPolicy(target, event)) {
      hide()
      return
    }
    const selection = window.getSelection()
    if (target.kind === 'link' && selection && !selection.isCollapsed) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const record = makeOwner(target.element, target.kind)
    if (record) {
      record.settleImageSelection = target.kind === 'image'
      show(record)
      if (record.settleImageSelection) schedule()
    } else hide()
  }
  const showEdit = (record: LinkPopoverOwner) => {
    actions.hidden = true
    edit.hidden = false
    editing = true
    editingSelectionReady = false
    input.value = record.destination
    input.focus({ preventScroll: true })
    input.select()
    window.requestAnimationFrame(() => {
      if (owner !== record || !editing) return
      // Input focus may settle the browser selection after the button click.
      // Retain that settled Range; a later editor-owned change is a new target.
      const selection = window.getSelection()
      record.selection = selection?.rangeCount
        ? selection.getRangeAt(0).cloneRange()
        : null
      editingSelectionReady = true
    })
  }
  const applyAction = (
    record: LinkPopoverOwner,
    action: LinkPopoverAction,
  ): boolean => {
    if (editing && editingSelectionReady && editorSelectionMoved(record)) {
      hide()
      return false
    }
    const prepared = prepareLinkAction(record, action, deps, !editing)
    if (!prepared) return false
    const scroller = findScroller(record.editor)
    const scrollTop = scroller.scrollTop
    const undoSnapshot = snapshotTableUndoForRollback(record.inner)
    deps.setApplying(true)
    try {
      checkpointEditorUndo(record.inner)
      mutateLinkDom(record, action, prepared.plan.sourceReplacement)
      const afterRendered = record.outer.getValue()
      if (afterRendered !== prepared.projectedAfter)
        throw new Error(
          'link edit diverged from the planned exact source projection',
        )
      recordLinkHistory(record, prepared, afterRendered)
      scroller.scrollTop = scrollTop
      record.editor.focus({ preventScroll: true })
      hide()
    } catch (error) {
      try {
        record.outer.setValue(prepared.before)
        restoreTableUndoForRollback(record.inner, undoSnapshot)
        scroller.scrollTop = scrollTop
      } catch {
        // Never publish a speculative Markdown splice if the rendered rollback also fails.
      }
      deps.onError(error)
      hide()
      return false
    } finally {
      deps.setApplying(false)
    }
    // edit-sync suppresses posts while setApplying(true) protects the Vditor
    // mutation; publish exact authored bytes only after that guard is released.
    deps.postExact(prepared.plan.markdown)
    return true
  }
  const onClick = (event: MouseEvent) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action]',
    )
    const action = button?.dataset.action
    const record = owner
    if (!action || !record || !sameLiveOwner(record, deps, !editing)) {
      hide()
      return
    }
    switch (action) {
      case 'open':
        openLinkUrl(record.destination)
        hide()
        break
      case 'copy':
        window.vscode?.postMessage({
          command: 'copy-link-url',
          href: record.destination,
        })
        hide()
        break
      case 'edit':
        if (record.sourceSpan) showEdit(record)
        break
      case 'cancel':
        show(record)
        break
      case 'save':
        if (
          !applyAction(record, {
            kind: 'edit',
            destination: input.value,
          }) &&
          owner
        ) {
          edit.setAttribute('data-error', 'true')
          input.focus({ preventScroll: true })
        }
        break
      case 'unlink':
        applyAction(record, { kind: 'unlink' })
        break
    }
    event.stopPropagation()
  }
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !overlay.element.hidden) {
      event.preventDefault()
      hide()
      return
    }
    if (
      event.key === 'Enter' &&
      editing &&
      !inputComposing &&
      event.target === input
    ) {
      event.preventDefault()
      if (owner) applyAction(owner, { kind: 'edit', destination: input.value })
    }
  }
  const onCompositionStart = (event: CompositionEvent) => {
    if (overlay.element.contains(event.target as Node)) {
      inputComposing = true
      return
    }
    hide()
  }
  const onCompositionEnd = (event: CompositionEvent) => {
    if (overlay.element.contains(event.target as Node)) {
      inputComposing = false
      return
    }
    schedule()
  }
  const onMutation = () => {
    if (owner && sameLiveOwner(owner, deps, !editing)) return
    hide()
  }
  const app = document.getElementById('app')
  const observer = app ? new MutationObserver(onMutation) : null
  observer?.observe(app!, {
    subtree: true,
    childList: true,
    characterData: true,
  })
  document.addEventListener('selectionchange', onSelectionChange)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('click', onClickCapture, true)
  document.addEventListener('scroll', hide, true)
  document.addEventListener('dragstart', hide, true)
  document.addEventListener('compositionstart', onCompositionStart, true)
  document.addEventListener('compositionend', onCompositionEnd, true)
  document.addEventListener('keydown', onKeydown, true)
  window.addEventListener('resize', hide)
  overlay.element.addEventListener('click', onClick)
  return () => {
    if (timer !== undefined) window.clearTimeout(timer)
    observer?.disconnect()
    resizeObserver?.disconnect()
    document.removeEventListener('selectionchange', onSelectionChange)
    document.removeEventListener('pointerdown', onPointerDown, true)
    document.removeEventListener('click', onClickCapture, true)
    document.removeEventListener('scroll', hide, true)
    document.removeEventListener('dragstart', hide, true)
    document.removeEventListener('compositionstart', onCompositionStart, true)
    document.removeEventListener('compositionend', onCompositionEnd, true)
    document.removeEventListener('keydown', onKeydown, true)
    window.removeEventListener('resize', hide)
    overlay.element.removeEventListener('click', onClick)
    overlay.dispose()
  }
}
