import type { Page } from '@playwright/test'
import {
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from '../webview-helpers'

// Task 612 — shared setup of the real-VS-Code page-navigation specs: the page-line documents, the
// in-webview caret placement and measurement, and the IR editor opener.

export type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
export type HostEvaluator = Parameters<typeof reopenVmdeFixture>[0]

export const FONTS: Record<string, string> = {
  default: '',
  serif: '"DejaVu Serif", serif',
}
export const wrapped = 'wrapped prose '.repeat(40)
export const pageLine = (type: string, i: number): string => {
  switch (type) {
    case 'link':
      return `[link-${i}](https://example.com/${i}) tail text ${i}`
    case 'code':
      return `\`code-${i}\` tail text ${i}`
    case 'strong':
      return `**strong-${i}** tail text ${i}`
    case 'plain':
      return `plain-${i} tail text ${i}`
    case 'wcode':
      return `\`wcode-${i}\` ${wrapped}`
    default:
      return pageLine(['link', 'code', 'strong'][i % 3], i)
  }
}
export const COUNT = 80
export const docFor = (kind: string): string =>
  [
    `anchor-top ${'x'.repeat(40)}`,
    ...Array.from({ length: COUNT }, (_, i) => pageLine(kind, i)),
    `anchor-bottom ${'x'.repeat(40)}`,
  ].join('\n\n')

export const frames = (frame: Frame, count = 2) =>
  frame.locator('body').evaluate(
    (_body, n) =>
      new Promise<void>((resolve) => {
        let left = (n as number) * 2
        const step = () =>
          --left <= 0 ? resolve() : requestAnimationFrame(step)
        requestAnimationFrame(step)
      }),
    count,
  )

// Defines window.__p612 = { place(where, count, font), measure() } inside the webview.
export async function installProbe(frame: Frame, count: number, font: string) {
  await frame.locator('body').evaluate(
    (_body, [n, fontFamily]) => {
      const w = window as any
      const surface = w.vditor.vditor.ir.element as HTMLElement
      if (fontFamily)
        for (const el of document.querySelectorAll<HTMLElement>(
          '.vditor-reset',
        ))
          el.style.fontFamily = fontFamily as string
      const topOf = (rect: DOMRect) =>
        rect.top - surface.getBoundingClientRect().top + surface.scrollTop
      const blockOf = (node: Node): HTMLElement => {
        let el: Node = node
        while (el.parentNode && el.parentNode !== surface) el = el.parentNode
        return el as HTMLElement
      }
      w.__p612 = {
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: measurement helper that places and reads a caret across several document layouts; not product code (Task 612 probe)
        place(where: string) {
          const [target, pos] =
            where === 'anchor-end'
              ? ['anchor-bottom', 'end']
              : where === 'anchor-top-end'
                ? ['anchor-top', 'end']
                : [
                    `-${Math.floor((n as number) / 2)}\\b`,
                    where.replace('mid-', ''),
                  ]
          const walker = document.createTreeWalker(
            surface,
            NodeFilter.SHOW_TEXT,
          )
          let first: Text | null = null
          for (let t = walker.nextNode(); t; t = walker.nextNode())
            if (new RegExp(target).test((t as Text).data)) {
              first = t as Text
              break
            }
          if (!first) return false
          const texts: Text[] = []
          const tw = document.createTreeWalker(
            blockOf(first),
            NodeFilter.SHOW_TEXT,
          )
          for (let t = tw.nextNode(); t; t = tw.nextNode()) {
            const x = t as Text
            if (
              x.data.length &&
              !x.parentElement?.closest('.vditor-ir__marker, [data-render]')
            )
              texts.push(x)
          }
          let node = texts[0]
          let offset = 0
          if (pos === 'end') {
            node = texts[texts.length - 1]
            offset = node.data.length
          } else if (pos === 'mid') {
            const total = texts.reduce((s, t) => s + t.data.length, 0)
            let left = Math.floor(total / 2)
            for (const t of texts) {
              if (left <= t.data.length) {
                node = t
                offset = left
                break
              }
              left -= t.data.length
            }
          }
          surface.focus()
          if (where === 'anchor-end') surface.scrollTop = surface.scrollHeight
          else if (where === 'anchor-top-end') surface.scrollTop = 0
          else blockOf(first).scrollIntoView({ block: 'center' })
          const range = document.createRange()
          range.setStart(node, offset)
          range.collapse(true)
          const selection = getSelection()!
          selection.removeAllRanges()
          selection.addRange(range)
          document.dispatchEvent(new Event('selectionchange'))
          return true
        },
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: measurement helper that places and reads a caret across several document layouts; not product code (Task 612 probe)
        measure() {
          const selection = getSelection()!
          if (!selection.rangeCount) return null
          const focus = document.createRange()
          focus.setStart(selection.focusNode!, selection.focusOffset)
          focus.collapse(true)
          let rect = focus.getClientRects()[0]
          let rectFallback = false
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            const node = selection.focusNode!
            const el =
              node.nodeType === Node.ELEMENT_NODE
                ? (node as Element)
                : node.parentElement
            rect = el!.getBoundingClientRect()
            rectFallback = true
          }
          const cs = getComputedStyle(surface)
          const lh = Number.parseFloat(cs.lineHeight)
          const parent =
            selection.focusNode!.nodeType === Node.TEXT_NODE
              ? selection.focusNode!.parentElement
              : (selection.focusNode as Element)
          return {
            docY: topOf(rect),
            x: rect.left,
            scrollTop: surface.scrollTop,
            clientHeight: surface.clientHeight,
            scrollHeight: surface.scrollHeight,
            lineHeight: Number.isFinite(lh)
              ? lh
              : Number.parseFloat(cs.fontSize) * 1.2,
            container: parent?.className ?? '',
            collapsed: selection.isCollapsed,
            rectFallback,
            selected: selection.toString().length,
            win: `${window.innerWidth}x${window.innerHeight}`,
          }
        },
      }
    },
    [count, font] as [number, string],
  )
}

export const measure = (frame: Frame) =>
  frame.locator('body').evaluate(() => (window as any).__p612.measure())
export const place = (frame: Frame, where: string) =>
  frame
    .locator('body')
    .evaluate((_b, w) => (window as any).__p612.place(w), where)

export async function openIr(
  evaluate: HostEvaluator,
  workbox: Page,
  file: string,
  font: string,
) {
  const frame = await reopenVmdeFixture(
    evaluate,
    workbox,
    file,
    60_000,
    '.vditor',
    false,
  )
  const opened = await waitForE2EReadiness(
    frame,
    (s) => s.routerReady && s.editorEpoch > 0 && s.mode !== null,
    { message: 'Task 612 editor ready' },
  )
  if (opened.mode !== 'ir') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="ir"]').click()
    await waitForE2EReadiness(
      frame,
      (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
      { message: 'Task 612 ir ready' },
    )
  }
  await waitForInitialUndoSnapshot(frame)
  await installProbe(frame, COUNT, FONTS[font])
  return frame
}
