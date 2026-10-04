// Task 580 CP2-1 — the one webview entry for contributed VMDE commands that arrive as an
// `editor-action` message (message-router.ts validates the name first). It replaces the scattered
// keydown chord matches step by step: each Checkpoint 2 conversion registers its action's runner
// here and removes its old key owner in the same step, so no command runs twice.
//
// Every action passes the same gates, in this order (Part 1 handoff §2.2):
//   1. no runner registered yet: drop, before any side effect;
//   2. IME composition active: drop, so a command never splits a composition;
//   3. Preview or a read-only surface: drop actions that act on the editable surface;
//   4. `invalidateCaret()`: an explicit command wins over a pending caret intent (ADR-0007
//      decision 3, as Task 579's Find actions do);
//   5. a VMDE input (Find, link popover) has focus: Select All selects the input's text and every
//      other action does nothing (Orchestrator ruling, 2026-10-04);
//   6. the action's scope reproduces the target check its old keydown handler made;
//   7. the selection-restore hook, then the undo-boundary hook (boot/main.ts installs both:
//      format-hotkey-guard.ts's command selection snapshot and undo-boundaries.ts's action list);
//   8. the runner, inside one E2E readiness activity.
import type { EditorAction } from '../../../src/shared/protocol'
import { invalidateCaret } from '../editing/caret'
import { beginE2EActivity, markE2EError } from '../testing/e2e-readiness'
import { isCompositionActive } from '../util/caret-gesture'
import { innerVditor } from '../util/inner-vditor'
import { activeModeElement } from '../util/source-map'
import { logToHost, reportError } from '../util/webview-log'

/**
 * Where an action may start:
 * - `webview`: anywhere in the webview (fold, mode switch);
 * - `editor-selection`: the live selection's focus is in the active editing surface;
 * - `editor-focus`: the active editing surface (or a node inside it) has focus.
 */
type EditorActionScope = 'webview' | 'editor-selection' | 'editor-focus'

interface EditorActionSpec {
  scope: EditorActionScope
  /** Acts on the editable surface, so Preview and read-only states drop it. */
  needsEditableSurface: boolean
}

const EDIT_AT_FOCUS: EditorActionSpec = {
  scope: 'editor-focus',
  needsEditableSurface: true,
}
const EDIT_AT_SELECTION: EditorActionSpec = {
  scope: 'editor-selection',
  needsEditableSurface: true,
}
const SELECT: EditorActionSpec = {
  scope: 'editor-selection',
  needsEditableSurface: false,
}
const FOLD: EditorActionSpec = { scope: 'webview', needsEditableSurface: false }
// Vditor disables its edit-mode menu while Preview is showing, and its Ctrl/Cmd+Alt+7/8/9 handler
// listens on the hidden editing surface, so today no mode switch can start from Preview.
const MODE_SWITCH: EditorActionSpec = {
  scope: 'webview',
  needsEditableSurface: true,
}

const EDITOR_ACTION_SPECS = {
  'select-all': SELECT,
  'expand-selection': SELECT,
  'move-block-up': EDIT_AT_FOCUS,
  'move-block-down': EDIT_AT_FOCUS,
  fold: FOLD,
  unfold: FOLD,
  'table-align-left': EDIT_AT_FOCUS,
  'table-align-center': EDIT_AT_FOCUS,
  'table-align-right': EDIT_AT_FOCUS,
  'table-insert-row-above': EDIT_AT_FOCUS,
  'table-insert-row-below': EDIT_AT_FOCUS,
  'table-insert-column-left': EDIT_AT_FOCUS,
  'table-insert-column-right': EDIT_AT_FOCUS,
  'table-delete-row': EDIT_AT_FOCUS,
  'table-delete-column': EDIT_AT_FOCUS,
  'table-move-column-left': EDIT_AT_SELECTION,
  'table-move-column-right': EDIT_AT_SELECTION,
  'table-move-row-up': EDIT_AT_SELECTION,
  'table-move-row-down': EDIT_AT_SELECTION,
  'heading-1': EDIT_AT_FOCUS,
  'heading-2': EDIT_AT_FOCUS,
  'heading-3': EDIT_AT_FOCUS,
  'heading-4': EDIT_AT_FOCUS,
  'heading-5': EDIT_AT_FOCUS,
  'heading-6': EDIT_AT_FOCUS,
  'switch-to-wysiwyg': MODE_SWITCH,
  'switch-to-ir': MODE_SWITCH,
  'switch-to-sv': MODE_SWITCH,
  'toggle-task-checkbox': EDIT_AT_FOCUS,
} satisfies Record<EditorAction, EditorActionSpec>

export type EditorActionRunner = () => void

export interface EditorActionHooks {
  /** Restore the originating chord's selection snapshot before the runner reads it. */
  restoreSelection: (action: EditorAction) => void
  /** Take an undo boundary where the P5 baseline shows one for the action. */
  takeUndoBoundary: (action: EditorAction) => void
}

const NO_HOOKS: EditorActionHooks = {
  restoreSelection: () => {
    /* no selection snapshot installed */
  },
  takeUndoBoundary: () => {
    /* no action boundary installed */
  },
}

const runners = new Map<EditorAction, EditorActionRunner>()
let hooks: EditorActionHooks = NO_HOOKS

/** Register the runner for one action; the returned function removes it again. */
export function registerEditorActionRunner(
  action: EditorAction,
  runner: EditorActionRunner,
): () => void {
  runners.set(action, runner)
  return () => {
    if (runners.get(action) === runner) runners.delete(action)
  }
}

/** Install the selection and undo-boundary hooks; the returned function restores the no-ops. */
export function configureEditorActionHooks(
  next: Partial<EditorActionHooks>,
): () => void {
  const installed = { ...NO_HOOKS, ...next }
  hooks = installed
  return () => {
    if (hooks === installed) hooks = NO_HOOKS
  }
}

// Input types whose text a Select All command selects, as the browser's own select-all would.
const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'text',
  'search',
  'url',
  'email',
  'tel',
  'password',
])

function focusedTextInput(): HTMLInputElement | HTMLTextAreaElement | null {
  const active = document.activeElement
  if (active instanceof HTMLTextAreaElement) return active
  return active instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(active.type)
    ? active
    : null
}

function activeEditingSurface(): HTMLElement | null {
  return window.vditor ? activeModeElement(window.vditor) : null
}

function previewShowing(): boolean {
  const button = innerVditor()?.toolbar?.elements?.preview?.children[0]
  return button?.classList.contains('vditor-menu--current') === true
}

// Streaming large documents and Vditor's own `disabled()` both mark the surface
// `contenteditable="false"`; treat that the same as Preview.
function editableSurfaceAvailable(): boolean {
  if (previewShowing()) return false
  const surface = activeEditingSurface()
  return !!surface && surface.getAttribute('contenteditable') !== 'false'
}

function scopeAllows(scope: EditorActionScope): boolean {
  if (scope === 'webview') return true
  const surface = activeEditingSurface()
  if (!surface) return false
  if (scope === 'editor-focus') {
    const focused = document.activeElement
    return !!focused && surface.contains(focused)
  }
  const selection = getSelection()
  const node = selection?.rangeCount ? selection.focusNode : null
  return !!node && surface.contains(node)
}

// Gates 2 and 3, which run before any side effect. Returns the drop reason, or null to continue.
function earlyDropReason(spec: EditorActionSpec): string | null {
  if (isCompositionActive()) return 'IME composition active'
  if (spec.needsEditableSurface && !editableSurfaceAvailable())
    return 'Preview or read-only'
  return null
}

function runInsideActivity(
  action: EditorAction,
  runner: EditorActionRunner,
): void {
  const done = beginE2EActivity(`editor-action:${action}`)
  try {
    runner()
  } catch (error) {
    markE2EError(`editor-action:${action}`, error)
    reportError(error, `editor-action ${action} failed`)
  } finally {
    done()
  }
}

/** Run one validated editor action through the shared gates (see the module header). */
export function runEditorAction(action: EditorAction): void {
  const runner = runners.get(action)
  const spec: EditorActionSpec = EDITOR_ACTION_SPECS[action]
  const early = runner ? earlyDropReason(spec) : 'no runner registered'
  if (early || !runner) {
    logToHost(`[editor-action] ${action} dropped: ${early}`)
    return
  }
  invalidateCaret()
  const input = focusedTextInput()
  if (input) {
    if (action === 'select-all') input.select()
    return
  }
  if (!scopeAllows(spec.scope)) {
    logToHost(`[editor-action] ${action} dropped: outside ${spec.scope}`)
    return
  }
  hooks.restoreSelection(action)
  hooks.takeUndoBoundary(action)
  runInsideActivity(action, runner)
}
