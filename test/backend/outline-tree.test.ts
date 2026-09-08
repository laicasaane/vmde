import { describe, it, expect, beforeEach } from 'vitest'
import * as vscode from 'vscode'
import {
  MarkdownOutlineProvider,
  MarkdownOutlineDragAndDropController,
  parseHeadings,
  type HeadingItem,
} from '../../src/markdown/outline-tree'
import { mock } from './vscode-mock'

function doc(text: string) {
  mock.setWorkspaceFolder('/workspace')
  return mock.createTextDocument('/workspace/test.md', text)
}

function tree(items: HeadingItem[]): any[] {
  return items.map((i) => ({
    name: i.heading,
    level: i.level,
    index: i.index,
    children: tree(i.children),
  }))
}

describe('parseHeadings', () => {
  beforeEach(() => mock.reset())

  it('finds ATX headings with their level, line, and ordinal index', () => {
    const h = parseHeadings(doc('# One\n\n## Two\n\n# Three\n') as any)
    expect(h).toEqual([
      { level: 1, name: 'One', line: 0, index: 0, offset: 0 },
      { level: 2, name: 'Two', line: 2, index: 1, offset: 7 },
      { level: 1, name: 'Three', line: 4, index: 2, offset: 15 },
    ])
  })

  it('skips ATX-looking lines inside fenced code blocks', () => {
    const h = parseHeadings(
      doc('# Real\n\n```\n# fake\n## also fake\n```\n\n## After\n') as any,
    )
    expect(h.map((x) => x.name)).toEqual(['Real', 'After'])
    // index stays contiguous over the real headings only
    expect(h.map((x) => x.index)).toEqual([0, 1])
  })

  it('handles ~~~ fences too', () => {
    const h = parseHeadings(doc('# A\n~~~\n# nope\n~~~\n# B\n') as any)
    expect(h.map((x) => x.name)).toEqual(['A', 'B'])
  })

  it('strips a closing ATX sequence', () => {
    const h = parseHeadings(doc('## Title ##\n') as any)
    expect(h[0].name).toBe('Title')
  })

  it('uses the move scanner for setext headings and protected source regions', () => {
    const h = parseHeadings(
      doc(
        'Title\n=====\n\n```md\n# fake\n```\n\n> ## nested\n\n## Real\n',
      ) as any,
    )
    expect(h.map(({ name, level }) => ({ name, level }))).toEqual([
      { name: 'Title', level: 1 },
      { name: 'Real', level: 2 },
    ])
  })

  it('returns nothing for a heading-free document', () => {
    expect(parseHeadings(doc('plain text\nmore text\n') as any)).toEqual([])
  })
})

describe('MarkdownOutlineProvider tree', () => {
  beforeEach(() => mock.reset())

  it('nests deeper headings under shallower ones with correct indices', () => {
    const p = new MarkdownOutlineProvider()
    p.refresh(doc('# A\n## B\n### C\n## D\n# E\n') as any)
    expect(tree(p.getChildren())).toEqual([
      {
        name: 'A',
        level: 1,
        index: 0,
        children: [
          {
            name: 'B',
            level: 2,
            index: 1,
            children: [{ name: 'C', level: 3, index: 2, children: [] }],
          },
          { name: 'D', level: 2, index: 3, children: [] },
        ],
      },
      { name: 'E', level: 1, index: 4, children: [] },
    ])
  })

  it('exposes the current document uri and clears on undefined', () => {
    const p = new MarkdownOutlineProvider()
    p.refresh(doc('# X\n') as any)
    expect(p.uri?.toString()).toContain('test.md')
    expect(p.getChildren()).toHaveLength(1)
    p.refresh(undefined)
    expect(p.uri).toBeUndefined()
    expect(p.getChildren()).toHaveLength(0)
  })

  it('each heading item carries the reveal command with its index', () => {
    const p = new MarkdownOutlineProvider()
    p.refresh(doc('# A\n## B\n') as any)
    const [a] = p.getChildren()
    expect(a.command?.command).toBe('vmde.outlineReveal')
    expect(a.command?.arguments?.[0]).toBe(a)
    expect(a.children[0].index).toBe(1)
  })
})

describe('MarkdownOutlineDragAndDropController', () => {
  beforeEach(() => mock.reset())

  it('applies one same-document exact move and rejects a stale drag version', async () => {
    const document = doc('# A\n\n# B\n') as any
    const provider = new MarkdownOutlineProvider()
    provider.refresh(document)
    const [a, b] = provider.getChildren()
    const controller = new MarkdownOutlineDragAndDropController()
    const data = new (vscode as any).DataTransfer()
    await controller.handleDrag([b], data, undefined as any)
    await controller.handleDrop(a, data, undefined as any)
    expect(document.getText()).toBe('# B\n\n# A\n')
    expect(mock.calls.appliedEdits).toHaveLength(1)

    provider.refresh(document)
    const [moved] = provider.getChildren()
    const stale = new (vscode as any).DataTransfer()
    await controller.handleDrag([moved], stale, undefined as any)
    document.__setText('# Changed\n\n# A\n')
    await controller.handleDrop(undefined, stale, undefined as any)
    expect(mock.calls.appliedEdits).toHaveLength(1)
  })
})
