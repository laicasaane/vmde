// Task 580 CP2-10 — the commands that replace Vditor's hard-coded chords, all unbound (Owner answer
// Q4): Format: Heading 1–6 (`vmde.format.heading1..6`), Toggle Task Checkbox
// (`vmde.toggleTaskCheckbox`) and the three edit-mode switches (`vmde.switchTo*`). The build patches
// Vditor to answer only untrusted chords (media-src/esbuild-shared.mjs, `patchDigitChordsUntrusted`
// and `patchHotKeyTrustedEvents`), so the user's real Ctrl/Cmd+Alt+Digit and Ctrl/Cmd+Shift+J no
// longer reach these actions.
//
// The heading and task commands send the former chord as an untrusted keydown through the contained
// synthetic helper, so Vditor's own per-mode logic runs unchanged: the IR and Split View heading
// prefixes, the WYSIWYG heading toggle-off and the IR/WYSIWYG task toggle. The mode switches click
// the toolbar's edit-mode choice instead (Part 1 handoff §2.6 allows either). Both run Vditor's
// `setEditMode`, but only the toolbar path also persists the mode and reports it to the status bar
// and screen readers (chrome/toolbar-actions.ts), which a command should do. Without that button
// (no toolbar) they fall back to the chord.
//
// None of the former chords took an undo boundary (undo-boundaries.ts skips Alt chords, J was never
// a model key, and edit-mode clicks are excluded), so the actions take none either.
import type { EditorAction } from '../../../src/shared/protocol'
import { innerVditor } from '../util/inner-vditor'
import { isMac } from '../util/platform'
import { activeModeElement } from '../util/source-map'
import { dispatchContainedKeydown } from './table-hotkey'

/** The keys of one former Vditor chord; the primary modifier (Ctrl, or Cmd on macOS) is added. */
type VditorChord = Pick<
  KeyboardEventInit,
  'key' | 'code' | 'shiftKey' | 'altKey'
>

type EditMode = 'wysiwyg' | 'ir' | 'sv'

// Vditor tests `event.code` for the Digit chords and `event.key` for the task toggle (`matchHotKey`
// compares the lowercased key with Shift held).
const digit = (n: number): VditorChord => ({
  key: String(n),
  code: `Digit${n}`,
  altKey: true,
})

/** The heading and task editor actions and the chord each sends. */
export const VDITOR_CHORD_ACTIONS: readonly (readonly [
  EditorAction,
  VditorChord,
])[] = [
  ['heading-1', digit(1)],
  ['heading-2', digit(2)],
  ['heading-3', digit(3)],
  ['heading-4', digit(4)],
  ['heading-5', digit(5)],
  ['heading-6', digit(6)],
  ['toggle-task-checkbox', { key: 'J', code: 'KeyJ', shiftKey: true }],
]

/** The edit-mode editor actions, their mode and the former chord for the no-toolbar fallback. */
export const EDIT_MODE_ACTIONS: readonly (readonly [
  EditorAction,
  EditMode,
  VditorChord,
])[] = [
  ['switch-to-wysiwyg', 'wysiwyg', digit(7)],
  ['switch-to-ir', 'ir', digit(8)],
  ['switch-to-sv', 'sv', digit(9)],
]

/** Send one Vditor chord to the active mode element. Returns whether Vditor handled it. */
export function runVditorChord(chord: VditorChord, mac = isMac()): boolean {
  const root = window.vditor ? activeModeElement(window.vditor) : null
  if (!root) return false
  return dispatchContainedKeydown(root, {
    ...chord,
    ctrlKey: !mac,
    metaKey: mac,
  })
}

/** Switch the edit mode as the toolbar's mode choice does, or by the former chord without it. */
export function switchEditMode(mode: EditMode, chord: VditorChord): boolean {
  const choice = innerVditor()?.toolbar?.elements?.[
    'edit-mode'
  ]?.querySelector<HTMLElement>(`button[data-mode="${mode}"]`)
  if (!choice) return runVditorChord(chord)
  choice.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  )
  return true
}
