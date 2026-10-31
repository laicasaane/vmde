import Vditor from 'vditor/src/index'
import { installIrMarkerReveal } from '../src/editing/editor-caret'
import {
  caretClientRect,
  installIrPageNavigation,
} from '../src/editing/ir-page-navigation'
import { installCompositionState } from '../src/util/caret-gesture'

// Task 612 — configurable harness for page-key travel near hidden IR markers. Query string:
//   doc    link | code | strong | em | plain | mixed | wlink | wcode   (page-line kind)
//   mode   ir | wysiwyg | sv
//   height editor height in px
//   font   CSS font-family applied to every `.vditor-reset` (empty = content theme default)
//   n      number of page lines
// The real `installIrMarkerReveal` and `main.css` are loaded, so the Task 286 normalizer and the
// Task 369 marker rule behave as in the extension.

installCompositionState()
installIrMarkerReveal()
// `nopatch=1` leaves the native page move alone (the unrepaired baseline of the RED tests).
if (new URLSearchParams(location.search).get('nopatch') !== '1')
  installIrPageNavigation()

const params = new URLSearchParams(location.search)
const kind = params.get('doc') ?? 'link'
const mode = (params.get('mode') ?? 'ir') as 'ir' | 'wysiwyg' | 'sv'
const height = Number(params.get('height') ?? 320)
const font = params.get('font') ?? ''
const count = Number(params.get('n') ?? 60)
const width = params.get('width')

const wrapped = 'wrapped prose '.repeat(40)
const pageLine = (type: string, i: number): string => {
  switch (type) {
    case 'link':
      return `[link-${i}](https://example.com/${i}) tail text ${i}`
    case 'code':
      return `\`code-${i}\` tail text ${i}`
    case 'strong':
      return `**strong-${i}** tail text ${i}`
    case 'em':
      return `*em-${i}* tail text ${i}`
    case 'plain':
      return `plain-${i} tail text ${i}`
    case 'wlink':
      return `[wlink-${i}](https://example.com/${i}) ${wrapped}`
    case 'wcode':
      return `\`wcode-${i}\` ${wrapped}`
    default:
      return pageLine(['link', 'code', 'strong', 'em'][i % 4], i)
  }
}

// `geo`: Task 369 layout fixture (text + collapsed code in a narrow editor); `copy`: one marker line.
const fixtures: Record<string, string> = {
  geo: [
    'geo-aaaa-first-word`codecodecodecode` tail words here',
    'geo-bbbb-second-word`codecodecodecode` tail',
    'geo-c plain line with no code at all',
  ].join('\n\n'),
  copy: 'pre `code` post',
}

const value =
  fixtures[kind] ??
  [
    `anchor-top ${'x'.repeat(40)}`,
    ...Array.from({ length: count }, (_, i) => pageLine(kind, i)),
    `anchor-bottom ${'x'.repeat(40)}`,
  ].join('\n\n')

interface Probe {
  place(where: string): boolean
  measure(): Measurement | null
  modifySteps(dir: 'backward' | 'forward', steps: number): number[]
  copySelection(): { plain: string; html: string }
  surface: HTMLElement
}
interface Measurement {
  docY: number
  x: number
  scrollTop: number
  clientHeight: number
  scrollHeight: number
  lineHeight: number
  container: string
  text: string
  offset: number
  collapsed: boolean
  rectFallback: boolean
  anchorDocY: number
  selected: string
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  height,
  ...(width ? { width: Number(width) } : {}),
  cdn: `${location.origin}/vditor`,
  value,
  after() {
    const inner = (editor as unknown as { vditor: IVditor }).vditor
    const surface = inner[mode].element as HTMLElement
    // The `geo` layout fixture needs the narrow editor to be the text column itself.
    if (width)
      for (const el of document.querySelectorAll<HTMLElement>('.vditor-reset'))
        el.style.padding = '0 4px'
    if (font)
      for (const el of document.querySelectorAll<HTMLElement>('.vditor-reset'))
        el.style.fontFamily = font
    const lineHeight = (): number => {
      const cs = getComputedStyle(surface)
      const lh = Number.parseFloat(cs.lineHeight)
      return Number.isFinite(lh) ? lh : Number.parseFloat(cs.fontSize) * 1.2
    }
    const topOf = (rect: DOMRect) =>
      rect.top - surface.getBoundingClientRect().top + surface.scrollTop

    const findText = (needle: RegExp): Text | null => {
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode())
        if (needle.test((n as Text).data)) return n as Text
      return null
    }
    const blockOf = (node: Node): HTMLElement => {
      let el: Node = node
      while (el.parentNode && el.parentNode !== surface) el = el.parentNode
      return el as HTMLElement
    }
    const visibleTexts = (block: HTMLElement): Text[] => {
      const out: Text[] = []
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text
        if (
          t.data.length &&
          !t.parentElement?.closest('.vditor-ir__marker, [data-render]')
        )
          out.push(t)
      }
      return out
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: measurement helper that places and reads a caret across several document layouts; not product code (Task 612 probe)
    const place = (where: string): boolean => {
      const [target, pos] =
        where === 'anchor-end'
          ? ['anchor-bottom', 'end']
          : where === 'anchor-top-end'
            ? ['anchor-top', 'end']
            : [`-${Math.floor(count / 2)}\\b`, where.replace('mid-', '')]
      const first = findText(new RegExp(target))
      if (!first) return false
      const texts = visibleTexts(blockOf(first))
      if (!texts.length) return false
      let node: Node = texts[0]
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
      if (where === 'mid-elem-end') {
        // An element position at the end of the block: what the Task 286 ejection writes.
        const block = blockOf(first)
        block.scrollIntoView({ block: 'center' })
        const range = document.createRange()
        range.setStart(block, block.childNodes.length)
        range.collapse(true)
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        return true
      }
      if (where === 'anchor-end') surface.scrollTop = surface.scrollHeight
      else if (where === 'anchor-top-end') surface.scrollTop = 0
      else blockOf(first).scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.setStart(node, offset)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      return true
    }

    const measure = (): Measurement | null => {
      const selection = window.getSelection()
      if (!selection?.rangeCount) return null
      const range = selection.getRangeAt(0)
      const focus = document.createRange()
      focus.setStart(selection.focusNode as Node, selection.focusOffset)
      focus.collapse(true)
      const rect = caretClientRect(
        selection.focusNode as Node,
        selection.focusOffset,
        document,
      )
      if (!rect) return null
      const rectFallback = false
      const anchorRange = document.createRange()
      anchorRange.setStart(selection.anchorNode as Node, selection.anchorOffset)
      anchorRange.collapse(true)
      const anchorRect = anchorRange.getClientRects()[0]
      const parent =
        selection.focusNode?.nodeType === Node.TEXT_NODE
          ? selection.focusNode.parentElement
          : (selection.focusNode as Element | null)
      return {
        docY: topOf(rect),
        x: rect.left,
        scrollTop: surface.scrollTop,
        clientHeight: surface.clientHeight,
        scrollHeight: surface.scrollHeight,
        lineHeight: lineHeight(),
        container: parent?.className ?? '',
        text: (selection.focusNode?.textContent ?? '').slice(0, 24),
        offset: selection.focusOffset,
        collapsed: range.collapsed,
        rectFallback,
        anchorDocY: anchorRect ? topOf(anchorRect) : Number.NaN,
        selected: selection.toString().slice(0, 40),
      }
    }

    const modifySteps = (dir: 'backward' | 'forward', steps: number) => {
      const selection = window.getSelection()
      const out: number[] = []
      for (let i = 0; i < steps; i++) {
        selection?.modify('move', dir, 'line')
        out.push(measure()?.docY ?? Number.NaN)
      }
      return out
    }

    // Same synthetic copy the other IR specs use: the handler writes the payload into the transfer.
    const copySelection = (): { plain: string; html: string } => {
      const data = new DataTransfer()
      data.setData('text/plain', '__UNSET__')
      data.setData('text/html', '__UNSET__')
      surface.dispatchEvent(
        new ClipboardEvent('copy', {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      )
      return {
        plain: data.getData('text/plain'),
        html: data.getData('text/html'),
      }
    }
    const probe: Probe = {
      place,
      measure,
      modifySteps,
      copySelection,
      surface,
    }
    ;(window as unknown as { __probe: Probe }).__probe = probe
    ;(window as unknown as { vditor: Vditor }).vditor = editor
    ;(window as unknown as { __ready: boolean }).__ready = true
  },
})
