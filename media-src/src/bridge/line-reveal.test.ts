// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  previewOffsetForLine,
  readableDocument,
  revealLineOnSurface,
} from './line-reveal'

// Task 730 — `reveal-line` on Split and Preview (IR/WYSIWYG go through nav/outline.ts, covered in
// outline-reveal.test.ts). The line and range are the host's; the expected landing places come from
// the fixture text, never from the code under test.

describe('readableDocument', () => {
  it('joins the readable lines and records where each starts', () => {
    const doc = readableDocument('# Title\n\n1. **one**\n```\ncode\n```')
    expect(doc.lines).toEqual(['Title', '', 'one', '', 'code', ''])
    expect(doc.text).toBe('Title\n\none\n\ncode\n')
    expect(doc.lineStarts).toEqual([0, 6, 7, 11, 12, 17])
  })
})

describe('previewOffsetForLine', () => {
  const markdown = [
    '# Title',
    '',
    'Intro **bold** text.',
    '',
    '```mermaid',
    'graph TD',
    '```',
    '',
    '14. Point fourteen',
  ].join('\n')
  // What Preview's text collector yields: rendered text, block per line, no diagram source.
  const rendered = 'Title\nIntro bold text.\nPoint fourteen\n'

  it('maps a line to the start of its rendered text', () => {
    expect(previewOffsetForLine(markdown, rendered, 8)).toEqual({
      offset: rendered.indexOf('Point fourteen'),
      after: false,
    })
    expect(previewOffsetForLine(markdown, rendered, 2)).toEqual({
      offset: rendered.indexOf('Intro'),
      after: false,
    })
  })

  it('maps a line that renders no text to the block after the preceding content', () => {
    const place = previewOffsetForLine(markdown, rendered, 5)
    expect(place?.after).toBe(true)
    // The preceding content is the paragraph, so the offset sits inside it.
    expect(rendered.slice(0, place?.offset).includes('Intro')).toBe(true)
    expect(place && place.offset < rendered.indexOf('Point')).toBe(true)
  })

  it('returns null for a line outside the document', () => {
    expect(previewOffsetForLine(markdown, rendered, 99)).toBeNull()
    expect(previewOffsetForLine(markdown, rendered, -1)).toBeNull()
  })
})

describe('revealLineOnSurface', () => {
  const requestCaret = vi.fn(() => true)
  let scrolled: Element[]

  beforeEach(() => {
    scrolled = []
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      scrolled.push(this)
    })
    ;(window as any).__vmdeRequestCaret = requestCaret
    requestCaret.mockClear()
  })

  afterEach(() => {
    document.body.replaceChildren()
    delete (window as any).vditor
    delete (window as any).__vmdeRequestCaret
  })

  function svVditor(lines: string[]) {
    const sv = document.createElement('pre')
    sv.className = 'vditor-sv'
    const block = document.createElement('div')
    block.dataset.block = '0'
    // Lute's SV splits the source into spans per token and line.
    for (const line of lines) {
      const span = document.createElement('span')
      span.textContent = line
      block.append(span, document.createTextNode('\n'))
    }
    sv.append(block)
    document.body.append(sv)
    const vditor = {
      getValue: () => lines.join('\n'),
      vditor: {
        currentMode: 'sv',
        sv: { element: sv },
        preview: { element: document.createElement('div') },
      },
    }
    return { vditor: vditor as never, sv }
  }

  it('Split: puts the caret at the start of the source line and scrolls it into view', () => {
    const lines = ['# Head', '', 'alpha', '', 'beta target', 'gamma']
    const { vditor, sv } = svVditor(lines)
    expect(
      revealLineOnSurface(vditor, { line: 4, lineText: 'beta target' }),
    ).toBe(true)
    const spans = sv.querySelectorAll('span')
    expect(requestCaret).toHaveBeenCalledWith({
      node: spans[4].firstChild,
      offset: 0,
    })
    expect(scrolled).toEqual([spans[4]])
  })

  it('Split: a range selects from the first line start to the last line end', () => {
    const lines = ['one', 'two', 'three', 'four']
    const { vditor, sv } = svVditor(lines)
    expect(
      revealLineOnSurface(vditor, {
        line: 1,
        lineText: 'two',
        endLine: 2,
        endLineText: 'three',
      }),
    ).toBe(true)
    const spans = sv.querySelectorAll('span')
    expect(requestCaret).toHaveBeenCalledWith({
      anchor: { node: spans[1].firstChild, offset: 0 },
      focus: { node: spans[2].firstChild, offset: 'three'.length },
    })
  })

  it('Split: finds the line by its text when the pane renumbered it', () => {
    const { vditor, sv } = svVditor(['1. a', '2. b', '3. c'])
    expect(revealLineOnSurface(vditor, { line: 5, lineText: '7. c' })).toBe(
      true,
    )
    expect(requestCaret).toHaveBeenCalledWith({
      node: sv.querySelectorAll('span')[2].firstChild,
      offset: 0,
    })
  })

  it('Split: waits (false) while the source pane is empty', () => {
    const { vditor } = svVditor([])
    expect(revealLineOnSurface(vditor, { line: 0, lineText: 'x' })).toBe(false)
    expect(requestCaret).not.toHaveBeenCalled()
  })

  function previewVditor(markdown: string, html: string) {
    const editParent = document.createElement('div')
    editParent.style.display = 'none'
    const ir = document.createElement('div')
    editParent.append(ir)
    const preview = document.createElement('div')
    preview.style.display = 'block'
    const previewElement = document.createElement('div')
    previewElement.className = 'vditor-reset'
    previewElement.innerHTML = html
    preview.append(previewElement)
    document.body.append(editParent, preview)
    // A Preview-first open has no edit view: getValue() is empty and the held text comes from
    // the Preview snapshot hook.
    ;(window as any).__vmdePreviewSnapshot = () => markdown
    const vditor = {
      getValue: () => '\n',
      vditor: {
        currentMode: 'ir',
        ir: { element: ir },
        preview: { element: preview, previewElement },
      },
    }
    return { vditor: vditor as never, previewElement }
  }

  it('Preview: scrolls the rendered list item holding the line into view and flashes it', () => {
    const markdown = [
      '# Plan',
      '',
      '1. Point one',
      '',
      '2. Point two',
      '',
      'After.',
    ].join('\n')
    const { vditor, previewElement } = previewVditor(
      markdown,
      '<h1>Plan</h1><ol><li><p>Point one</p></li><li><p>Point two</p></li></ol><p>After.</p>',
    )
    expect(
      revealLineOnSurface(vditor, { line: 4, lineText: '2. Point two' }),
    ).toBe(true)
    const item = previewElement.querySelectorAll('li p')[1]
    expect(scrolled).toEqual([item])
    expect(item.classList.contains('heading-flash')).toBe(true)
    expect(requestCaret).not.toHaveBeenCalled()
    delete (window as any).__vmdePreviewSnapshot
  })

  it('Preview: a line inside a diagram lands on the diagram block', () => {
    const markdown = [
      'Before.',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      'After.',
    ].join('\n')
    const { vditor, previewElement } = previewVditor(
      markdown,
      '<p>Before.</p><div class="language-mermaid"><svg></svg></div><p>After.</p>',
    )
    expect(revealLineOnSurface(vditor, { line: 3, lineText: 'graph TD' })).toBe(
      true,
    )
    expect(scrolled).toEqual([previewElement.children[1]])
    delete (window as any).__vmdePreviewSnapshot
  })

  it('Preview: waits (false) while nothing is rendered yet', () => {
    const { vditor } = previewVditor('# Plan\n\ntext', '')
    expect(revealLineOnSurface(vditor, { line: 2, lineText: 'text' })).toBe(
      false,
    )
    delete (window as any).__vmdePreviewSnapshot
  })
})
