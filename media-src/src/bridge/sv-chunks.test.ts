// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MovableBlock } from '../../../src/shared/block-move'
import { tableHeavyMarkdown } from '../../../test/vscode-e2e/table-heavy-markdown'
import { svFixture } from '../testing/real-lute'

// Task 733 / 015-T1, S-01 (task 015 sections 6.2 D-1 and 6.3): `scanSourceChunks` cuts the model text
// into the chunks that Vditor's Source build shows as `data-block` divs. The boundary table below is
// read from the real Source spin (`SpinVditorSVDOM`, split as `sv/process.ts:54-62` does); a chunk is
// one Source unit, which may span several divs. The module is loaded by a computed specifier so this
// file typechecks before the module exists.

interface SvChunksModule {
  scanSourceChunks(markdown: string): MovableBlock[]
}
const MODULE: string = './sv-chunks'
const load = async (): Promise<SvChunksModule> =>
  (await import(/* @vite-ignore */ MODULE)) as SvChunksModule

interface Shape {
  name: string
  markdown: string
  /** Source units (chunks) the text holds. */
  chunks: number
  /** `data-block` divs of the real Source build. */
  divs: number
}

// Every entry was checked against the vendored Lute; a shape that is not listed here is not claimed.
const BOUNDARIES: readonly Shape[] = [
  { name: 'blank line', markdown: 'para one\n\nsecond\n', chunks: 2, divs: 2 },
  { name: 'extra blank lines', markdown: 'a\n\n\n\nb\n', chunks: 2, divs: 2 },
  {
    name: 'fence holding a blank line',
    markdown: 'p\n\n```js\na\n\nb\n```\n',
    chunks: 2,
    divs: 2,
  },
  {
    name: 'math block holding a blank line',
    markdown: 'p\n\n$$\na\n\nb\n$$\n',
    chunks: 2,
    divs: 2,
  },
  {
    name: 'paragraph directly before a list (the spin inserts a blank line)',
    markdown: 'p\n- a\n- b\n',
    chunks: 2,
    divs: 2,
  },
  {
    name: 'heading directly before a paragraph (the spin inserts a blank line)',
    markdown: '# h\npara\n',
    chunks: 2,
    divs: 2,
  },
  {
    name: 'front matter',
    markdown: '---\ntitle: t\n---\n\nbody\n',
    chunks: 2,
    divs: 2,
  },
  { name: 'tight list', markdown: 'x\n\n- a\n- b\n- c\n', chunks: 2, divs: 2 },
  { name: 'loose list', markdown: '- a\n\n- b\n', chunks: 1, divs: 1 },
  { name: 'quote', markdown: '> q\n> r\n\nz\n', chunks: 2, divs: 2 },
  {
    name: 'table at the end (an empty trailing div)',
    markdown: 'p\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n',
    chunks: 2,
    divs: 3,
  },
  {
    name: 'HTML enclosure holding blank lines',
    markdown: '<div>\n\nx\n\n</div>\n',
    chunks: 1,
    divs: 3,
  },
]

/** The chunks cover the text in order, without a gap or an overlap. */
function expectContiguous(blocks: readonly MovableBlock[], text: string) {
  let at = 0
  for (const block of blocks) {
    expect(block.start).toBe(at)
    expect(block.sectionEnd).toBeGreaterThanOrEqual(block.end)
    at = block.sectionEnd
  }
  expect(at).toBe(text.length)
}

describe('S-01 boundary table', () => {
  it.each(BOUNDARIES)('$name', async (shape) => {
    const { scanSourceChunks } = await load()
    const root = svFixture(shape.markdown)
    expect(root.children.length).toBe(shape.divs)
    const chunks = scanSourceChunks(shape.markdown)
    expect(chunks.length).toBe(shape.chunks)
    expectContiguous(chunks, shape.markdown)
    root.remove()
  })

  it('reports tables and list items as opaque paragraphs', async () => {
    const { scanSourceChunks } = await load()
    const kinds = scanSourceChunks(
      'p\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n- a\n- b\n',
    ).map((block) => block.kind)
    expect(kinds).not.toContain('table')
    expect(kinds).not.toContain('list-item')
  })
})

// Task 733 / 015: factors 4 and 16 build Source or IR fixtures of 51 KB and 208 KB with the real Lute in
// jsdom; the suite timeout is explicit (family rule 13.17).
const FIXTURE_TIMEOUT_MS = 30_000

describe.each([1, 4, 16] as const)(
  'S-01 at factor %i',
  { timeout: FIXTURE_TIMEOUT_MS },
  (factor) => {
    it('gives one chunk per div of the real Source build', async () => {
      const { scanSourceChunks } = await load()
      const markdown = tableHeavyMarkdown(factor)
      const root = svFixture(markdown)
      const chunks = scanSourceChunks(markdown)
      // The fixture separates every block by one blank line and holds no HTML enclosure, so each div
      // is one chunk; the last div may be the empty one a table at the end leaves.
      const divs = root.children.length
      const trailingEmpty = root.lastElementChild?.textContent === '' ? 1 : 0
      expect(chunks.length).toBe(divs - trailingEmpty)
      expectContiguous(chunks, markdown)
      root.remove()
    })
  },
)
