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

  // Task 602: a flush cancels the idle timer, so the idle post's mode-aware undo window never
  // ran for flushed typing and a large WYSIWYG document kept the 800 ms default instead of 2 s.
  describe('undo delay after a flushed edit (Task 602)', () => {
    const LARGE = 25_000
    const flushRoutes: Array<
      [string, (es: ReturnType<typeof boot>['es']) => void]
    > = [
      ['flush()', (es) => es.flush()],
      ['flushHistoryInput()', (es) => es.flushHistoryInput()],
      ['settleBlockActionInput()', (es) => es.settleBlockActionInput()],
      ['prepareRewrap()', (es) => es.prepareRewrap()],
    ]

    it.each(flushRoutes)(
      '%s widens a large WYSIWYG document to the 2 s window',
      (_name, flushRoute) => {
        const { es, edits } = boot({ mode: 'wysiwyg', textLen: LARGE })
        es.markUserInput()
        es.schedule()
        flushRoute(es)
        expect(edits()).toHaveLength(1)
        expect(h.inner?.options?.undoDelay).toBe(2_000)
      },
    )

    it('keeps a small WYSIWYG document and a large IR document on the 800 ms window', () => {
      const small = boot({ mode: 'wysiwyg', textLen: 100 })
      small.es.markUserInput()
      small.es.schedule()
      small.es.flush()
      expect(small.edits()).toHaveLength(1)
      expect(h.inner?.options?.undoDelay).toBe(800)

      const largeIr = boot({ mode: 'ir', textLen: LARGE })
      largeIr.es.markUserInput()
      largeIr.es.schedule()
      largeIr.es.flush()
      expect(largeIr.edits()).toHaveLength(1)
      expect(h.inner?.options?.undoDelay).toBe(800)
    })

    it('leaves the window alone when a suppressed flush posts nothing', () => {
      const { es, edits } = boot({
        mode: 'wysiwyg',
        textLen: LARGE,
        suppressed: true,
      })
      es.markUserInput()
      es.schedule()
      es.flush()
      expect(edits()).toHaveLength(0)
      expect(h.inner?.options?.undoDelay).toBe(800)
    })

    it('matches the idle post for the same large WYSIWYG document', async () => {
      const { es, edits } = boot({ mode: 'wysiwyg', textLen: LARGE })
      es.markUserInput()
      es.schedule()
      // A large non-IR idle post awaits a paint before it serializes.
      await vi.advanceTimersByTimeAsync(250)
      expect(edits()).toHaveLength(1)
      expect(h.inner?.options?.undoDelay).toBe(2_000)
    })
  })

  // Task 601: the host must hold a scheduled edit before an Undo/Redo transition is posted.
  it('flushHistoryInput() posts a scheduled edit at once, and only once', () => {
    const { es, edits } = boot({ getValue: () => 'TYPED' })
    es.schedule()
    expect(es.flushHistoryInput()).toBe(true)
    expect(edits()).toEqual([
      [{ command: 'edit', content: 'TYPED', rewrapDocument: false }],
    ])
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(1)
    expect(es.flushHistoryInput()).toBe(false)
    expect(edits()).toHaveLength(1)
  })

  it('flushHistoryInput() posts nothing without a scheduled edit, or while suppressed', () => {
    const idle = boot({ getValue: () => 'SETTLED' })
    expect(idle.es.flushHistoryInput()).toBe(false)
    expect(idle.edits()).toHaveLength(0)
    const suppressed = boot({ getValue: () => 'PARTIAL', suppressed: true })
    suppressed.es.schedule()
    expect(suppressed.es.flushHistoryInput()).toBe(false)
    vi.advanceTimersByTime(250)
    expect(suppressed.edits()).toHaveLength(0)
  })

  // Task 602: history messages must compare with the edits the host received, so SV uses the
  // same text as an SV edit post (without Vditor's trailing editable newline span).
  it('historyText() reads the SV edit form in SV and getValue() otherwise', () => {
    let mode = 'sv'
    const { es } = boot({ mode: 'sv', getValue: () => 'a\n\n' })
    ;(window.vditor as any).getCurrentMode = () => mode
    const svElement = document.createElement('div')
    svElement.innerHTML =
      '<div data-block="0"><span>a</span><span data-type="newline">\n</span></div>'
    h.activeEl = svElement as unknown as { textContent: string }
    expect(es.historyText()).toBe('a')

    mode = 'ir'
    expect(es.historyText()).toBe('a\n\n')
  })

  it('flushHistoryInput() keeps exact host bytes that still own the rendered baseline', () => {
    const exact = '| A | B |\n| --- | --- |\n'
    const canonical = '| A | B |\n| - | - |\n'
    const { es, edits } = boot({
      mode: 'wysiwyg',
      getValue: () => canonical,
      initialMarkdown: exact,
    })
    es.schedule()
    expect(es.flushHistoryInput()).toBe(true)
    vi.advanceTimersByTime(250)
    expect(edits()).toHaveLength(0)
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
    // Task 607: the published typing leaves no owned pair; the rendering is never exact.
    expect(es.snapshotExactMarkdown()).toBeNull()
  })

  it('a save flush keeps exact bytes the host holds instead of posting the rendered serialization', () => {
    // Task 196: Find/block actions post exact bytes; the will-save flush (save-flush.ts) must not normalize them.
    const exact = '| A | B |\n| --- | --- |\nchanged\n'
    const rendered = '| A | B |\n| - | - |\nchanged\n'
    const { es, edits } = boot({ mode: 'wysiwyg', getValue: () => rendered })
    es.postExact(exact)
    es.markUserInput(false)
    es.schedule()
    es.flush()
    vi.advanceTimersByTime(250)
    expect(edits()).toEqual([
      [
        {
          command: 'edit',
          content: exact,
          exact: true,
          requestId: expect.any(String),
        },
      ],
    ])
    expect(es.snapshotExactMarkdown()).toBe(exact)
  })

  it('a save flush still posts typing made after an exact transaction', () => {
    const exact = '| A | B |\n| --- | --- |\n'
    const rendered = '| A | B |\n| - | - |\ntyped\n'
    const { es, edits } = boot({ mode: 'wysiwyg', getValue: () => rendered })
    es.postExact(exact)
    es.markUserInput()
    es.flush()
    expect(edits().at(-1)?.[0].content).toBe(rendered)
  })

  describe('exact ownership across a mode switch (Task 196)', () => {
    const exact = '|A|B|\n|---|---|\n'
    function switchable(irDom: string) {
      let mode = 'ir'
      let rendered = '| A | B |\n| --- | --- |\n'
      const booted = boot({
        getValue: () => rendered,
        serialize: () => irDom,
        initialMarkdown: exact,
      })
      ;(window.vditor as any).getCurrentMode = () => mode
      return {
        ...booted,
        toWysiwyg() {
          mode = 'wysiwyg'
          rendered = '| A | B |\n| - | - |\n'
        },
      }
    }

    it('keeps the exact bytes when nothing changed before the switch', () => {
      const view = switchable('| A | B |\n| --- | --- |\n')
      expect(view.es.snapshotPair().exact).toBe(exact)
      const revision = view.es.snapshotRevision()
      view.toWysiwyg()
      expect(view.es.snapshotPair()).toEqual({
        exact,
        rendered: '| A | B |\n| - | - |\n',
      })
      expect(view.es.snapshotRevision()).toBe(revision)
    })

    it('revokes them when the previous mode was edited before the switch', () => {
      const view = switchable('| A | B |\n| --- | --- |\nedited\n')
      expect(view.es.snapshotPair().exact).toBe(exact)
      view.toWysiwyg()
      expect(view.es.snapshotPair().exact).toBeNull()
    })

    it('revokes them after typing', () => {
      const view = switchable('| A | B |\n| --- | --- |\n')
      expect(view.es.snapshotPair().exact).toBe(exact)
      view.es.markUserInput()
      view.toWysiwyg()
      expect(view.es.snapshotPair().exact).toBeNull()
    })

    // The two cases above anchor in IR and switch away; `serializeModeDom`'s IR branch proves the
    // previous mode's DOM still round-trips. These exercise its other branches: anchoring in
    // WYSIWYG/SV and switching away, and the "the inner mode element is gone" fallback.
    it('reanchors a WYSIWYG-anchored switch through the WYSIWYG DOM serializer', () => {
      // Switching away to IR (not SV) keeps `vditor.getValue()` the live-rendered read for both
      // legs — SV's own live read goes through `activeModeElement`/`serializeSvForHost` instead,
      // which is exercised by the SV-anchored case below.
      const wysiwygRendered = '| A | B |\n| - | - |\n'
      const irRendered = '| A | B |\n|---|---|\nafter-switch\n'
      let mode = 'wysiwyg'
      const { es } = boot({
        mode: 'wysiwyg',
        getValue: () => (mode === 'wysiwyg' ? wysiwygRendered : irRendered),
        initialMarkdown: exact,
      })
      ;(window.vditor as any).getCurrentMode = () => mode
      // The WYSIWYG DOM's own serializer always reproduces the anchored render because nothing
      // in that (hidden, but still mounted) DOM changed.
      ;(h.inner as any).wysiwyg = { element: document.createElement('div') }
      ;(h.inner as any).lute = {
        ...h.inner!.lute,
        VditorDOM2Md: () => wysiwygRendered,
      }
      expect(es.snapshotPair()).toEqual({ exact, rendered: wysiwygRendered })

      mode = 'ir'
      expect(es.snapshotPair()).toEqual({ exact, rendered: irRendered })
    })

    it('reanchors an SV-anchored switch through the SV DOM serializer', () => {
      const svRendered = 'sv rendered text'
      const wysiwygRendered = '| A | B |\n|---|---|\nafter-switch\n'
      let mode = 'sv'
      const { es } = boot({
        mode: 'sv',
        getValue: () => (mode === 'sv' ? svRendered : wysiwygRendered),
        initialMarkdown: exact,
      })
      ;(window.vditor as any).getCurrentMode = () => mode
      // `serializeSvForHost` reads the SV element's own text; a plain text node reproduces it
      // without the "drop Vditor's trailing editable newline span" special case. The live read
      // (`activeModeElement`, `h.activeEl`) and Vditor's per-mode DOM cache that `serializeModeDom`
      // reads after the switch (`h.inner.sv`) are set to the SAME element: both describe "the SV
      // mode's DOM", live vs. cached.
      const svElement = document.createElement('div')
      svElement.append(document.createTextNode(svRendered))
      h.activeEl = svElement as unknown as { textContent: string }
      ;(h.inner as any).sv = { element: svElement }
      expect(es.snapshotPair()).toEqual({ exact, rendered: svRendered })

      mode = 'wysiwyg'
      expect(es.snapshotPair()).toEqual({ exact, rendered: wysiwygRendered })
    })

    it('does not reanchor when the anchored mode no longer has a live DOM element', () => {
      // `serializeModeDom` returns null when the previous mode's element is gone (e.g. a full
      // re-init between the anchor and the switch); the switch must revoke, not guess.
      const wysiwygRendered = '| A | B |\n| - | - |\n'
      const irRendered = '| A | B |\n|---|---|\nafter-switch\n'
      let mode = 'wysiwyg'
      const { es } = boot({
        mode: 'wysiwyg',
        getValue: () => (mode === 'wysiwyg' ? wysiwygRendered : irRendered),
        initialMarkdown: exact,
      })
      ;(window.vditor as any).getCurrentMode = () => mode
      expect(es.snapshotPair()).toEqual({ exact, rendered: wysiwygRendered })

      delete (h.inner as any).wysiwyg
      mode = 'ir'
      expect(es.snapshotPair()).toEqual({ exact: null, rendered: irRendered })
    })
  })

  it('postExact sends known formatter bytes once and cancels a pending serialize', () => {
    const getValue = vi.fn(() => 'CANONICALIZED DOM')
    const { es, edits } = boot({ getValue })
    es.schedule()

    es.postExact('EXACT FORMATTER BYTES')

    expect(edits()).toEqual([
      [
        {
          command: 'edit',
          content: 'EXACT FORMATTER BYTES',
          exact: true,
          requestId: expect.any(String),
        },
      ],
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
    expect(es.snapshotExactMarkdown()).toBeNull()

    const revokedRevision = es.snapshotRevision()
    expect(revokedRevision).not.toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBeNull()
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

  it('recalls revoked exact bytes when genuine input leaves the rendering unchanged', () => {
    const { es } = boot({
      mode: 'wysiwyg',
      getValue: () => 'canonical rendered\n',
      initialMarkdown: 'canonical rendered\n\n',
    })
    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
    const ownedRevision = es.snapshotRevision()

    es.markUserInput()

    // Task 607: the revoked pair is remembered; its unchanged rendering proves it again.
    expect(es.snapshotRevision()).not.toBe(ownedRevision)
    expect(es.snapshotExactMarkdown()).toBe('canonical rendered\n\n')
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
    // Task 607: without host bytes there is no owned pair, so no exact source.
    expect(pair.exact).toBeNull()
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
      exact: null,
      rendered: 'changed canonical DOM',
    })
    const revokedRevision = es.snapshotRevision()
    expect(revokedRevision).not.toBe(initialRevision)
    expect(es.snapshotExactMarkdown()).toBeNull()
    expect(es.snapshotRevision()).toBe(revokedRevision)
  })
})

// Parity against the vendored Lute: `rendered` equals a full serializer call on the live DOM in
// every IR serializer state (incremental, seeded, pending fallback, reseed, invalidate) and in
// WYSIWYG. The fixture is noncanonical on purpose: CRLF, a compact table delimiter, doubled
// spaces and trailing blank lines keep the exact bytes different from the rendered bytes.
// Each case renders and serializes a 737-block document through GopherJS Lute; coverage
// instrumentation makes that slower than the default per-test timeout.
describe('snapshotPair rendered parity with the vendored Lute', {
  timeout: 60_000,
}, () => {
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
    isSuppressed: () => boolean = () => false,
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
      lute: real[mode].lute,
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
      isSuppressed,
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

  // Task 574 review: the exact transaction anchors its rendered baseline lazily. An untrusted
  // edit (toolbar or bubble formatting) that lands before the first read must not be paired
  // with the pre-edit exact bytes; a render-only callback must keep noncanonical exact bytes.
  for (const mode of ['ir', 'wysiwyg'] as const) {
    it(`revokes exact ownership when an untrusted edit precedes the first read (${mode})`, () => {
      const exact = 'alpha\n\nbeta\n'
      const { es, el } = bootReal(mode, exact)
      const initialRevision = es.snapshotRevision()
      el.innerHTML = real[mode].render('**alpha**\n\nbeta\n')
      es.schedule()

      const pair = es.snapshotPair()

      expect(pair.rendered).toBe('**alpha**\n\nbeta\n')
      expect(pair.exact).toBeNull()
      expect(es.snapshotRevision()).not.toBe(initialRevision)
    })

    it(`revokes stale exact bytes after an undo that edit-sync did not schedule (${mode})`, () => {
      const exact = 'alpha\n\nbeta\n'
      const { es, el } = bootReal(mode, exact)
      es.postExact('alpha\n\n## beta\n')
      el.innerHTML = real[mode].render('alpha\n\n## beta\n')
      // Vditor's history engine restores the earlier DOM without an input callback.
      el.innerHTML = real[mode].render(exact)
      es.markEditorChange()

      // Task 607: the stale pair is revoked and the rendering is not promoted to exact.
      expect(es.snapshotPair()).toEqual({ exact: null, rendered: exact })
    })

    it(`keeps exact bytes when a redo restores their rendering (${mode})`, () => {
      const exact = '| A | B |\n|---|---|\n| 1 | 2 |\n'
      const { es, el, canonical } = bootReal(mode, exact)
      es.postExact(exact)
      el.innerHTML = real[mode].render('changed\n')
      el.innerHTML = real[mode].render(exact)
      es.markEditorChange()

      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })
    })

    it(`keeps noncanonical exact bytes across a render-only callback (${mode})`, () => {
      const exact = '| A | B |\n|---|---|\n| 1 | 2 |\n\n\n'
      const { es, canonical } = bootReal(mode, exact)
      expect(canonical).not.toBe(exact)
      const initialRevision = es.snapshotRevision()
      es.schedule()

      expect(es.snapshotPair()).toEqual({ exact, rendered: canonical })
      expect(es.snapshotRevision()).toBe(initialRevision)
    })
  }

  it('revokes exact ownership when the edit-before-anchor projection throws', () => {
    const exact = 'alpha\n\nbeta\n'
    const { es, el } = bootReal('ir', exact)
    ;(h.inner as { lute: unknown }).lute = {
      ...real.ir.lute,
      Md2VditorIRDOM: () => {
        throw new Error('render failed')
      },
      VditorIRDOM2Md: real.ir.serialize,
    }
    el.innerHTML = real.ir.render('**alpha**\n\nbeta\n')
    es.schedule()

    expect(es.snapshotPair()).toEqual({
      exact: null,
      rendered: '**alpha**\n\nbeta\n',
    })
  })

  it('keeps the first-read anchoring when no visual projection is available', () => {
    const exact = 'alpha\n\nbeta\n'
    const { es, el } = bootReal('ir', exact)
    ;(h.inner as { lute: unknown }).lute = {}
    el.innerHTML = real.ir.render('**alpha**\n\nbeta\n')
    es.schedule()

    expect(es.snapshotPair()).toEqual({
      exact,
      rendered: '**alpha**\n\nbeta\n',
    })
  })

  // Task 607 (RED until INV-A, the D3 rebase and pull-based authority land). The fixture's rendered
  // serialization differs from its source in the table delimiter row and cell padding, so
  // Vditor's own serialization is never a valid stand-in for the host bytes.
  const normalizing =
    'Intro   paragraph\n\n| a | b |\n|--|--|\n| 1 |  2 |\n\nTail paragraph here\n\n* star item\n'

  const typeInto = (
    el: HTMLElement,
    startsWith: string,
    text: string,
  ): void => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.nodeValue?.startsWith(startsWith))
      node = walker.nextNode()
    if (!node) throw new Error('fixture text missing')
    node.nodeValue = text
  }

  // The settled Task 607 seam (the contract section of the task record).
  interface AuthorityEditSync {
    acquireExactAuthority(opts?: {
      publish?: boolean
      background?: boolean
    }): Promise<{ exact: string; rendered: string } | null>
    receiveExactAuthority(message: { requestId: string; content: string }): void
    receiveExactRefusal(message: { requestId: string; content: string }): void
  }
  const authority = (es: unknown): AuthorityEditSync => es as AuthorityEditSync
  const posted = (post: ReturnType<typeof vi.fn>) =>
    post.mock.calls.map((call) => call[0])
  const authorityRequest = (post: ReturnType<typeof vi.fn>) =>
    posted(post).find(
      (message) => message?.command === 'request-exact-authority',
    )
  const hostPost = (): ReturnType<typeof vi.fn> =>
    (
      globalThis as unknown as {
        vscode: { postMessage: ReturnType<typeof vi.fn> }
      }
    ).vscode.postMessage
  const exactEdits = (post: ReturnType<typeof vi.fn>) =>
    posted(post).filter((m) => m?.command === 'edit' && m.exact === true)
  // Type into the Tail paragraph, mark the input trusted and let the plain edit post (250 ms idle),
  // so the host holds the typed text and the D3 rebase no longer applies.
  const typeTailAndPublish = (
    es: ReturnType<typeof createEditSync>,
    el: HTMLElement,
  ): void => {
    typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
    es.markUserInput(true)
    es.schedule()
    vi.advanceTimersByTime(250)
  }
  // Vditor's setValue stand-in so a refusal rollback is observable.
  const withSetValue = (mode: 'ir' | 'wysiwyg', el: HTMLElement) => {
    const setValue = vi.fn((markdown: string) => {
      el.innerHTML = real[mode].render(markdown)
    })
    ;(window.vditor as unknown as { setValue: unknown }).setValue = setValue
    return setValue
  }

  for (const mode of ['ir', 'wysiwyg'] as const) {
    describe(`exact ownership after a trusted edit (Task 607, ${mode})`, () => {
      it('control: a fresh document reports the host bytes as exact', () => {
        const { es, canonical } = bootReal(mode, normalizing)
        expect(canonical).not.toBe(normalizing)
        expect(es.snapshotPair()).toEqual({
          exact: normalizing,
          rendered: canonical,
        })
      })

      it('control: a remembered owned pair stays while the rendering is unchanged', () => {
        const { es, canonical } = bootReal(mode, normalizing)
        es.schedule()
        es.snapshotPair()
        es.schedule()
        expect(es.snapshotPair()).toEqual({
          exact: normalizing,
          rendered: canonical,
        })
      })

      it('control: a round-trip document keeps exact equal to rendered after typing', () => {
        const roundTrip = 'alpha\n\nbeta\n'
        const { es, el } = bootReal(mode, roundTrip)
        typeInto(el, 'beta', 'betaX')
        es.markUserInput(true)
        es.schedule()
        const pair = es.snapshotPair()
        expect(pair.rendered).toBe('alpha\n\nbetaX\n')
        expect(pair.exact).toBe(pair.rendered)
      })

      it('does not report Vditor’s rendered serialization as exact after a trusted edit on a normalizing document', () => {
        const { es, el, canonical } = bootReal(mode, normalizing)
        expect(canonical).not.toBe(normalizing)
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()

        const pair = es.snapshotPair()

        expect(pair.rendered).not.toBe(canonical)
        // INV-A: the pair must not promote the normalized rendering to exact authority.
        expect(pair.exact).not.toBe(pair.rendered)
        expect(es.snapshotExactMarkdown()).not.toBe(pair.rendered)
      })

      it('rebases unpublished typing inside one paragraph onto the prior exact bytes (D3)', () => {
        const { es, el } = bootReal(mode, normalizing)
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()

        const pair = es.snapshotPair()

        expect(pair.exact).toBe(
          normalizing.replace('Tail paragraph here', 'Tail paragraphX here'),
        )
      })

      it('returns no exact when one span would drag normalized bytes along (D3)', () => {
        const { es, el, canonical } = bootReal(mode, normalizing)
        // Two typed spans with the normalized table between them: one common prefix/suffix span
        // would rewrite the table padding, so the change cannot be mapped to the typed spans only.
        typeInto(el, 'Intro', 'Intro   paragraphX')
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()

        const pair = es.snapshotPair()

        expect(pair.rendered).not.toBe(canonical)
        expect(pair.exact).toBeNull()
      })

      it('recovers the prior exact bytes for a block action after an edit and its Undo through host authority', async () => {
        const { es, el, canonical } = bootReal(mode, normalizing)
        const post = hostPost()
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()
        vi.advanceTimersByTime(5000)
        // The host history returns to the prior exact bytes; Vditor restores the earlier DOM.
        typeInto(el, 'Tail paragraphX', 'Tail paragraph here')
        es.markEditorChange()

        es.settleBlockActionInput()

        // Contract rule 2(b), tightened: after a plain post the host text is unknown, so the
        // remembered pair is not recalled from the rendering alone; host authority proves it.
        expect(es.snapshotExactMarkdown()).toBeNull()
        const pending = authority(es).acquireExactAuthority({ publish: true })
        authority(es).receiveExactAuthority({
          requestId: authorityRequest(post).requestId,
          content: normalizing,
        })
        expect(await pending).toEqual({
          exact: normalizing,
          rendered: canonical,
        })
        expect(es.snapshotExactMarkdown()).toBe(normalizing)
      })

      it('postExact carries the exact bytes it replaces as `before`', () => {
        const { es } = bootReal(mode, normalizing)
        const post = hostPost()
        es.postExact('Intro paragraph\n\n## Tail\n')

        const edit = post.mock.calls
          .map((call) => call[0])
          .find((message) => message?.command === 'edit')
        expect(edit).toMatchObject({
          exact: true,
          content: 'Intro paragraph\n\n## Tail\n',
          before: normalizing,
          requestId: expect.any(String),
        })
      })

      it('adopts an exact-authority reply that the rendering proves', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        const hostText = normalizing.replace(
          'Tail paragraph here',
          'Tail paragraphX here',
        )

        const pending = authority(es).acquireExactAuthority()
        const request = authorityRequest(post)
        expect(request).toBeDefined()
        authority(es).receiveExactAuthority({
          requestId: request.requestId,
          content: hostText,
        })

        expect((await pending)?.exact).toBe(hostText)
        expect(es.snapshotPair().exact).toBe(hostText)
      })

      it('rejects an exact-authority reply the rendering does not prove', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)

        const pending = authority(es).acquireExactAuthority()
        const request = authorityRequest(post)
        expect(request).toBeDefined()
        authority(es).receiveExactAuthority({
          requestId: request.requestId,
          content: 'unrelated host text\n',
        })

        expect(await pending).toBeNull()
        expect(es.snapshotPair().exact).not.toBe('unrelated host text\n')
      })

      it('declines with no post when no authority reply arrives within 1.5 s (D4)', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        post.mockClear()

        const pending = authority(es).acquireExactAuthority()
        await vi.advanceTimersByTimeAsync(1600)

        expect(await pending).toBeNull()
        expect(
          post.mock.calls.filter((call) => call[0]?.exact === true),
        ).toHaveLength(0)
      })

      it('posts the combined D3 write with `before` equal to the prior exact bytes', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()
        // The action plans on the rebased pair (contract rule 9: acquire before planning); that
        // read is what makes the prior exact bytes the owned base the post names.
        expect(es.snapshotPair().exact).not.toBeNull()

        es.postExact('Intro   paragraph\n\n## Tail paragraphX here\n')

        expect(exactEdits(post)).toHaveLength(1)
        expect(exactEdits(post)[0]).toMatchObject({
          content: 'Intro   paragraph\n\n## Tail paragraphX here\n',
          before: normalizing,
        })
      })

      it('rolls an action back on a host refusal when no plain edit followed', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        const setValue = withSetValue(mode, el)
        es.snapshotPair()
        const action = 'Intro   paragraph\n\n## Tail paragraph here\n'
        es.postExact(action)
        el.innerHTML = real[mode].render(action)
        const { requestId } = exactEdits(post)[0]
        const hostText = `${normalizing}`

        authority(es).receiveExactRefusal({ requestId, content: hostText })

        expect(setValue).toHaveBeenCalledWith(hostText)
        expect(es.snapshotPair().exact).toBe(hostText)
      })

      it('keeps the DOM and clears ownership on a refusal after a later plain post', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        const setValue = withSetValue(mode, el)
        es.snapshotPair()
        es.postExact('Intro   paragraph\n\n## Tail paragraph here\n')
        const { requestId } = exactEdits(post)[0]
        typeInto(el, 'Tail paragraph', 'Tail paragraphY here')
        es.markUserInput(true)
        es.schedule()
        vi.advanceTimersByTime(250)

        authority(es).receiveExactRefusal({ requestId, content: normalizing })

        expect(setValue).not.toHaveBeenCalled()
        expect(es.snapshotPair().exact).toBeNull()
      })

      it('posts Rewrap Document with the host-sent text as `before` after published typing', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        // The host's rewrap-document reply: its text, which includes the published typing.
        const hostText = normalizing.replace(
          'Tail paragraph here',
          'Tail paragraphX here',
        )
        const rewrapped = hostText.replace(
          'Tail paragraphX here',
          'Tail\nparagraphX here',
        )

        es.postExact(rewrapped, { before: hostText })

        expect(exactEdits(post)).toHaveLength(1)
        expect(exactEdits(post)[0]).toMatchObject({
          content: rewrapped,
          before: hostText,
        })
      })

      it('a background acquire never flushes pending typing and asks once after it publishes', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        typeInto(el, 'Tail paragraphX', 'Tail paragraphXY here')
        es.markUserInput(true)
        es.schedule()
        post.mockClear()

        const pending = authority(es).acquireExactAuthority({
          background: true,
        })
        await vi.advanceTimersByTimeAsync(200)
        expect(posted(post).filter((m) => m?.command === 'edit')).toHaveLength(
          0,
        )
        expect(authorityRequest(post)).toBeUndefined()

        await vi.advanceTimersByTimeAsync(60)
        const commands = posted(post).map((m) => m?.command)
        expect(commands.filter((c) => c === 'edit')).toHaveLength(1)
        expect(
          commands.filter((c) => c === 'request-exact-authority'),
        ).toHaveLength(1)
        expect(commands.indexOf('edit')).toBeLessThan(
          commands.indexOf('request-exact-authority'),
        )
        const hostText = normalizing.replace(
          'Tail paragraph here',
          'Tail paragraphXY here',
        )
        authority(es).receiveExactAuthority({
          requestId: authorityRequest(post).requestId,
          content: hostText,
        })
        expect((await pending)?.exact).toBe(hostText)
      })

      it('an untrusted rendering change drops the owned base, so a rendering-planned exact post has no `before`', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        expect(es.snapshotPair().exact).toBe(normalizing)
        // A toolbar-style edit: the DOM changes without trusted input.
        el.innerHTML = real[mode].render(
          normalizing.replace('Intro   paragraph', '**Intro** paragraph'),
        )
        expect(es.snapshotExactMarkdown()).toBeNull()

        const planned = es.snapshotMarkdown()
        es.postExact(`${planned}appended\n`)

        expect(exactEdits(post)).toHaveLength(1)
        expect(exactEdits(post)[0]).not.toHaveProperty('before')
      })

      it('control: an action’s own setValue keeps the owned base for its exact post', () => {
        let applying = false
        const { es, el } = bootReal(mode, normalizing, false, () => applying)
        const post = hostPost()
        expect(es.snapshotPair().exact).toBe(normalizing)
        const action = normalizing.replace(
          'Tail paragraph here',
          '## Tail paragraph here',
        )
        es.setActionApplying(true)
        applying = true
        el.innerHTML = real[mode].render(action)
        // A read inside the action's apply window sees its own rebuild.
        expect(es.snapshotExactMarkdown()).toBeNull()
        applying = false
        es.setActionApplying(false)

        es.postExact(action)

        expect(exactEdits(post)[0]).toMatchObject({
          content: action,
          before: normalizing,
        })
      })

      it('a streamed or host-updated rendering change drops the owned base', () => {
        let streaming = false
        const { es, el } = bootReal(mode, normalizing, false, () => streaming)
        const post = hostPost()
        expect(es.snapshotPair().exact).toBe(normalizing)
        // Suppression without an action's apply window: streaming or an extension update.
        streaming = true
        el.innerHTML = real[mode].render(
          normalizing.replace('Intro   paragraph', '**Intro** paragraph'),
        )
        expect(es.snapshotExactMarkdown()).toBeNull()
        streaming = false

        es.postExact(`${es.snapshotMarkdown()}appended\n`)

        expect(exactEdits(post)).toHaveLength(1)
        expect(exactEdits(post)[0]).not.toHaveProperty('before')
      })

      it('publishes pending typing before an action without an owned base, so a refusal keeps it', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        const setValue = withSetValue(mode, el)
        // Two typed spans with normalized bytes between them: no rebase, so no owned base.
        typeInto(el, 'Intro', 'Intro   paragraphX')
        typeInto(el, 'Tail paragraph', 'Tail paragraphX here')
        es.markUserInput(true)
        es.schedule()
        expect(es.snapshotExactMarkdown()).toBeNull()
        const typedRendering = es.snapshotMarkdown()
        post.mockClear()

        // A legacy action inside the 250 ms debounce: apply window, setValue, exact post.
        es.setActionApplying(true)
        const action = `${typedRendering}appended\n`
        el.innerHTML = real[mode].render(action)
        es.setActionApplying(false)
        es.postExact(action)

        const edits = posted(post).filter((m) => m?.command === 'edit')
        expect(edits).toHaveLength(2)
        expect(edits[0]).not.toHaveProperty('exact')
        expect(edits[0].content).toBe(typedRendering)
        expect(edits[1]).toMatchObject({ exact: true, content: action })
        expect(edits[1]).not.toHaveProperty('before')

        // The host minimized the typing onto its bytes; it refuses the action with that text.
        const hostText = normalizing
          .replace('Intro   paragraph', 'Intro   paragraphX')
          .replace('Tail paragraph here', 'Tail paragraphX here')
        authority(es).receiveExactRefusal({
          requestId: edits[1].requestId,
          content: hostText,
        })
        expect(setValue).toHaveBeenCalledWith(hostText)
        expect(es.snapshotMarkdown()).toBe(typedRendering)
        vi.advanceTimersByTime(300)
        expect(posted(post).filter((m) => m?.command === 'edit')).toHaveLength(
          2,
        )
      })

      it('does not recall the pre-edit bytes after published typing is deleted again', () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        // Backspace: the rendering is the pre-edit one again, but the host holds the typed text.
        typeInto(el, 'Tail paragraphX', 'Tail paragraph here')
        es.markUserInput(true)
        es.schedule()

        expect(es.snapshotExactMarkdown()).toBeNull()
        void authority(es).acquireExactAuthority()
        expect(authorityRequest(post)).toBeDefined()
        expect(exactEdits(post)).toHaveLength(0)
      })

      it('ignores an authority reply that arrives after an exact post', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        const hostText = normalizing.replace(
          'Tail paragraph here',
          'Tail paragraphX here',
        )
        const pending = authority(es).acquireExactAuthority()
        const { requestId } = authorityRequest(post)
        const action = hostText.replace(
          'Tail paragraphX here',
          '## Tail paragraphX here',
        )

        es.postExact(action, { before: hostText })
        authority(es).receiveExactAuthority({ requestId, content: hostText })

        expect(await pending).toBeNull()
        el.innerHTML = real[mode].render(action)
        expect(es.snapshotExactMarkdown()).toBe(action)
      })

      it('resolves a background waiter when the pending edit resolves without posting', async () => {
        let suppressed = false
        const { es, el } = bootReal(mode, normalizing, false, () => suppressed)
        const post = hostPost()
        typeTailAndPublish(es, el)
        typeInto(el, 'Tail paragraphX', 'Tail paragraphXY here')
        es.markUserInput(true)
        es.schedule()
        post.mockClear()

        const pending = authority(es).acquireExactAuthority({
          background: true,
        })
        suppressed = true
        await vi.advanceTimersByTimeAsync(260)

        expect(await pending).toBeNull()
        expect(posted(post).filter((m) => m?.command === 'edit')).toHaveLength(
          0,
        )
      })

      it('gives up a background waiter after 1.5 s when the typing never publishes', async () => {
        const { es, el } = bootReal(mode, normalizing)
        const post = hostPost()
        typeTailAndPublish(es, el)
        typeInto(el, 'Tail paragraphX', 'Tail paragraphXY here')
        es.markUserInput(true)
        es.schedule()
        post.mockClear()
        let result: unknown = 'unsettled'

        void authority(es)
          .acquireExactAuthority({ background: true })
          .then((value) => {
            result = value
          })
        // Continuous typing keeps the debounce from firing.
        for (let elapsed = 0; elapsed < 1400; elapsed += 200) {
          es.schedule()
          await vi.advanceTimersByTimeAsync(200)
        }
        expect(result).toBe('unsettled')
        es.schedule()
        await vi.advanceTimersByTimeAsync(200)

        expect(result).toBeNull()
        expect(authorityRequest(post)).toBeUndefined()
      })

      it('accepts CRLF host text in the authority proof', async () => {
        const crlf = normalizing.replace(/\n/g, '\r\n')
        const { es, el } = bootReal(mode, crlf)
        const post = hostPost()
        typeTailAndPublish(es, el)
        const hostText = crlf.replace(
          'Tail paragraph here',
          'Tail paragraphX here',
        )

        const pending = authority(es).acquireExactAuthority()
        const request = authorityRequest(post)
        expect(request).toBeDefined()
        authority(es).receiveExactAuthority({
          requestId: request.requestId,
          content: hostText,
        })

        expect((await pending)?.exact).toBe(hostText)
      })
    })
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
      // Task 607: an edit the pair cannot account for leaves no exact source.
      expect(edited.exact).toBeNull()
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
