import {
  SOURCE_UNITS,
  sourceUnitFeedOf,
  unitModeOf,
} from '../util/unit-changes'
import { type SelectionEnds, writeSelection } from '../util/selection-write'

/** The node a released ends object points at (no document node). */
const PLACEHOLDER: Node = { nodeType: 0 } as unknown as Node
/** One ends object for every caret write of the Source input (R-2: no allocation per key). */
const CARET_ENDS: SelectionEnds = {
  anchorNode: PLACEHOLDER,
  anchorOffset: 0,
  focusNode: PLACEHOLDER,
  focusOffset: 0,
}

// Task 733 / 015-I2 (task 015 sections 6.2 D-3, D-5 and 6.4): the window hooks of the Source build
// patches. Patch V-S1 (`sv/inputEvent.ts`) asks `__vmdeSvLocalSpin` whether the caret block is spun
// alone (Vditor otherwise prepends the previous block and gathers every definition block of the
// document) and `__vmdeSvPlaceCaret` to write the caret into the elements the spin produced (Vditor
// otherwise searches the whole Source root for the marker). Patch V-S2 (`toolbar/EditMode.ts`) asks
// `__vmdeModeSwitchText` for the text of a switch into or out of Source. Each hook declines (false or
// undefined) whenever its conditions do not hold, and Vditor's own code runs.

interface VditorLike {
  currentMode?: string
  sv?: { element?: HTMLElement }
}

declare global {
  interface Window {
    __vmdeSvLocalSpin?(vditor: unknown, block: HTMLElement): boolean
    __vmdeSvPlaceCaret?(
      vditor: unknown,
      before: Element | null,
      after: Element | null,
      range: Range,
    ): boolean
    __vmdeModeSwitchText?(vditor: unknown, mode: string): string | undefined
    /** Task 733 / 015 (D-14 review A-1): the Source switch at run time, for patches V-S3 and V-S3b. */
    __vmdeSourceUnitsOn?(): boolean
  }
}

export interface SourceInputHookDeps {
  /** The model text when the model owns it and no typing is unpublished (`ModelSession.modeSwitchText`). */
  modeSwitchText?(): string | undefined
}

const BLANK_LINE_END = '\n\n'
const FRONT_MATTER_START = '---\n'
// Upstream widens to the root for these (`sv/inputEvent.ts:109-116`): a definition or a footnote
// block depends on the other definition blocks of the document.
const DEFINITION_TYPES = [
  'link-ref-defs-block',
  'footnotes-link',
  'footnotes-block',
]

const sourceRootOf = (vditor: unknown): HTMLElement | undefined =>
  (vditor as VditorLike | undefined)?.sv?.element

/** The block or its first child is a definition or footnote construct (O(1), no query). */
function holdsDefinition(block: HTMLElement): boolean {
  const type = block.firstElementChild?.getAttribute('data-type')
  return type !== null && type !== undefined && DEFINITION_TYPES.includes(type)
}

/** Text of a block that starts with a link reference definition (`[x]: …`) or a footnote (`[^x]: …`). */
const DEFINITION_LINE = /^ {0,3}\[\^?[^\]]+\]:/u

function localSpin(win: Window, vditor: unknown, block: HTMLElement): boolean {
  if (!SOURCE_UNITS) return false
  const root = sourceRootOf(vditor)
  if (!root || block === root || block.parentElement !== root) return false
  const feed = sourceUnitFeedOf(win)
  if (!feed?.isLive() || feed.root !== root) return false
  if (holdsDefinition(block)) return false
  const text = block.textContent ?? ''
  if (text.startsWith(FRONT_MATTER_START) || DEFINITION_LINE.test(text))
    return false
  const previous = block.previousElementSibling
  // The blank line that separated the two blocks was deleted: the upstream merge joins them.
  return !previous || (previous.textContent ?? '').endsWith(BLANK_LINE_END)
}

/** The caret position the marker stands for: the end of the text before it, else the start of the text after it. */
function caretAt(marker: Element): [Node, number] {
  const previous = marker.previousSibling
  if (previous?.nodeType === Node.TEXT_NODE)
    return [previous, previous.textContent?.length ?? 0]
  const next = marker.nextSibling
  if (next?.nodeType === Node.TEXT_NODE) return [next, 0]
  const parent = marker.parentNode as Node
  return [parent, Array.prototype.indexOf.call(parent.childNodes, marker)]
}

function placeCaret(
  vditor: unknown,
  before: Element | null,
  after: Element | null,
  range: Range,
): boolean {
  const root = sourceRootOf(vditor)
  if (!root) return false
  let block = before ? before.nextElementSibling : root.firstElementChild
  for (; block && block !== after; block = block.nextElementSibling) {
    const marker = block.querySelector('wbr')
    if (!marker) continue
    const [node, offset] = caretAt(marker)
    // A node before the marker keeps its offset after the marker leaves; a parent offset was the marker's own index.
    marker.remove()
    range.setStart(node, offset)
    range.collapse(true)
    // One deliberate selection write through the caret authority's helper (one `setBaseAndExtent`,
    // shared rules 3.11), with no read of the live range; the reused ends object allocates nothing.
    CARET_ENDS.anchorNode = node
    CARET_ENDS.focusNode = node
    CARET_ENDS.anchorOffset = offset
    CARET_ENDS.focusOffset = offset
    const written = writeSelection(CARET_ENDS)
    // Drop the node references so a removed block is not kept alive by this module.
    CARET_ENDS.anchorNode = CARET_ENDS.focusNode = PLACEHOLDER
    return written
  }
  return false
}

/** Installs the hooks on `win` (V-S1, V-S2, and the Source switch of V-S3 and V-S3b); returns the removal. */
export function installSourceInputHooks(
  win: Window,
  deps: SourceInputHookDeps = {},
): () => void {
  const local = (vditor: unknown, block: HTMLElement): boolean =>
    localSpin(win, vditor, block)
  const place = (
    vditor: unknown,
    before: Element | null,
    after: Element | null,
    range: Range,
  ): boolean => placeCaret(vditor, before, after, range)
  const switchText = (vditor: unknown, mode: string): string | undefined => {
    const current = (vditor as VditorLike | undefined)?.currentMode
    // Task 733 / 020 (Q-164): a switch between the unit modes (IR and WYSIWYG units) also keeps the text.
    const source = SOURCE_UNITS && (mode === 'sv' || current === 'sv')
    const units =
      unitModeOf(mode) !== undefined && unitModeOf(current) !== undefined
    if (!source && !units) return undefined
    return deps.modeSwitchText?.()
  }
  const sourceUnitsOn = (): boolean => SOURCE_UNITS
  win.__vmdeSourceUnitsOn = sourceUnitsOn
  win.__vmdeSvLocalSpin = local
  win.__vmdeSvPlaceCaret = place
  win.__vmdeModeSwitchText = switchText
  return () => {
    if (win.__vmdeSourceUnitsOn === sourceUnitsOn)
      delete win.__vmdeSourceUnitsOn
    if (win.__vmdeSvLocalSpin === local) delete win.__vmdeSvLocalSpin
    if (win.__vmdeSvPlaceCaret === place) delete win.__vmdeSvPlaceCaret
    if (win.__vmdeModeSwitchText === switchText) delete win.__vmdeModeSwitchText
  }
}
