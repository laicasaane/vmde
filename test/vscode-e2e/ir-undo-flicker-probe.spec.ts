import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import {
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

// @probe — IR Undo flicker investigation, part 1. A non-asserting measurement of what one OS-level
// Ctrl+Z (XTEST, through VS Code's keybinding and the host round trip) does to the editor DOM and
// layout after typing or pasting. Each record holds MutationObserver totals, the identity of the
// top-level blocks and of far-away elements, preview re-renders, layout-shift entries, per-frame
// block tops and scrollTop, and the time to settle. The first repetition of each case also captures
// an X screen series (xwd) for a visual check. Excluded from every tier; run with VMDE_PROBES=1 and
// VMDE_XTEST=1 in the isolated Xvfb + Openbox shell. Rows go to $VMDE_PROBE_OUT (default
// tmp/undoflash/rows.jsonl); screen series go next to it under frames/.

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof reopenVmdeFixture>[0]

const OUT =
  process.env.VMDE_PROBE_OUT ??
  path.resolve(__dirname, '../../tmp/undoflash/rows.jsonl')
const FRAMES_DIR = path.join(path.dirname(OUT), 'frames')
const REPEATS = Number(process.env.VMDE_PROBE_REPEATS ?? 5)
const PASTE_WORD = 'pastedword'
const TYPED = 'qzx'

const FIXTURE = [
  '---',
  'title: Undo flicker probe',
  'tags: [probe, undo]',
  '---',
  '',
  '# Undo flicker probe',
  '',
  'Opening paragraph with `inline code` and **bold** text that stays the same.',
  '',
  '## Section one',
  '',
  ...Array.from(
    { length: 4 },
    (_, i) =>
      `Filler paragraph ${i} above the edit site with enough words to wrap across the editor line once or twice.`,
  ).flatMap((p) => [p, '']),
  '- first list item',
  '- second list item with `code`',
  '- third list item',
  '',
  'The middle paragraph MIDPARA is where the caret goes for the first test cases.',
  '',
  '| Name | Value | Note |',
  '| ---- | ----- | ---- |',
  '| alpha | 1 | cellalpha here |',
  '| bravo | 2 | second row |',
  '',
  '```ts',
  'function probe(value: number): number {',
  '  return value * 2',
  '}',
  '```',
  '',
  '```mermaid',
  'graph TD',
  '  A[Undo pressed] --> B{Snapshot}',
  '  B --> C[Restore]',
  '  B --> D[Render]',
  '  C --> E[Caret]',
  '```',
  '',
  '> [!NOTE]',
  '> A callout with a short body line.',
  '',
  '## Section two',
  '',
  ...Array.from(
    { length: 8 },
    (_, i) =>
      `Lower filler paragraph ${i} below the diagram, long enough to make the document scroll in the editor.`,
  ).flatMap((p) => [p, '']),
  'The lower paragraph LOWPARA is the edit site for the scrolled test cases.',
  '',
  ...Array.from(
    { length: 6 },
    (_, i) => `Closing paragraph ${i} after the lower edit site.`,
  ).flatMap((p) => [p, '']),
].join('\n')

// A section of the large-document fixture. Unit `heavyAt` adds math, ECharts and PlantUML blocks
// (all three are reset to unrendered source by Vditor's undo snapshot) right above DEEPPARA.
const largeUnit = (k: number, heavyAt: number) =>
  [
    `## Unit ${k}`,
    '',
    ...Array.from(
      { length: 4 },
      (_, i) =>
        `Unit ${k} paragraph ${i} with \`inline code ${k}\` and **bold** words, long enough to wrap across the editor line at least once.`,
    ).flatMap((p) => [p, '']),
    '| Key | Value |',
    '| --- | ----- |',
    `| unit${k}a | \`code\` value ${k} |`,
    `| unit${k}b | plain value ${k} |`,
    '',
    '```js',
    `const unit${k} = ${k} * 2`,
    '```',
    '',
    `- unit ${k} item one`,
    `- unit ${k} item two`,
    '',
    ...(k === heavyAt
      ? [
          '$$',
          'E = mc^2 + \\sum_{i=1}^{n} x_i',
          '$$',
          '',
          '```echarts',
          '{ "xAxis": { "type": "category", "data": ["a","b","c"] }, "yAxis": { "type": "value" }, "series": [{ "type": "bar", "data": [3, 7, 5] }] }',
          '```',
          '',
          '```plantuml',
          '@startuml',
          'Alice -> Bob: Undo',
          'Bob --> Alice: Restored',
          '@enduml',
          '```',
          '',
          'The deep paragraph DEEPPARA is the edit site of the large-document test cases.',
          '',
        ]
      : []),
  ].join('\n')

// Over the 100 KB content-visibility band (CONTENT_VIS_MIN_CHARS in boot/vditor-init.ts).
const LARGE_FIXTURE = (() => {
  const parts = [FIXTURE]
  for (let k = 1; parts.join('\n\n').length < 110_000; k++)
    parts.push(largeUnit(k, 40))
  return parts.join('\n\n')
})()

// --- In-page probe (self-contained; runs inside the webview) ---

// Defines window.__undoFlash with snapshot(), arm() and result(). arm() records the layout before
// the key, then observes mutations, layout shifts, host messages, Mermaid calls and every animation
// frame until the DOM has been quiet for 800 ms (or 8 s pass).
function installProbe(_body: Element, mode: Mode) {
  const w = window as any
  const inner = () => w.vditor.vditor
  const root = (): HTMLElement => inner()[mode].element as HTMLElement
  const scroller = (): HTMLElement => {
    let el: HTMLElement | null = root()
    while (el) {
      const oy = getComputedStyle(el).overflowY
      if (/auto|scroll/.test(oy) && el.scrollHeight > el.clientHeight) return el
      el = el.parentElement
    }
    return document.scrollingElement as HTMLElement
  }
  const blocks = () => [...root().children] as HTMLElement[]
  const label = (el: Element) => {
    const t = (el.getAttribute('data-type') ?? el.tagName).toLowerCase()
    return `${t}:${(el.textContent ?? '').trim().slice(0, 24)}`
  }
  const far = () => {
    const r = root()
    const pick = (sel: string) => r.querySelector(sel)
    return {
      h1: pick('h1'),
      table: pick('table'),
      codePre: pick('pre code.language-ts, code.language-ts'),
      mermaidHost: pick('.language-mermaid'),
      mermaidSvg: pick('.language-mermaid svg'),
      callout: pick('blockquote'),
      list: pick('ul'),
      lastBlock: r.lastElementChild,
      frontMatter: r.firstElementChild,
    } as Record<string, Element | null>
  }
  // The rendered Mermaid SVG lives in the block's preview; its identity per frame shows a re-render.
  let lastSvg: Element | null = null
  const mermaidState = () => {
    const svg = root().querySelector(
      '[class*="__preview"] .language-mermaid svg, [class*="__preview"] svg[id^="mermaid"]',
    )
    const preview = svg?.closest('[class*="__preview"]')
    const same = svg !== null && svg === lastSvg
    lastSvg = svg
    return {
      svg: !!svg,
      same,
      h: preview ? Math.round(preview.getBoundingClientRect().height) : null,
    }
  }
  const describe = (n: Node | null) => {
    if (!n) return null
    const el = (n.nodeType === 1 ? n : n.parentElement) as Element | null
    if (!el) return n.nodeName
    const cls =
      el.className?.toString?.().split(/\s+/).slice(0, 2).join('.') ?? ''
    const top = [...root().children].find((c) => c.contains(el))
    const idx = top ? [...root().children].indexOf(top) : -1
    return `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}@block${idx}:${(top?.textContent ?? '').trim().slice(0, 16)}`
  }
  // First-row cell widths of up to 3 tables in the viewport (a column reset shows here).
  const cols = () =>
    [...root().querySelectorAll('table')]
      .filter((t) => {
        const r = t.getBoundingClientRect()
        return r.bottom > 0 && r.top < innerHeight
      })
      .slice(0, 3)
      .map((t) =>
        [...(t.rows[0]?.cells ?? [])].map((cell) =>
          Math.round(cell.getBoundingClientRect().width),
        ),
      )
  const tops = () =>
    blocks().map((b) => Math.round(b.getBoundingClientRect().top))
  w.__undoFlash = {
    snapshot() {
      return blocks().map((b) => b.textContent ?? '')
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the in-page instrument must stay self-contained (it is serialized into the webview)
    arm(preEditTexts: string[]) {
      const r = root()
      const sc = scroller()
      const preBlocks = blocks()
      const preFar = far()
      const pre = {
        blockCount: preBlocks.length,
        tops: tops(),
        cols: cols(),
        scrollTop: Math.round(sc.scrollTop),
        scrollHeight: sc.scrollHeight,
        rootHeight: Math.round(r.getBoundingClientRect().height),
        mermaid: mermaidState(),
        labels: preBlocks.map(label),
      }
      const state: any = {
        armedAt: performance.now(),
        epochAtArm: performance.timeOrigin + performance.now(),
        keyAt: null as number | null,
        sentAt: null as number | null,
        preKeyRecords: 0,
        firstMutationAt: null as number | null,
        lastMutationAt: null as number | null,
        mutations: {
          records: 0,
          added: 0,
          removed: 0,
          attributes: 0,
          characterData: 0,
          rootChildListRecords: 0,
          rootRemovedChildren: 0,
          rootAddedChildren: 0,
          outsideRootRecords: 0,
          svgAdded: 0,
          svgAddedAfterFirstBatch: 0,
          targets: {} as Record<string, number>,
        },
        timeline: [] as unknown[],
        shifts: [] as unknown[],
        messages: [] as string[],
        mermaidCalls: 0,
        frames: [] as unknown[],
        done: false,
      }
      const vditorEl = inner().element as HTMLElement
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the in-page instrument must stay self-contained (it is serialized into the webview)
      const classify = (n: Node): string => {
        let el: Node | null = n
        while (el && el.parentNode !== r) {
          if (el === r || !el.parentNode) return el === r ? 'root' : 'detached'
          el = el.parentNode
        }
        return el ? `block${[...r.children].indexOf(el as Element)}` : 'outside'
      }
      const hasSvg = (n: Node) =>
        n.nodeType === 1 &&
        ((n as Element).tagName.toLowerCase() === 'svg' ||
          !!(n as Element).querySelector?.('svg'))
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the in-page instrument must stay self-contained (it is serialized into the webview)
      const mo = new MutationObserver((list) => {
        const now = performance.now()
        // Only mutations after the test sends the key belong to the Undo record.
        if (state.sentAt === null) {
          state.preKeyRecords += list.length
          return
        }
        state.firstMutationAt ??= now
        const firstBatch = now - state.firstMutationAt < 2
        state.lastMutationAt = now
        const m = state.mutations
        let added = 0
        const batchTargets: Record<string, number> = {}
        let removed = 0
        for (const rec of list) {
          m.records++
          if (rec.type === 'attributes') m.attributes++
          if (rec.type === 'characterData') m.characterData++
          m.added += rec.addedNodes.length
          m.removed += rec.removedNodes.length
          added += rec.addedNodes.length
          removed += rec.removedNodes.length
          if (!r.contains(rec.target) && rec.target !== r)
            m.outsideRootRecords++
          if (rec.target === r && rec.type === 'childList') {
            m.rootChildListRecords++
            m.rootRemovedChildren += rec.removedNodes.length
            m.rootAddedChildren += rec.addedNodes.length
          }
          for (const n of rec.addedNodes)
            if (hasSvg(n)) {
              m.svgAdded++
              if (!firstBatch) m.svgAddedAfterFirstBatch++
            }
          const key =
            rec.target === r
              ? 'root'
              : r.contains(rec.target)
                ? classify(rec.target)
                : (rec.target as Element).className
                    ?.toString?.()
                    .slice(0, 40) || rec.target.nodeName
          m.targets[key] = (m.targets[key] ?? 0) + 1
          batchTargets[key] = (batchTargets[key] ?? 0) + 1
        }
        state.timeline.push({
          t: Math.round(now - state.armedAt),
          records: list.length,
          added,
          removed,
          top: Object.entries(batchTargets)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([k, v]) => `${k}=${v}`),
        })
      })
      mo.observe(vditorEl, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      })
      // Mutations outside the editor (outline, gutters, toolbar) are also counted.
      mo.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
      })
      let po: PerformanceObserver | null = null
      try {
        po = new PerformanceObserver((list) => {
          for (const e of list.getEntries() as any[])
            state.shifts.push({
              t: Math.round(e.startTime - state.armedAt),
              value: Number(e.value.toFixed(4)),
              hadRecentInput: e.hadRecentInput,
              sources: (e.sources ?? []).slice(0, 6).map((src: any) => ({
                node: describe(src.node),
                from: [
                  Math.round(src.previousRect.y),
                  Math.round(src.previousRect.height),
                ],
                to: [
                  Math.round(src.currentRect.y),
                  Math.round(src.currentRect.height),
                ],
              })),
            })
        })
        po.observe({ type: 'layout-shift', buffered: false })
      } catch {
        state.shifts.push({ unsupported: true })
      }
      // Every scroll writer during the record: JS calls carry a stack; a scroll event with no JS
      // writer before it is the browser's own (scroll anchoring or clamping).
      state.scrolls = [] as unknown[]
      const stackOf = () =>
        (new Error().stack ?? '')
          .split('\n')
          .slice(2, 9)
          .map((l) => l.trim())
      const since = () =>
        state.firstMutationAt === null
          ? `pre${Math.round(performance.now() - state.armedAt)}`
          : Math.round(performance.now() - state.firstMutationAt)
      const proto = Element.prototype as any
      const restores: (() => void)[] = []
      for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy', 'scroll']) {
        const orig = proto[name]
        proto[name] = function (...a: unknown[]) {
          if (state.sentAt !== null && state.scrolls.length < 40)
            state.scrolls.push({
              t: since(),
              call: name,
              el: describe(this),
              stack: stackOf(),
            })
          return orig.apply(this, a)
        }
        restores.push(() => {
          proto[name] = orig
        })
      }
      const topDesc = Object.getOwnPropertyDescriptor(
        Element.prototype,
        'scrollTop',
      )
      if (topDesc?.set && topDesc.get) {
        const get = topDesc.get
        const set = topDesc.set
        Object.defineProperty(sc, 'scrollTop', {
          configurable: true,
          get() {
            return get.call(this)
          },
          set(v: number) {
            if (state.sentAt !== null && state.scrolls.length < 40)
              state.scrolls.push({
                t: since(),
                call: 'scrollTop=',
                from: Math.round(get.call(this)),
                to: Math.round(v),
                stack: stackOf(),
              })
            set.call(this, v)
          },
        })
        restores.push(() => {
          delete (sc as any).scrollTop
        })
      }
      const onScroll = () => {
        if (state.sentAt !== null && state.scrolls.length < 40)
          state.scrolls.push({
            t: since(),
            event: 'scroll',
            top: Math.round(sc.scrollTop),
          })
      }
      sc.addEventListener('scroll', onScroll)
      restores.push(() => sc.removeEventListener('scroll', onScroll))
      const onKey = (e: KeyboardEvent) => {
        if (
          e.ctrlKey &&
          /^[zy]$/.test(e.key.toLowerCase()) &&
          state.keyAt === null &&
          state.sentAt !== null
        )
          state.keyAt = performance.now()
      }
      const onMessage = (e: MessageEvent) => {
        const c = (e.data as any)?.command
        if (typeof c === 'string')
          state.messages.push(
            `${Math.round(performance.now() - state.armedAt)}:${c}`,
          )
        if (c === 'trigger-toolbar-hotkey' && state.sentAt !== null)
          state.hotkeyMessageAt ??= performance.now()
      }
      window.addEventListener('keydown', onKey, true)
      window.addEventListener('message', onMessage, true)
      // Task 720 Part 2a: where the time from the key to the DOM swap goes. Each wrapper records
      // [start, end] of one call after the key is sent: the history transition (undo/redo, wrapped
      // by the history coupling), Vditor's renderDiff, the diff-match-patch apply, the outer
      // getValue (the coupling's readText), the Lute DOM-to-Markdown calls, and reads and writes
      // of the root's innerHTML.
      state.timed = [] as { n: string; s: number; e: number }[]
      const timedRestores: (() => void)[] = []
      const wrapTimed = (obj: any, name: string, label = name) => {
        if (!obj || typeof obj[name] !== 'function') return
        const orig = obj[name]
        const own = Object.hasOwn(obj, name)
        timedRestores.push(() => {
          if (own) obj[name] = orig
          else delete obj[name]
        })
        obj[name] = function (...a: unknown[]) {
          if (state.sentAt === null) return orig.apply(this, a)
          const start = performance.now()
          try {
            return orig.apply(this, a)
          } finally {
            if (state.timed.length < 80)
              state.timed.push({ n: label, s: start, e: performance.now() })
          }
        }
      }
      const undoEngine = inner().undo
      wrapTimed(undoEngine, 'undo')
      wrapTimed(undoEngine, 'redo')
      wrapTimed(Object.getPrototypeOf(undoEngine), 'renderDiff')
      // The live HTML at arm time and the previous and restored snapshot strings of the first
      // renderDiff after the key, for an offline check of the block comparison (snapshots()).
      state.snap = { live: r.innerHTML, prev: null, next: null }
      {
        const proto = Object.getPrototypeOf(undoEngine)
        const renderDiff = proto.renderDiff
        proto.renderDiff = function (...a: unknown[]) {
          const slot = this[inner().currentMode]
          const first = state.sentAt !== null && state.snap.prev === null
          if (first) state.snap.prev = slot.lastText
          try {
            return renderDiff.apply(this, a)
          } finally {
            if (first) state.snap.next = slot.lastText
          }
        }
        timedRestores.push(() => {
          proto.renderDiff = renderDiff
        })
      }
      wrapTimed(undoEngine.dmp, 'patch_apply')
      wrapTimed(w.vditor, 'getValue')
      for (const name of ['VditorIRDOM2Md', 'VditorDOM2Md', 'SpinVditorIRDOM'])
        wrapTimed(inner().lute, name)
      const htmlDesc = Object.getOwnPropertyDescriptor(
        Element.prototype,
        'innerHTML',
      )
      if (htmlDesc?.get && htmlDesc.set) {
        const getHtml = htmlDesc.get
        const setHtml = htmlDesc.set
        const timedHtml = (label: string, run: () => unknown) => {
          if (state.sentAt === null) return run()
          const start = performance.now()
          try {
            return run()
          } finally {
            if (state.timed.length < 80)
              state.timed.push({ n: label, s: start, e: performance.now() })
          }
        }
        Object.defineProperty(r, 'innerHTML', {
          configurable: true,
          get() {
            return timedHtml('root.innerHTML get', () => getHtml.call(this))
          },
          set(v: string) {
            timedHtml('root.innerHTML set', () => setHtml.call(this, v))
          },
        })
        timedRestores.push(() => {
          delete (r as any).innerHTML
        })
      }
      const mermaid = w.mermaid
      const wrapped: [any, string, any][] = []
      if (mermaid)
        for (const name of ['render', 'run', 'init']) {
          const orig = mermaid[name]
          if (typeof orig === 'function') {
            wrapped.push([mermaid, name, orig])
            mermaid[name] = function (...a: unknown[]) {
              state.mermaidCalls++
              return orig.apply(this, a)
            }
          }
        }
      const sample = () => {
        const now = performance.now()
        if (state.sentAt === null) {
          requestAnimationFrame(sample)
          return
        }
        if (state.firstMutationAt !== null) {
          const sc2 = scroller()
          state.frames.push({
            t: Math.round(now - state.firstMutationAt),
            scrollTop: Math.round(sc2.scrollTop),
            tops: tops(),
            cols: cols(),
            mermaid: mermaidState(),
            pendingPreviews:
              root().querySelectorAll('[data-render="2"]').length,
            expanded: root().querySelectorAll('.vditor-ir__node--expand')
              .length,
            rootHeight: Math.round(root().getBoundingClientRect().height),
            scrollHeight: sc2.scrollHeight,
          })
        }
        const quiet =
          state.lastMutationAt !== null &&
          now - state.lastMutationAt > 800 &&
          state.frames.length >= 20
        if (quiet || now - state.sentAt > 8000) {
          finish()
          return
        }
        requestAnimationFrame(sample)
      }
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the in-page instrument must stay self-contained (it is serialized into the webview)
      const finish = () => {
        mo.disconnect()
        for (const undo of restores) undo()
        po?.disconnect()
        window.removeEventListener('keydown', onKey, true)
        window.removeEventListener('message', onMessage, true)
        for (const [obj, name, orig] of wrapped) obj[name] = orig
        for (const undo of timedRestores.reverse()) undo()
        const postBlocks = blocks()
        const postFar = far()
        const postTexts = postBlocks.map((b) => b.textContent ?? '')
        const changedTexts: number[] = []
        const n = Math.max(postTexts.length, preEditTexts.length)
        for (let i = 0; i < n; i++)
          if (
            (postTexts[i] ?? '').replace(/​/g, '') !==
            (preEditTexts[i] ?? '').replace(/​/g, '')
          )
            changedTexts.push(i)
        const finalTops = tops()
        const frames = state.frames as {
          tops: number[]
          scrollTop: number
          mermaid: any
        }[]
        const maxDelta = (i: number) =>
          Math.max(
            0,
            ...frames.map((f) =>
              Math.abs((f.tops[i] ?? 0) - (pre.tops[i] ?? 0)),
            ),
          )
        const shiftedBlocks = pre.tops
          .map((_, i) => ({
            i,
            max: maxDelta(i),
            final: (finalTops[i] ?? 0) - pre.tops[i],
          }))
          .filter((x) => x.max > 1)
        const sel = getSelection()
        state.result = {
          pre: { ...pre, labels: undefined },
          keyToFirstMutationMs:
            state.keyAt !== null && state.firstMutationAt !== null
              ? Math.round(state.firstMutationAt - state.keyAt)
              : null,
          settleMs:
            state.firstMutationAt !== null && state.lastMutationAt !== null
              ? Math.round(state.lastMutationAt - state.firstMutationAt)
              : null,
          keySeen: state.keyAt !== null,
          sentToFirstMutationMs:
            state.firstMutationAt !== null
              ? Math.round(state.firstMutationAt - state.sentAt)
              : null,
          preKeyRecords: state.preKeyRecords,
          mutations: state.mutations,
          mutationTimeline: state.timeline.slice(0, 40),
          blocksKeptIdentity: preBlocks.filter((b) => b.isConnected).length,
          blocksBefore: preBlocks.length,
          blocksAfter: postBlocks.length,
          farIdentity: Object.fromEntries(
            Object.entries(preFar).map(([k, el]) => [
              k,
              el === null
                ? 'absent'
                : el === postFar[k]
                  ? 'same'
                  : el.isConnected
                    ? 'moved'
                    : 'replaced',
            ]),
          ),
          mermaidCalls: state.mermaidCalls,
          mermaidFramesWithoutSvg: frames.filter((f) => !f.mermaid.svg).length,
          mermaidSvgSwapsAfterFirstFrame: frames
            .slice(1)
            .filter((f) => !f.mermaid.same).length,
          mermaidHeightRange: [
            Math.min(...frames.map((f) => f.mermaid.h ?? 0)),
            Math.max(...frames.map((f) => f.mermaid.h ?? 0)),
          ],
          mermaidPre: pre.mermaid,
          layoutShifts: state.shifts,
          layoutShiftTotal: Number(
            (state.shifts as any[])
              .reduce((s, e) => s + (e.value ?? 0), 0)
              .toFixed(4),
          ),
          scrollTopBefore: pre.scrollTop,
          scrollTopAfter: Math.round(scroller().scrollTop),
          colsBefore: pre.cols,
          colsAfter: cols(),
          colFramesChanged: (state.frames as { cols: number[][] }[]).filter(
            (f) => JSON.stringify(f.cols) !== JSON.stringify(pre.cols),
          ).length,
          scrollTopRange: [
            Math.min(...frames.map((f) => f.scrollTop)),
            Math.max(...frames.map((f) => f.scrollTop)),
          ],
          shiftedBlocks: shiftedBlocks.slice(0, 12),
          shiftedBlockCount: shiftedBlocks.length,
          framesWithAnyShift: frames.filter((f) =>
            f.tops.some((t, i) => Math.abs(t - (pre.tops[i] ?? t)) > 1),
          ).length,
          frameCount: frames.length,
          framesHead: frames.slice(0, 6).map((f: any) => ({
            ...f,
            tops: f.tops.slice(0, 40),
          })),
          changedTextBlocks: changedTexts,
          changedTextLabels: changedTexts
            .slice(0, 5)
            .map((i) => pre.labels[i] ?? `#${i}`),
          caret: sel?.anchorNode
            ? {
                inRoot: root().contains(sel.anchorNode),
                block: classify(sel.anchorNode),
                offset: sel.anchorOffset,
              }
            : null,
          messages: state.messages,
          // Times in ms from the key (the send when no key event was seen).
          breakdown: (() => {
            const base = state.keyAt ?? state.sentAt
            return {
              hotkeyMessage:
                state.hotkeyMessageAt != null
                  ? Math.round(state.hotkeyMessageAt - base)
                  : null,
              firstMutation:
                state.firstMutationAt !== null
                  ? Math.round(state.firstMutationAt - base)
                  : null,
              calls: (state.timed as { n: string; s: number; e: number }[]).map(
                (c) => ({
                  n: c.n,
                  at: Math.round(c.s - base),
                  ms: Math.round((c.e - c.s) * 10) / 10,
                }),
              ),
            }
          })(),
          scrolls: state.scrolls,
          epochAtArm: Math.round(state.epochAtArm),
          epochFirstMutation:
            state.firstMutationAt !== null
              ? Math.round(performance.timeOrigin + state.firstMutationAt)
              : null,
        }
        state.done = true
      }
      w.__undoFlash.state = state
      requestAnimationFrame(sample)
      return { scrollTop: pre.scrollTop, blockCount: pre.blockCount }
    },
    markSent() {
      w.__undoFlash.state.sentAt = performance.now()
    },
    result() {
      const s = w.__undoFlash.state
      return s?.done ? s.result : null
    },
    snapshots() {
      return w.__undoFlash.state?.snap ?? null
    },
  }
}

// Point (relative to the mode root) at the end of `needle` inside the root, or null.
function needlePoint(_body: Element, args: { mode: Mode; needle: string }) {
  const root = (window as any).vditor.vditor[args.mode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const i = n.textContent?.indexOf(args.needle) ?? -1
    if (i < 0) continue
    const range = document.createRange()
    range.setStart(n, i + args.needle.length - 1)
    range.setEnd(n, i + args.needle.length)
    const rect = range.getBoundingClientRect()
    const base = root.getBoundingClientRect()
    if (rect.width === 0 && rect.height === 0) continue
    return {
      x: rect.right - base.left - 1,
      y: rect.top + rect.height / 2 - base.top,
    }
  }
  return null
}

function scrollNeedle(
  _body: Element,
  args: { mode: Mode; needle: string; block?: ScrollLogicalPosition },
) {
  const root = (window as any).vditor.vditor[args.mode].element as HTMLElement
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let el: Element | null = null
  for (let n = walker.nextNode(); n && !el; n = walker.nextNode())
    if (n.textContent?.includes(args.needle)) el = n.parentElement
  el?.scrollIntoView({ block: args.block ?? 'center' })
  return !!el
}

function scrollTopOfDoc(_body: Element, mode: Mode) {
  const root = (window as any).vditor.vditor[mode].element as HTMLElement
  root.firstElementChild?.scrollIntoView({ block: 'start' })
  let el: HTMLElement | null = root
  while (el) {
    if (
      /auto|scroll/.test(getComputedStyle(el).overflowY) &&
      el.scrollHeight > el.clientHeight
    )
      el.scrollTop = 0
    el = el.parentElement
  }
}

const nextFrames = (frame: Frame, count: number) =>
  frame.locator('body').evaluate(
    (_b, n) =>
      new Promise<void>((resolve) => {
        let left = n as number
        const step = () =>
          --left <= 0 ? resolve() : requestAnimationFrame(step)
        requestAnimationFrame(step)
      }),
    count,
  )

const pause = (frame: Frame, ms: number) =>
  frame
    .locator('body')
    .evaluate((_b, d) => new Promise((r) => setTimeout(r, d as number)), ms)

// Captures `count` root-window xwd dumps as fast as the X server allows, each with an epoch-ms stamp.
function startScreenSeries(dir: string, count: number) {
  mkdirSync(dir, { recursive: true })
  const script =
    'i=0; while [ $i -lt "$1" ]; do s=$(date +%s%3N); xwd -root -silent -out "$2/f$(printf %03d $i).xwd"; ' +
    'echo "$i $s $(date +%s%3N)" >> "$2/stamps.txt"; i=$((i+1)); done'
  const child = spawn('sh', ['-c', script, 'sh', String(count), dir], {
    stdio: 'ignore',
    env: process.env,
  })
  return new Promise<void>((resolve) => child.on('exit', () => resolve()))
}

async function openMode(
  evaluate: HostEvaluator,
  workbox: Page,
  file: string,
  mode: Mode,
): Promise<Frame> {
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
    { message: 'undo flicker probe: editor ready', timeout: 60_000 },
  )
  if (opened.mode !== mode) {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(
      frame,
      (s) => s.routerReady && s.editorEpoch > 0 && s.mode === mode,
      { message: `undo flicker probe: ${mode} ready`, timeout: 60_000 },
    )
  }
  await waitForInitialUndoSnapshot(frame)
  if (mode !== 'sv')
    await frame
      .locator(`.vditor-${mode} .language-mermaid svg`)
      .first()
      .waitFor({ timeout: 60_000 })
  await pause(frame, 1500)
  await frame.locator('body').evaluate(installProbe, mode)
  return frame
}

interface Case {
  name: string
  mode: Mode
  needle: string
  action: 'type' | 'paste'
  scrolled: boolean
  /** Pause between the edit and Ctrl+Z; documents of 20 000+ characters use a 2 s undoDelay. */
  editPauseMs?: number
  /** Redo key; VMDE binds Ctrl+Y and Ctrl+Shift+Z to vmde.format.redo. Default ctrl+y. */
  redoKey?: 'ctrl+y' | 'ctrl+shift+z'
}

// In a content-visibility document the scroll position drifts while skipped blocks get their
// real sizes; scroll again until the needle sits inside the visible root.
async function visibleNeedlePoint(frame: Frame, c: Case) {
  let point: { x: number; y: number } | null = null
  for (let i = 0; i < 10; i++) {
    point = await frame
      .locator('body')
      .evaluate(needlePoint, { mode: c.mode, needle: c.needle })
    const visible = await frame
      .locator('body')
      .evaluate(
        (_b, a) =>
          ((window as any).vditor.vditor[a.mode].element as HTMLElement)
            .clientHeight,
        { mode: c.mode },
      )
    if (point && point.y > 10 && point.y < visible - 10) break
    await frame
      .locator('body')
      .evaluate(scrollNeedle, { mode: c.mode, needle: c.needle })
    await pause(frame, 400)
  }
  return point
}

async function placeView(frame: Frame, c: Case) {
  if (c.scrolled)
    await frame
      .locator('body')
      .evaluate(scrollNeedle, { mode: c.mode, needle: c.needle })
  else {
    await frame.locator('body').evaluate(scrollTopOfDoc, c.mode)
    // A table cell or an SV source line can sit below the fold even at the document top.
    await frame.locator('body').evaluate(scrollNeedle, {
      mode: c.mode,
      needle: c.needle,
      block: 'nearest',
    })
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one sequential probe scenario (edit, Undo record, Redo record, reset); splitting it hides the order
async function runCase(
  frame: Frame,
  xtest: XtestInput,
  c: Case,
  rep: number,
  capture: boolean,
) {
  await placeView(frame, c)
  await pause(frame, 400)
  const preEdit = await snapshotTexts(frame)
  const point = await visibleNeedlePoint(frame, c)
  if (!point) {
    appendFileSync(
      OUT,
      `${JSON.stringify({ case: c.name, rep, error: 'needle not found' })}\n`,
    )
    return
  }
  const rootSel =
    c.mode === 'sv' ? '.vditor-sv' : `.vditor-${c.mode} .vditor-reset`
  await frame.locator(rootSel).first().click({ position: point })
  await pause(frame, 250)
  if (c.action === 'type') await xtest.type(TYPED)
  else await xtest.key('ctrl+v')
  // Past Vditor's 800 ms undoDelay and the 250 ms edit publish, so their DOM work (the snapshot's
  // caret marker, the after-render pass) is not counted as part of the Undo record.
  await pause(frame, c.editPauseMs ?? 1200)
  const edited = await documentHas(
    frame,
    c.action === 'type' ? TYPED : PASTE_WORD,
  )
  const postEdit = await snapshotTexts(frame)
  const needle = c.action === 'type' ? TYPED : PASTE_WORD
  const frames = capture ? (c.editPauseMs ? 110 : 45) : 0
  const undo = await recordHistoryKey(
    frame,
    xtest,
    'ctrl+z',
    preEdit,
    frames ? path.join(FRAMES_DIR, `${c.name}-r${rep}`) : null,
    frames,
  )
  const restored = !(await documentHas(frame, needle))
  appendFileSync(
    OUT,
    `${JSON.stringify({ case: c.name, op: 'undo', mode: c.mode, action: c.action, scrolled: c.scrolled, rep, edited, restored, ...undo, capture })}\n`,
  )
  // Task 720 Part 1b: Redo the same step with the real key, then Undo it again so every repetition
  // starts from the same text. The Redo record compares blocks with the post-edit text.
  await pause(frame, c.editPauseMs ?? 1200)
  const redoKey = c.redoKey ?? 'ctrl+y'
  const redo = await recordHistoryKey(
    frame,
    xtest,
    redoKey,
    postEdit,
    frames ? path.join(FRAMES_DIR, `${c.name}-redo-r${rep}`) : null,
    frames,
  )
  const reapplied = await documentHas(frame, needle)
  appendFileSync(
    OUT,
    `${JSON.stringify({ case: c.name, op: 'redo', key: redoKey, mode: c.mode, action: c.action, scrolled: c.scrolled, rep, reapplied, ...redo, capture })}\n`,
  )
  await pause(frame, c.editPauseMs ?? 1200)
  await xtest.key('ctrl+z')
  await pause(frame, c.editPauseMs ? 3000 : 1200)
}

const snapshotTexts = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).__undoFlash.snapshot()) as Promise<string[]>

const documentHas = (frame: Frame, needle: string) =>
  frame
    .locator('body')
    .evaluate(
      (_b, n) =>
        ((window as any).vditor.getValue() as string).includes(n as string),
      needle,
    ) as Promise<boolean>

// Arms the in-page probe, sends one history key through XTEST and returns the probe record.
async function recordHistoryKey(
  frame: Frame,
  xtest: XtestInput,
  key: string,
  expectedTexts: string[],
  seriesDir: string | null,
  seriesFrames: number,
) {
  const armed = await frame
    .locator('body')
    .evaluate((_b, t) => (window as any).__undoFlash.arm(t), expectedTexts)
  const series = seriesDir ? startScreenSeries(seriesDir, seriesFrames) : null
  await frame
    .locator('body')
    .evaluate(() => (window as any).__undoFlash.markSent())
  await xtest.key(key)
  let result: unknown = null
  for (let i = 0; i < 60 && result === null; i++) {
    await pause(frame, 200)
    result = await frame
      .locator('body')
      .evaluate(() => (window as any).__undoFlash.result())
  }
  await series
  if (seriesDir)
    writeFileSync(
      `${seriesDir}.snap.json`,
      JSON.stringify(
        await frame
          .locator('body')
          .evaluate(() => (window as any).__undoFlash.snapshots()),
      ),
    )
  return { armed, result }
}

async function runCases(
  evaluate: HostEvaluator,
  workbox: Page,
  electronApp: Parameters<typeof createXtestInput>[0],
  baseDir: string,
  mode: Mode,
  cases: Case[],
  repeats: number,
  fixture = FIXTURE,
) {
  const file = path.join(
    baseDir,
    `undoflash-${mode}${fixture === FIXTURE ? '' : '-large'}.md`,
  )
  writeFileSync(file, fixture)
  await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    [PASTE_WORD] as [string],
  )
  const frame = await openMode(evaluate, workbox, file, mode)
  const xtest = await createXtestInput(electronApp, workbox)
  // The first XTEST Ctrl chord of a session sometimes never reaches the webview
  // (undo-first-edit.spec.ts header); send one to the untouched, settled document first.
  await xtest.key('ctrl+z')
  await pause(frame, 800)
  for (const c of cases)
    for (let rep = 0; rep < repeats; rep++)
      await runCase(frame, xtest, c, rep, rep === 0)
  await nextFrames(frame, 2)
}

test.describe('@probe IR Undo flicker', () => {
  test.beforeAll(() => {
    mkdirSync(path.dirname(OUT), { recursive: true })
  })

  test('@probe IR: type or paste then OS Ctrl+Z', async ({
    electronApp,
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.skip(
      process.env.VMDE_XTEST !== '1' || !process.env.VMDE_PROBES,
      'Requires isolated Xvfb + Openbox, VMDE_XTEST=1 and VMDE_PROBES=1',
    )
    test.setTimeout(1_800_000)
    const cases: Case[] = [
      {
        name: 'ir-type-mid',
        mode: 'ir',
        needle: 'MIDPARA',
        action: 'type',
        scrolled: false,
      },
      {
        name: 'ir-paste-mid',
        mode: 'ir',
        needle: 'MIDPARA',
        action: 'paste',
        scrolled: false,
      },
      {
        name: 'ir-type-scrolled',
        mode: 'ir',
        needle: 'LOWPARA',
        action: 'type',
        scrolled: true,
      },
      {
        name: 'ir-paste-scrolled',
        mode: 'ir',
        needle: 'LOWPARA',
        action: 'paste',
        scrolled: true,
      },
      {
        name: 'ir-type-mid-shiftz',
        mode: 'ir',
        needle: 'MIDPARA',
        action: 'type',
        scrolled: false,
        redoKey: 'ctrl+shift+z',
      },
      {
        name: 'ir-type-cell',
        mode: 'ir',
        needle: 'cellalpha',
        action: 'type',
        scrolled: false,
      },
      {
        name: 'ir-paste-cell',
        mode: 'ir',
        needle: 'cellalpha',
        action: 'paste',
        scrolled: false,
      },
    ]
    await runCases(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      electronApp,
      baseDir,
      'ir',
      cases,
      REPEATS,
    )
  })

  test('@probe IR large document: type then OS Ctrl+Z', async ({
    electronApp,
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.skip(
      process.env.VMDE_XTEST !== '1' || !process.env.VMDE_PROBES,
      'Requires isolated Xvfb + Openbox, VMDE_XTEST=1 and VMDE_PROBES=1',
    )
    test.setTimeout(1_800_000)
    const large = { mode: 'ir', action: 'type', editPauseMs: 2600 } as const
    await runCases(
      evaluateInVSCode as HostEvaluator,
      workbox as Page,
      electronApp,
      baseDir,
      'ir',
      [
        {
          ...large,
          name: 'ir-large-type-mid',
          needle: 'MIDPARA',
          scrolled: false,
        },
        {
          ...large,
          name: 'ir-large-type-deep',
          needle: 'DEEPPARA',
          scrolled: true,
        },
        {
          ...large,
          name: 'ir-large-type-deep-cell',
          needle: 'unit41a',
          scrolled: true,
        },
      ],
      REPEATS,
      LARGE_FIXTURE,
    )
  })

  for (const mode of ['wysiwyg', 'sv'] as const)
    test(`@probe ${mode}: type then OS Ctrl+Z (comparison)`, async ({
      electronApp,
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.skip(
        process.env.VMDE_XTEST !== '1' || !process.env.VMDE_PROBES,
        'Requires isolated Xvfb + Openbox, VMDE_XTEST=1 and VMDE_PROBES=1',
      )
      test.setTimeout(900_000)
      await runCases(
        evaluateInVSCode as HostEvaluator,
        workbox as Page,
        electronApp,
        baseDir,
        mode,
        [
          {
            name: `${mode}-type-mid`,
            mode,
            needle: 'MIDPARA',
            action: 'type',
            scrolled: false,
          },
        ],
        REPEATS,
      )
    })
})
