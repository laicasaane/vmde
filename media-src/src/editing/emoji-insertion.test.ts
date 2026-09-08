// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyEmojiInsertion,
  captureEmojiInsertion,
  configureEmojiInsertion,
  invalidateEmojiInsertion,
  mapEmojiSourceOffsets,
  planEmojiInsertion,
} from './emoji-insertion'

interface TransactionFixture {
  editor: HTMLElement
  markdown: () => string
  select: (paragraph: number, start: number, end: number) => Range
  setWritable: (value: boolean) => void
  setSession: (value: object) => void
  checkpoints: ReturnType<typeof vi.fn>
  syncExact: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
}

function transactionFixture(
  source = 'first target\n\nsecond target',
  options: { dropApplyMarker?: boolean } = {},
): TransactionFixture {
  document.body.innerHTML =
    '<div class="vditor-wysiwyg" contenteditable="true"></div>'
  const editor = document.querySelector<HTMLElement>('.vditor-wysiwyg')!
  let currentMarkdown = source
  let writable = true
  let session: object = {}
  const render = (markdown: string) => {
    const rendered = options.dropApplyMarker
      ? markdown.replace(/\uE320VMDE_EMOJI_CARET_*/gu, '')
      : markdown
    currentMarkdown = rendered
    editor.replaceChildren(
      ...rendered.split('\n\n').map((text) => {
        const paragraph = document.createElement('p')
        paragraph.textContent = text
        return paragraph
      }),
    )
  }
  const serialize = (html: string) => {
    const scratch = document.createElement('div')
    scratch.innerHTML = html
    return Array.from(scratch.querySelectorAll('p'))
      .map((paragraph) => paragraph.textContent ?? '')
      .join('\n\n')
  }
  render(source)
  const checkpoints = vi.fn(() => {
    const first = editor.querySelector('p')?.firstChild
    if (!first) return
    const reset = document.createRange()
    reset.setStart(first, 0)
    reset.collapse(true)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(reset)
  })
  const undoSlot = {
    undoStack: [] as unknown[],
    redoStack: [] as unknown[],
    lastText: '',
    hasUndo: false,
  }
  const outer = {
    getCurrentMode: () => 'wysiwyg',
    getValue: () => serialize(editor.innerHTML),
    setValue: render,
    focus: () => editor.focus(),
    vditor: {
      currentMode: 'wysiwyg',
      wysiwyg: { element: editor },
      lute: {
        VditorDOM2Md: serialize,
        VditorIRDOM2Md: serialize,
      },
      undo: {
        wysiwyg: undoSlot,
        addToUndoStack: checkpoints,
        resetIcon: () => undefined,
      },
      toolbar: { elements: {} },
    },
  }
  ;(window as unknown as { vditor: unknown }).vditor = outer
  const syncExact = vi.fn((after: string) => {
    currentMarkdown = after
  })
  const onError = vi.fn()
  configureEmojiInsertion({
    snapshotMarkdown: () => currentMarkdown,
    session: () => session,
    writable: () => writable,
    setApplying: () => undefined,
    syncExact,
    onError,
  })
  return {
    editor,
    markdown: () => outer.getValue(),
    select: (paragraph, start, end) => {
      const text = editor.querySelectorAll('p')[paragraph].firstChild!
      const range = document.createRange()
      range.setStart(text, start)
      range.setEnd(text, end)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      return range
    },
    setWritable: (value) => {
      writable = value
    },
    setSession: (value) => {
      session = value
    },
    checkpoints,
    syncExact,
    onError,
  }
}

afterEach(() => {
  invalidateEmojiInsertion()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('planEmojiInsertion', () => {
  it.each([
    ['alpha beta', 6, 10, '🫪', 'alpha 🫪', 8],
    ['alpha', 2, 2, '👨‍👩‍👧‍👦', 'al👨‍👩‍👧‍👦pha', 13],
    ['key', 0, 3, '1️⃣', '1️⃣', 3],
  ] as const)(
    'splices one complete Unicode sequence without changing surrounding source',
    (before, start, end, sequence, markdown, caretOffset) => {
      expect(planEmojiInsertion(before, start, end, sequence)).toEqual({
        markdown,
        caretOffset,
      })
    },
  )

  it.each([
    ['abc', -1, 0, '🙂'],
    ['abc', 2, 1, '🙂'],
    ['abc', 0, 4, '🙂'],
    ['abc', 0.5, 1, '🙂'],
    ['abc', 0, 1, ''],
  ] as const)(
    'rejects invalid offsets and empty sequences',
    (source, start, end, emoji) => {
      expect(planEmojiInsertion(source, start, end, emoji)).toBeNull()
    },
  )
})

describe('mapEmojiSourceOffsets', () => {
  it('maps a selection through CRLF and noncanonical surrounding whitespace', () => {
    expect(
      mapEmojiSourceOffsets(
        'head\n\ntarget\n',
        'head\r\n\r\ntarget\r\n',
        6,
        12,
      ),
    ).toEqual({ startOffset: 8, endOffset: 14 })
    expect(
      mapEmojiSourceOffsets('head\n\ntarget\n', 'head\n\n\ntarget\n', 6, 12),
    ).toEqual({ startOffset: 7, endOffset: 13 })
    expect(mapEmojiSourceOffsets('target\n', 'target\n\n', 0, 6)).toEqual({
      startOffset: 0,
      endOffset: 6,
    })
  })

  it('rejects a selection whose own bytes overlap normalization', () => {
    expect(mapEmojiSourceOffsets('ab', 'a b', 0, 2)).toBeNull()
  })
})

it('replaces the captured non-first WYSIWYG source after equivalent DOM and live-range changes', () => {
  const fixture = transactionFixture()
  const range = fixture.select(1, 7, 13)
  const bookmark = captureEmojiInsertion(range)
  expect(bookmark).not.toBeNull()

  fixture.editor.innerHTML = '<p>first target</p><p>second target</p>'
  fixture.select(0, 0, 0)
  const result = applyEmojiInsertion(bookmark, '🫪')

  expect(result?.status).toBe('success')
  expect(fixture.markdown()).toBe('first target\n\nsecond 🫪')
  expect(fixture.editor.textContent).not.toMatch(/VMDE_EMOJI/u)
  expect(fixture.checkpoints).toHaveBeenCalledTimes(2)
  expect(fixture.syncExact).toHaveBeenCalledWith(
    'first target\n\nsecond 🫪',
    'first target\n\nsecond target',
    'first target\n\nsecond target',
  )
})

it('returns a fresh bookmark for consecutive keep-open insertions', () => {
  const fixture = transactionFixture('alpha')
  const first = captureEmojiInsertion(fixture.select(0, 5, 5))
  const firstResult = applyEmojiInsertion(first, '🙂')
  const secondResult = applyEmojiInsertion(
    firstResult?.nextBookmark ?? null,
    '🫪',
  )

  expect(secondResult?.status).toBe('success')
  expect(fixture.markdown()).toBe('alpha🙂🫪')
  expect(fixture.syncExact).toHaveBeenCalledTimes(2)
})

it('rolls back source, selection, and exact sync when rendered marker resolution fails', () => {
  const fixture = transactionFixture('first target\n\nsecond target', {
    dropApplyMarker: true,
  })
  const bookmark = captureEmojiInsertion(fixture.select(1, 7, 13))

  expect(applyEmojiInsertion(bookmark, '🫪')).toBeNull()

  expect(fixture.markdown()).toBe('first target\n\nsecond target')
  expect(document.getSelection()?.toString()).toBe('target')
  expect(fixture.syncExact).not.toHaveBeenCalled()
})

it.each(['input', 'update', 'mode', 'dispose'] as const)(
  'rejects a bookmark invalidated by %s without checkpointing or syncing',
  () => {
    const fixture = transactionFixture()
    const bookmark = captureEmojiInsertion(fixture.select(1, 7, 13))
    invalidateEmojiInsertion()

    expect(applyEmojiInsertion(bookmark, '🫪')).toBeNull()
    expect(fixture.checkpoints).not.toHaveBeenCalled()
    expect(fixture.syncExact).not.toHaveBeenCalled()
  },
)

it('rejects same-text replacement sessions and read-only editors', () => {
  const fixture = transactionFixture()
  const sessionBookmark = captureEmojiInsertion(fixture.select(1, 7, 13))
  fixture.setSession({})
  expect(applyEmojiInsertion(sessionBookmark, '🫪')).toBeNull()

  fixture.editor.innerHTML = '<p>first target</p><p>second target</p>'
  const readOnlyBookmark = captureEmojiInsertion(fixture.select(1, 7, 13))
  fixture.setWritable(false)
  expect(applyEmojiInsertion(readOnlyBookmark, '🫪')).toBeNull()
  expect(fixture.checkpoints).not.toHaveBeenCalled()
  expect(fixture.syncExact).not.toHaveBeenCalled()
})
