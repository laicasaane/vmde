// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'

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
import { sourceComplexitySignature } from '../../../src/shared/incremental-admission'
import { createRealLute, type RealLute } from '../testing/real-lute'

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

  it('cancels a pending canonical edit when exact host bytes still own the rendered baseline', () => {
    const exact = '| A | B |\n| --- | --- |\n'
    const canonical = '| A | B |\n| - | - |\n'
    const { es, edits } = boot({
      mode: 'wysiwyg',
      getValue: () => canonical,
      initialMarkdown: exact,
    })
    es.schedule()
    es.settleBlockActionInput()
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(0)
    expect(es.snapshotExactMarkdown()).toBe(exact)
  })

  it('flushes real typing before a block action after exact ownership is revoked', () => {
    const exact = '| A | B |\n| --- | --- |\n'
    const canonical = '| A | B |\n| - | - |\n'
    const { es, edits } = boot({
      mode: 'wysiwyg',
      getValue: () => canonical,
      initialMarkdown: exact,
    })
    es.markUserInput()
    es.schedule()
    es.settleBlockActionInput()
    expect(edits()).toHaveLength(1)
    expect(edits()[0][0].content).toBe(canonical)
    expect(es.snapshotExactMarkdown()).toBe(canonical)
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

  it('keeps source revision identity stable while reading an unchanged exact baseline', () => {
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => 'canonical rendered\n',
      initialMarkdown: 'canonical rendered\n\n',
    })
    const initialRevision = es.snapshotRevision()

    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
    expect(es.snapshotRevision()).toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
    expect(es.snapshotRevision()).toBe(initialRevision)

    es.markUserInput(false)
    expect(es.snapshotRevision()).toBe(initialRevision)
    es.markUserInput()
    expect(es.snapshotRevision()).not.toBe(initialRevision)
  })

  it('advances source revision for postExact', () => {
    const { es } = boot()
    const initialRevision = es.snapshotRevision()

    es.postExact('formatted bytes')

    expect(es.snapshotRevision()).not.toBe(initialRevision)
  })

  it('advances source revision for reseed even when rendered DOM is unchanged', () => {
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => 'same rendered DOM',
      initialMarkdown: 'original exact bytes',
    })
    const initialRevision = es.snapshotRevision()

    es.reseed(undefined, 'different exact bytes')

    expect(es.snapshotRevision()).not.toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBe('different exact bytes')
  })

  it('advances source revision for invalidate and dispose', () => {
    const { es } = boot()
    const initialRevision = es.snapshotRevision()

    es.invalidate()

    const invalidatedRevision = es.snapshotRevision()
    expect(invalidatedRevision).not.toBe(initialRevision)
    es.dispose()
    expect(es.snapshotRevision()).not.toBe(invalidatedRevision)
  })

  it('advances source revision when exact ownership is revoked by a rendered mismatch', () => {
    let rendered = 'canonical baseline'
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => rendered,
      initialMarkdown: 'exact source bytes',
    })
    const initialRevision = es.snapshotRevision()
    expect(es.snapshotExactMarkdown()).toBe('exact source bytes')
    expect(es.snapshotRevision()).toBe(initialRevision)

    rendered = 'changed canonical DOM'
    expect(es.snapshotExactMarkdown()).toBe('changed canonical DOM')

    const revokedRevision = es.snapshotRevision()
    expect(revokedRevision).not.toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBe('changed canonical DOM')
    expect(es.snapshotRevision()).toBe(revokedRevision)
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

// Task 574 Checkpoint 3: consumers that need exact bytes and the rendered serialization take both
// from one call. The pair must not add a serializer run, and `rendered` must stay byte-identical
// to Vditor's full serializer, or block-handle units misalign.
describe('snapshotPair', () => {
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

  it('makes one full serializer call in WYSIWYG where the old pair made two', () => {
    const getValue = vi.fn(() => 'canonical rendered\n')
    const { es } = boot({
      mode: 'wysiwyg',
      getValue,
      initialMarkdown: 'canonical rendered\n\n',
    })

    expect(es.snapshotPair()).toEqual({
      exact: 'canonical rendered\n\n',
      rendered: 'canonical rendered\n',
    })
    expect(getValue).toHaveBeenCalledTimes(1)

    getValue.mockClear()
    es.snapshotExactMarkdown()
    window.vditor.getValue()
    expect(getValue).toHaveBeenCalledTimes(2)
  })

  it('makes no full serializer call in large incremental IR where the old pair made one', () => {
    const getValue = vi.fn(() => 'FULL')
    const { es } = boot({
      mode: 'ir',
      blocks: 700,
      getValue,
      serialize: (html) => html,
    })

    const pair = es.snapshotPair()

    expect(pair.rendered).toBe(h.inner?.ir?.element?.innerHTML)
    expect(pair.exact).toBe(pair.rendered)
    expect(getValue).not.toHaveBeenCalled()
    es.snapshotExactMarkdown()
    window.vditor.getValue()
    expect(getValue).toHaveBeenCalledTimes(1)
  })

  it('keeps the exact-transaction revocation and revision side effects', () => {
    let rendered = 'canonical baseline'
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => rendered,
      initialMarkdown: 'exact source bytes',
    })
    const initialRevision = es.snapshotRevision()
    expect(es.snapshotPair()).toEqual({
      exact: 'exact source bytes',
      rendered: 'canonical baseline',
    })
    expect(es.snapshotRevision()).toBe(initialRevision)

    rendered = 'changed canonical DOM'
    expect(es.snapshotPair()).toEqual({
      exact: 'changed canonical DOM',
      rendered: 'changed canonical DOM',
    })
    const revokedRevision = es.snapshotRevision()
    expect(revokedRevision).not.toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBe('changed canonical DOM')
    expect(es.snapshotRevision()).toBe(revokedRevision)
  })
})

// Parity against the vendored Lute: `rendered` equals a full serializer call on the live DOM in
// every IR serializer state (incremental, seeded, pending fallback, reseed, invalidate) and in
// WYSIWYG. The fixture is noncanonical on purpose: CRLF, a compact table delimiter, doubled
// spaces and trailing blank lines keep the exact bytes different from the rendered bytes.
describe('snapshotPair rendered parity with the vendored Lute', () => {
  const noncanonical = (eol: string): string => {
    const parts: string[] = []
    for (let i = 0; i < 360; i++) {
      parts.push(`Paragraph ${i} with *emphasis*  and  spacing`)
      if (i % 40 === 0)
        parts.push(['```ts', `const x${i} = ${i}`, '```'].join(eol))
      if (i % 50 === 0)
        parts.push(['| A | B |', '|---|:-:|', `| ${i} | b |`].join(eol))
      parts.push(`- item ${i}${eol}- second`)
    }
    return `${parts.join(eol + eol)}${eol}${eol}${eol}`
  }
  let real: Record<'ir' | 'wysiwyg', RealLute>
  beforeAll(() => {
    real = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
  })
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

  function bootReal(
    mode: 'ir' | 'wysiwyg',
    exact: string,
    seeded = false,
  ): {
    es: ReturnType<typeof createEditSync>
    el: HTMLElement
    getValue: ReturnType<typeof vi.fn<() => string>>
    canonical: string
  } {
    const { render, serialize } = real[mode]
    const el = document.createElement('div')
    el.innerHTML = render(exact)
    const canonical = serialize(el.innerHTML)
    h.inner = {
      ir: { element: el },
      options: { undoDelay: 800 },
      lute: { VditorIRDOM2Md: real.ir.serialize },
    }
    h.activeEl = el as unknown as { textContent: string }
    const getValue = vi.fn(() => serialize(el.innerHTML))
    const vd = { getValue, getCurrentMode: () => mode }
    ;(globalThis as unknown as { vscode: unknown }).vscode = {
      postMessage: vi.fn(),
    }
    ;(window as unknown as { vditor: unknown }).vditor = vd
    const source = sourceComplexitySignature(exact)
    const es = createEditSync({
      isSuppressed: () => false,
      docMode: { cvActive: false, streamActive: false, docChars: exact.length },
      initialMarkdown: exact,
      ...(seeded
        ? {
            incrementalSeed: {
              markdown: canonical,
              source,
              reason: 'source-blocks' as const,
              hostMs: 0,
            },
          }
        : {}),
    })
    return { es, el, getValue, canonical }
  }

  const fullValue = (mode: 'ir' | 'wysiwyg', el: HTMLElement): string =>
    real[mode].serialize(el.innerHTML)

  const editFirstParagraph = (el: HTMLElement, text: string): void => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.nodeValue?.startsWith('Paragraph 0'))
      node = walker.nextNode()
    if (!node) throw new Error('fixture paragraph missing')
    node.nodeValue = text
  }

  for (const eol of ['\n', '\r\n']) {
    const label = eol === '\n' ? 'LF' : 'CRLF'

    it(`matches the full serializer through incremental IR edits (${label})`, () => {
      const exact = noncanonical(eol)
      const { es, el, getValue, canonical } = bootReal('ir', exact)
      expect(
        el.querySelectorAll(':scope > [data-block]').length,
      ).toBeGreaterThanOrEqual(700)
      expect(canonical).not.toBe(exact)

      const first = es.snapshotPair()
      expect(first.rendered).toBe(canonical)
      expect(first.exact).toBe(exact)
      expect(getValue).not.toHaveBeenCalled()

      editFirstParagraph(el, 'Paragraph 0 edited  in place')
      const edited = es.snapshotPair()
      expect(edited.rendered).toBe(fullValue('ir', el))
      expect(edited.rendered).not.toBe(canonical)
      expect(edited.exact).toBe(edited.rendered)
      expect(getValue).not.toHaveBeenCalled()

      es.invalidate()
      editFirstParagraph(el, 'Paragraph 0 after invalidate')
      expect(es.snapshotPair().rendered).toBe(fullValue('ir', el))
    })

    it(`matches the full serializer while seeding, after seeding and after reseed (${label})`, async () => {
      const exact = noncanonical(eol)
      const { es, el, getValue, canonical } = bootReal('ir', exact, true)

      es.startIncrementalSeed()
      const pending = es.snapshotPair()
      expect(pending).toEqual({ exact, rendered: canonical })
      expect(getValue).toHaveBeenCalledTimes(1)

      await vi.runAllTimersAsync()
      getValue.mockClear()
      const seeded = es.snapshotPair()
      expect(seeded).toEqual({ exact, rendered: canonical })
      expect(getValue).not.toHaveBeenCalled()

      editFirstParagraph(el, 'Paragraph 0 edited after seed')
      expect(es.snapshotPair().rendered).toBe(fullValue('ir', el))
      expect(getValue).not.toHaveBeenCalled()

      const rebuilt = real.ir.render(exact)
      el.innerHTML = rebuilt
      es.reseed(
        {
          markdown: canonical,
          source: sourceComplexitySignature(exact),
          reason: 'source-blocks',
          hostMs: 0,
        },
        exact,
      )
      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })
      await vi.runAllTimersAsync()
      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })

      es.postExact(exact)
      await vi.runAllTimersAsync()
      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })
      editFirstParagraph(el, 'Paragraph 0 after postExact')
      expect(es.snapshotPair().rendered).toBe(fullValue('ir', el))
    })

    it(`matches the full serializer in WYSIWYG (${label})`, () => {
      const exact = noncanonical(eol)
      const { es, el, getValue, canonical } = bootReal('wysiwyg', exact)

      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })
      expect(getValue).toHaveBeenCalledTimes(1)
      editFirstParagraph(el, 'Paragraph 0 edited in WYSIWYG')
      expect(es.snapshotPair().rendered).toBe(fullValue('wysiwyg', el))
    })
  }
})
