import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import {
  clickToolbarHotkeyButton,
  HOTKEY_GATED_TOOLBAR_NAMES,
  resolveVditorEditorRange,
  toolbarHotkeyGate,
} from '../src/editing/format-hotkey-context'
import { innerVditor } from '../src/util/inner-vditor'
import { selectEditorText } from './editor-selection'

// Task 596 S3 — Vditor built from SOURCE with the real toolbar (the vditor-chords-harness
// pattern), so the build's Vditor patches apply (Task 600's refusal included) and the toolbar
// buttons carry the same disabled/current classes as production. The product gate is used as it
// is: the parity spec compares `toolbarHotkeyGate` with Vditor's own highlight, and the behaviour
// spec drives `clickToolbarHotkeyButton`, the function the `trigger-toolbar-hotkey` route calls.

type Mode = 'ir' | 'wysiwyg'
type Cls = { disabled: boolean; current: boolean }

/** Where a test puts the selection. `text` is [needle, offset, length] as `selectEditorText`;
 *  `span` selects from one needle offset to another (`backward` puts the anchor at the end, so the
 *  range start is still the earlier point, as for a Shift+Left selection); `contents` selects the contents of the first `sel` element holding `has`; `el` puts a caret at
 *  `offset` inside that element itself (an element container); `root` puts a caret at that child
 *  offset of the editor root (`end` = after the last child). */
export type Target =
  | { text: readonly [string, number, number] }
  | {
      span: {
        from: readonly [string, number]
        to: readonly [string, number]
        backward: boolean
      }
    }
  | { contents: { sel: string; has: string } }
  | { el: { sel: string; has: string; offset: number } }
  | { root: number | 'end' }

function activeRoot(): { mode: Mode; root: HTMLElement } {
  const inner = innerVditor()
  const mode = inner?.currentMode as Mode
  const root = inner?.[mode]?.element
  if (!root) throw new Error('no active editor')
  return { mode, root }
}

function findElement(root: HTMLElement, sel: string, has: string): Element {
  const found = [...root.querySelectorAll(sel)].find((e) =>
    (e.textContent ?? '').includes(has),
  )
  if (!found) throw new Error(`no ${sel} holding ${has}`)
  return found
}

/** The text node and offset of `needle`'s first occurrence plus `offset`. Unlike `selectEditorText`
 *  this keeps a node boundary on the node it was asked for, so a span can end exactly there. */
function textPoint(
  root: HTMLElement,
  needle: string,
  offset: number,
): [Text, number] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const at = (node as Text).data.indexOf(needle)
    if (at !== -1) return [node as Text, at + offset]
  }
  throw new Error(`text not found: ${needle}`)
}

function place(target: Target): void {
  const { root } = activeRoot()
  if ('text' in target) {
    selectEditorText(target.text)
    return
  }
  if ('span' in target) {
    const { from, to, backward } = target.span
    const start = textPoint(root, ...from)
    const end = textPoint(root, ...to)
    root.focus({ preventScroll: true })
    const selection = getSelection()
    if (backward)
      selection?.setBaseAndExtent(end[0], end[1], start[0], start[1])
    else selection?.setBaseAndExtent(start[0], start[1], end[0], end[1])
    return
  }
  const range = document.createRange()
  if ('contents' in target) {
    range.selectNodeContents(
      findElement(root, target.contents.sel, target.contents.has),
    )
  } else if ('el' in target) {
    const { sel, has, offset } = target.el
    range.setStart(findElement(root, sel, has), offset)
    range.collapse(true)
  } else {
    range.setStart(
      root,
      target.root === 'end' ? root.childNodes.length : target.root,
    )
    range.collapse(true)
  }
  root.focus({ preventScroll: true })
  const selection = getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** What the product gate answers for the live selection, per toolbar name. */
function expected(): Record<string, Cls> {
  const inner = innerVditor()
  const mode = inner?.currentMode as Mode
  const out: Record<string, Cls> = {}
  for (const name of HOTKEY_GATED_TOOLBAR_NAMES) {
    const gate = toolbarHotkeyGate(
      mode,
      inner ? resolveVditorEditorRange(inner, mode) : null,
      inner?.[mode]?.element ?? null,
      name,
      { fullPreview: false },
    )
    if (gate === 'blocked') throw new Error(`gate blocked for ${name}`)
    out[name] = gate
  }
  return out
}

function button(name: string): HTMLElement {
  const b = innerVditor()?.toolbar?.elements?.[name]?.children[0]
  if (!b) throw new Error(`no toolbar button ${name}`)
  return b as HTMLElement
}

/** The two classes Vditor's highlight writes, read from the 12 hotkey buttons. */
function snapshot(): Record<string, Cls> {
  const out: Record<string, Cls> = {}
  for (const name of HOTKEY_GATED_TOOLBAR_NAMES) {
    const b = button(name)
    out[name] = {
      disabled: b.classList.contains('vditor-menu--disabled'),
      current: b.classList.contains('vditor-menu--current'),
    }
  }
  return out
}

/** Set every hotkey button to the INVERSE of the gate, then fire the keyup that schedules Vditor's
 *  debounced highlight (a key without Ctrl: the IR and WYSIWYG keyup handlers skip Ctrl keys). A
 *  highlight that never ran or skipped a button leaves the inverse, so it can never read as a
 *  match. Both modes' keyup handlers only schedule the highlight for this key (no DOM edit). */
function poisonAndSchedule(): void {
  const want = expected()
  for (const name of HOTKEY_GATED_TOOLBAR_NAMES) {
    const b = button(name)
    b.classList.toggle('vditor-menu--disabled', !want[name].disabled)
    b.classList.toggle('vditor-menu--current', !want[name].current)
  }
  activeRoot().root.dispatchEvent(
    new KeyboardEvent('keyup', {
      key: 'Shift',
      code: 'ShiftLeft',
      bubbles: true,
    }),
  )
}

/** Poll (no fixed sleep) until the 12 buttons equal the gate's answer for the live selection, or
 *  `timeoutMs` passes. The gate is read each poll, so a selection Vditor itself moved still
 *  compares like with like. Returns both sides for a precise failure message. */
async function waitHighlight(timeoutMs: number): Promise<{
  ok: boolean
  actual: Record<string, Cls>
  expected: Record<string, Cls>
}> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    const actual = snapshot()
    const want = expected()
    const ok = JSON.stringify(actual) === JSON.stringify(want)
    if (ok || performance.now() > deadline)
      return { ok, actual, expected: want }
    await new Promise((resolve) => setTimeout(resolve, 15))
  }
}

/** The pre-596 hotkey click: the router's bubbling click on the button, with the button's classes
 *  left as Vditor's stale highlight wrote them. The RED control for the behaviour spec. */
function plainClick(name: string): void {
  button(name).dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  )
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: 'Para text\n',
  toolbar: createToolbar(),
  after() {
    const w = window as any
    w.vditor = editor
    w.__gate = {
      place,
      snapshot,
      expected,
      poisonAndSchedule,
      waitHighlight,
      plainClick,
      // The product function under test, unwrapped.
      gatedClick: clickToolbarHotkeyButton,
      names: [...HOTKEY_GATED_TOOLBAR_NAMES],
    }
    w.__ready = true
  },
})
