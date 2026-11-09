// Undo/redo history coupling.
//
// Task 580 CP2-3 moved keyboard Undo/Redo out of the webview. Ctrl/Cmd+Z, Ctrl+Y and
// Ctrl/Cmd+Shift+Z are now VS Code keybindings of `vmde.format.undo`/`redo` under G1
// (package.json, checked against src/shared/editor-shortcuts.ts). The flow per press:
//   1. the keydown passes VMDE's own listeners untouched;
//   2. VS Code's webview preload calls `preventDefault` (blocking native contenteditable undo)
//      and forwards the key, from whichever webview element has focus;
//   3. the VMDE binding (extension weight) beats core `undo`/`redo`, so only one command runs;
//   4. the host posts `trigger-toolbar-hotkey` and message-router.ts calls the engine once.
// This keeps Task 463's measured requirements: one engine call per press, VS Code's native
// undo never also fires, Ctrl/Cmd+Shift+Z redoes, and the key works with focus outside the
// editable root in all three modes. macOS Cmd+Y no longer redoes (VS Code has no such default).
//
// The file keeps its name because Task 601 hooks `installVditorHistoryCoupling` here: the wrapper
// prepares a pending edit (undo-boundaries.ts) before every engine call.

import { clearTableCellSelections } from './table-cell-selection'

type HistoryKind = 'undo' | 'redo'

type HistoryPost = (message: {
  command: 'history-transition'
  kind: HistoryKind
  before: string
  after: string
  beforeBaseId?: string
  afterBaseId?: string
}) => void

/** Task 602 hooks; boot/finish-init.ts injects them from edit-sync. */
export interface HistoryCouplingOptions {
  /** The document text in the form `edit` posts use. Defaults to `getValue()`. */
  readText?: () => string
  /** Called after Vditor records a history entry. Returns false when the checkpoint flush did not
   * publish the pending edit (automatic-wrap deferral): that entry gets no history base. */
  onEntryRecorded?: () => unknown
  /** Called when a mode's empty history gets its first entry, with the ID tied to that entry. The
   * host pairs the ID with its own text; no document text is read or sent (Task 700). */
  onHistoryBase?: (mode: string, baseId: string) => void
  /** Task 700: the canonical Markdown of a saved history snapshot (edit-sync's
   * `historySnapshotText`), in the form `readText` returns. Called lazily, at most once per base,
   * only from an Undo/Redo that cannot reach the base entry directly. */
  snapshotText?: (mode: string, html: string) => string | undefined
}

/** A registered history base: the first entry array of a mode's stack and what is known of it. */
interface HistoryBaseTag {
  id: string
  entry: unknown
  /** The mode's history slot the entry belongs to; a reset or another slot proves nothing. */
  slot: unknown
  /** `slot.lastText` when the entry was pushed (the base snapshot HTML); released once resolved. */
  snapshot: string | undefined
  /** The base's canonical Markdown; `undefined` = unknown (an empty string is a valid value). */
  markdown: string | undefined
  /** `markdown` came from a live read after an engine move reached the entry, not a snapshot. */
  live: boolean
  /** The lazy snapshot serialization already ran (once per base, even when it failed). */
  serialized: boolean
  /** A live read contradicted the snapshot-derived Markdown: the tag proves nothing more. */
  contradicted: boolean
}

type BaseIds = { beforeBaseId?: string; afterBaseId?: string }

// Unique across editor reinitializations: each install draws its own prefix.
let baseIdSeed = 0

const HISTORY_COUPLED = Symbol('vmde-history-coupled')

/** Wrap the one shared Vditor history engine so keyboard, toolbar, and command actions all couple.
 * `prepare` settles a pending edit before the transition and returns false to refuse it (Task 601:
 * undo-boundaries.ts's `preparePendingHistory`, injected by boot/finish-init.ts). */
export function installVditorHistoryCoupling(
  win: any,
  post: HistoryPost = (message) => win.vscode?.postMessage(message),
  prepare: (inner: unknown) => boolean = () => true,
  options: HistoryCouplingOptions = {},
): void {
  const outer = win?.vditor
  const undo = outer?.vditor?.undo
  if (!outer || !undo || undo[HISTORY_COUPLED]) return
  undo[HISTORY_COUPLED] = true
  // Task 602: the host compares transitions with the edits it received. SV edits omit Vditor's
  // trailing editable newline, so SV transitions must use the same form or never match exactly.
  const readText = options.readText ?? (() => outer.getValue())
  const stackOf = (inner: any): unknown[] | undefined =>
    undo[inner?.currentMode ?? outer.vditor?.currentMode]?.undoStack
  // Task 602: Vditor records history entries through `addToUndoStack` (its after-render timer,
  // setValue, VMDE's checkpoints) and the Task 598 seed. Wrapping both reports (1) every recorded
  // entry, so edit-sync can publish a pending edit at the entry boundary (checkpoint flush F: a
  // webview entry whose state never reached the host cannot be reached by native Undo), and
  // (2) the first entry of an empty stack (after open, a host update's setValue, or a first visit
  // to a mode): the history base.
  //
  // Task 700: the base is an opaque ID tied to that entry array, reported synchronously after the
  // flush; the host pairs it with its own text. The old whole-document read (88-255 ms on large
  // documents) and its idle deferral are gone.
  baseIdSeed += 1
  const prefix = `${baseIdSeed.toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let counter = 0
  const bases = new Map<string, HistoryBaseTag>()
  const modeOf = (inner: any) => inner?.currentMode ?? outer.vditor?.currentMode
  const reportEntry = (inner: any, wasEmpty: boolean, previousTop: unknown) => {
    const stack = stackOf(inner)
    if (!stack?.length || stack.at(-1) === previousTop) return
    const mode = modeOf(inner)
    // Task 700: the snapshot is Vditor's own string reference (no clone, diff or serialization),
    // read before the flush callback can change anything.
    const slot = undo[mode]
    const snapshot = wasEmpty ? slot?.lastText : undefined
    const published = options.onEntryRecorded?.()
    if (!wasEmpty) return
    if (published === false) {
      // G1: this reset's first entry has no base, and the mode's previous tag must not prove it.
      bases.delete(mode)
      return
    }
    // A reset (clearStack, a host update's setValue) empties the stack, so its new first entry
    // replaces the old tag with a fresh ID; the old ID is never moved onto the new entry.
    counter += 1
    const tag: HistoryBaseTag = {
      id: `${prefix}-${counter}`,
      entry: stack[0],
      slot,
      snapshot: typeof snapshot === 'string' ? snapshot : undefined,
      markdown: undefined,
      live: false,
      serialized: false,
      contradicted: false,
    }
    bases.set(mode, tag)
    options.onHistoryBase?.(mode, tag.id)
  }
  // The tag proves something only while its entry is still the first entry of the same slot.
  const isBaseLive = (tag: HistoryBaseTag | undefined, mode: string) =>
    tag !== undefined &&
    undo[mode] === tag.slot &&
    (undo[mode]?.undoStack as unknown[] | undefined)?.[0] === tag.entry
  const liveBase = (mode: string) => {
    const tag = bases.get(mode)
    return tag && isBaseLive(tag, mode) ? { tag, mode } : undefined
  }
  // The base's Markdown: from a live read once the engine reached the entry, else from the saved
  // snapshot through the injected serializer, once per base (a mismatch is cached too).
  const markdownOf = (tag: HistoryBaseTag, mode: string) => {
    if (tag.contradicted) return undefined
    if (tag.markdown === undefined && !tag.serialized) {
      tag.serialized = true
      const snapshot = tag.snapshot
      tag.snapshot = undefined
      try {
        if (snapshot !== undefined)
          tag.markdown = options.snapshotText?.(mode, snapshot)
      } catch {
        tag.markdown = undefined
      }
    }
    return tag.markdown
  }
  // A move that leaves the tagged entry on top of its slot has just rendered the base: that live
  // read establishes the cache, confirms a snapshot-derived one, or contradicts it (F1).
  const reconcileDirectReturn = (
    tag: HistoryBaseTag,
    mode: string,
    after: string,
  ) => {
    const stack = undo[mode].undoStack as unknown[]
    if (stack.at(-1) !== tag.entry || tag.live || tag.contradicted) return
    if (tag.markdown === undefined) {
      tag.markdown = after
      tag.snapshot = undefined
    } else if (tag.markdown !== after) {
      // A snapshot-derived cache (S) that differs from the live render (a coalesced rewrite folded
      // a change into the entry, or the serializers disagree): neither is trusted, and S is not
      // overwritten.
      tag.contradicted = true
      return
    }
    tag.live = true
  }
  // Task 700: a base endpoint is named by value under identity guards. A move that leaves the
  // tagged entry on top of its slot has just rendered the base, so that live read establishes or
  // checks the Markdown (`reconcileDirectReturn`). Otherwise the entry must still be the slot's
  // first, and the endpoint text must equal the cached Markdown. Never `undoStack.length`: a
  // trimmed stack would claim a base that was shifted out.
  const baseEndpoints = (
    start: { tag: HistoryBaseTag; mode: string } | undefined,
    end: { tag: HistoryBaseTag; mode: string } | undefined,
    before: string,
    after: string,
  ): BaseIds => {
    const ids: BaseIds = {}
    // The end resolves first: a direct return to the entry establishes the Markdown from the live
    // read and spares the start its snapshot serialization.
    if (end) {
      reconcileDirectReturn(end.tag, end.mode, after)
      if (markdownOf(end.tag, end.mode) === after) ids.afterBaseId = end.tag.id
    }
    if (start && markdownOf(start.tag, start.mode) === before)
      ids.beforeBaseId = start.tag.id
    return ids
  }
  for (const method of ['addToUndoStack', 'vmdeSeedBaseline'] as const) {
    const original = undo[method]
    if (typeof original !== 'function') continue
    undo[method] = function (this: unknown, ...args: any[]) {
      const stack = stackOf(args[0])
      const wasEmpty = !stack?.length
      const previousTop = stack?.at(-1)
      const result = original.apply(this, args)
      reportEntry(args[0], wasEmpty, previousTop)
      return result
    }
  }
  for (const kind of ['undo', 'redo'] as const) {
    const original = undo[kind].bind(undo)
    undo[kind] = (inner: unknown) => {
      // A fake table-cell rectangle names cells of the pre-transition DOM; drop it on every
      // undo/redo path (command, toolbar button) rather than on the Z/Y keys.
      clearTableCellSelections()
      // Task 601: the pending edit gets its own entry and reaches the host before `before` is read,
      // so the engine undoes only that edit and the host sees the same transition.
      // A refused transition (IME composition) makes no engine call and posts nothing.
      if (!prepare(inner)) return undefined
      const before = readText()
      const start = liveBase(modeOf(inner))
      const result = original(inner)
      const after = readText()
      if (before !== after)
        post({
          command: 'history-transition',
          kind,
          before,
          after,
          ...baseEndpoints(start, liveBase(modeOf(inner)), before, after),
        })
      return result
    }
  }
}
