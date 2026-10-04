// Task 385 — Ctrl+C / Ctrl+X with nothing selected.
//
// In VS Code, and in every editor a VS Code user comes from, a collapsed Ctrl+C copies the current
// LINE and a collapsed Ctrl+X cuts it. VMDE did neither. Worse, both of Vditor's collapsed paths
// are actively wrong (probe-confirmed in task 191, then left in place pending this decision):
//
//   - Ctrl+C in split mode WIPED the clipboard. `sv`'s copy handler writes `getSelectText(...)` to
//     text/plain with no empty-selection guard, so an empty selection sets it to "". Copy, then
//     paste, and nothing comes back — the literal "copy/paste doesn't work".
//   - Ctrl+X anywhere was a STEALTH BACKSPACE. `cutEvent` runs `execCommand("delete")`
//     unconditionally, even when the copy half early-returned, so it silently ate the character
//     before the caret.
//
// Rather than reimplement copy or cut, this expands the SELECTION to the current block just before
// Vditor's own handler runs (installed via the esbuild patches in esbuild-shared.mjs). Vditor then
// serializes the block through its normal path — which is what makes the copied text real markdown
// rather than DOM text — and the cut's own delete removes exactly what was copied. One small helper
// buys line-copy, line-cut, and the removal of both defects.
//
// "Line" means the containing BLOCK (paragraph, heading, list item, table row, code block…), which
// is the markdown analogue of a VS Code source line: a soft-wrapped paragraph is one line of
// markdown however many rows it occupies on screen.

const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, tr, pre, .vditor-ir__node, .vditor-wysiwyg__block, div[data-block]'

/** Content that copies as something although `Range.toString()` reads it as "". */
const NON_TEXT_CONTENT = 'img, br, hr, svg, canvas, video, audio, iframe, input'

/**
 * Whether `range` is a caret for copy/cut purposes: collapsed, or spanning nothing but empty text.
 *
 * The second shape is real, measured in a VS Code webview (Task 580 CP2-11): Vditor's undo snapshot
 * (`addCaret`, undo/index.ts) calls `insertNode` on the LIVE selection range, which by the DOM spec
 * moves the end of a collapsed range past the inserted marker, and then removes the marker. What is
 * left spans one empty split-off text node: `collapsed === false`, `toString() === ""`. It appears
 * both during a Ctrl+C/X keydown and a few hundred ms after a caret placement, so by the time a
 * `beforecopy`/`beforecut` arrives the caret often already looks like a selection.
 */
export function isCaretRange(range: Range): boolean {
  if (range.collapsed) return true
  if (range.toString() !== '') return false
  return range.cloneContents().querySelector(NON_TEXT_CONTENT) === null
}

/**
 * If the selection inside `editorElement` is a caret (see `isCaretRange`), grow it to cover the
 * block the caret sits in. Returns whether there is now something to copy — `false` means the
 * caller must NOT delete anything, which is what keeps a collapsed cut from behaving like a
 * backspace.
 */
export function expandToLine(editorElement: HTMLElement | null): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return false
  const range = selection.getRangeAt(0)
  if (!isCaretRange(range)) return true
  if (!editorElement) return false

  // The caret must actually be inside this editor — a copy fired while focus sits elsewhere
  // (the toolbar, an outline entry) must not silently grab a block.
  const anchor =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement
  if (!anchor || !editorElement.contains(anchor)) return false

  const block = anchor.closest(BLOCK_SELECTOR)
  // `closest` can walk out of the editor (the editor element itself matches `div[data-block]` in
  // some modes); anything at or above the editor is not a line.
  if (!block || block === editorElement || !editorElement.contains(block))
    return false
  if ((block.textContent ?? '') === '') return false

  const lineRange = document.createRange()
  lineRange.selectNodeContents(block)
  selection.removeAllRanges()
  selection.addRange(lineRange)
  return true
}

/** The editable surface the caret is in, whichever mode is live. */
function activeEditor(doc: Document): HTMLElement | null {
  const active = doc.activeElement
  if (!active) return null
  return (active.closest('.vditor-ir, .vditor-wysiwyg, .vditor-sv') ??
    null) as HTMLElement | null
}

/**
 * Was the selection collapsed when this cut started? Recorded by the `beforecut` listener below,
 * read once by the `cutEvent` patch and cleared, so a cut that skipped the before-event (a
 * synthetic `ClipboardEvent`) falls back to reading the live selection instead of trusting a stale
 * answer.
 *
 * Task 385 recorded this on the Ctrl+X keydown because the live selection inside the cut handler
 * can be an empty but non-collapsed range in a VS Code webview (see `isCaretRange`). `beforecut`
 * reads it with `isCaretRange` in the same `execCommand("cut")` call as the `cut` event, so the
 * patched handler still never mistakes that range for a selection and deletes a character.
 */
interface CutIntent {
  collapsed: boolean
  at: number
}
/** A recorded intent older than this is stale — a cut that is not the one this intent started. */
const CUT_INTENT_TTL_MS = 2000

/** Read-once accessor for the recorded intent; `undefined` when there is nothing trustworthy. */
function takeCutIntent(win: Window & typeof globalThis): boolean | undefined {
  const store = win as unknown as Record<string, unknown>
  const intent = store.__vmdeCutIntent as CutIntent | undefined
  store.__vmdeCutIntent = undefined
  if (!intent) return undefined
  return Date.now() - intent.at > CUT_INTENT_TTL_MS
    ? undefined
    : intent.collapsed
}

/** Whether the document selection is a caret (`isCaretRange`); `undefined` when there is no range. */
function selectionCollapsed(
  win: Window & typeof globalThis,
): boolean | undefined {
  const selection = win.getSelection()
  if (!selection || selection.rangeCount === 0) return undefined
  return isCaretRange(selection.getRangeAt(0))
}

/**
 * Task 580 (CP2-11): VS Code owns Copy and Cut. Its Copy/Cut commands, keys included, reach the
 * webview frame as `document.execCommand("copy"/"cut")`, and Chromium fires a cancelable
 * `beforecopy`/`beforecut` first, collapsed caret included, as it does for a native Ctrl+C/X in a
 * plain browser (CP1 P7, Chromium and Electron). So the line expansion hooks the before-event
 * instead of matching Ctrl/Cmd+C/X on keydown: no key match is left to catch other chords (the
 * old one ignored Shift and widened the caret before Align Center's Ctrl+Shift+C reached the
 * table), and a cut from the command path removes the line too, where it used to be inert.
 *
 * After expanding, the before-event is cancelled, as the Task 580 §2.8 decision specifies, so the
 * `copy`/`cut` is dispatched even by an engine that would skip it for an empty selection; CP1 P7
 * measured the cancel as neither needed nor harmful in Chromium and Electron. Nothing else is
 * cancelled: the copy/cut itself still runs and Vditor's handler serializes the selected block.
 */
export function installClipboardLine(win: Window & typeof globalThis): void {
  ;(win as unknown as Record<string, unknown>).__vmdeExpandToLine = (
    editorElement: HTMLElement | null,
  ) => {
    try {
      return expandToLine(editorElement)
    } catch {
      // Never let a clipboard helper break copy/cut. Returning true keeps Vditor's own behaviour.
      return true
    }
  }

  ;(win as unknown as Record<string, unknown>).__vmdeTakeCutIntent = () => {
    try {
      return takeCutIntent(win)
    } catch {
      // Never let this break cut. `undefined` sends the patch back to reading the live selection,
      // which is exactly the behaviour it had before this existed.
      return undefined
    }
  }

  /** Expand a collapsed caret to its line; true only when this call grew the selection. */
  const expandCollapsed = (event: Event, collapsed: boolean): boolean => {
    if (!collapsed) return false
    let expanded = false
    try {
      expanded = expandToLine(activeEditor(win.document))
    } catch {
      /* a failed expansion leaves the copy/cut as it was */
    }
    if (expanded) event.preventDefault()
    return expanded
  }

  win.document.addEventListener(
    'beforecopy',
    (event) => {
      const collapsed = selectionCollapsed(win)
      if (collapsed !== undefined) expandCollapsed(event, collapsed)
    },
    true,
  )

  win.document.addEventListener(
    'beforecut',
    (event) => {
      const collapsed = selectionCollapsed(win)
      if (collapsed === undefined) return
      // Task 387 replaced Vditor's deferred delete with synchronous Range.deleteContents(), so a
      // line cut deletes exactly the expanded range. The intent tells the patched cut handler
      // whether there is now a real range to copy and delete.
      const expanded = expandCollapsed(event, collapsed)
      ;(win as unknown as Record<string, unknown>).__vmdeCutIntent = {
        collapsed: collapsed && !expanded,
        at: Date.now(),
      }
    },
    true,
  )
}
