import type { wf } from '../webview-helpers'

// Task 723 — shared geometry reader for the front-matter properties table. Everything is read in
// the real webview with getBoundingClientRect and getComputedStyle (CSS pixels), then asserted in
// the spec outside the page.

export type Frame = ReturnType<typeof wf>

export interface RowGeometry {
  /** `tr` height. */
  rowH: number
  keyCellW: number
  valueCellW: number
  /** Key cell content box (the property name's own block). */
  nameBlockW: number
  /** Value cell content block height: the text line box of a one-line value. */
  valueLineH: number
  /** Key content block height: the text line box of a one-line name. */
  nameLineH: number
  /** Width of the property name's text as a text range. */
  nameTextW: number
  /** Number of line boxes in the name and value text. */
  nameLines: number
  valueLines: number
  keyButton: { w: number; h: number; left: number; right: number; top: number }
  valueButton: { w: number; h: number }
  /** Distance from the right end of the name text to the left edge of its copy button. */
  nameToButtonGap: number
  /** Distance from the right edge of the copy button to the right edge of the cell. */
  buttonInset: number
  cellPadding: { top: number; bottom: number; left: number; right: number }
  borders: { top: number; bottom: number }
  nameText: string
}

export interface TableGeometry {
  fontSize: number
  fontFamily: string
  lineHeight: string
  tableW: number
  /** Width of the widest `.vmde-front-matter` ancestor content box (the room the table has). */
  hostW: number
  rows: RowGeometry[]
  maxNameTextW: number
}

/** Read the first front-matter table under `scope` (for example `.vditor-ir`). */
export function readGeometry(
  frame: Frame,
  scope: string,
): Promise<TableGeometry> {
  return frame.locator('body').evaluate((_body, sel) => {
    const root = document.querySelector(`${sel} .vmde-front-matter`)
    if (!root) throw new Error(`no front-matter table under ${sel}`)
    const tableEl = root.querySelector('.vmde-front-matter__table') as Element
    const textRange = (el: Element) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      const rects = [...range.getClientRects()]
      const lines = new Set(rects.map((r) => Math.round(r.top)))
      const box = range.getBoundingClientRect()
      return { width: box.width, right: box.right, lines: lines.size }
    }
    const px = (v: string) => Number.parseFloat(v) || 0
    const rows = [...root.querySelectorAll('tr.vmde-front-matter__row')].map(
      (tr) => {
        const key = tr.querySelector('th.vmde-front-matter__key') as HTMLElement
        const value = tr.querySelector(
          'td.vmde-front-matter__value',
        ) as HTMLElement
        const nameBlock = key.querySelector(
          '.vmde-front-matter__content',
        ) as HTMLElement
        const valueBlock = value.querySelector(
          '.vmde-front-matter__content',
        ) as HTMLElement
        const keyBtn = key
          .querySelector('.vmde-front-matter__copy')!
          .getBoundingClientRect()
        const valueBtn = value
          .querySelector('.vmde-front-matter__copy')!
          .getBoundingClientRect()
        const keyRect = key.getBoundingClientRect()
        const name = textRange(nameBlock)
        const value_ = textRange(valueBlock)
        const cs = getComputedStyle(key)
        return {
          rowH: tr.getBoundingClientRect().height,
          keyCellW: keyRect.width,
          valueCellW: value.getBoundingClientRect().width,
          nameBlockW: nameBlock.getBoundingClientRect().width,
          valueLineH: valueBlock.getBoundingClientRect().height,
          nameLineH: nameBlock.getBoundingClientRect().height,
          nameTextW: name.width,
          nameLines: name.lines,
          valueLines: value_.lines,
          keyButton: {
            w: keyBtn.width,
            h: keyBtn.height,
            left: keyBtn.left,
            right: keyBtn.right,
            top: keyBtn.top - keyRect.top,
          },
          valueButton: { w: valueBtn.width, h: valueBtn.height },
          nameToButtonGap: keyBtn.left - name.right,
          buttonInset: keyRect.right - keyBtn.right,
          cellPadding: {
            top: px(cs.paddingTop),
            bottom: px(cs.paddingBottom),
            left: px(cs.paddingLeft),
            right: px(cs.paddingRight),
          },
          borders: {
            top: px(cs.borderTopWidth),
            bottom: px(cs.borderBottomWidth),
          },
          nameText: nameBlock.textContent ?? '',
        }
      },
    )
    const content = root.querySelector(
      '.vmde-front-matter__content',
    ) as HTMLElement
    const cs = getComputedStyle(content)
    return {
      fontSize: px(cs.fontSize),
      fontFamily: cs.fontFamily,
      lineHeight: cs.lineHeight,
      tableW: tableEl.getBoundingClientRect().width,
      hostW: root.getBoundingClientRect().width,
      rows,
      maxNameTextW: Math.max(...rows.map((r) => r.nameTextW)),
    }
  }, scope)
}
