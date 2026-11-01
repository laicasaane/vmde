// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('./caret', () => ({ requestCaret: vi.fn(() => true) }))
vi.mock('../chrome/toolbar-scroll-guard', () => ({
  findScroller: vi.fn(() => ({
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
  })),
}))
vi.mock('../util/caret-gesture', () => ({
  isCompositionActive: vi.fn(() => false),
}))
vi.mock('./table-actions', () => ({
  snapshotTableUndoForRollback: vi.fn(() => 'SNAPSHOT'),
  restoreTableUndoForRollback: vi.fn(),
}))
// Partial mock: checkpoint and history plumbing are covered by rewrap-command.test.ts; the caret
// line mapping stays real because the command's offset math depends on it.
vi.mock('./rewrap-command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./rewrap-command')>()
  return {
    ...actual,
    checkpointEditorUndo: vi.fn(),
    recordRewrapDocumentHistory: vi.fn(),
  }
})

import { recordRewrapDocumentHistory } from './rewrap-command'
import {
  captureSourceListSvSelection,
  configureSourceListCommand,
  runSourceListCommand,
} from './list-normalize-source-command'

// Task 630 S1 (RED): the SV list command acquires exact authority inside the command, plans on the
// acquired exact text and posts with a rollback. `configureSourceListCommand` has no acquire seam yet,
// so `acquireExactAuthority` and `postExact(markdown, opts)` are declared here and cast onto the
// product type. SV text is the LF-normalized source: a CRLF host differs from the editor text.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type Deps = Parameters<typeof configureSourceListCommand>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

const HOST_EXACT = 'Intro\r\n\r\n1. one\r\n3. two\r\n\r\nTail\r\n'
const HOST_NORMALIZED = 'Intro\r\n\r\n1. one\r\n2. two\r\n\r\nTail\r\n'
const lf = (text: string) => text.replace(/\r\n|\r/gu, '\n')
const RENDERED = lf(HOST_EXACT)

let editor: HTMLPreElement
let host: { text: string; owned: string | null; restored: number }
let acquireExactAuthority: ReturnType<
  typeof vi.fn<() => Promise<AcquiredPair | null>>
>
let postExact: ReturnType<typeof vi.fn<(m: string, o?: ExactEdit) => void>>
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  editor = document.createElement('pre')
  editor.contentEditable = 'true'
  editor.textContent = RENDERED
  document.body.append(editor)
  const inner = {
    currentMode: 'sv',
    sv: { element: editor },
    undo: { sv: { undoStack: [{ marker: 'native' }] } },
  }
  ;(window as any).vditor = { vditor: inner }
  host = { text: HOST_EXACT, owned: null, restored: 0 }
  acquireExactAuthority = vi.fn(async () => {
    host.owned = host.text
    return { exact: host.text, rendered: editor.textContent ?? '' }
  })
  postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      editor.textContent = lf(host.text)
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  onError = vi.fn()
  configureSourceListCommand({
    // The legacy source after a trusted edit: the LF editor text, not the host bytes.
    snapshotExactMarkdown: () => editor.textContent ?? '',
    setApplying: vi.fn(),
    postExact,
    acquireExactAuthority,
    onError,
  } as Deps)
  const text = editor.firstChild as Text
  const range = document.createRange()
  const caret = RENDERED.indexOf('3. two') + 2
  range.setStart(text, caret)
  range.collapse(true)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  expect(captureSourceListSvSelection()).toBe(true)
})

afterEach(() => {
  document.body.replaceChildren()
  delete (window as any).vditor
})

describe('SV list normalize exact authority (Task 630)', () => {
  test('acquires authority and renumbers on the acquired CRLF host text, posting with a rollback', async () => {
    expect(await runSourceListCommand(window, 'caret')).toBe(1)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).toHaveBeenCalledOnce()
    // Every byte outside the renumbered line, including the CRLF line ends, is the host's.
    expect(postExact.mock.calls[0][0]).toBe(HOST_NORMALIZED)
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(host.text).toBe(HOST_NORMALIZED)
    expect(editor.textContent).toBe(lf(HOST_NORMALIZED))
  })

  test('refuses a stale host: no write, the rollback runs and the editor shows the host text', async () => {
    const drifted = `${HOST_EXACT}Delta\r\n`
    acquireExactAuthority.mockImplementationOnce(async () => {
      host.owned = HOST_EXACT
      host.text = drifted
      return { exact: HOST_EXACT, rendered: editor.textContent ?? '' }
    })

    await runSourceListCommand(window, 'caret')

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    expect(host.restored).toBe(1)
    expect(host.text).toBe(drifted)
    expect(editor.textContent).toBe(lf(drifted))
  })

  test('declines without a write or a DOM change when acquisition fails', async () => {
    acquireExactAuthority.mockResolvedValueOnce(null)

    expect(await runSourceListCommand(window, 'caret')).toBe(0)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).not.toHaveBeenCalled()
    expect(editor.textContent).toBe(RENDERED)
    expect(onError).not.toHaveBeenCalled()
  })
})

// Task 669 (RED): the SV list command proves its retained offsets against the acquired exact text
// and replaces only the proven rendered region. The editor text is Vditor's, not the host's: it ends
// in one appended newline span (the snapshot drops it) and, after a mode switch, shows Lute's padded
// tables, so it does not equal the exact text up to line endings.
describe('SV list normalize proves its offsets (Task 669)', () => {
  const RAW_TABLE = '|a|b|\n|-|-|'
  const PADDED_TABLE = '| a | b |\n| - | - |'
  const crlf = (text: string) => text.replace(/\n/gu, '\r\n')
  const posted: string[] = []
  let view: HTMLPreElement
  const renumber = (markdown: string): string => {
    let n = 0
    return markdown.replace(
      /^(\s*)\d+\./gmu,
      (_m, indent: string) => `${indent}${++n}.`,
    )
  }

  /** Mounts the SV editor with `text`, retains a caret after `needle`, runs the command on `exact`. */
  async function run(
    text: string,
    exact: string,
    needle: string,
    at = 0,
    scope: 'caret' | 'all' = 'caret',
    getValue?: () => string,
  ) {
    document.body.innerHTML = ''
    posted.length = 0
    view = document.createElement('pre')
    view.contentEditable = 'true'
    view.textContent = text
    document.body.append(view)
    ;(window as any).vditor = {
      vditor: {
        currentMode: 'sv',
        sv: { element: view },
        // Lute renumbers an ordered list from its first number; the fake keeps just that rule.
        lute: {
          FormatStr: (_origin: string, markdown: string) => renumber(markdown),
        },
        undo: { sv: { undoStack: [{ marker: 'native' }] } },
      },
      ...(getValue ? { getValue } : {}),
    }
    const onError = vi.fn()
    configureSourceListCommand({
      acquireExactAuthority: async () => ({
        exact,
        // The edit-sync snapshot: the editor text without Vditor's appended newline span.
        rendered: text.replace(/\n$/u, ''),
      }),
      setApplying: vi.fn(),
      postExact: (markdown: string) => posted.push(markdown),
      onError,
    } as Deps)
    const range = document.createRange()
    range.setStart(view.firstChild as Text, text.indexOf(needle, at) + 1)
    range.collapse(true)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
    expect(captureSourceListSvSelection()).toBe(true)
    return { changed: await runSourceListCommand(window, scope), onError }
  }

  test('renumbers a list when the editor text keeps the appended newline span', async () => {
    const source = 'Intro\n\n1. one\n3. two\n\nTail\n'
    const { changed } = await run(`${source}\n`, crlf(source), '3. two')
    expect(changed).toBe(1)
    expect(posted).toEqual([crlf('Intro\n\n1. one\n2. two\n\nTail\n')])
    expect(view.textContent).toBe('Intro\n\n1. one\n2. two\n\nTail\n\n')
  })

  // Task 675: Vditor's Source `getValue()` differs from the editor text after a direct open (the
  // text ends in a zero-width space, `getValue()` adds a line break), and the native Undo replay
  // compares `getValue()`, so the history pair must be recorded in that form.
  test('records the history pair in the form the native Undo replay compares (direct Source open)', async () => {
    const directOpenValue = (text: string): string =>
      `${text}\n`.replace(/\n\n$/u, '\n')
    const source = 'Intro\n\n1. one\n3. two\n\nTail\n'
    const shown = `${source}\n\u200B`
    const { changed } = await run(
      shown,
      crlf(source),
      '3. two',
      0,
      'caret',
      () => directOpenValue(view.textContent ?? ''),
    )
    expect(changed).toBe(1)
    expect(directOpenValue(shown)).not.toBe(shown)
    expect(recordRewrapDocumentHistory).toHaveBeenCalledTimes(1)
    expect(recordRewrapDocumentHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeRendered: directOpenValue(shown),
        afterRendered: directOpenValue(view.textContent ?? ''),
      }),
    )
  })

  test('renumbers a list next to a table that Lute padded in the editor text only', async () => {
    const exact = crlf(`${RAW_TABLE}\n\n1. one\n3. two\n\nTail\n`)
    const text = `${PADDED_TABLE}\n\n1. one\n3. two\n\nTail\n\n`
    const { changed } = await run(text, exact, '3. two')
    expect(changed).toBe(1)
    // The raw table and every CRLF line end are the host's; only the list number changes.
    expect(posted).toEqual([crlf(`${RAW_TABLE}\n\n1. one\n2. two\n\nTail\n`)])
    expect(view.textContent).toBe(
      `${PADDED_TABLE}\n\n1. one\n2. two\n\nTail\n\n`,
    )
  })

  test('renumbers only the proven one of two identical lists', async () => {
    const list = '1. one\n3. two\n'
    const exact = crlf(`${list}\n${RAW_TABLE}\n\n${list}`)
    const text = `${list}\n${PADDED_TABLE}\n\n${list}\n`
    const { changed } = await run(
      text,
      exact,
      '3. two',
      text.indexOf(PADDED_TABLE),
    )
    expect(changed).toBe(1)
    expect(posted).toEqual([crlf(`${list}\n${RAW_TABLE}\n\n1. one\n2. two\n`)])
    expect(view.textContent).toBe(
      `${list}\n${PADDED_TABLE}\n\n1. one\n2. two\n\n`,
    )
  })

  // Guard: this already declines today and must keep declining after the proof replaces the checks.
  test('declines with no write and no DOM change when the list text is not the exact text', async () => {
    const exact = crlf('Intro\n\n1. one\n3. two\n\nTail\n')
    const text = 'Intro\n\n1. one\n4. two\n\nTail\n\n'
    const { changed, onError } = await run(text, exact, '4. two')
    expect(changed).toBe(0)
    expect(posted).toEqual([])
    expect(view.textContent).toBe(text)
    expect(onError).not.toHaveBeenCalled()
  })

  test('renumbers with scope all when the caret sits on text outside the list and a table is padded', async () => {
    const exact = crlf(`top\n\n${RAW_TABLE}\n\n1. one\n3. two\n`)
    const text = `top\n\n${PADDED_TABLE}\n\n1. one\n3. two\n\n`
    const { changed } = await run(text, exact, 'top', 0, 'all')
    expect(changed).toBe(1)
    expect(posted).toEqual([crlf(`top\n\n${RAW_TABLE}\n\n1. one\n2. two\n`)])
    expect(view.textContent).toBe(
      `top\n\n${PADDED_TABLE}\n\n1. one\n2. two\n\n`,
    )
  })

  test('renumbers a list that Lute already renumbered in the editor text', async () => {
    const exact = crlf('1. one\n1. two\n')
    const text = '1. one\n2. two\n\n'
    const { changed } = await run(text, exact, '1. two')
    expect(changed).toBe(1)
    expect(posted).toEqual([crlf('1. one\n2. two\n')])
    expect(view.textContent).toBe(text)
  })

  test('declines when the list region is not the exact text although both endpoints are proven', async () => {
    const exact = crlf('1. one\n3. two\n')
    const text = '1. ONE\n3. two\n\n'
    const { changed } = await run(text, exact, '3. two')
    expect(changed).toBe(0)
    expect(posted).toEqual([])
    expect(view.textContent).toBe(text)
  })
})
