// Task 596 Part 2: act on the LIVE selection, not on Vditor's stale toolbar classes.
//
// A toolbar hotkey runs by clicking the Vditor toolbar button, and that click reads the button's own
// `vditor-menu--disabled` / `vditor-menu--current` classes ("disabled" = do nothing, "current" =
// remove this format). Vditor writes those classes only from `highlightToolbarIR` /
// `highlightToolbarWYSIWYG`, debounced 200 ms, run on click, keyup and Undo/Redo, and never in SV.
// A selection that changed by program, or under 200 ms before the key, therefore acts on the previous
// context (measured: `tmp/task596-603-evidence/t596`). This module recomputes the same classes
// synchronously from the range Vditor itself would use, so the caller can set them on the one button
// it is about to click.
//
// It has no timer, cache, highlight pass or serialization and never focuses anything. The rules mirror
// vditor/src/ts/ir/highlightToolbarIR.ts:20-94 and wysiwyg/highlightToolbarWYSIWYG.ts:47-192
// (Vditor 3.11.3) exactly, quirks included, because the click that follows is Vditor's own code.
// Consumed by the `trigger-toolbar-hotkey` route (bridge/message-router.ts, Task 596 S2).

import {
  hasClosestByAttribute,
  hasClosestByMatchTag,
} from 'vditor/src/ts/util/hasClosest'
import { hasClosestByHeadings } from 'vditor/src/ts/util/hasClosestByHeadings'
import { type InnerVditor, innerVditor } from '../util/inner-vditor'

// Vditor's Constants.CLASS_MENU_DISABLED and the `vditor-menu--current` class that its
// set/removeCurrentToolbar toggle, kept literal so this module needs no Vditor constants import.
const DISABLED_CLASS = 'vditor-menu--disabled'
const CURRENT_CLASS = 'vditor-menu--current'

export type HotkeyGateMode = 'ir' | 'wysiwyg' | 'sv'

/** The two toolbar classes Vditor would have set. Both can hold at once (an IR code block makes
 *  `code` disabled and current). */
interface HotkeyGateState {
  disabled: boolean
  current: boolean
}

/** `'blocked'`: nothing may be clicked (full Preview, read-only editor, no editor, or a range that
 *  does not start inside this editor). */
export type ToolbarHotkeyGate = HotkeyGateState | 'blocked'

/** The 12 toolbar names a hotkey clicks through the gate: `TOOLBAR_COMMAND_NAMES`
 *  (src/shared/editor-shortcuts.ts) minus undo and redo, which call the undo engine instead. A test
 *  keeps the two lists in step. */
export const HOTKEY_GATED_TOOLBAR_NAMES = [
  'bold',
  'italic',
  'strike',
  'headings',
  'list',
  'ordered-list',
  'check',
  'outdent',
  'indent',
  'quote',
  'code',
  'inline-code',
] as const

/** Names Vditor disables inside code (IR `data-type="code"` and WYSIWYG CODE outside PRE): every
 *  format name except `inline-code`, which becomes current there instead. */
const INLINE_CODE_DISABLED: readonly string[] = [
  'headings',
  'bold',
  'italic',
  'strike',
  'quote',
  'list',
  'ordered-list',
  'check',
  'code',
]

/** Names Vditor disables in an IR table (`data-type="table"`). */
const TABLE_DISABLED: readonly string[] = [
  'headings',
  'list',
  'ordered-list',
  'check',
  'quote',
  'code',
]

/** Mirrors `getEditorRange` (vditor util/selection.ts:5-22): the live range when it starts inside the
 *  editor, else the stored `inner[mode].range`, else a collapsed range at the editor start. Vditor's
 *  last step also calls `element.focus()`; this one never does, so a gate cannot move focus or the
 *  selection. `null` when the mode has no editor element. */
export function resolveVditorEditorRange(
  inner: InnerVditor,
  mode: HotkeyGateMode,
): Range | null {
  const editor = inner[mode]?.element
  if (!editor) return null
  const selection = editor.ownerDocument.defaultView?.getSelection()
  if (selection && selection.rangeCount > 0) {
    const live = selection.getRangeAt(0)
    // Vditor tests `isEqualNode || contains`; identity is the intended meaning of the first half.
    if (editor === live.startContainer || editor.contains(live.startContainer))
      return live
  }
  const stored = inner[mode]?.range
  if (stored) return stored
  const start = editor.ownerDocument.createRange()
  start.setStart(editor, 0)
  start.collapse(true)
  return start
}

interface Context {
  disabled: Set<string>
  current: Set<string>
}

/** Add `names` to `set` when `when` (a Vditor `hasClosest*` answer, `false` or an element) holds. */
function addIf(
  set: Set<string>,
  when: unknown,
  names: readonly string[],
): void {
  if (when) for (const name of names) set.add(name)
}

/** The list rules are identical in both modes: an LI enables indent/outdent and marks `check`,
 *  `ordered-list` or `list` current; no LI disables indent/outdent. */
function applyListRules(el: Node | undefined, ctx: Context): void {
  const li = hasClosestByMatchTag(el as Node, 'LI')
  addIf(ctx.disabled, !li, ['indent', 'outdent'])
  if (!li) return
  const parentTag = li.parentElement?.tagName
  if (li.classList.contains('vditor-task')) ctx.current.add('check')
  else if (parentTag === 'OL') ctx.current.add('ordered-list')
  else if (parentTag === 'UL') ctx.current.add('list')
}

/** Mirrors highlightToolbarIR.ts:20-94 for the 12 hotkey names. */
function irContext(range: Range): Context {
  const ctx: Context = { disabled: new Set(), current: new Set() }
  let typeElement: Node | undefined = range.startContainer
  if (typeElement.nodeType === Node.TEXT_NODE)
    typeElement = typeElement.parentElement ?? undefined
  // A `.vditor-reset` container resolves to `childNodes[startOffset]` (IR only; WYSIWYG maps every
  // element container). An offset past the end gives `undefined`, and each predicate below answers
  // `false` for it, so nothing is current and only indent/outdent are disabled.
  if ((typeElement as Element | undefined)?.classList?.contains('vditor-reset'))
    typeElement = typeElement?.childNodes[range.startOffset]
  const el = typeElement as Node
  const typed = (type: string) => hasClosestByAttribute(el, 'data-type', type)

  addIf(ctx.current, hasClosestByHeadings(el), ['headings'])
  addIf(ctx.current, hasClosestByMatchTag(el, 'BLOCKQUOTE'), ['quote'])
  addIf(ctx.current, typed('strong'), ['bold'])
  addIf(ctx.current, typed('em'), ['italic'])
  addIf(ctx.current, typed('s'), ['strike'])
  applyListRules(typeElement, ctx)

  const codeBlock = typed('code-block')
  addIf(ctx.disabled, codeBlock, [...INLINE_CODE_DISABLED, 'inline-code'])
  addIf(ctx.current, codeBlock, ['code'])
  // Inline code disables bold but, unlike a code block, not inline-code (it is the one to toggle off).
  const inlineCode = typed('code')
  addIf(ctx.disabled, inlineCode, INLINE_CODE_DISABLED)
  addIf(ctx.current, inlineCode, ['inline-code'])
  addIf(ctx.disabled, typed('table'), TABLE_DISABLED)
  return ctx
}

/** Mirrors highlightToolbarWYSIWYG.ts:47-192 for the 12 hotkey names. */
function wysiwygContext(range: Range): Context {
  const ctx: Context = { disabled: new Set(), current: new Set() }
  let typeElement: Node | undefined = range.startContainer
  if (typeElement.nodeType === Node.TEXT_NODE) {
    typeElement = typeElement.parentElement ?? undefined
  } else {
    // Every element container maps to `childNodes[min(offset, len - 1)]`; an empty container gives
    // `childNodes[-1]` (undefined), which no predicate matches.
    const kids = typeElement.childNodes
    typeElement =
      kids[
        range.startOffset >= kids.length ? kids.length - 1 : range.startOffset
      ]
  }
  const el = typeElement as Node
  const tag = (name: string) => hasClosestByMatchTag(el, name)

  // A footnotes block returns right after Vditor enabled every button: nothing is disabled or
  // current, not even indent/outdent for the LI inside it (highlightToolbarWYSIWYG.ts:65-72).
  if (hasClosestByAttribute(el, 'data-type', 'footnotes-block')) return ctx

  applyListRules(typeElement, ctx)
  addIf(ctx.current, tag('BLOCKQUOTE'), ['quote'])
  addIf(ctx.current, tag('B') || tag('STRONG'), ['bold'])
  addIf(ctx.current, tag('I') || tag('EM'), ['italic'])
  addIf(ctx.current, tag('STRIKE') || tag('S'), ['strike'])

  const code = tag('CODE')
  const codeBlock = code && tag('PRE')
  addIf(ctx.disabled, code, INLINE_CODE_DISABLED)
  addIf(ctx.disabled, codeBlock, ['inline-code'])
  addIf(ctx.current, codeBlock, ['code'])
  addIf(ctx.current, code && !codeBlock, ['inline-code'])
  // A heading outside CODE (Vditor's `else if` after the CODE branch) disables bold and is current.
  const heading = !code && hasClosestByHeadings(el)
  addIf(ctx.disabled, heading, ['bold'])
  addIf(ctx.current, heading, ['headings'])
  // A WYSIWYG table cell disables only the `table` button, none of the 12 hotkey names.
  return ctx
}

/** The gate for one toolbar name: what Vditor's highlight would have set on its button for `range`,
 *  or `'blocked'` for full Preview, a read-only or absent editor, or a range that does not start in
 *  this editor (a stored range whose node was detached or replaced). `fullPreview` is passed in
 *  because `preview.element.style.display === 'block'` also holds for an editable SV both-pane
 *  layout, so it cannot be read from the DOM here (see `previewShowing` below for the button test).
 *
 *  Keyed by toolbar name only, never by a key or command id. A name the highlight does not decide
 *  (undo, redo, anything else) reads as enabled and not current. */
export function toolbarHotkeyGate(
  mode: HotkeyGateMode,
  range: Range | null,
  editor: HTMLElement | null,
  name: string,
  options: { fullPreview: boolean },
): ToolbarHotkeyGate {
  if (options.fullPreview || !editor || !range) return 'blocked'
  if (editor.getAttribute('contenteditable') === 'false') return 'blocked'
  if (!editor.isConnected || !editor.contains(range.startContainer))
    return 'blocked'
  if (!(HOTKEY_GATED_TOOLBAR_NAMES as readonly string[]).includes(name))
    return { disabled: false, current: false }
  if (mode === 'sv') {
    // Vditor never highlights SV, and a stray IR timer may fire after a switch to SV
    // (highlightToolbarIR reads `vditor[currentMode]` when it fires). SV has no formats to gate;
    // only indent/outdent are disabled, as EditMode.ts:44-46 sets on entering SV.
    return { disabled: name === 'indent' || name === 'outdent', current: false }
  }
  const ctx = mode === 'ir' ? irContext(range) : wysiwygContext(range)
  return { disabled: ctx.disabled.has(name), current: ctx.current.has(name) }
}

/** Set or clear exactly the two gate classes on this one button. `'blocked'` changes nothing. */
export function syncToolbarButtonGate(
  button: Element,
  gate: ToolbarHotkeyGate,
): void {
  if (gate === 'blocked') return
  button.classList.toggle(DISABLED_CLASS, gate.disabled)
  button.classList.toggle(CURRENT_CLASS, gate.current)
}

/** Full Preview, not an editable SV both-pane: Vditor marks the Preview toolbar button current only
 *  for the full overlay (same test as its twin `previewShowing` in bridge/editor-actions.ts, which is private; duplicated
 *  because editing must not import bridge). */
function previewShowing(inner: InnerVditor): boolean {
  return (
    inner.toolbar?.elements?.preview?.children[0]?.classList.contains(
      CURRENT_CLASS,
    ) === true
  )
}

/** Gate one toolbar name against the live selection, sync that one button's classes, and dispatch
 *  the bubbling, cancelable click the router already sends (message-router.ts). Vditor's own hotkey
 *  handler sends a non-bubbling `CustomEvent(getEventName())` instead; `getEventName()` is "click"
 *  except on iPhone, so the event type matches Vditor's button listeners. `false`, with nothing
 *  changed, when the gate is `'blocked'` or the editor or button is missing. The caller owns the
 *  steps before it (name whitelist, Undo/Redo, command-selection restore, Task 600's refusal). */
export function clickToolbarHotkeyButton(name: string): boolean {
  const inner = innerVditor()
  const button = inner?.toolbar?.elements?.[name]?.children[0]
  const mode = inner?.currentMode
  if (!inner || !button) return false
  if (mode !== 'ir' && mode !== 'wysiwyg' && mode !== 'sv') return false
  const gate = toolbarHotkeyGate(
    mode,
    resolveVditorEditorRange(inner, mode),
    inner[mode]?.element ?? null,
    name,
    { fullPreview: previewShowing(inner) },
  )
  if (gate === 'blocked') return false
  syncToolbarButtonGate(button, gate)
  button.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  )
  return true
}
