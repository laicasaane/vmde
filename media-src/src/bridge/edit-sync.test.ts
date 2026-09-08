// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The debounced keystroke→host serialize (createEditSync) is the corruption-critical core
// of the save path: a missed post loses the edit, a post while suppressed (mid stream /
// extension update) saves a truncated document, and a flush that trusts the incremental
// cache without auditing it could persist a drifted document. None of this had unit
// coverage (task 190 P0). Collaborators that touch the real Vditor/DOM/host are mocked;
// the debounce, incremental serializer and tuning stay REAL (they own their own tests).
const h = vi.hoisted(() => ({
  inner: null as {
    ir?: { element?: HTMLElement }
    options?: { undoDelay?: number }
    lute?: { VditorIRDOM2Md(html: string): string }
  } | null,
  activeEl: null as { textContent: string } | null,
  setBusyCursor: vi.fn(),
  nextPaint: vi.fn(() => Promise.resolve()),
  logToHost: vi.fn(),
}))
vi.mock('../util/inner-vditor', () => ({ innerVditor: () => h.inner }))
vi.mock('../util/source-map', () => ({ activeModeElement: () => h.activeEl }))
vi.mock('../chrome/busy-cursor', () => ({
  setBusyCursor: h.setBusyCursor,
  nextPaint: h.nextPaint,
}))
vi.mock('../util/webview-log', () => ({ logToHost: h.logToHost }))

import { createEditSync } from './edit-sync'

// Build an IR element with `n` top-level block children (drives the task-69 incremental gate:
// ≥700 blocks in IR mode → incremental serialize; below → plain getValue()).
function irElement(n: number, nested = false): HTMLElement {
  const el = document.createElement('div')
  for (let i = 0; i < n; i++) {
    const paragraph = document.createElement('p')
    paragraph.setAttribute('data-block', '0')
    if (nested)
      paragraph.innerHTML =
        `<strong>block ${i}</strong><em>rich</em>` +
        '<a href="./note.md">link</a><code>code</code>'
    el.appendChild(paragraph)
  }
  return el
}

interface Opts {
  mode?: string
  blocks?: number
  getValue?: () => string
  serialize?: (html: string) => string
  suppressed?: boolean
  textLen?: number
  nested?: boolean
  seed?: boolean
  initialMarkdown?: string
}

function boot(o: Opts = {}) {
  const post = vi.fn()
  const value = o.getValue ?? (() => 'MD')
  h.inner = {
    ir: { element: irElement(o.blocks ?? 2, o.nested) },
    options: { undoDelay: 800 },
    lute: { VditorIRDOM2Md: o.serialize ?? (() => 'INCR') },
  }
  h.activeEl = { textContent: 'x'.repeat(o.textLen ?? 10) }
  const vd = { getValue: value, getCurrentMode: () => o.mode ?? 'ir' }
  ;(globalThis as unknown as { vscode: unknown }).vscode = { postMessage: post }
  ;(globalThis as unknown as { vditor: unknown }).vditor = vd
  ;(window as unknown as { vditor: unknown }).vditor = vd
  const es = createEditSync({
    isSuppressed: () => o.suppressed ?? false,
    docMode: {
      cvActive: false,
      streamActive: false,
      docChars: o.nested ? 94_533 : 123,
    },
    initialMarkdown: o.initialMarkdown,
    ...(o.seed
      ? {
          incrementalSeed: {
            markdown: h.inner.ir!.element!.innerHTML,
            source: {
              chars: 94_533,
              lines: 2_253,
              blockHints: o.blocks ?? 2,
              listItems: 0,
              tableRows: 0,
              inlineRich: (o.blocks ?? 2) * 4,
              fencedBlocks: 0,
            },
            reason: 'source-structure' as const,
            hostMs: 398.4,
          },
        }
      : {}),
  })
  const edits = () => post.mock.calls.filter((c) => c[0]?.command === 'edit')
  const docModes = () =>
    post.mock.calls.filter((c) => c[0]?.command === 'docMode')
  return { es, post, edits, docModes }
}

describe('createEditSync', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('schedule() posts one debounced edit with the serialized content', () => {
    const { es, edits } = boot({ getValue: () => 'HELLO' })
    es.schedule()
    expect(edits()).toHaveLength(0)
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(1)
    expect(edits()[0][0]).toEqual({ command: 'edit', content: 'HELLO' })
  })

  it('coalesces rapid schedule() calls into a single edit post', () => {
    const { es, edits } = boot()
    es.schedule()
    es.schedule()
    es.schedule()
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(1)
  })

  it('rebaselines but does not post mode-canonicalized bytes for an untrusted mode switch', () => {
    const getValue = vi.fn(() => 'MODE CANONICAL')
    const { es, edits } = boot({
      mode: 'ir',
      blocks: 700,
      getValue,
      serialize: (html) => html,
    })
    es.snapshotMarkdown()
    ;(window.vditor as any).getCurrentMode = () => 'wysiwyg'

    es.markUserInput(false)
    es.schedule()
    vi.advanceTimersByTime(250)

    expect(getValue).toHaveBeenCalledTimes(1)
    expect(edits()).toHaveLength(0)
  })

  it('flush() posts immediately and cancels the pending debounced post (no double send)', () => {
    const { es, edits } = boot({ getValue: () => 'SAVED' })
    es.schedule()
    es.flush()
    expect(edits()).toHaveLength(1)
    expect(edits()[0][0].content).toBe('SAVED')
    vi.advanceTimersByTime(250) // the coalesced idle must NOT also fire
    expect(edits()).toHaveLength(1)
  })

  it('postExact sends known formatter bytes once and cancels a pending serialize', () => {
    const getValue = vi.fn(() => 'CANONICALIZED DOM')
    const { es, edits } = boot({ getValue })
    es.schedule()

    es.postExact('EXACT FORMATTER BYTES')

    expect(edits()).toEqual([
      [{ command: 'edit', content: 'EXACT FORMATTER BYTES', exact: true }],
    ])
    expect(getValue).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(1)
  })

  it('returns an exact large-IR snapshot from the incremental authority without getValue', () => {
    const getValue = vi.fn(() => 'FULL')
    const serialize = vi.fn((html: string) => html)
    const { es } = boot({
      mode: 'ir',
      blocks: 700,
      getValue,
      serialize,
    })

    const snapshot = es.snapshotMarkdown()

    expect(snapshot).toBe(h.inner?.ir?.element?.innerHTML)
    expect(getValue).not.toHaveBeenCalled()
    expect(serialize).toHaveBeenCalled()
  })

  it('admits and atomically seeds a nested sub-700 IR document after mount', async () => {
    const getValue = vi.fn(() => 'AUTHORITATIVE WHILE PARTIAL')
    const serialize = vi.fn((html: string) => html)
    const { es } = boot({
      mode: 'ir',
      blocks: 585,
      nested: true,
      seed: true,
      getValue,
      serialize,
    })
    expect(typeof (es as any).startIncrementalSeed).toBe('function')
    if (typeof (es as any).startIncrementalSeed !== 'function') return

    ;(es as any).startIncrementalSeed()
    expect(es.snapshotMarkdown()).toBe('AUTHORITATIVE WHILE PARTIAL')
    expect(getValue).toHaveBeenCalledTimes(1)
    await vi.runAllTimersAsync()

    serialize.mockClear()
    expect(es.snapshotMarkdown()).toBe(h.inner!.ir!.element!.innerHTML)
    expect(getValue).toHaveBeenCalledTimes(1)
    expect(serialize).not.toHaveBeenCalled()

    const seededMarkdown = es.snapshotMarkdown()
    const helper = document.createElement('div')
    helper.id = 'fix-table-ir-wrapper'
    h.inner!.ir!.element!.appendChild(helper)
    serialize.mockClear()
    expect(es.snapshotMarkdown()).toBe(seededMarkdown)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('cancels stale ownership and atomically reseeds after an external DOM rebuild', async () => {
    const getValue = vi.fn(() => 'AUTHORITATIVE WHILE PARTIAL')
    const serialize = vi.fn((html: string) => html)
    const { es } = boot({
      mode: 'ir',
      blocks: 585,
      nested: true,
      seed: true,
      getValue,
      serialize,
    })
    es.startIncrementalSeed()
    vi.advanceTimersByTime(1)

    const rebuilt = irElement(585, true)
    h.inner!.ir!.element = rebuilt
    es.reseed({
      markdown: rebuilt.innerHTML,
      source: {
        chars: 94_534,
        lines: 2_254,
        blockHints: 585,
        listItems: 0,
        tableRows: 0,
        inlineRich: 585 * 4,
        fencedBlocks: 0,
      },
      reason: 'source-structure',
      hostMs: 2,
    })
    expect(es.snapshotMarkdown()).toBe('AUTHORITATIVE WHILE PARTIAL')

    await vi.runAllTimersAsync()
    serialize.mockClear()
    expect(es.snapshotMarkdown()).toBe(rebuilt.innerHTML)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('retries an equivalent delayed setValue mutation but cancels on genuine user input', async () => {
    const getValue = vi.fn(() => 'AUTHORITATIVE WHILE PARTIAL')
    const serialize = vi.fn((html: string) => html)
    const first = boot({
      mode: 'ir',
      blocks: 585,
      nested: true,
      seed: true,
      getValue,
      serialize,
    })
    first.es.startIncrementalSeed()
    const owner = h.inner!.ir!.element!
    const equivalentHtml = owner.innerHTML
    owner.replaceChildren()
    owner.insertAdjacentHTML('afterbegin', equivalentHtml)
    await vi.runAllTimersAsync()
    serialize.mockClear()
    expect(first.es.snapshotMarkdown()).toBe(owner.innerHTML)
    expect(serialize).not.toHaveBeenCalled()

    const second = boot({
      mode: 'ir',
      blocks: 585,
      nested: true,
      seed: true,
      getValue,
      serialize,
    })
    second.es.startIncrementalSeed()
    second.es.markUserInput()
    h.inner!.ir!.element!.children[0].textContent = 'user edit'
    await vi.runAllTimersAsync()
    expect(second.es.snapshotMarkdown()).toBe('AUTHORITATIVE WHILE PARTIAL')
  })

  it('retries when a delayed exact setValue replaces the IR owner identity', async () => {
    const getValue = vi.fn(() => 'AUTHORITATIVE WHILE PARTIAL')
    const serialize = vi.fn((html: string) => html)
    const { es } = boot({
      mode: 'ir',
      blocks: 585,
      nested: true,
      seed: true,
      getValue,
      serialize,
    })
    const equivalent = h.inner!.ir!.element!.innerHTML
    es.startIncrementalSeed()
    vi.advanceTimersByTime(1)
    const replacement = irElement(585, true)
    expect(replacement.innerHTML).toBe(equivalent)
    h.inner!.ir!.element = replacement

    await vi.runAllTimersAsync()
    serialize.mockClear()
    expect(es.snapshotMarkdown()).toBe(equivalent)
    expect(serialize).not.toHaveBeenCalled()
  })

  it.each([
    ['small IR', { mode: 'ir', blocks: 2 }],
    ['WYSIWYG', { mode: 'wysiwyg', blocks: 700 }],
  ])('falls back to getValue for %s snapshots', (_label, options) => {
    const getValue = vi.fn(() => 'AUTHORITATIVE FALLBACK')
    const { es } = boot({ ...options, getValue })

    expect(es.snapshotMarkdown()).toBe('AUTHORITATIVE FALLBACK')
    expect(getValue).toHaveBeenCalledTimes(1)
  })

  it('retains initial exact WYSIWYG bytes while its rendered baseline is unchanged', () => {
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => 'canonical rendered\n',
      initialMarkdown: 'canonical rendered\n\n',
    })

    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
  })

  it('revokes exact source ownership on genuine input', () => {
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => 'canonical rendered\n',
      initialMarkdown: 'canonical rendered\n\n',
    })
    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')

    es.markUserInput()

    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n')
  })

  it('updates and rebaselines the incremental snapshot after DOM edits and invalidation', () => {
    const getValue = vi.fn(() => 'FULL')
    const { es } = boot({
      mode: 'ir',
      blocks: 700,
      getValue,
      serialize: (html) => html,
    })
    const editor = h.inner?.ir?.element
    expect(editor).toBeDefined()
    es.snapshotMarkdown()
    ;(editor!.children[0] as HTMLElement).textContent = 'changed once'
    expect(es.snapshotMarkdown()).toBe(editor!.innerHTML)

    es.invalidate()
    ;(editor!.children[1] as HTMLElement).textContent = 'changed twice'
    expect(es.snapshotMarkdown()).toBe(editor!.innerHTML)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('self-heals an incremental snapshot inconsistency without falling back to getValue', () => {
    const getValue = vi.fn(() => 'FULL')
    let failChangedBlockOnce = true
    const { es } = boot({
      mode: 'ir',
      blocks: 700,
      getValue,
      serialize: (html) => {
        if (failChangedBlockOnce && html === '<p>changed</p>') {
          failChangedBlockOnce = false
          throw new Error('narrow incremental serialize failed')
        }
        return html
      },
    })
    const editor = h.inner?.ir?.element
    es.snapshotMarkdown()
    ;(editor!.children[0] as HTMLElement).textContent = 'changed'

    expect(es.snapshotMarkdown()).toBe(editor!.innerHTML)
    expect(getValue).not.toHaveBeenCalled()
  })

  it('prepareRewrap flushes unsynced live bytes before requesting authoritative rewrap', () => {
    const getValue = vi.fn(() => 'live unsynced edit')
    const { es, edits } = boot({ getValue })
    es.markUserInput()
    es.schedule()

    es.prepareRewrap()

    expect(edits()).toEqual([
      [
        {
          command: 'edit',
          content: 'live unsynced edit',
          rewrapDocument: true,
        },
      ],
    ])
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(1)
  })

  it('requests host bytes without flushing a render-only pending callback', () => {
    const getValue = vi.fn(() => 'mode-normalized bytes')
    const { es, post } = boot({ getValue })
    es.schedule()

    es.prepareRewrap()

    expect(post).toHaveBeenCalledWith({ command: 'request-rewrap-document' })
    expect(getValue).not.toHaveBeenCalled()
    vi.advanceTimersByTime(250)
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('posts nothing on idle while suppressed (a partial getValue would truncate the file)', () => {
    const { es, edits, docModes } = boot({ suppressed: true })
    es.schedule()
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(0)
    expect(docModes()).toHaveLength(0)
  })

  it('posts nothing on flush while suppressed', () => {
    const { es, edits } = boot({ suppressed: true })
    es.flush()
    expect(edits()).toHaveLength(0)
  })

  it('reportDocMode posts once per active-set signature (deduped)', () => {
    const { es, docModes } = boot()
    es.reportDocMode()
    es.reportDocMode()
    expect(docModes()).toHaveLength(1)
    expect(docModes()[0][0]).toMatchObject({
      command: 'docMode',
      contentVisibility: false,
      streaming: false,
      incremental: false,
    })
  })

  it('flush audits the incremental cache and posts the AUTHORITATIVE getValue on drift', () => {
    // Large IR doc → incremental path. Force the incremental serialize to disagree with the
    // full getValue(): the guard must log the drift, drop the cache, and save the
    // authoritative bytes — never the drifted incremental result (data-loss safety net).
    // identity serialize → the incremental cache is the joined block HTML, deterministically
    // DIFFERENT from the authoritative getValue() below → the drift guard must trip.
    const { es, edits } = boot({
      mode: 'ir',
      blocks: 700,
      serialize: (html) => html,
      getValue: () => 'AUTHORITATIVE',
    })
    es.flush()
    expect(edits()).toHaveLength(1)
    expect(edits()[0][0].content).toBe('AUTHORITATIVE')
    expect(h.logToHost).toHaveBeenCalledTimes(1)
  })
})
