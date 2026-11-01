import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  MarkdownOutlineProvider,
  MarkdownOutlineDragAndDropController,
  parseHeadings,
  type HeadingItem,
} from '../../src/markdown/outline-tree'
import { activePanels } from '../../src/platform/active-panels'
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

  it('shows the heading text as the item label, not the source label used for drops', () => {
    const p = new MarkdownOutlineProvider()
    p.refresh(doc('# Two  spaces   inside\n') as any)
    const [item] = p.getChildren()
    expect(item.label).toBe('Two  spaces   inside')
    expect(item.heading).toBe('Two  spaces   inside')
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

  // Task 668: a ready panel plans the move on its own text, so the host names each heading by offset,
  // level and label (the label comes from the host text at drop time).
  describe('with a ready webview panel (task 668)', () => {
    const entries: any[] = []
    function readyPanel(document: any) {
      const moveOutlineSection = vi.fn()
      const entry = {
        panel: {} as any,
        uri: document.uri,
        ready: true,
        moveOutlineSection,
      }
      activePanels.add(entry as any)
      entries.push(entry)
      return moveOutlineSection
    }
    afterEach(() => {
      for (const entry of entries.splice(0)) activePanels.delete(entry)
    })

    it('a ready panel receives the dragged and target labels from the host text', async () => {
      const document = doc('# Alpha\n\nx\n\n## Beta\n\ny\n\n# Gamma\n') as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [alpha, gamma] = provider.getChildren()
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([gamma], data, undefined as any)
      await controller.handleDrop(alpha, data, undefined as any)
      expect(move).toHaveBeenCalledWith(
        { start: gamma.offset, level: 1, label: 'Gamma', index: 2, count: 3 },
        { start: alpha.offset, level: 1, label: 'Alpha', index: 0, count: 3 },
        'before',
      )
      expect(mock.calls.appliedEdits).toHaveLength(0)
    })

    it('names the last heading of the dragged level, with its label, when dropped on empty space', async () => {
      const document = doc('# Alpha\n\nx\n\n# Beta\n\ny\n\n# Gamma\n') as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [alpha, , gamma] = provider.getChildren()
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([alpha], data, undefined as any)
      await controller.handleDrop(undefined, data, undefined as any)
      expect(move).toHaveBeenCalledWith(
        { start: alpha.offset, level: 1, label: 'Alpha', index: 0, count: 3 },
        { start: gamma.offset, level: 1, label: 'Gamma', index: 2, count: 3 },
        'after',
      )
    })

    // Task 668 review: VS Code keeps the tree items it was given, so after published typing that
    // shifts offsets but not lines the items are stale. The label the user saw travels with the drag
    // and must still be the label at the resolved offset, for the source and for the target.
    const SHIFT_DOCUMENT = '# A\n\na\n\n# B\n\nb\n\n# C\n\nc\n\n# D\n\nd\n'

    it('refuses stale tree items whose offsets now name other headings', async () => {
      const document = doc(`introword\n\n${SHIFT_DOCUMENT}`) as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [, staleB, , staleD] = provider.getChildren()
      // Eight typed characters shift every heading by one section; no line changes.
      document.__setText(`intro12345678word\n\n${SHIFT_DOCUMENT}`)
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([staleD], data, undefined as any)
      await controller.handleDrop(staleB, data, undefined as any)
      expect(move).not.toHaveBeenCalled()
      expect(mock.calls.appliedEdits).toHaveLength(0)
    })

    it('refuses stale tree items whose offsets now name other same-label headings', async () => {
      // Four equal sections: typing exactly one section length above them makes every stale
      // offset name the previous section, with the same level and label.
      const days = '# Day\n\nx\n\n'.repeat(4)
      const document = doc(`introword\n\n${days}`) as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [, day2, , day4] = provider.getChildren()
      document.__setText(`intro${'1'.repeat(10)}word\n\n${days}`)
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([day4], data, undefined as any)
      await controller.handleDrop(day2, data, undefined as any)
      expect(move).not.toHaveBeenCalled()
      expect(mock.calls.appliedEdits).toHaveLength(0)
    })

    it('refuses a fresh target dropped with a stale dragged item', async () => {
      const document = doc(`introword\n\n${SHIFT_DOCUMENT}`) as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [, , , staleD] = provider.getChildren()
      document.__setText(`intro12345678word\n\n${SHIFT_DOCUMENT}`)
      provider.refresh(document)
      const [, freshB] = provider.getChildren()
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([staleD], data, undefined as any)
      await controller.handleDrop(freshB, data, undefined as any)
      expect(move).not.toHaveBeenCalled()
    })

    it('fires a tree change when only the offsets moved', () => {
      const document = doc(`introword\n\n${SHIFT_DOCUMENT}`) as any
      const provider = new MarkdownOutlineProvider()
      let fired = 0
      provider.onDidChangeTreeData(() => {
        fired++
      })
      provider.refresh(document)
      document.__setText(`intro12345678word\n\n${SHIFT_DOCUMENT}`)
      provider.refresh(document)
      expect(fired).toBe(2)
    })

    it('refuses a target that is no longer a heading of the host text', async () => {
      const document = doc('# Alpha\n\nx\n\n# Beta\n') as any
      const provider = new MarkdownOutlineProvider()
      provider.refresh(document)
      const [staleAlpha] = provider.getChildren()
      // The tree was refreshed from a text where offset 0 was a heading; the host text has moved on.
      document.__setText('intro\n\n# Alpha\n\nx\n\n# Beta\n')
      provider.refresh(document)
      const [, beta] = provider.getChildren()
      const move = readyPanel(document)
      const controller = new MarkdownOutlineDragAndDropController()
      const data = new (vscode as any).DataTransfer()
      await controller.handleDrag([beta], data, undefined as any)
      await controller.handleDrop(staleAlpha, data, undefined as any)
      expect(move).not.toHaveBeenCalled()
      expect(mock.calls.appliedEdits).toHaveLength(0)
    })
  })
})
