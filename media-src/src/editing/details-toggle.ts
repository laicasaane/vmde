import { captureCalloutActionTarget } from './callouts'
import { invalidateCaret } from './caret'
import { transformDetailsSelection } from './details'
import { resolveDetailsBlockRange, type SourceRange } from './details-source'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import {
  captureRewrapSourceRange,
  mapCaretOffsetByLine,
  replaceSvMarkdownRange,
} from './rewrap-command'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'
import { readDetailsSelectionState } from './details-selection-state'
import type {
  SourceBlockIndex,
  SourceBlockIndexHandle,
} from '../nav/source-block-index'
import { isCompositionActive } from '../util/caret-gesture'
import { observeBlockTransformChoice } from './block-transform-command'

export interface DetailsToggleDeps {
  setApplying(applying: boolean): void
  /** Task 630: settle typing and pull the host-exact bytes (`null`: no proof, the toggle declines). */
  acquireExactAuthority(): Promise<{ exact: string; rendered: string } | null>
  /** `rollback` restores what the toggle changed besides the DOM when the host refuses the edit. */
  postExact(markdown: string, opts?: { rollback?: { restore(): void } }): void
  onError(error: unknown): void
  snapshotMarkdown?(): string
}

function sameIgnoringTrailingBreaks(a: string, b: string): boolean {
  return (
    a.replace(/(?:(?:\r\n|\n|\r)[\t ]*)+$/u, '') ===
    b.replace(/(?:(?:\r\n|\n|\r)[\t ]*)+$/u, '')
  )
}

function uniqueMarker(markdown: string, base: string): string {
  let index = 0
  for (;;) {
    const marker = `\uE480${base}_${index}\uE48F`
    if (!markdown.includes(marker)) return marker
    index++
  }
}

function removeMarker(
  root: HTMLElement,
  marker: string,
): { node: Text; offset: number } | null {
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text
    const offset = text.data.indexOf(marker)
    if (offset < 0) continue
    text.deleteData(offset, marker.length)
    return { node: text, offset }
  }
  return null
}

function captureTarget(exactMarkdown?: string): SourceRange | null {
  const target = captureCalloutActionTarget(window)
  if (!target) return null
  const snapshot =
    configuredDeps?.snapshotMarkdown?.() ?? target.selection.markdown
  const markdown =
    exactMarkdown &&
    sameIgnoringTrailingBreaks(target.selection.markdown, exactMarkdown)
      ? exactMarkdown
      : snapshot
  return resolveDetailsBlockRange(
    markdown,
    target.selection.startOffset,
    target.selection.endOffset,
  )
}

const toLf = (text: string): string => text.replace(/\r\n|\r/gu, '\n')

/** Map a block range captured over the rendered bytes onto the host-exact bytes. Line mapping alone
 * guesses at a missing line, so the proof is that the mapped slice reads like the captured one. */
function mapRangeToExact(
  captured: SourceRange,
  exact: string,
): SourceRange | null {
  const startOffset = mapCaretOffsetByLine(
    captured.markdown,
    exact,
    captured.startOffset,
  )
  const endOffset = mapCaretOffsetByLine(
    captured.markdown,
    exact,
    captured.endOffset,
  )
  if (
    startOffset === null ||
    endOffset === null ||
    startOffset > endOffset ||
    toLf(exact.slice(startOffset, endOffset)) !==
      toLf(captured.markdown.slice(captured.startOffset, captured.endOffset))
  )
    return null
  return { markdown: exact, startOffset, endOffset }
}

interface DetailsActionOwner {
  outer: NonNullable<Window['vditor']>
  inner: NonNullable<ReturnType<typeof innerVditor>>
  editor: HTMLElement
  mode: string | undefined
}

/** The editor identity the toggle was started on; null when no editable surface is live. */
function detailsOwner(win: Window): DetailsActionOwner | null {
  const outer = win.vditor
  const inner = innerVditor()
  const editor = outer ? activeModeElement(outer) : null
  return outer && inner && editor
    ? { outer, inner, editor, mode: inner.currentMode }
    : null
}

function detailsOwnerIsLive(win: Window, owner: DetailsActionOwner): boolean {
  const inner = innerVditor()
  return (
    win.vditor === owner.outer &&
    inner === owner.inner &&
    inner.currentMode === owner.mode &&
    owner.editor.isConnected &&
    activeModeElement(owner.outer) === owner.editor &&
    !isCompositionActive()
  )
}

/**
 * Task 630: acquire the host-exact bytes, plan on them, apply, and post with a rollback. Resolves
 * the rendered-coordinate result (the retained toggle state), or null when the toggle declined.
 * IR/WYSIWYG rebuild the DOM from the exact plan; SV keeps its LF source text and the exact plan is
 * only proven equal to it up to line endings.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one transaction keeps acquisition, liveness, mapping, apply, rollback handle and post together.
async function runDetailsToggle(
  win: Window,
  deps: DetailsToggleDeps,
  captured: SourceRange | null,
  inputUnchanged: () => boolean,
): Promise<SourceRange | null> {
  try {
    const owner = detailsOwner(win)
    if (!captured || !owner) return null
    const rendered = transformDetailsSelection({ ...captured, resolved: true })
    if (rendered.status === 'disabled') return null
    const pair = await deps.acquireExactAuthority()
    if (
      !pair ||
      !detailsOwnerIsLive(win, owner) ||
      !inputUnchanged() ||
      !sameIgnoringTrailingBreaks(captured.markdown, pair.rendered)
    )
      return null
    const exactRange = mapRangeToExact(captured, pair.exact)
    if (!exactRange) return null
    const exact = transformDetailsSelection({ ...exactRange, resolved: true })
    if (exact.status === 'disabled') return null
    const sv = owner.mode === 'sv'
    if (sv && toLf(exact.markdown) !== toLf(rendered.markdown)) return null
    // What the editor shows: the exact plan, or (SV) the same plan in the editor's LF text.
    const result = sv ? rendered : exact
    const before = sv ? captured.markdown : pair.exact
    const { outer, inner, editor } = owner
    const startMarker = uniqueMarker(result.markdown, 'VMDE_DETAILS_START')
    const endMarker = uniqueMarker(
      result.markdown + startMarker,
      'VMDE_DETAILS_END',
    )
    const marked =
      result.markdown.slice(0, result.endOffset) +
      endMarker +
      result.markdown.slice(result.endOffset)
    const withMarkers =
      marked.slice(0, result.startOffset) +
      startMarker +
      marked.slice(result.startOffset)
    const scroller = findScroller(editor)
    const scrollTop = scroller.scrollTop
    const undoSnapshot = snapshotTableUndoForRollback(inner)
    deps.setApplying(true)
    try {
      inner.undo?.addToUndoStack?.(inner)
      if (sv) {
        if (
          !replaceSvMarkdownRange(editor, editor.textContent ?? before, {
            markdown: withMarkers,
            caretOffset: result.endOffset + startMarker.length,
          })
        )
          return null
      } else {
        outer.setValue(withMarkers)
      }
      const fresh = activeModeElement(outer)
      const start = fresh ? removeMarker(fresh, startMarker) : null
      const end = fresh ? removeMarker(fresh, endMarker) : null
      if (!fresh || !start || !end) {
        outer.setValue(before)
        return null
      }
      inner.undo?.addToUndoStack?.(inner)
      // Task 609: the checkpoint above restores through the caret authority and arms an intent for
      // the caret from before the rewrite. This command (a toolbar press or a host command with no
      // preceding gesture) now selects the wrapped body deliberately, and that selection supersedes
      // the pending intent; left armed, it re-asserts the old caret over the selection.
      invalidateCaret()
      const range = fresh.ownerDocument.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset)
      const selection = fresh.ownerDocument.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      fresh.focus({ preventScroll: true })
      const nextScroller = findScroller(fresh)
      nextScroller.scrollTop = Math.min(
        scrollTop,
        Math.max(0, nextScroller.scrollHeight - nextScroller.clientHeight),
      )
    } finally {
      deps.setApplying(false)
    }
    // Task 607 (D2): a host refusal rebuilds the DOM from the host text; the Undo stacks this
    // transaction touched are restored here. `before` stays the owned base (setValue keeps it).
    deps.postExact(exact.markdown, {
      rollback: {
        restore: () => restoreTableUndoForRollback(inner, undoSnapshot),
      },
    })
    return rendered
  } catch (error) {
    deps.onError(error)
    return null
  }
}

let configuredDeps: DetailsToggleDeps | undefined

export function configureDetailsToggle(deps: DetailsToggleDeps): void {
  configuredDeps = deps
}

function previewOpen(): boolean {
  const button = innerVditor()?.toolbar?.elements?.preview?.children[0]
  return button?.classList.contains('vditor-menu--current') === true
}

type DetailsStatus = 'wrap' | 'unwrap' | 'disabled'

const statusOf = (target: SourceRange | null): DetailsStatus =>
  target
    ? transformDetailsSelection({ ...target, resolved: true }).status
    : 'disabled'

/** The same capture as `captureTarget`, from a known Range and an optional warm rendered source. */
function captureRangeTarget(
  range: Range,
  rendered: string | undefined,
  exactMarkdown: string | undefined,
): SourceRange | null {
  const selection = captureRewrapSourceRange(
    window,
    range,
    rendered === undefined ? {} : { authoritativeMarkdown: rendered },
  )
  if (!selection) return null
  const snapshot =
    rendered ?? configuredDeps?.snapshotMarkdown?.() ?? selection.markdown
  const markdown =
    exactMarkdown &&
    sameIgnoringTrailingBreaks(selection.markdown, exactMarkdown)
      ? exactMarkdown
      : snapshot
  return resolveDetailsBlockRange(
    markdown,
    selection.startOffset,
    selection.endOffset,
  )
}

/** What the passive-state and action helpers need from one controller instance. */
interface DetailsControllerView {
  retained: SourceRange | null
  exactMarkdown: string | undefined
  retainedFor(entry: SourceBlockIndex | null): SourceRange | null
  retainedForCurrentSource(): SourceRange | null
  exactFallbackState(entry: SourceBlockIndex | null): DetailsStatus | null
}

/** Index-derived state for an expanded selection; 'unknown' needs the exact fallback. */
function expandedDetailsState(
  view: DetailsControllerView,
  entry: SourceBlockIndex,
  range: Range,
): DetailsStatus | 'unknown' {
  const state = readDetailsSelectionState(entry, range)
  const kept = state === 'disabled' ? view.retainedFor(entry) : null
  // The exact path fell back to the retained result when a capture resolved to nothing.
  return kept ? statusOf(kept) : state
}

/** Passive IR/WYSIWYG state from a warm entry only; 'unknown' needs a build or the exact
 * fallback and keeps the current button state until the selection settles. */
function warmDetailsState(
  view: DetailsControllerView,
  entry: SourceBlockIndex | null,
  range: Range | null,
): DetailsStatus | 'unknown' {
  const expanded = range && !range.collapsed ? range : null
  if (!expanded && !view.retained) return 'disabled'
  if (!entry) return 'unknown'
  return expanded
    ? expandedDetailsState(view, entry, expanded)
    : statusOf(view.retainedFor(entry))
}

/** Settled state from the entry one build delivered; may run the exact fallback once. */
function settledDetailsState(
  view: DetailsControllerView,
  entry: SourceBlockIndex | null,
  range: Range | null,
): DetailsStatus | null {
  const expanded = range && !range.collapsed ? range : null
  if (!expanded && !view.retained) return 'disabled'
  if (entry && expanded) {
    const state = expandedDetailsState(view, entry, expanded)
    return state === 'unknown' ? view.exactFallbackState(entry) : state
  }
  if (entry) return statusOf(view.retainedFor(entry))
  // Without a cacheable key (e.g. a non-editable root or no revision authority), settle on
  // today's exact path.
  return expanded
    ? view.exactFallbackState(null)
    : statusOf(view.retainedForCurrentSource())
}

/** Exact action target: one capture from the live Range, else the still-current retained result. */
function detailsActionTarget(
  view: DetailsControllerView,
  source: SourceBlockIndexHandle,
  live: Range | null,
): SourceRange | null {
  const entry = source.peek()
  if (live && !live.collapsed) {
    const target = entry
      ? captureRangeTarget(live, entry.rendered, view.exactMarkdown)
      : captureTarget(view.exactMarkdown)
    if (target) return target
  }
  const retained = view.retained
  if (!retained) return null
  // Display compares rendered bytes, as before; applying the retained result additionally
  // requires the current exact bytes, so an invisible external change is never reverted.
  const current = entry ?? source.read()
  return current &&
    view.retainedFor(current) &&
    sameIgnoringTrailingBreaks(current.exact, retained.markdown)
    ? retained
    : null
}

/**
 * Details toolbar state and action (Task 533). In IR/WYSIWYG with a shared source index (Task
 * 574), passive selection reads the index: no serialization, no live markers. A state the index
 * cannot derive ('unknown') runs today's exact capture once per settled selection (pointer
 * release, or a quiet frame after key release). The action always captures exact source again.
 * SV, and installs without an index, keep the explicit capture on every selection change.
 */
export function installDetailsToggleControls(
  index?: SourceBlockIndexHandle,
): () => void {
  const doc = document
  const button = doc.querySelector<HTMLButtonElement>(
    '.vditor-toolbar [data-type="details"]',
  )
  let pending: SourceRange | null = null
  // The last toggle's result stays the target while the source still equals its bytes (Task 533):
  // a capture right after setValue can fail, and a collapsed caret keeps the pressed state.
  let retained: SourceRange | null = null
  let settleAfterToggle = false
  let retainedCheck: {
    entry: SourceBlockIndex
    target: SourceRange
    valid: boolean
  } | null = null
  let exactMarkdown: string | undefined
  let frame = 0
  let settleFrame = 0
  let selectionGeneration = 0
  let settled = false
  let primaryPointerHeld = false
  const keysHeld = new Set<string>()
  let fallback: { generation: number; status: DetailsStatus } | null = null
  let inputGeneration = 0
  let cancelSettledRead: (() => void) | null = null
  let focusDeferred = false
  let choicePending = false
  let fallbackDeferred = false

  const indexed = (): boolean => {
    const mode = innerVditor()?.currentMode
    return Boolean(index) && (mode === 'ir' || mode === 'wysiwyg')
  }
  const applyState = (status: DetailsStatus) => {
    if (!button) return
    const enabled = status !== 'disabled'
    const active = status === 'unwrap'
    button.disabled = !enabled
    button.setAttribute('aria-disabled', String(!enabled))
    button.setAttribute('aria-pressed', String(active))
    button.classList.toggle('vditor-menu--current', active)
  }
  const retainedForCurrentSource = () => {
    if (
      !retained ||
      !sameIgnoringTrailingBreaks(
        window.vditor?.getValue() ?? '',
        retained.markdown,
      )
    )
      return null
    return retained
  }
  // Same test as `retainedForCurrentSource`, against the index entry's rendered bytes (the value
  // `getValue()` returns) instead of a fresh serialization; checked once per entry.
  const retainedFor = (entry: SourceBlockIndex | null): SourceRange | null => {
    if (!retained || !entry) return null
    if (retainedCheck?.entry !== entry || retainedCheck.target !== retained)
      retainedCheck = {
        entry,
        target: retained,
        valid: sameIgnoringTrailingBreaks(entry.rendered, retained.markdown),
      }
    return retainedCheck.valid ? retained : null
  }
  const selectionExpanded = () => {
    const selection = doc.getSelection()
    return Boolean(selection?.rangeCount && !selection.isCollapsed)
  }
  const legacyTarget = () => {
    const retainedTarget = retainedForCurrentSource()
    if (!selectionExpanded()) return retainedTarget
    return captureTarget(exactMarkdown) ?? retainedTarget
  }
  const liveEditorRange = (): Range | null => {
    const selection = doc.getSelection()
    const root = window.vditor ? activeModeElement(window.vditor) : null
    if (!root || !selection?.rangeCount) return null
    const range = selection.getRangeAt(0)
    return root.contains(range.startContainer) &&
      root.contains(range.endContainer)
      ? range
      : null
  }
  const exactFallbackState = (
    entry: SourceBlockIndex | null,
  ): DetailsStatus | null => {
    // Passive markers split the live selection's text nodes and invalidate Turn Into's pending
    // token (Task 604 N3). Keep the current button state until that choice is consumed/cancelled.
    if (choicePending) {
      fallbackDeferred = true
      return null
    }
    if (fallback?.generation !== selectionGeneration)
      fallback = {
        generation: selectionGeneration,
        status: statusOf(captureTarget(exactMarkdown) ?? retainedFor(entry)),
      }
    return fallback.status
  }
  const view: DetailsControllerView = {
    get retained() {
      return retained
    },
    get exactMarkdown() {
      return exactMarkdown
    },
    retainedFor,
    retainedForCurrentSource,
    exactFallbackState,
  }
  const indexedUpdate = (source: SourceBlockIndexHandle) => {
    // Never build or capture while a native drag is in progress; release schedules an update.
    if (primaryPointerHeld) return
    const state = warmDetailsState(view, source.peek(), liveEditorRange())
    if (state !== 'unknown') {
      settleAfterToggle = false
      applyState(state)
      return
    }
    // Before the selection settles, keep the current state rather than capturing.
    if (!settled && !settleAfterToggle) return
    // Task 577: the settled build or exact fallback waits for the selection bubble's first
    // frame (the index runs it at once when nothing holds builds). The current state stays until
    // then; a reselection, edit or new drag in between discards the result.
    const generation = selectionGeneration
    const edits = inputGeneration
    cancelSettledRead = source.readWhenReady((entry) => {
      cancelSettledRead = null
      if (
        primaryPointerHeld ||
        generation !== selectionGeneration ||
        edits !== inputGeneration
      )
        return
      settleAfterToggle = false
      const state = settledDetailsState(view, entry, liveEditorRange())
      if (state !== null) applyState(state)
    })
  }
  const update = () => {
    frame = 0
    cancelSettledRead?.()
    if (!button) return
    if (previewOpen() || isCompositionActive()) {
      applyState('disabled')
      return
    }
    // Find selects matches while retaining input focus. Passive Details capture would serialize
    // and insert markers that invalidate Find's mapper; keep the button state until focus leaves.
    if (doc.activeElement?.closest('.vmde-find-replace')) {
      focusDeferred = true
      return
    }
    focusDeferred = false
    if (index && indexed()) indexedUpdate(index)
    else applyState(statusOf(legacyTarget()))
  }
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(update)
  }
  // Settled: one quiet frame after the last selection change with no key or primary button held.
  const armSettle = () => {
    if (settleFrame) cancelAnimationFrame(settleFrame)
    const generation = selectionGeneration
    settleFrame = requestAnimationFrame(() => {
      settleFrame = 0
      if (
        primaryPointerHeld ||
        keysHeld.size ||
        generation !== selectionGeneration
      )
        return
      settled = true
      schedule()
    })
  }
  const releasePointer = () => {
    if (!primaryPointerHeld) return
    primaryPointerHeld = false
    settled = true
    schedule()
  }
  const onFocusIn = () => {
    if (!focusDeferred || doc.activeElement?.closest('.vmde-find-replace'))
      return
    focusDeferred = false
    armSettle()
    schedule()
  }
  const captureActionTarget = (): SourceRange | null =>
    index && indexed()
      ? detailsActionTarget(view, index, liveEditorRange())
      : legacyTarget()
  const onPointerDown = () => {
    pending = captureActionTarget()
  }
  let toggling = false
  const toggle = async () => {
    const target = pending ?? captureActionTarget()
    pending = null
    // A second press while the first awaits authority would plan on the same source twice.
    if (toggling || !configuredDeps || !target) return schedule()
    toggling = true
    try {
      const edits = inputGeneration
      const result = await runDetailsToggle(
        window,
        configuredDeps,
        target,
        () => inputGeneration === edits,
      )
      if (result) {
        retained = {
          markdown: result.markdown,
          startOffset: result.startOffset,
          endOffset: result.endOffset,
        }
        // setValue and postExact advance the source revision; resolve the new state immediately.
        settleAfterToggle = true
        exactMarkdown = result.markdown
      }
    } finally {
      toggling = false
    }
    schedule()
  }
  const onToggle = () => {
    void toggle()
  }
  const onDocumentPointerDown = (event: PointerEvent) => {
    const target = event.target instanceof Element ? event.target : null
    if (target?.closest('.vditor-reset')) retained = null
    const root = window.vditor ? activeModeElement(window.vditor) : null
    if (
      event.button === 0 &&
      event.isPrimary !== false &&
      target &&
      root?.contains(target)
    ) {
      primaryPointerHeld = true
      settled = false
    }
  }
  const onMouseMove = (event: MouseEvent) => {
    // A release outside the webview can skip pointerup; the button state proves it ended.
    if (primaryPointerHeld && (event.buttons & 1) === 0) releasePointer()
  }
  const onSelectionChange = () => {
    selectionGeneration++
    settled = false
    armSettle()
    schedule()
  }
  const onKeyDown = (event: KeyboardEvent) => {
    // Synthetic keydowns (the IR table panel's hotkeys) carry no physical code and never get a
    // keyup, so only physical keys can hold the selection unsettled.
    if (event.code) keysHeld.add(event.code)
    releasePointer()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    keysHeld.delete(event.code)
    // macOS drops keyups for keys pressed while Cmd is held; a keyup with no modifier down
    // proves no chord is still in progress.
    if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey)
      keysHeld.clear()
    if (!keysHeld.size) armSettle()
  }
  const onBlur = () => {
    keysHeld.clear()
    releasePointer()
  }
  const onInput = (event: Event) => {
    inputGeneration++
    if (event.isTrusted) {
      retained = null
      exactMarkdown = undefined
    }
    schedule()
  }
  const stopChoiceObserver = observeBlockTransformChoice((active) => {
    choicePending = active
    if (!active && fallbackDeferred) {
      fallbackDeferred = false
      // Scheduling keeps the capture after the synchronous apply/rollback and rechecks the
      // current selection, source index and Find focus through the ordinary update path.
      schedule()
    }
  })
  button?.addEventListener('pointerdown', onPointerDown, true)
  doc.addEventListener('pointerdown', onDocumentPointerDown, true)
  doc.addEventListener('pointerup', releasePointer, true)
  doc.addEventListener('pointercancel', releasePointer, true)
  doc.addEventListener('mousemove', onMouseMove, true)
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('keyup', onKeyUp, true)
  window.addEventListener('blur', onBlur)
  doc.addEventListener('vmde-toggle-details', onToggle)
  doc.addEventListener('selectionchange', onSelectionChange)
  doc.addEventListener('focusin', onFocusIn)
  doc.addEventListener('input', onInput, true)
  const previewButton = innerVditor()?.toolbar?.elements?.preview?.children[0]
  const previewObserver = new MutationObserver(schedule)
  if (previewButton)
    previewObserver.observe(previewButton, {
      attributes: true,
      attributeFilter: ['class'],
    })
  schedule()
  return () => {
    stopChoiceObserver()
    if (frame) cancelAnimationFrame(frame)
    if (settleFrame) cancelAnimationFrame(settleFrame)
    cancelSettledRead?.()
    previewObserver.disconnect()
    button?.removeEventListener('pointerdown', onPointerDown, true)
    doc.removeEventListener('pointerdown', onDocumentPointerDown, true)
    doc.removeEventListener('pointerup', releasePointer, true)
    doc.removeEventListener('pointercancel', releasePointer, true)
    doc.removeEventListener('mousemove', onMouseMove, true)
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('keyup', onKeyUp, true)
    window.removeEventListener('blur', onBlur)
    doc.removeEventListener('vmde-toggle-details', onToggle)
    doc.removeEventListener('selectionchange', onSelectionChange)
    doc.removeEventListener('focusin', onFocusIn)
    doc.removeEventListener('input', onInput, true)
  }
}
