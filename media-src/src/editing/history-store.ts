// Task 003 — the history store: the one interface every VMDE module uses for Undo and Redo state.
//
// This file holds the old-engine adapter, an adapter over Vditor's `Undo` class with its build
// patches (`vmdeSeedBaseline`, `vmdeHeldTimer`, the patched `addCaret`). Modules ask the store for
// entry bookmarks, savepoints, an in-place caret amend and a revision counter instead of reading
// `undoStack`, `redoStack`, `lastText` or `hasUndo`, and they observe recorded entries and
// transitions through the store instead of wrapping engine methods. A behaviour-preserving seam:
// task 004 puts the unit engine behind the same interface.
import { stripWrapHints } from '../util/wrap-hint-mark'

export type HistoryMode = 'ir' | 'wysiwyg' | 'sv'
declare const entryBrand: unique symbol
declare const slotBrand: unique symbol
declare const savepointBrand: unique symbol
/** Owned by the store, never the storage; keeps its identity across amendTopCaret; WeakMap-safe. */
export interface HistoryEntryToken {
  readonly [entryBrand]: true
}
/** Identity of one mode's history; a reset gives a new slot. */
export interface HistorySlotToken {
  readonly [slotBrand]: true
}
export interface HistorySavepoint {
  readonly mode: HistoryMode
  readonly [savepointBrand]: true
}
export interface RecordedEntry {
  readonly mode: HistoryMode
  readonly wasEmpty: boolean
  readonly entry: HistoryEntryToken
  readonly slot: HistorySlotToken
}
type CheckpointResult = 'pushed' | 'coalesced' | 'unchanged'
type AmendResult = 'coalesced' | 'unchanged' | 'refused'

export interface HistoryStore {
  // A. recording
  checkpoint(): void
  checkpointOrCoalesce(options?: {
    sourceUnchanged?: boolean
  }): CheckpointResult
  seedBaseline(event?: Event): boolean
  holdPendingTimer(timer: number | undefined): void
  reset(): void
  undo(): void
  redo(): void
  // B. bookmarks
  top(mode?: HistoryMode): HistoryEntryToken | undefined
  redoTop(mode?: HistoryMode): HistoryEntryToken | undefined
  base(mode?: HistoryMode): HistoryEntryToken | undefined
  slot(mode?: HistoryMode): HistorySlotToken | undefined
  baseSnapshot(entry: HistoryEntryToken): string | undefined
  // C. savepoints
  savepoint(): HistorySavepoint | undefined
  restore(savepoint: HistorySavepoint): boolean
  // D. amend
  amendTopCaret(options?: { sourceUnchanged?: boolean }): AmendResult
  isSourceNeutral(): boolean
  // E. queries
  isEmpty(mode?: HistoryMode): boolean
  revision(mode?: HistoryMode): number
  // F. observation and control
  onEntryRecorded(listener: (entry: RecordedEntry) => void): () => void
  aroundTransition(
    hook: (kind: 'undo' | 'redo', run: () => void) => void,
  ): () => void
  suppressRecording(): () => void
  addSnapshotScope(scope: SnapshotScope): () => void
}
type SnapshotScope = Parameters<
  typeof import('./undo-snapshot-neutral').bindUndoSnapshotNeutral
>[1]

/** 003 keeps the old engine for IR; 004 sets 'unit' after its property test passes. */
export const IR_HISTORY_ENGINE: 'unit' | 'vditor' = 'vditor'

const MODES: readonly HistoryMode[] = ['ir', 'wysiwyg', 'sv']

type TransitionHook = (kind: 'undo' | 'redo', run: () => void) => void
type TransitionKind = 'undo' | 'redo'

// Vditor's `Undo` object and its per-mode slots are reached by name; the shapes below list only
// what the adapter reads or writes.
interface EngineSlot {
  undoStack?: unknown[]
  redoStack?: unknown[]
  lastText?: unknown
  hasUndo?: unknown
}
// Loose on purpose: the engine is a Vditor class with build patches, and a partial host (a test
// double) may lack any member, so every call site below checks what it uses.
type Engine = Record<string, any>

/** What a savepoint holds: what `snapshotTableUndoForRollback` held before the store (Task 611:
 * Turn Into rewrites the top entry's patch list in place, so its contents are saved with the
 * stack; the entry keeps its identity and the patches are immutable). */
class SavepointImpl {
  declare readonly [savepointBrand]: true
  constructor(
    readonly mode: HistoryMode,
    readonly slot: EngineSlot,
    readonly undoStack: unknown[] | undefined,
    readonly redoStack: unknown[] | undefined,
    readonly top: unknown[] | undefined,
    readonly topContents: unknown[] | undefined,
    readonly lastText: unknown,
    readonly hasUndo: unknown,
  ) {}
}

const TEXT_NODE = 3

// Task 610 — the proof that the `addCaret` wrap uses (see `addSnapshotScope`).
function isDetachedMarker(node: Node): boolean {
  return (
    node instanceof HTMLElement &&
    node.localName === 'span' &&
    node.classList.contains('vditor-wbr') &&
    !node.firstChild &&
    !node.isConnected
  )
}

interface RecordFacts {
  addedText: Set<Node>
  truncated: Set<Node>
}

// Fold one record into `facts`; false when the record is not marker/split shaped.
function readRecord(record: MutationRecord, facts: RecordFacts): boolean {
  if (record.type === 'attributes') return false
  if (record.type === 'characterData') {
    if (record.target.nodeType !== TEXT_NODE) return false
    facts.truncated.add(record.target)
    return true
  }
  if (!Array.from(record.removedNodes).every(isDetachedMarker)) return false
  for (const node of Array.from(record.addedNodes)) {
    if (node.nodeType === TEXT_NODE) facts.addedText.add(node)
    else if (!isDetachedMarker(node)) return false
  }
  return true
}

/** The proof that a scope's records are only Undo's marker insert/remove and its Text split.
 * Anything else (another element, a removed Text node, a text edit that is not half of a split, a
 * Comment edit, any attribute write, a marker left connected) is not proven and invalidates. A
 * split is an added Text node whose previous sibling is the Text node whose data was truncated
 * (its `characterData` record), so both halves must be present and adjacent. */
export function isUndoSnapshotMarkerMutation(
  records: MutationRecord[],
): boolean {
  const facts: RecordFacts = { addedText: new Set(), truncated: new Set() }
  if (!records.every((record) => readRecord(record, facts))) return false
  const { addedText, truncated } = facts
  return (
    Array.from(addedText).every(
      (node) =>
        node.isConnected &&
        node.previousSibling?.nodeType === TEXT_NODE &&
        truncated.has(node.previousSibling),
    ) &&
    Array.from(truncated).every(
      (node) => node.nextSibling && addedText.has(node.nextSibling),
    )
  )
}

// The store keeps the engine it wraps, so a replaced `inner.undo` (a test double) gets a new store.
const stores = new WeakMap<object, { undo: object; store: HistoryStore }>()

/** The store of one inner Vditor editor; `undefined` without an `undo` object (a partial host). */
export function historyStoreOf(inner: unknown): HistoryStore | undefined {
  if (!inner || typeof inner !== 'object') return undefined
  const undo = (inner as { undo?: unknown }).undo
  if (!undo || typeof undo !== 'object') return undefined
  const known = stores.get(inner)
  if (known?.undo === undo) return known.store
  const created = new VditorHistoryStore(inner as Record<string, any>)
  stores.set(inner, { undo, store: created })
  return created
}

// Task 601/611 — the caret marker and IR's caret-dependent expansion class are not source, and
// neither are a table's width classes (Task 639) or a wrap hint (Task 640). These are the
// comparisons of `undo-boundaries.ts`, kept here so the store has no import cycle with it.
const TABLE_WIDTH_CLASS = /^vmde-table-(?:auto-\d+|width-\d+|resized)$/

function withoutTableWidthClasses(html: string): string {
  return html.replace(
    / class="([^"]*)"/g,
    (attribute: string, value: string) => {
      const names = value.split(/\s+/).filter(Boolean)
      const kept = names.filter((name) => !TABLE_WIDTH_CLASS.test(name))
      if (kept.length === names.length) return attribute
      return kept.length > 0 ? ` class="${kept.join(' ')}"` : ''
    },
  )
}

function withoutCaret(html: string): string {
  return withoutTableWidthClasses(
    stripWrapHints(html)
      .replace(/<wbr>|<span class="vditor-wbr"><\/span>/g, '')
      .replace(/ vditor-ir__node--expand/g, ''),
  )
}

interface Fingerprint {
  readonly slot: unknown
  readonly undoLength: number
  readonly redoLength: number
  readonly top: unknown
}
const EMPTY_FINGERPRINT: Fingerprint = {
  slot: undefined,
  undoLength: 0,
  redoLength: 0,
  top: undefined,
}

class VditorHistoryStore implements HistoryStore {
  private readonly undoObject: Engine
  private readonly entryTokens = new WeakMap<object, HistoryEntryToken>()
  private readonly slotTokens = new WeakMap<object, HistorySlotToken>()
  // Task 700: the snapshot text a mode's first entry was recorded with, by entry token.
  private readonly baseSnapshots = new WeakMap<object, string>()
  private readonly revisions: Record<HistoryMode, number> = {
    ir: 0,
    wysiwyg: 0,
    sv: 0,
  }
  private listeners: ReadonlyArray<(entry: RecordedEntry) => void> = []
  private hooks: readonly TransitionHook[] = []
  private suppressed = 0
  private wrapped = false
  // Last stack shape `revision` saw, per mode: it counts a change made by a path the wrappers do not
  // see (a direct stack edit, or before the wrappers are installed).
  private readonly seen: Record<HistoryMode, Fingerprint> = {
    ir: EMPTY_FINGERPRINT,
    wysiwyg: EMPTY_FINGERPRINT,
    sv: EMPTY_FINGERPRINT,
  }
  private scopes: Set<SnapshotScope> | undefined

  constructor(private readonly inner: Record<string, any>) {
    this.undoObject = inner.undo
    for (const mode of MODES) this.seen[mode] = this.fingerprint(mode)
  }

  // Installed on first use of the observation features (a listener, a hook, a suppression), so a
  // module that only reads bookmarks leaves the engine methods untouched.
  private ensureWrapped(): void {
    if (this.wrapped) return
    this.wrapped = true
    this.wrapRecording()
    this.wrapTransition('undo')
    this.wrapTransition('redo')
    this.wrapReset()
  }

  // The wrappers below are installed once per store and replace the per-module method wrapping of
  // `undo-keybind.ts`, `rewrap-command.ts` and `undo-snapshot-neutral.ts`: Vditor's own timers and
  // toolbar call these engine methods directly, so the store must see those calls too. With no
  // listener, hook or suppression they run the original and allocate nothing.
  private wrapRecording(): void {
    const undo = this.undoObject
    const store = this
    const add = undo.addToUndoStack
    if (typeof add === 'function')
      undo.addToUndoStack = function (this: unknown, inner: unknown) {
        // Suppressed: the swap `rewrap-command.ts` used to make (a blocked, no-op method).
        if (store.suppressed > 0) return undefined
        return store.callRecording(add, this, inner, false)
      }
    const seed = undo.vmdeSeedBaseline
    if (typeof seed === 'function')
      undo.vmdeSeedBaseline = function (
        this: unknown,
        inner: unknown,
        event?: Event,
      ) {
        return store.callRecording(seed, this, inner, true, event)
      }
  }

  private wrapTransition(kind: TransitionKind): void {
    const undo = this.undoObject
    const original = undo[kind]
    if (typeof original !== 'function') return
    const store = this
    undo[kind] = function (this: unknown, inner: unknown) {
      // Called on the captured engine, not on `this`: a detached call (`const u = undo.undo`)
      // worked before the store, as the former `bind(undo)` wrapper did.
      if (store.hooks.length === 0)
        return store.engineTransition(original, undo, inner)
      return store.hookedTransition(kind, () =>
        store.engineTransition(original, undo, inner),
      )
    }
  }

  private wrapReset(): void {
    const undo = this.undoObject
    const clear = undo.clearStack
    if (typeof clear !== 'function') return
    const store = this
    undo.clearStack = function (this: unknown, inner: unknown) {
      const result = clear.call(this, inner)
      for (const mode of MODES) store.revisions[mode] += 1
      return result
    }
  }

  private modeOf(inner: unknown): HistoryMode {
    return (
      (inner as { currentMode?: HistoryMode } | undefined)?.currentMode ??
      this.inner.currentMode
    )
  }

  private slotOf(mode: HistoryMode): EngineSlot | undefined {
    const slot = this.undoObject[mode]
    return slot && typeof slot === 'object' ? slot : undefined
  }

  // Vditor's entries are patch-list arrays. A partial host (a test double) may use a primitive: it
  // is identified by value, as the former `===` comparisons did.
  // Grows only for a test double whose entries are primitives; Vditor's entries are arrays.
  private readonly primitiveTokens = new Map<unknown, HistoryEntryToken>()

  private entryToken(entry: unknown): HistoryEntryToken | undefined {
    if (entry === undefined || entry === null) return undefined
    const isObject = typeof entry === 'object' || typeof entry === 'function'
    let token = isObject
      ? this.entryTokens.get(entry as object)
      : this.primitiveTokens.get(entry)
    if (!token) {
      token = Object.freeze({}) as unknown as HistoryEntryToken
      if (isObject) this.entryTokens.set(entry as object, token)
      else this.primitiveTokens.set(entry, token)
    }
    return token
  }

  // Run an engine call that may push an entry; report the new entry when the top changed.
  private callRecording(
    original: (inner: unknown, event?: Event) => unknown,
    self: unknown,
    inner: unknown,
    withEvent: boolean,
    event?: Event,
  ): unknown {
    const mode = this.modeOf(inner)
    const stack = this.slotOf(mode)?.undoStack
    const wasEmpty = !stack?.length
    const previousTop = stack?.at(-1)
    // The engine receives exactly the arguments it was called with.
    const result = withEvent
      ? original.call(self, inner, event)
      : original.call(self, inner)
    this.afterRecord(mode, wasEmpty, previousTop)
    return result
  }

  private afterRecord(
    mode: HistoryMode,
    wasEmpty: boolean,
    previousTop: unknown,
  ): void {
    const slot = this.slotOf(mode)
    const stack = slot?.undoStack
    if (!slot || !stack?.length || stack.at(-1) === previousTop) return
    this.revisions[mode] += 1
    if (wasEmpty) {
      // Task 700: Vditor's own string reference (no clone, diff or serialization), read before a
      // listener can change anything.
      const first = this.entryToken(stack[0])
      if (first && typeof slot.lastText === 'string')
        this.baseSnapshots.set(first, slot.lastText)
    }
    if (this.listeners.length === 0) return
    const entry = this.entryToken(stack.at(-1))
    const slotToken = this.slotToken(mode)
    if (!entry || !slotToken) return
    const recordedEntry: RecordedEntry = {
      mode,
      wasEmpty,
      entry,
      slot: slotToken,
    }
    for (const listener of this.listeners) listener(recordedEntry)
  }

  // One engine Undo or Redo; the revision grows when the stacks moved.
  private engineTransition(
    original: (inner: unknown) => unknown,
    self: unknown,
    inner: unknown,
  ): unknown {
    const mode = this.modeOf(inner)
    const slot = this.slotOf(mode)
    const undoLength = slot?.undoStack?.length
    const redoLength = slot?.redoStack?.length
    const top = slot?.undoStack?.at(-1)
    const result = original.call(self, inner)
    const after = this.slotOf(mode)
    if (
      after !== slot ||
      after?.undoStack?.length !== undoLength ||
      after?.redoStack?.length !== redoLength ||
      after?.undoStack?.at(-1) !== top
    )
      this.revisions[mode] += 1
    return result
  }

  // First-installed hook is outermost. A hook that does not call `run` refuses the transition.
  private hookedTransition(kind: TransitionKind, run: () => unknown): unknown {
    const hooks = this.hooks
    let result: unknown
    const step = (index: number): void => {
      if (index === hooks.length) {
        result = run()
        return
      }
      hooks[index](kind, () => step(index + 1))
    }
    step(0)
    return result
  }

  private slotToken(mode: HistoryMode): HistorySlotToken | undefined {
    const slot = this.slotOf(mode)
    if (!slot) return undefined
    let token = this.slotTokens.get(slot)
    if (!token) {
      token = Object.freeze({}) as unknown as HistorySlotToken
      this.slotTokens.set(slot, token)
    }
    return token
  }

  // A. recording

  checkpoint(): void {
    this.undoObject.addToUndoStack?.(this.inner)
  }

  checkpointOrCoalesce(
    options: { sourceUnchanged?: boolean } = {},
  ): CheckpointResult {
    const amended = this.amendTopCaret(options)
    if (amended !== 'refused') return amended
    this.checkpoint()
    return 'pushed'
  }

  seedBaseline(event?: Event): boolean {
    return this.undoObject.vmdeSeedBaseline?.(this.inner, event) ?? false
  }

  holdPendingTimer(timer: number | undefined): void {
    this.undoObject.vmdeHeldTimer = timer
  }

  reset(): void {
    this.undoObject.clearStack?.(this.inner)
    this.checkpoint()
  }

  undo(): void {
    this.undoObject.undo?.(this.inner)
  }

  redo(): void {
    this.undoObject.redo?.(this.inner)
  }

  // B. bookmarks

  top(mode: HistoryMode = this.inner.currentMode) {
    return this.entryToken(this.slotOf(mode)?.undoStack?.at(-1))
  }

  redoTop(mode: HistoryMode = this.inner.currentMode) {
    return this.entryToken(this.slotOf(mode)?.redoStack?.at(-1))
  }

  base(mode: HistoryMode = this.inner.currentMode) {
    return this.entryToken(this.slotOf(mode)?.undoStack?.[0])
  }

  slot(mode: HistoryMode = this.inner.currentMode) {
    return this.slotToken(mode)
  }

  baseSnapshot(entry: HistoryEntryToken): string | undefined {
    return this.baseSnapshots.get(entry)
  }

  // C. savepoints

  savepoint(): HistorySavepoint | undefined {
    const mode: HistoryMode | undefined = this.inner.currentMode
    const slot = mode ? this.slotOf(mode) : undefined
    if (!mode || !slot) return undefined
    const top = Array.isArray(slot.undoStack)
      ? slot.undoStack.at(-1)
      : undefined
    return new SavepointImpl(
      mode,
      slot,
      Array.isArray(slot.undoStack) ? [...slot.undoStack] : undefined,
      Array.isArray(slot.redoStack) ? [...slot.redoStack] : undefined,
      Array.isArray(top) ? top : undefined,
      Array.isArray(top) ? [...top] : undefined,
      slot.lastText,
      slot.hasUndo,
    ) as unknown as HistorySavepoint
  }

  restore(savepoint: HistorySavepoint): boolean {
    if (!(savepoint instanceof SavepointImpl)) return false
    // The slot is re-read now: a reset or a mode switch since the savepoint gives a new slot.
    if (
      this.inner.currentMode !== savepoint.mode ||
      this.slotOf(savepoint.mode) !== savepoint.slot
    )
      return false
    savepoint.top?.splice(
      0,
      savepoint.top.length,
      ...(savepoint.topContents ?? []),
    )
    const slot = savepoint.slot
    slot.undoStack = savepoint.undoStack
    slot.redoStack = savepoint.redoStack
    slot.lastText = savepoint.lastText
    slot.hasUndo = savepoint.hasUndo
    this.revisions[savepoint.mode] += 1
    this.undoObject.resetIcon?.(this.inner)
    return true
  }

  // D. amend

  /** Task 611 — rewrite the top entry in place when the live state differs from it only in the
   * caret, so the entry keeps its identity (and its token). The body of the former
   * `coalesceCaretOnlyDifference`; `null` there is `'refused'` here. The Redo stack, `hasUndo`
   * and the host are not touched. */
  amendTopCaret(options: { sourceUnchanged?: boolean } = {}): AmendResult {
    const undo = this.undoObject
    const mode: HistoryMode = this.inner.currentMode
    const state = this.slotOf(mode)
    const top = state?.undoStack?.at(-1)
    if (
      !undo.addCaret ||
      !undo.dmp ||
      !state ||
      !Array.isArray(top) ||
      typeof state.lastText !== 'string'
    )
      return 'refused'
    const lastText = state.lastText
    // The engine's own snapshot, not `innerHTML`: it normalizes math, echarts and plantuml previews.
    const live: string = undo.addCaret(this.inner, true)
    if (live === lastText) return 'unchanged'
    if (!live.includes('<wbr>')) return 'refused'
    if (
      !options.sourceUnchanged &&
      withoutCaret(live) !== withoutCaret(lastText)
    )
      return 'refused'
    const dmp = undo.dmp
    const [previous, applied] = dmp.patch_apply(top, lastText)
    if (!applied.every(Boolean)) return 'refused'
    const rewritten = dmp.patch_make(
      live,
      previous,
      dmp.diff_main(live, previous, true),
    )
    if (rewritten.length === 0) return 'refused'
    const [replayed, replayApplied] = dmp.patch_apply(rewritten, live)
    if (replayed !== previous || !replayApplied.every(Boolean)) return 'refused'
    top.splice(0, top.length, ...rewritten)
    state.lastText = live
    this.revisions[mode] += 1
    return 'coalesced'
  }

  isSourceNeutral(): boolean {
    const mode: HistoryMode = this.inner.currentMode
    const root = this.inner[mode]?.element
    const lastText = this.slotOf(mode)?.lastText
    if (!root || typeof lastText !== 'string') return false
    return withoutCaret(root.innerHTML) === withoutCaret(lastText)
  }

  // E. queries

  isEmpty(mode: HistoryMode = this.inner.currentMode): boolean {
    return (this.slotOf(mode)?.undoStack?.length ?? 0) === 0
  }

  revision(mode: HistoryMode = this.inner.currentMode): number {
    const now = this.fingerprint(mode)
    const before = this.seen[mode]
    if (
      now.slot !== before.slot ||
      now.undoLength !== before.undoLength ||
      now.redoLength !== before.redoLength ||
      now.top !== before.top
    ) {
      this.revisions[mode] += 1
      this.seen[mode] = now
    }
    return this.revisions[mode]
  }

  private fingerprint(mode: HistoryMode): Fingerprint {
    const slot = this.slotOf(mode)
    return {
      slot,
      undoLength: slot?.undoStack?.length ?? 0,
      redoLength: slot?.redoStack?.length ?? 0,
      top: slot?.undoStack?.at(-1),
    }
  }

  // F. observation and control

  onEntryRecorded(listener: (entry: RecordedEntry) => void): () => void {
    this.ensureWrapped()
    this.listeners = [...this.listeners, listener]
    return () => {
      this.listeners = this.listeners.filter((known) => known !== listener)
    }
  }

  aroundTransition(hook: TransitionHook): () => void {
    this.ensureWrapped()
    this.hooks = [...this.hooks, hook]
    return () => {
      this.hooks = this.hooks.filter((known) => known !== hook)
    }
  }

  suppressRecording(): () => void {
    this.ensureWrapped()
    this.suppressed += 1
    let released = false
    return () => {
      if (released) return
      released = true
      this.suppressed -= 1
    }
  }

  /** Task 640 — mark `addCaret` as a source-neutral scope of `scope`, and keep wrap hints out of
   * its snapshot text. The former wrapper of `undo-snapshot-neutral.ts`: installed once, further
   * calls only register another scope. A missing `addCaret` (Vditor drift) throws instead of
   * silently restoring the rebuilds. */
  addSnapshotScope(scope: SnapshotScope): () => void {
    let scopes = this.scopes
    if (!scopes) {
      scopes = this.installSnapshotWrap()
      this.scopes = scopes
    }
    scopes.add(scope)
    return () => {
      scopes.delete(scope)
    }
  }

  private installSnapshotWrap(): Set<SnapshotScope> {
    const undo = this.undoObject
    const original = undo.addCaret
    if (typeof original !== 'function')
      throw new Error(
        'HistoryStore.addSnapshotScope: the Vditor Undo instance has no addCaret (version drift?)',
      )
    const registered = new Set<SnapshotScope>()
    undo.addCaret = function (this: unknown, ...args: unknown[]) {
      // One nested scope per registered index; the outermost owns the records of all of them.
      const run = () => original.apply(this, args)
      const text = Array.from(registered).reduceRight<() => unknown>(
        (next, scope) => () =>
          scope.sourceNeutral(next, isUndoSnapshotMarkerMutation),
        run,
      )()
      // Task 640: a wrap hint is view state, so a snapshot never carries one. A hint written
      // between two snapshots is then no difference, and an Undo restores source without hints.
      return typeof text === 'string' ? stripWrapHints(text) : text
    }
    return registered
  }
}
