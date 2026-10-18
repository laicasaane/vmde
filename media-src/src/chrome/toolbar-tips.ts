import { t } from '../util/lang'
import { ROW_TIP_ATTRIBUTE } from './toolbar-row-hover'

/**
 * Task 642 — toolbar descriptions. Every top-level button and every authored More and Math row has a
 * short description of what it does, never a key (an extension cannot read the user's rebindings).
 * `aria-label` stays the short name everywhere; the description is a separate channel:
 *  - top-level buttons: `data-vmde-tip` (painted by CSS) plus `aria-description`;
 *  - authored More and Math rows: `data-vmde-row-tip` (shown by toolbar-row-hover.ts as the shared
 *    hover box) plus `aria-description`, because their row text already is the visible name. No
 *    `title`: Chromium paints it in a small system font CSS cannot style.
 * Overflowed controls and the collapse toggle get theirs from the overflow and collapse passes.
 */

/** Item name to its `lang.ts` description key. */
const TIP_KEYS: Readonly<Record<string, string>> = {
  undo: 'tipUndo',
  redo: 'tipRedo',
  headings: 'tipHeadings',
  bold: 'tipBold',
  italic: 'tipItalic',
  underline: 'tipUnderline',
  strike: 'tipStrike',
  'inline-code': 'tipInlineCode',
  subscript: 'tipSubscript',
  superscript: 'tipSuperscript',
  link: 'tipLink',
  list: 'tipList',
  'ordered-list': 'tipOrderedList',
  check: 'tipCheck',
  outdent: 'tipOutdent',
  indent: 'tipIndent',
  quote: 'tipQuote',
  callout: 'tipCallout',
  details: 'tipDetails',
  code: 'tipCode',
  math: 'tipMath',
  table: 'tipTable',
  line: 'tipLine',
  upload: 'tipUpload',
  emoji: 'tipEmoji',
  'insert-before': 'tipInsertBefore',
  'insert-after': 'tipInsertAfter',
  outline: 'tipOutline',
  'navigate-back': 'tipNavigateBack',
  'wiki-pages': 'tipWikiPages',
  'edit-in-vscode': 'tipEditInVsCode',
  preview: 'tipPreview',
  'edit-mode': 'tipEditMode',
  more: 'tipMore',
  'collapse-toolbar': 'tipCollapseToolbar',
  both: 'tipBoth',
  settings: 'tipSettings',
  'insert-anchor': 'tipInsertAnchor',
  'insert-picture': 'tipInsertPicture',
  info: 'tipInfo',
  about: 'tipAbout',
  'math-inline-github': 'tipMathInlineGithub',
  'math-block': 'tipMathBlock',
}

const TOGGLE = 'collapse-toolbar'

export function toolbarTipNames(): string[] {
  return Object.keys(TIP_KEYS)
}

/** The description of an item; throws for a name with none so a typo cannot ship a blank tooltip. */
export function tipFor(name: string): string {
  const key = TIP_KEYS[name]
  if (!key) throw new Error(`"${name}" has no toolbar tip`)
  return t(key)
}

/** The toggle's description for its current state. */
export function collapseToggleTip(collapsed: boolean): string {
  return t(collapsed ? 'tipExpandToolbar' : 'tipCollapseToolbar')
}

function dataType(el: Element): string {
  return el.getAttribute('data-type') ?? ''
}

function setTip(el: HTMLElement, channel: 'data' | 'row', tip: string): void {
  if (channel === 'data') el.setAttribute('data-vmde-tip', tip)
  else el.setAttribute(ROW_TIP_ATTRIBUTE, tip)
  el.setAttribute('aria-description', tip)
}

/**
 * Describe every top-level button and every authored More and Math row in `toolbar`. Idempotent.
 * A control already inside More (an overflowed one) and the collapse toggle are left to the overflow
 * and collapse passes, so no control ever carries two tooltips.
 */
export function applyToolbarTips(toolbar: HTMLElement): void {
  for (const button of toolbar.querySelectorAll<HTMLElement>(
    '.vditor-toolbar__item > [data-type]',
  )) {
    const name = dataType(button)
    if (name === TOGGLE || button.closest('.vditor-hint')) continue
    if (name in TIP_KEYS) setTip(button, 'data', tipFor(name))
  }
  for (const row of toolbar.querySelectorAll<HTMLElement>(
    '.vditor-hint button[data-type]:not(.vditor-tooltipped)',
  )) {
    const name = dataType(row)
    if (name in TIP_KEYS) setTip(row, 'row', tipFor(name))
  }
}

/** Distance from a toolbar edge inside which a tooltip opens inward instead of centred. */
export const TIP_EDGE_BAND_PX = 160

export type TipDirection = '__se' | '__s' | '__sw'

/**
 * Tooltip direction for a button whose centre is at `centre`, between the toolbar's content edges.
 * Within the band of the left edge the tip opens towards the right (`__se`), within the band of the
 * right edge towards the left (`__sw`), else centred under the button (`__s`). When both bands
 * apply (a very narrow toolbar) the nearer edge wins.
 */
export function tipDirection(
  centre: number,
  left: number,
  right: number,
): TipDirection {
  const fromLeft = centre - left
  const fromRight = right - centre
  const nearLeft = fromLeft < TIP_EDGE_BAND_PX
  const nearRight = fromRight < TIP_EDGE_BAND_PX
  if (nearLeft && nearRight) return fromLeft <= fromRight ? '__se' : '__sw'
  if (nearLeft) return '__se'
  if (nearRight) return '__sw'
  return '__s'
}

const DIRECTION_CLASSES = [
  'vditor-tooltipped__s',
  'vditor-tooltipped__se',
  'vditor-tooltipped__sw',
] as const

/**
 * Set the tooltip direction class of every placed top-level button from its measured centre: one
 * read pass, then one write pass. The toggle is always `__sw`. The pass exports no state, so S1c
 * calls it after each changed plan. Buttons inside More show no tooltip and are skipped.
 */
export function applyToolbarTipDirections(toolbar: HTMLElement): void {
  const box = toolbar.getBoundingClientRect()
  const style = getComputedStyle(toolbar)
  const left = box.left + (Number.parseFloat(style.paddingLeft) || 0)
  const right = box.right - (Number.parseFloat(style.paddingRight) || 0)
  const reads: Array<[HTMLElement, TipDirection]> = []
  for (const button of toolbar.querySelectorAll<HTMLElement>(
    '.vditor-toolbar__item > .vditor-tooltipped[data-type]',
  )) {
    if (button.closest('.vditor-hint')) continue
    if (dataType(button) === TOGGLE) {
      reads.push([button, '__sw'])
      continue
    }
    const rect = button.getBoundingClientRect()
    reads.push([
      button,
      tipDirection((rect.left + rect.right) / 2, left, right),
    ])
  }
  for (const [button, direction] of reads) {
    const next = `vditor-tooltipped${direction}`
    if (button.classList.contains(next) && !hasOtherDirection(button, next)) {
      continue
    }
    button.classList.remove(...DIRECTION_CLASSES)
    button.classList.add(next)
  }
}

function hasOtherDirection(button: HTMLElement, keep: string): boolean {
  return DIRECTION_CLASSES.some(
    (name) => name !== keep && button.classList.contains(name),
  )
}
