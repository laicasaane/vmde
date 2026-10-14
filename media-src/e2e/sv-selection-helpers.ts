import { expect } from './coverage-fixture'
import { gotoMouseops, setDoc } from './mouseops-helpers'

type Page = import('@playwright/test').Page

// Shared by the SV selection-edit specs (Tasks 619 and 629) on the mouseops SV harness.

export const ORIGINAL = 'Alpha line\nBravo line\nCharlie line\n'

// Sources are read the way the host receives them: the SV text without Vditor's trailing editable
// newline span.
export const hostSource = (page: Page) =>
  page.evaluate(() => {
    const root = (window as any).__modeEl() as HTMLElement
    const clone = root.cloneNode(true) as HTMLElement
    clone
      .querySelector(
        ':scope > [data-block]:last-child > [data-type="newline"]:last-child',
      )
      ?.remove()
    return (clone.textContent ?? '').replace(/\u200B(?=\n*$)/gu, '')
  })

const undo = (page: Page) =>
  page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.undo(inner)
  })

export async function open(page: Page, source = ORIGINAL) {
  await gotoMouseops(page, 'sv')
  await setDoc(page, source)
  await page.waitForTimeout(900) // past undoDelay: the opening snapshot settles
  expect(await hostSource(page)).toBe(source)
}

export async function undoIsExact(page: Page, source: string) {
  await page.waitForTimeout(900) // record the edit as its own Undo step
  await undo(page)
  await expect.poll(() => hostSource(page)).toBe(source)
}

// Selects source offsets [start, end) of the editor text. A start on a node boundary goes to the start
// of the next node, the shape a drag from a line start produces; an end goes to the end of the earlier node.
export const selectOffsets = (page: Page, start: number, end: number) =>
  page.evaluate(
    ([from, to]) => {
      const el = (window as any).__modeEl() as HTMLElement
      el.focus()
      const nodes: { node: Node; at: number; len: number }[] = []
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
      let acc = 0
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = (n.textContent ?? '').length
        nodes.push({ node: n, at: acc, len })
        acc += len
      }
      const s = nodes.find((x) => x.at + x.len > from)
      const e = nodes.find((x) => x.at + x.len >= to)
      if (!s || !e) throw new Error('offsets out of range')
      const r = document.createRange()
      r.setStart(s.node, from - s.at)
      r.setEnd(e.node, to - e.at)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(r)
      return r.toString()
    },
    [start, end] as const,
  )

export const caretOffset = (page: Page) =>
  page.evaluate(() => {
    const s = getSelection()!
    const el = (window as any).__modeEl() as HTMLElement
    const r = document.createRange()
    r.selectNodeContents(el)
    r.setEnd(s.focusNode!, s.focusOffset)
    return { collapsed: s.isCollapsed, offset: r.toString().length }
  })

export const redo = (page: Page) =>
  page.evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.undo.redo(inner)
  })
