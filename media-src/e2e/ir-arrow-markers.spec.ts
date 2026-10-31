import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import {
  installSelectionPerformanceProbe,
  type SelectionPerformanceProbeResult,
} from '../../test/vscode-e2e/selection-performance-probe'
import { expect, test } from './coverage-fixture'

// Task 648 — ArrowLeft/ArrowRight (and Shift+Arrow) move one source character per press through the
// revealed Markdown markers of an inline node in IR. Keys are Playwright keys (browser level); the
// OS-level proof is test/vscode-e2e/ir-arrow-markers.spec.ts.
//
// Source offset (settled in the Task 648 handoff): the number of text characters of the block before
// a caret position, counting marker text and content, excluding text inside `[data-render]` or
// `.vditor-ir__preview` and excluding U+200B. Highlight, superscript and subscript syntax is off by
// default in VMDE, so those documents enable it through the Lute instance before `setValue`.
//
// Documented rendered-element stops: the native caret also stops before/after a rendered `<img>`
// and at the rendered `<kbd>` box, and at the ZWSP that Vditor appends after a footnote reference.
// Those are repeated offsets, not markers, and are listed per case as `extraRight`/`extraLeft`.
// Decision 5 as amended in Task 648 (R1): equal-source-offset native stops at element boundaries,
// including the nested inline code in strong and the footnote reference, are accepted like the
// `<img>`/`<kbd>` stops and are not repaired. Every marker character stays reachable.

const call = <T>(page: Page, fn: string, ...args: unknown[]) =>
  page.evaluate(
    ([name, rest]) => (window as any)[name as string](...(rest as unknown[])),
    [fn, args] as const,
  ) as Promise<T>

const frames = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  )

async function open(page: Page, url = '/marker-reveal.html') {
  await page.goto(url)
  await page.waitForFunction(() => (window as any).__ready === true)
}

interface DocOptions {
  syntax?: boolean
  /** Extra paragraphs after the probe paragraph (link/footnote definitions, neighbours). */
  tail?: string[]
}

/** Replace the document; the first block is the probe paragraph. Returns the stored value. */
async function setDoc(page: Page, source: string, options: DocOptions = {}) {
  const markdown = [source, ...(options.tail ?? [])].join('\n\n')
  const value = await page.evaluate(
    ([text, syntax]) => {
      const editor = (window as any).vditor
      if (syntax) {
        const lute = editor.vditor.lute
        lute.SetMark(true)
        lute.SetSup(true)
        lute.SetSub(true)
      }
      editor.setValue(text)
      return editor.getValue() as string
    },
    [markdown, options.syntax === true] as const,
  )
  await frames(page)
  return value
}

// Install the in-page offset helpers once per page.
async function installOffsets(page: Page) {
  await page.evaluate(() => {
    const w = window as any
    const block = (node: Node): HTMLElement | null => {
      const el = node instanceof Element ? node : node.parentElement
      return (
        el?.closest<HTMLElement>('.vditor-reset > p, .vditor-reset > h1') ??
        el?.closest<HTMLElement>('.vditor-sv') ??
        null
      )
    }
    w.__offsetOf = (node: Node, offset: number): number => {
      const root = block(node)
      if (!root) return -9
      const prefix = document.createRange()
      prefix.setStart(root, 0)
      prefix.setEnd(node, offset)
      const fragment = prefix.cloneContents()
      let length = 0
      const walker = document.createTreeWalker(fragment, NodeFilter.SHOW_TEXT)
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (
          (t.parentElement as Element | null)?.closest(
            '[data-render], .vditor-ir__preview',
          )
        )
          continue
        length += (t as Text).data.replace(/​/g, '').length
      }
      return length
    }
    w.__caretState = () => {
      const s = window.getSelection()
      if (!s?.rangeCount || !s.anchorNode || !s.focusNode) return null
      const el =
        s.focusNode instanceof Element ? s.focusNode : s.focusNode.parentElement
      return {
        anchor: w.__offsetOf(s.anchorNode, s.anchorOffset) as number,
        focus: w.__offsetOf(s.focusNode, s.focusOffset) as number,
        inMarker: Boolean(el?.closest('.vditor-ir__marker')),
        expanded: document.querySelectorAll('.vditor-ir__node--expand').length,
      }
    }
    // Caret at the end of the text just before the first inline node of block `index`, so the
    // following key presses cross that node's markers.
    w.__placeBeforeFirstNode = (index: number) => {
      const root = document.querySelector('.vditor-ir .vditor-reset')!
      const target = root.children[index]!
      const node = target.querySelector('.vditor-ir__node:not([data-block])')!
      ;(root as HTMLElement).focus()
      const range = document.createRange()
      const before = node.previousSibling
      if (before instanceof Text) range.setStart(before, before.data.length)
      else
        range.setStart(
          node.parentNode!,
          [...node.parentNode!.childNodes].indexOf(node as ChildNode),
        )
      range.collapse(true)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(range)
    }
    // Caret at the start of block `index`, as an element position (what Home leaves behind).
    w.__placeBlockStart = (index: number) => {
      const root = document.querySelector('.vditor-ir .vditor-reset')!
      const target = root.children[index]!
      ;(root as HTMLElement).focus()
      const range = document.createRange()
      range.setStart(target, 0)
      range.collapse(true)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(range)
    }
  })
}

const caret = (page: Page) =>
  call<{
    anchor: number
    focus: number
    inMarker: boolean
    expanded: number
  } | null>(page, '__caretState')

async function press(page: Page, key: string) {
  await page.keyboard.press(key)
  await frames(page)
}

async function walk(page: Page, key: string, count: number) {
  const seen: number[] = []
  for (let i = 0; i < count; i++) {
    await press(page, key)
    seen.push((await caret(page))?.focus ?? -99)
  }
  return seen
}

/** 1..n with the listed offsets repeated once (the documented rendered-element stops). */
const ascending = (n: number, extra: number[] = []) =>
  Array.from({ length: n }, (_, i) => i + 1).flatMap((v) =>
    extra.includes(v) ? [v, v] : [v],
  )
const descending = (n: number, extra: number[] = []) =>
  Array.from({ length: n }, (_, i) => n - 1 - i).flatMap((v) =>
    extra.includes(v) ? [v, v] : [v],
  )

interface WalkCase {
  name: string
  source: string
  tail?: string[]
  syntax?: boolean
  extraRight?: number[]
  extraLeft?: number[]
}

// Acceptance 2: every construct of the Task 648 handoff table, nested and adjacent cases included.
const CASES: WalkCase[] = [
  { name: 'strong **', source: '**Confirm**' },
  { name: 'strong in text', source: 'a **b** c' },
  { name: 'strong __', source: 'a __b__ c' },
  { name: 'emphasis *', source: 'a *b* c' },
  { name: 'emphasis _', source: 'a _b_ c' },
  { name: 'strikethrough', source: 'a ~~b~~ c' },
  { name: 'inline code', source: 'a `b` c' },
  { name: 'inline code, double backtick', source: 'a ``b`` c' },
  { name: 'inline code at the paragraph end', source: 'x `end`' },
  { name: 'link', source: 'a [t](u) c' },
  {
    name: 'link reference',
    source: 'a [t][r] c',
    tail: ['[r]: https://example.com'],
  },
  {
    name: 'image',
    source: 'a ![i](u) c',
    extraRight: [9],
    extraLeft: [9],
  },
  { name: 'highlight', source: 'a ==m== c', syntax: true },
  { name: 'superscript', source: 'a ^s^ c', syntax: true },
  { name: 'subscript', source: 'a ~s~ c', syntax: true },
  { name: 'inline math', source: 'a $x$ c' },
  {
    name: 'footnote reference',
    source: 'a [^1] c',
    tail: ['[^1]: note'],
    extraRight: [6],
    extraLeft: [6],
  },
  {
    name: 'inline HTML tags',
    source: 'a <kbd>k</kbd> c',
    extraRight: [8],
  },
  { name: 'nested strong in emphasis', source: '***both***' },
  { name: 'nested link in strong', source: '**[l](u)**' },
  // Chromium also stops where the inner code node's text nodes meet the outer markers (equal
  // source offsets across element boundaries), like the image and <kbd> stops above.
  {
    name: 'nested code in strong',
    source: '**`co`**',
    extraRight: [2, 3, 5, 6],
    extraLeft: [6, 5, 3, 2],
  },
  { name: 'adjacent strong and emphasis', source: '**a**_b_' },
]

for (const c of CASES) {
  test(`walk: ${c.name} — ArrowRight steps through every offset, ArrowLeft returns`, async ({
    page,
  }) => {
    await open(page)
    await installOffsets(page)
    await setDoc(page, c.source, { syntax: c.syntax, tail: c.tail })
    await call(page, '__placeBlockStart', 0)
    await frames(page)
    expect((await caret(page))?.focus).toBe(0)

    const n = c.source.length
    const right = ascending(n, c.extraRight)
    expect(await walk(page, 'ArrowRight', right.length)).toEqual(right)
    const left = descending(n, c.extraLeft)
    expect(await walk(page, 'ArrowLeft', left.length)).toEqual(left)
  })
}

// Instrument controls (Task 648 S2): the walk helpers must see real key movement. A plain paragraph
// walks 1,2,3 and back; and in `**Confirm**` a caret that starts inside the revealed content
// (offset 5, after "Con") walks through the content and the closing markers on unchanged code up to
// the node edge, so the all-zero walk from offset 0 is the marker trap, not a dead key reader.
test('instrument control: a plain paragraph walks 1,2,3 and back', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, 'abc')
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  expect(await walk(page, 'ArrowRight', 3)).toEqual([1, 2, 3])
  expect(await walk(page, 'ArrowLeft', 3)).toEqual([2, 1, 0])
})

test('instrument control: from inside **Confirm** the keys move the caret through the content', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, '**Confirm**')
  await page.evaluate(() => {
    const strong = document.querySelector('.vditor-ir strong')!
    const text = strong.firstChild as Text
    ;(document.querySelector('.vditor-ir .vditor-reset') as HTMLElement).focus()
    const range = document.createRange()
    range.setStart(text, 3)
    range.collapse(true)
    const s = window.getSelection()!
    s.removeAllRanges()
    s.addRange(range)
  })
  await frames(page)
  await page.waitForTimeout(150)
  expect((await caret(page))?.focus).toBe(5)
  const right = await walk(page, 'ArrowRight', 4)
  const left = await walk(page, 'ArrowLeft', 4)
  console.log(
    'task648 instrument control Confirm',
    JSON.stringify({ right, left }),
  )
  // Content steps are reachable: the walk leaves offset 5 for the next content offsets.
  expect(right.slice(0, 3)).toEqual([6, 7, 8])
  expect(left.slice(0, 3)).toEqual([8, 7, 6])
})

// Control: the HTML entity source is a `--pre` marker, which the normalizer already skips. Its walk
// must be one step or none per press and reach both ends; exact stops are not pinned.
test('walk control: HTML entity source stays monotonic and reaches both ends', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, 'a &amp; c')
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  const n = 'a &amp; c'.length
  const right = await walk(page, 'ArrowRight', n + 3)
  right.forEach((v, i) => {
    expect(v - (right[i - 1] ?? 0)).toBeGreaterThanOrEqual(0)
    expect(v - (right[i - 1] ?? 0)).toBeLessThanOrEqual(1)
  })
  expect(Math.max(...right)).toBe(n)
  const left = await walk(page, 'ArrowLeft', n + 3)
  expect(Math.min(...left)).toBe(0)
})

// Acceptance 3: Shift+Arrow covers the expected source ranges and keeps the focus node revealed.
for (const source of ['**Confirm**', 'a **b** c']) {
  test(`shift: ${source} — Shift+ArrowRight/Left select one source character per press`, async ({
    page,
  }) => {
    await open(page)
    await installOffsets(page)
    await setDoc(page, source)
    await call(page, '__placeBlockStart', 0)
    await frames(page)
    const n = source.length

    for (let k = 1; k <= n; k++) {
      await press(page, 'Shift+ArrowRight')
      const s = await caret(page)
      expect({ k, anchor: s?.anchor, focus: s?.focus }).toEqual({
        k,
        anchor: 0,
        focus: k,
      })
      // From the first marker character on, the node under the focus is revealed.
      if (k >= source.indexOf('*') + 1 && k <= source.lastIndexOf('*') + 1)
        expect((await caret(page))?.expanded).toBeGreaterThan(0)
    }

    await press(page, 'End')
    for (let k = 1; k <= n; k++) {
      await press(page, 'Shift+ArrowLeft')
      const s = await caret(page)
      expect({ k, anchor: s?.anchor, focus: s?.focus }).toEqual({
        k,
        anchor: n,
        focus: n - k,
      })
    }
  })
}

// Decision 4: the node at the fixed end (the anchor) stays revealed while the selection extends out
// of it, also after the dwell that would collapse a node nothing keeps alive.
test('shift: a node holding the anchor stays revealed while the selection extends out of it', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, 'a **b** c')
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  expect(await walk(page, 'ArrowRight', 5)).toEqual([1, 2, 3, 4, 5])
  for (let k = 1; k <= 4; k++) {
    await press(page, 'Shift+ArrowRight')
    const s = await caret(page)
    expect({ anchor: s?.anchor, focus: s?.focus }).toEqual({
      anchor: 5,
      focus: 5 + k,
    })
    expect(s?.expanded).toBeGreaterThan(0)
  }
  await page.waitForTimeout(250)
  expect((await caret(page))?.expanded).toBe(1)
})

// Acceptance 4: typing at every reachable offset writes at that source offset. The one-step Undo is
// proven in real VS Code (test/vscode-e2e/ir-arrow-markers.spec.ts): this harness does not wire
// Vditor's Undo (Ctrl+Z leaves even a plain-paragraph edit in place), so it cannot show it.
test('typing: `x` lands at each offset of **Confirm** (host text)', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const source = '**Confirm**'
  await open(page)
  await installOffsets(page)
  // The value Lute stores for each expected string, so a normalizing round trip does not hide a
  // correct caret (handoff decision 7). Recorded in the test output when it differs.
  const expected: string[] = []
  for (let k = 0; k <= source.length; k++) {
    const typed = source.slice(0, k) + 'x' + source.slice(k)
    expected.push(await setDoc(page, typed))
  }
  await setDoc(page, source)
  const differing = expected
    .map((v, k) => ({ k, v }))
    .filter(({ k, v }) => v !== source.slice(0, k) + 'x' + source.slice(k))
  if (differing.length) console.log('lute round trip differs', differing)

  for (let k = 0; k <= source.length; k++) {
    await setDoc(page, source)
    await call(page, '__placeBlockStart', 0)
    await frames(page)
    for (let i = 0; i < k; i++) await press(page, 'ArrowRight')
    expect((await caret(page))?.focus, `caret before typing at ${k}`).toBe(k)
    await page.keyboard.type('x')
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()), {
        message: `typing at offset ${k}`,
      })
      .toBe(expected[k])
  }
})

test('typing: `x` inside the URL marker of a link lands at that offset', async ({
  page,
}) => {
  const source = 'a [t](url) c'
  await open(page)
  await installOffsets(page)
  const typed = source.slice(0, 8) + 'x' + source.slice(8)
  const expected = await setDoc(page, typed)
  await setDoc(page, source)
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  for (let i = 0; i < 8; i++) await press(page, 'ArrowRight')
  expect((await caret(page))?.focus).toBe(8)
  await page.keyboard.type('x')
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
    .toBe(expected)
})

// Acceptance 5: entering reveals the node, leaving past the last marker hides it again.
test('reveal: entering from the text before reveals the node, leaving collapses it after the dwell', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, 'a **b** c')
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  expect((await caret(page))?.expanded).toBe(0)

  expect(await walk(page, 'ArrowRight', 2)).toEqual([1, 2])
  expect((await caret(page))?.expanded).toBe(1)
  // Through both marker characters, the content, and out past the closing marker.
  expect(await walk(page, 'ArrowRight', 6)).toEqual([3, 4, 5, 6, 7, 8])
  expect((await caret(page))?.expanded).toBe(1)
  expect(await walk(page, 'ArrowRight', 1)).toEqual([9])
  await page.waitForTimeout(250)
  expect((await caret(page))?.expanded).toBe(0)
})

// Acceptance 6: other navigation keeps today's behaviour.
test('control: ArrowDown into a line that starts with a node lands outside its marker', async ({
  page,
}) => {
  await open(page)
  await installOffsets(page)
  await setDoc(page, 'plain line here', { tail: ['**bold** tail'] })
  await call(page, '__placeBlockStart', 0)
  await frames(page)
  await walk(page, 'ArrowRight', 3)
  await press(page, 'ArrowDown')
  const s = await page.evaluate(() => {
    const sel = window.getSelection()!
    const el =
      sel.focusNode instanceof Element
        ? sel.focusNode
        : sel.focusNode!.parentElement!
    return {
      block: el.closest('.vditor-reset > p')?.textContent,
      inMarker: Boolean(el.closest('.vditor-ir__marker')),
    }
  })
  expect(s.block).toContain('bold')
  expect(s.inMarker).toBe(false)
})

for (const sample of [
  { source: '**home-bold** tail', typed: 'X**home-bold** tail', key: 'Home' },
  { source: 'tail **end-bold**', typed: 'tail **end-bold**X', key: 'End' },
]) {
  test(`control: ${sample.key} on ${sample.source} reveals the marker before typing`, async ({
    page,
  }) => {
    await open(page)
    await installOffsets(page)
    await setDoc(page, sample.source)
    await call(page, '__placeBlockStart', 0)
    await frames(page)
    await press(page, sample.key)
    await page.waitForTimeout(150)
    await page.keyboard.type('X')
    await expect
      .poll(() => page.evaluate(() => (window as any).vditor.getValue()))
      .toContain(sample.typed)
  })
}

// WYSIWYG and SV keep their own arrow behaviour: the per-press source offsets of `a **b** c` are
// recorded from the unchanged code and must be identical after the fix.
for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`control: ${mode} ArrowRight walk through a **b** c is unchanged`, async ({
    page,
  }) => {
    await open(page, `/details.html?mode=${mode}`)
    await installOffsets(page)
    await page.evaluate(() => {
      const editor = (window as any).__details?.editor ?? (window as any).vditor
      editor.setValue('a **b** c')
    })
    await frames(page)
    const seen = await page.evaluate(async (m) => {
      const root = document.querySelector<HTMLElement>(
        m === 'sv' ? '.vditor-sv' : '.vditor-wysiwyg .vditor-reset',
      )!
      root.focus()
      const start = (root.querySelector('p') ?? root) as HTMLElement
      const range = document.createRange()
      range.setStart(start, 0)
      range.collapse(true)
      const s = window.getSelection()!
      s.removeAllRanges()
      s.addRange(range)
      return start.tagName
    }, mode)
    expect(seen.length).toBeGreaterThan(0)
    const steps: number[] = []
    for (let i = 0; i < 9; i++) {
      await press(page, 'ArrowRight')
      steps.push(
        await page.evaluate(() => {
          const sel = window.getSelection()!
          const el =
            sel.focusNode instanceof Element
              ? sel.focusNode
              : sel.focusNode!.parentElement!
          const root =
            el.closest('p') ?? el.closest<HTMLElement>('.vditor-sv') ?? el
          const r = document.createRange()
          r.setStart(root, 0)
          r.setEnd(sel.focusNode!, sel.focusOffset)
          return r.toString().replace(/​/g, '').length
        }),
      )
    }
    expect(steps).toEqual(WYSIWYG_SV_WALK[mode])
  })
}

// Recorded from unchanged code in the Task 648 S1 run (see the step report).
const WYSIWYG_SV_WALK: Record<'wysiwyg' | 'sv', number[]> = {
  wysiwyg: [1, 2, 3, 4, 5, 5, 5, 5, 5],
  sv: [1, 2, 3, 4, 5, 6, 7, 8, 9],
}

// Acceptance 7 baseline: key handling on a large document stays within the Task 574/573 budgets.
test('performance: ArrowRight and Shift+ArrowRight on a large IR document stay within budget', async ({
  page,
}) => {
  test.setTimeout(240_000)
  const large = readFileSync(
    path.join(
      __dirname,
      '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
    ),
    'utf8',
  )
  await open(page)
  await installOffsets(page)
  const stored = await page.evaluate((markdown) => {
    const editor = (window as any).vditor
    editor.setValue(markdown)
    return editor.getValue() as string
  }, large)
  await frames(page)
  // First paragraph that holds an inline node.
  const index = await page.evaluate(() => {
    const root = document.querySelector('.vditor-ir .vditor-reset')!
    return [...root.children].findIndex(
      (child) =>
        child.tagName === 'P' &&
        child.querySelector('.vditor-ir__node:not([data-block])'),
    )
  })
  expect(index).toBeGreaterThanOrEqual(0)
  await call(page, '__placeBeforeFirstNode', index)
  await frames(page)

  await page.evaluate(installSelectionPerformanceProbe, stored)
  await page.evaluate(() => (window as any).__selectionPerformanceProbe.start())
  for (let i = 0; i < 30; i++) await page.keyboard.press('ArrowRight')
  for (let i = 0; i < 30; i++) await page.keyboard.press('Shift+ArrowRight')
  await page.evaluate(() =>
    (window as any).__selectionPerformanceProbe.endWorkload(),
  )
  await page.waitForTimeout(500)
  const result = await page.evaluate(
    () =>
      (
        window as any
      ).__selectionPerformanceProbe.stop() as SelectionPerformanceProbeResult,
  )
  const longest = Math.max(0, ...result.longTaskDurationsMs)
  console.log(
    'task648 key performance',
    JSON.stringify({
      fullGetValueCalls: result.fullGetValueCalls,
      indexBuilds: result.indexBuilds,
      longTasks: result.longTaskDurationsMs.length,
      longestTaskMs: Math.round(longest),
      workloadMs: Math.round(result.elapsedWorkloadMs),
      caret: await caret(page),
    }),
  )
  expect(result.fullGetValueCalls).toBeLessThanOrEqual(1)
  expect(result.indexBuilds).toBeLessThanOrEqual(1)
})
