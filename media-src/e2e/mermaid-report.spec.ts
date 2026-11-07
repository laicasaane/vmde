import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 705 — mermaid errors, fallbacks and layout defects are reported in place, at the block.
// Cases H1-H7 of the Part 1 test plan, on the mermaid harness (real Vditor IR, patched mermaidRender,
// NO initialize wrapper — so ELK is registered only if the render hooks do it). Acceptance items:
// H1 "state diagram with unregistered loaders never blank" / "register ELK on every render path",
// H2 "state: error; flowchart fallback warning", H3 "ELK load failure is a visible error",
// H4 "overlapping terminal-label warning", H5/H6 "no inventoried path ends blank" (F4, F5),
// H7 "warning is invisible to the serialized markdown".

const FM = '---\nconfig:\n  layout: elk\n  htmlLabels: false\n---\n'
const fence = (src: string) => `\`\`\`mermaid\n${src}\n\`\`\`\n`

const STATE = `${FM}stateDiagram-v2\n  [*] --> A\n  A --> B\n  B --> [*]`
const FLOW = `${FM}flowchart TD\n  A[Start] --> B[End]`
const STRAIGHT_TB = `${FM}classDiagram\n  direction TB\n  class Owner {\n    +Text name\n  }\n  class Item {\n    +Integer count\n  }\n  Owner "1" --> "*" Item`
const FAN_TB = `${FM}classDiagram\n  direction TB\n  class Owner {\n    +Text name\n  }\n  class Left\n  class Right\n  class Middle\n  Owner "1" --> "*" Left\n  Owner "1" --> "*" Right\n  Owner --> Middle`
const STRAIGHT_LR = `${FM}classDiagram\n  direction LR\n  class Owner\n  class Item\n  Owner "1" --> "*" Item`
const DAGRE_TB =
  'classDiagram\n  direction TB\n  class Owner\n  class Item\n  Owner "1" --> "*" Item'
const ONE_LABEL = `${FM}classDiagram\n  Owner --> "*" Item`

const BLOCKS = '.vditor-ir__preview .language-mermaid'

async function open(page: Page) {
  await page.goto('/mermaid.html')
  await page.waitForFunction(() => (window as any).__ready === true)
}

async function setBlocks(page: Page, sources: string[]) {
  await page.evaluate(
    (md) => (window as any).__setValue(md),
    sources.map(fence).join('\n'),
  )
  await page.waitForFunction(
    (n) =>
      document.querySelectorAll(
        '.vditor-ir__preview .language-mermaid[data-processed="true"]',
      ).length >= n,
    sources.length,
    { timeout: 20_000 },
  )
}

/** Per block: has an svg, error text, warning tokens and messages. */
async function report(page: Page) {
  return page.evaluate((sel) => {
    return [...document.querySelectorAll(sel)].map((el) => ({
      svg: !!el.querySelector('svg'),
      error: el.querySelector('.vmde-diagram-error__msg')?.textContent ?? null,
      tokens: [...el.querySelectorAll('.vmde-diagram-warning')].flatMap((w) =>
        (w.getAttribute('data-vmde-warning') ?? '').split(' '),
      ),
      messages: [...el.querySelectorAll('.vmde-diagram-warning__msg')].map(
        (m) => m.textContent ?? '',
      ),
    }))
  }, BLOCKS)
}

test('H1 state diagram with layout: elk renders an svg, no error (hooks register ELK)', async ({
  page,
}) => {
  await open(page)
  await setBlocks(page, [STATE])
  const [b] = await report(page)
  expect(b.error).toBeNull()
  expect(b.svg).toBe(true)
})

// Replaces registerLayoutLoaders with a no-op the moment mermaid assigns window.mermaid, so ELK is
// never registered by anyone (the stale-registry / unregistered-path situation of Finding 3).
const BREAK_ELK_REGISTRATION = () => {
  let current: any
  Object.defineProperty(window, 'mermaid', {
    configurable: true,
    get: () => current,
    set(v) {
      if (v) v.registerLayoutLoaders = () => undefined
      current = v
    },
  })
}

test('H2 unregistered ELK: state shows the error box, flowchart the layout-fallback warning', async ({
  page,
}) => {
  await page.addInitScript(BREAK_ELK_REGISTRATION)
  await open(page)
  await setBlocks(page, [STATE, FLOW])
  const [state, flow] = await report(page)
  expect(state.error).toContain('Unknown layout algorithm: elk')
  expect(flow.svg).toBe(true)
  expect(flow.tokens).toContain('layout-fallback')
  expect(flow.messages).toContain(
    'ELK layout is not available. Drawn with dagre instead.',
  )
})

test('H3 ELK adapter fails to load: visible "ELK layout failed to load." error', async ({
  page,
}) => {
  await page.route('**/mermaid-elk-main.js*', (route) => route.abort())
  await open(page)
  await setBlocks(page, [FLOW])
  const [b] = await report(page)
  expect(b.error).toContain('ELK layout failed to load.')
})

test('H4 terminal-label warning: straight ELK class edges flagged; fan-out, dagre, one-label not', async ({
  page,
}) => {
  await open(page)
  await setBlocks(page, [STRAIGHT_TB, FAN_TB, STRAIGHT_LR, DAGRE_TB, ONE_LABEL])
  const [straightTb, fan, straightLr, dagre, one] = await report(page)
  for (const flagged of [straightTb, straightLr]) {
    expect(flagged.error).toBeNull()
    expect(flagged.svg).toBe(true)
    expect(flagged.tokens).toContain('terminal-labels')
    expect(flagged.messages).toContain(
      '1 relation end label sits closer to the other end of its line.',
    )
  }
  for (const clean of [fan, dagre, one]) {
    expect(clean.svg).toBe(true)
    expect(clean.tokens).not.toContain('terminal-labels')
  }
  // The box is the LAST child of the render target, after the svg, never covering it.
  const order = await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement
    const last = el.lastElementChild
    return {
      lastIsWarning: !!last?.classList.contains('vmde-diagram-warning'),
      svgFirst: el.firstElementChild?.tagName.toLowerCase() === 'svg',
      lute: last?.getAttribute('data-render'),
    }
  }, BLOCKS)
  expect(order).toEqual({ lastIsWarning: true, svgFirst: true, lute: '1' })
})

test('H5 mermaid.min.js fails to load: visible dependency error, not raw source', async ({
  page,
}) => {
  await page.route('**/mermaid.min.js*', (route) => route.abort())
  await open(page)
  await page.waitForFunction(
    () => !!document.querySelector('.vditor-ir__preview .vmde-diagram-error'),
    undefined,
    { timeout: 15_000 },
  )
  const [b] = await report(page)
  expect(b.error).toContain('Mermaid renderer dependency failed to load.')
})

test('H6 a render that never settles ends in the 30 s timeout error', async ({
  page,
}) => {
  await page.clock.install()
  await page.goto('/mermaid.html')
  await page.clock.resume()
  await page.waitForFunction(
    () => (window as any).__ready === true && (window as any).mermaid,
    undefined,
    { timeout: 30_000 },
  )
  // Stub AFTER the first (real) render so only the new block hangs.
  await page.evaluate(() => {
    ;(window as any).mermaid.render = () => new Promise(() => undefined)
  })
  await page.evaluate(
    (md) => (window as any).__setValue(md),
    fence('flowchart TD\n  H6[never draws] --> Z'),
  )
  await page.clock.runFor(31_000)
  await page.waitForFunction(
    () => !!document.querySelector('.vditor-ir__preview .vmde-diagram-error'),
    undefined,
    { timeout: 10_000 },
  )
  const [b] = await report(page)
  expect(b.error).toContain(
    'Mermaid did not finish drawing this diagram within 30 seconds.',
  )
})

test('H7 getValue() is byte-identical with a warning present', async ({
  page,
}) => {
  await open(page)
  const md = fence(STRAIGHT_TB)
  await page.evaluate((v) => (window as any).__setValue(v), md)
  const before = await page.evaluate(() => (window as any).__getValue())
  await page.waitForFunction(
    () => !!document.querySelector('.vditor-ir__preview .vmde-diagram-warning'),
    undefined,
    { timeout: 20_000 },
  )
  const after = await page.evaluate(() => (window as any).__getValue())
  expect(after).toBe(before)
  expect(after).not.toContain('vmde-diagram-warning')
  expect(after).not.toContain('relation end label')
})
