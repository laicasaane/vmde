// Task 603 item 2 (Amendment 3) — a VMDE-owned Undo/Redo history for the webview's own text fields
// (the Find and Replace inputs, the link popover, Vditor's WYSIWYG popover inputs, any textarea).
//
// Why not the browser's own field history: VS Code's webview preload blocks the native Ctrl/Cmd+Z
// and Ctrl+Y, so the key reaches the webview as a host message (`vmde.format.undo/redo` →
// `trigger-toolbar-hotkey`), and a field that has focus has to be undone by script. The only script
// route, `document.execCommand('undo'|'redo')`, pops Chromium's ONE frame-wide undo stack, not the
// field's own: when the field has nothing left (or an editor edit is newer than the field's typing)
// it unapplies the editor's step instead. Measured in Chromium: `execCommand('undo')` fires no
// `beforeinput` and only a non-cancelable `input` on whichever element owns the top step, so no
// event guard can stop it. The effects were a same-text history entry (IR, SV), SV text changes and
// stray host `edit` posts, a Redo that moved focus into the editor (WYSIWYG, SV), and in IR a
// character typed just before focusing the field vanishing silently. This module keeps each
// field's history itself, so Undo/Redo in a field never touches Chromium's stack and never reaches
// the editor.
//
// Recording (one document capture listener per event, installed once at boot, before the first
// keypress): a trusted `beforeinput` stores the field's value and selection, and the matching
// `input` completes an entry {before, after}. History input types (`history*`) and untrusted events
// are skipped, including the synthetic `input` that `applyTextFieldHistory` itself dispatches.
// Composition (IME) records one entry from `compositionstart` to `compositionend`.
//
// Granularity: one entry per edit. Chromium gives every typed character of the Find input its own
// native step (measured: "abc" takes three presses) and this matches that; a plain field such as
// Replace merges a typed run natively, so there a run takes one press per character here.
//
// Drift rule: a field's value can change without a user edit, for example Find's seed
// (`elements.find.value = seed`, selection-scope.ts) or a value Vditor writes into a popover input.
// If `field.value` differs from the value after the last recorded entry, both stacks are dropped
// before the next recording or Undo/Redo, so the written value is the new base and Undo never
// restores text from before it (a programmatic value set clears the native history the same way).
// A written value identical to the last recorded one is not detectable by that rule, so the code that
// writes a value as a fresh start calls `resetTextFieldHistory` (Find's seed does).

type TextField = HTMLInputElement | HTMLTextAreaElement

// Input types whose text a Select All command selects and that Undo/Redo treat as text fields.
// `number`, `checkbox` and the rest keep the document's Undo, as before Task 603.
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
])

/** The history stays this long per field; the oldest entry goes first. */
const MAX_ENTRIES = 100

/** Whether `element` is a text input or textarea, the controls this module covers. */
export function isTextField(element: unknown): element is TextField {
  if (element instanceof HTMLTextAreaElement) return true
  return (
    element instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(element.type)
  )
}

interface Snapshot {
  value: string
  // Null for input types that expose no selection (`email`).
  start: number | null
  end: number | null
  direction: 'forward' | 'backward' | 'none' | null
}

interface Entry {
  before: Snapshot
  after: Snapshot
}

interface FieldState {
  undo: Entry[]
  redo: Entry[]
  /** The value after the last recorded entry (or when the field was first seen). */
  last: string
  /** The field as it was before the edit in flight (set at `beforeinput` or `compositionstart`). */
  pending: Snapshot | null
  composing: boolean
}

const states = new WeakMap<TextField, FieldState>()

function snapshot(field: TextField): Snapshot {
  return {
    value: field.value,
    start: field.selectionStart,
    end: field.selectionEnd,
    direction: field.selectionDirection,
  }
}

// Creates the state on first sight and applies the drift rule. Skipped while composing, because a
// composition changes the value many times before its single entry is recorded.
function stateOf(field: TextField): FieldState {
  let state = states.get(field)
  if (!state) {
    state = {
      undo: [],
      redo: [],
      last: field.value,
      pending: null,
      composing: false,
    }
    states.set(field, state)
  } else if (!state.composing && state.last !== field.value) {
    state.undo.length = 0
    state.redo.length = 0
    state.last = field.value
    state.pending = null
  }
  return state
}

function record(state: FieldState, before: Snapshot, after: Snapshot): void {
  state.pending = null
  state.last = after.value
  if (before.value === after.value) return
  state.undo.push({ before, after })
  if (state.undo.length > MAX_ENTRIES) state.undo.shift()
  state.redo.length = 0
}

/**
 * Forget a field's history and take its current value as the new base. For code that writes a value
 * as a fresh starting text (Find's seed): the drift rule alone cannot see a write that equals the
 * last recorded value, and the browser's own field history is cleared by every programmatic write.
 */
export function resetTextFieldHistory(field: TextField): void {
  const state = states.get(field)
  if (!state) return
  state.undo.length = 0
  state.redo.length = 0
  state.last = field.value
  state.pending = null
}

function isUserEdit(event: Event): boolean {
  const input = event as InputEvent
  return (
    event.isTrusted &&
    !input.isComposing &&
    !(input.inputType ?? '').startsWith('history')
  )
}

function onBeforeInput(event: Event): void {
  const field = event.target
  if (!isTextField(field) || !isUserEdit(event)) return
  stateOf(field).pending = snapshot(field)
}

function onInput(event: Event): void {
  const field = event.target
  if (!isTextField(field) || !isUserEdit(event)) return
  const state = states.get(field)
  if (!state) return
  // An input with no `beforeinput` before it (for example `execCommand('insertText')`, which fires
  // none) has no known "before": drop the history rather than record a wrong pair.
  if (!state.pending) {
    state.undo.length = 0
    state.redo.length = 0
    state.last = field.value
    return
  }
  record(state, state.pending, snapshot(field))
}

function onCompositionStart(event: Event): void {
  const field = event.target
  if (!isTextField(field)) return
  const state = stateOf(field)
  state.pending = snapshot(field)
  state.composing = true
}

function onCompositionEnd(event: Event): void {
  const field = event.target
  if (!isTextField(field)) return
  const state = states.get(field)
  if (!state?.composing) return
  state.composing = false
  // `compositionstart` always sets `pending`; the check only narrows the type.
  if (state.pending) record(state, state.pending, snapshot(field))
}

function restore(field: TextField, target: Snapshot): void {
  field.value = target.value
  if (target.start === null || target.end === null) return
  try {
    field.setSelectionRange(
      target.start,
      target.end,
      target.direction ?? undefined,
    )
  } catch {
    // The input type rejects selection at this moment; the value is already restored.
  }
}

/**
 * Undo or Redo the last edit of a text field from its own history. An empty stack or an active
 * composition does nothing. The change is applied as a value and selection write followed by an
 * `input` event of type `historyUndo` / `historyRedo`, so listeners react as they do to typing: the
 * Find widget refreshes its matches, and Vditor's popover inputs update the document. Returns
 * whether an edit was applied.
 */
export function applyTextFieldHistory(
  field: TextField,
  kind: 'undo' | 'redo',
): boolean {
  const state = stateOf(field)
  if (state.composing) return false
  const from = kind === 'undo' ? state.undo : state.redo
  const to = kind === 'undo' ? state.redo : state.undo
  const entry = from.pop()
  if (!entry) return false
  to.push(entry)
  const target = kind === 'undo' ? entry.before : entry.after
  restore(field, target)
  state.last = target.value
  state.pending = null
  field.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: kind === 'undo' ? 'historyUndo' : 'historyRedo',
    }),
  )
  return true
}

/**
 * Start recording every text field's edits. One listener per event on the document, in the capture
 * phase so it sees the edit before the field's own handlers change anything. Returns the removal
 * function.
 */
export function installTextFieldHistory(doc: Document = document): () => void {
  const listeners: [string, (event: Event) => void][] = [
    ['beforeinput', onBeforeInput],
    ['input', onInput],
    ['compositionstart', onCompositionStart],
    ['compositionend', onCompositionEnd],
  ]
  for (const [type, listener] of listeners)
    doc.addEventListener(type, listener, true)
  return () => {
    for (const [type, listener] of listeners)
      doc.removeEventListener(type, listener, true)
  }
}
