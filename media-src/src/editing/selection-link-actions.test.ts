// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'

vi.mock('../nav/block-handle', () => ({ currentBlockProjection: vi.fn() }))
const innerState = vi.hoisted(() => ({
  value: { currentMode: 'ir' } as Record<string, unknown>,
}))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: () => innerState.value,
}))
vi.mock('../util/source-map', () => ({
  activeModeElement: () => document.querySelector('pre'),
}))
vi.mock('./rewrap-command', () => ({
  captureRewrapSourceRange: vi.fn(),
  checkpointEditorUndo: vi.fn(),
  recordRewrapDocumentHistory: vi.fn(),
}))
vi.mock('./table-actions', () => ({
  snapshotTableUndoForRollback: vi.fn(),
  restoreTableUndoForRollback: vi.fn(),
}))

import { currentBlockProjection } from '../nav/block-handle'
import { captureRewrapSourceRange } from './rewrap-command'
import {
  runSelectedLink,
  type SelectionLinkDeps,
} from './selection-link-actions'

afterEach(() => {
  innerState.value = { currentMode: 'ir' }
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('declines a rendered text that differs from the acquired pair before touching the editor or posting Markdown', () => {
  const editor = document.createElement('pre')
  const text = document.createTextNode('alpha')
  editor.append(text)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 5)
  const outer = { getValue: () => 'alpha' } as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  const insert = vi.fn()
  document.execCommand = insert
  const postExact = vi.fn()
  const setApplying = vi.fn()
  const onError = vi.fn()

  expect(
    runSelectedLink(
      'wiki',
      {
        outer,
        editor,
        mode: 'ir',
        range,
        exact: 'alpha',
        rendered: 'externally changed alpha',
      },
      {
        setApplying,
        postExact,
        onError,
      },
    ),
  ).toBe(false)
  expect(insert).not.toHaveBeenCalled()
  expect(setApplying).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
  expect(onError).not.toHaveBeenCalled()
})

// Task 630 S1 (RED): the bubble hands over a pair acquired with `publish: true`; the action plans on
// that exact text and posts with `before` = the acquired exact text (its own `execCommand` input is
// trusted and clears the owned base, so the default `before` is gone) plus a rollback handle.
// `SelectionLinkDeps` still lists the legacy `snapshotExactMarkdown`; the test supplies it with the
// rendered fallback a trusted edit leaves behind and casts the new `postExact(markdown, opts)` shape.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}

// Extra blank lines normalize away, so rendered offsets differ from the host offsets.
const NORMALIZING = {
  exact: 'Alpha\n\n\n\nBeta target\n',
  rendered: 'Alpha\n\nBeta target\n',
}
const PLAIN = {
  exact: 'Alpha\n\nBeta target\n',
  rendered: 'Alpha\n\nBeta target\n',
}

function linkHarness(pair: { exact: string; rendered: string }) {
  const editor = document.createElement('pre')
  const text = document.createTextNode('target')
  editor.append(text)
  document.body.append(editor)
  const range = document.createRange()
  range.setStart(text, 0)
  range.setEnd(text, 6)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  let shown = pair.rendered
  const outer = {
    getValue: () => shown,
    setValue: vi.fn(),
  } as unknown as NonNullable<Window['vditor']>
  vi.stubGlobal('vditor', outer)
  innerState.value = { currentMode: 'ir', undo: { ir: { undoStack: [{}] } } }
  const host = {
    text: pair.exact,
    owned: pair.exact as string | null,
    restored: 0,
  }
  document.execCommand = vi.fn(() => {
    shown = shown.replace('target', '[[target]]')
    // A trusted `input` revokes the owned base (edit-sync `markUserInput`).
    host.owned = null
    return true
  })
  vi.mocked(currentBlockProjection).mockReturnValue({
    owner: {},
    mode: 'ir',
    render: (markdown: string) => markdown,
    serialize: (markdown: string) => markdown.replace(/\n{3,}/gu, '\n\n'),
  } as unknown as ReturnType<typeof currentBlockProjection>)
  vi.mocked(captureRewrapSourceRange).mockImplementation(((
    _win: Window,
    _range: Range,
    options: { authoritativeMarkdown: string },
  ) => {
    const markdown = options.authoritativeMarkdown
    const start = markdown.indexOf('target')
    return {
      markdown,
      startOffset: start,
      endOffset: start + 6,
      caretOffset: start + 6,
    }
  }) as unknown as typeof captureRewrapSourceRange)
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      shown = host.text
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  const deps = {
    // Legacy exact snapshot after a trusted edit: the rendered fallback, not the host bytes.
    snapshotExactMarkdown: () => pair.rendered,
    setApplying: vi.fn(),
    postExact,
    onError: vi.fn(),
  } as unknown as SelectionLinkDeps
  const run = () =>
    runSelectedLink(
      'wiki',
      {
        outer,
        editor,
        mode: 'ir',
        range,
        exact: pair.exact,
        rendered: pair.rendered,
      },
      deps,
    )
  return { host, postExact, run, shown: () => shown }
}

it('plans on the acquired exact text of a normalizing document and posts before = that text with a rollback', () => {
  const h = linkHarness(NORMALIZING)

  expect(h.run()).toBe(true)

  expect(h.postExact).toHaveBeenCalledExactlyOnceWith(
    NORMALIZING.exact.replace('target', '[[target]]'),
    { before: NORMALIZING.exact, rollback: { restore: expect.any(Function) } },
  )
})

it('applies on a non-normalizing document after the action’s own trusted input cleared the owned base', () => {
  const h = linkHarness(PLAIN)

  expect(h.run()).toBe(true)

  expect(h.postExact.mock.calls[0][1]).toEqual({
    before: PLAIN.exact,
    rollback: { restore: expect.any(Function) },
  })
  expect(h.host.restored).toBe(0)
  expect(h.host.text).toBe(PLAIN.exact.replace('target', '[[target]]'))
})

it('refuses a stale host: no write, the rollback runs and the DOM shows the host text', () => {
  const h = linkHarness(PLAIN)
  h.host.text = `${PLAIN.exact}Delta\n`

  expect(h.run()).toBe(true)

  expect(h.postExact.mock.calls[0][1]).toEqual({
    before: PLAIN.exact,
    rollback: { restore: expect.any(Function) },
  })
  expect(h.host.restored).toBe(1)
  expect(h.host.text).toBe(`${PLAIN.exact}Delta\n`)
  expect(h.shown()).toBe(`${PLAIN.exact}Delta\n`)
})
