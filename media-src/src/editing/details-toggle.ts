import { captureCalloutActionTarget } from './callouts'
import { transformDetailsSelection } from './details'
import { resolveDetailsBlockRange, type SourceRange } from './details-source'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { findScroller } from '../chrome/toolbar-scroll-guard'
import {
  captureRewrapSourceRange,
  replaceSvMarkdownRange,
} from './rewrap-command'
import { readDetailsSelectionState } from './details-selection-state'
import type {
  SourceBlockIndex,
  SourceBlockIndexHandle,
} from '../nav/source-block-index'
import { isCompositionActive } from '../util/caret-gesture'

export interface DetailsToggleDeps {
  setApplying(applying: boolean): void
  postExact(markdown: string): void
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

function runDetailsToggle(
  win: Window,
  deps: DetailsToggleDeps,
  captured: SourceRange | null,
): boolean {
  try {
    const outer = win.vditor
    const inner = innerVditor()
    const editor = outer ? activeModeElement(outer) : null
    if (!captured || !outer || !inner || !editor) return false
    const result = transformDetailsSelection({ ...captured, resolved: true })
    if (result.status === 'disabled') return false
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
    deps.setApplying(true)
    try {
      inner.undo?.addToUndoStack?.(inner)
      if (inner.currentMode === 'sv') {
        if (
          !replaceSvMarkdownRange(
            editor,
            editor.textContent ?? captured.markdown,
            {
              markdown: withMarkers,
              caretOffset: result.endOffset + startMarker.length,
            },
          )
        )
          return false
      } else {
        outer.setValue(withMarkers)
      }
      const fresh = activeModeElement(outer)
      const start = fresh ? removeMarker(fresh, startMarker) : null
      const end = fresh ? removeMarker(fresh, endMarker) : null
      if (!fresh || !start || !end) {
        outer.setValue(captured.markdown)
        return false
      }
      inner.undo?.addToUndoStack?.(inner)
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
    deps.postExact(result.markdown)
    return true
  } catch (error) {
    deps.onError(error)
    return false
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
  ): DetailsStatus => {
    if (fallback?.generation !== selectionGeneration)
      fallback = {
        generation: selectionGeneration,
        status: statusOf(captureTarget(exactMarkdown) ?? retainedFor(entry)),
      }
    return fallback.status
  }
  const expandedState = (
    entry: SourceBlockIndex,
    range: Range,
    settledNow: boolean,
  ): DetailsStatus | 'unknown' => {
    const state = readDetailsSelectionState(entry, range)
    const kept = state === 'disabled' ? retainedFor(entry) : null
    // The exact path fell back to the retained result when a capture resolved to nothing.
    if (kept) return statusOf(kept)
    return state === 'unknown' && settledNow ? exactFallbackState(entry) : state
  }
  const passiveState = (
    source: SourceBlockIndexHandle,
    range: Range | null,
  ): DetailsStatus | 'unknown' => {
    const expanded = range && !range.collapsed ? range : null
    if (!expanded && !retained) return 'disabled'
    const settledNow = settled || settleAfterToggle
    const entry = source.peek() ?? (settledNow ? source.read() : null)
    if (!entry) return 'unknown'
    return expanded
      ? expandedState(entry, expanded, settledNow)
      : statusOf(retainedFor(entry))
  }
  const indexedUpdate = (source: SourceBlockIndexHandle) => {
    // Never build or capture while a native drag is in progress; release schedules an update.
    if (primaryPointerHeld) return
    const state = passiveState(source, liveEditorRange())
    // Before the selection settles, keep the current state rather than capturing.
    if (state === 'unknown') return
    settleAfterToggle = false
    applyState(state)
  }
  const update = () => {
    frame = 0
    if (!button) return
    if (previewOpen() || isCompositionActive()) {
      applyState('disabled')
      return
    }
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
  const captureActionTarget = (): SourceRange | null => {
    if (!index || !indexed()) return legacyTarget()
    const live = liveEditorRange()
    const entry = index.peek()
    if (live && !live.collapsed) {
      const target = entry
        ? captureRangeTarget(live, entry.rendered, exactMarkdown)
        : captureTarget(exactMarkdown)
      if (target) return target
    }
    return retained ? retainedFor(entry ?? index.read()) : null
  }
  const onPointerDown = () => {
    pending = captureActionTarget()
  }
  const onToggle = () => {
    const target = pending ?? captureActionTarget()
    const result = target
      ? transformDetailsSelection({ ...target, resolved: true })
      : null
    if (
      configuredDeps &&
      target &&
      result &&
      result.status !== 'disabled' &&
      runDetailsToggle(window, configuredDeps, target)
    ) {
      retained = {
        markdown: result.markdown,
        startOffset: result.startOffset,
        endOffset: result.endOffset,
      }
      // setValue and postExact advance the source revision; resolve the new state immediately.
      settleAfterToggle = true
      exactMarkdown = result.markdown
    }
    pending = null
    schedule()
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
    keysHeld.add(event.code || event.key)
    releasePointer()
  }
  const onKeyUp = (event: KeyboardEvent) => {
    keysHeld.delete(event.code || event.key)
    if (!keysHeld.size) armSettle()
  }
  const onBlur = () => {
    keysHeld.clear()
    releasePointer()
  }
  const onInput = (event: Event) => {
    if (event.isTrusted) {
      retained = null
      exactMarkdown = undefined
    }
    schedule()
  }
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
    if (frame) cancelAnimationFrame(frame)
    if (settleFrame) cancelAnimationFrame(settleFrame)
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
    doc.removeEventListener('input', onInput, true)
  }
}
