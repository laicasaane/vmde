// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { createRealLute } from '../testing/real-lute'
import type { HistoryCapture } from '../util/unit-changes'
import { createModelSession, type ModelSession } from './model-session'
const renderSpy = vi.hoisted(() => vi.fn())
vi.mock('vditor/src/ts/util/processCode', () => ({
  processCodeRender: renderSpy,
}))
import type { UnitLute } from './unit-lute'

// Task 733 (task 004): the history capture of the model session (`historyPort()`), over a real text
// model, real Lute and a jsdom IR root. `capture()` returns the windows of units whose HTML changed
// since the previous capture, `restore(capture, side)` puts one side back, and the model must see
// the restore as ordinary edits so that the next sync computes the text change. The port does not
// exist before task 004's implementation segment, so these tests fail on `historyPort`.

let lute: UnitLute
beforeAll(() => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  lute = real.lute
})

interface Port {
  claimable(): boolean
  ready(): boolean
  capture(): HistoryCapture | undefined
  restore(capture: HistoryCapture, side: 'before' | 'after'): boolean
}
type WithPort = ModelSession & { historyPort(): Port }

const live: ModelSession[] = []
/** Animation frames of the current rig; `runFrames` runs them (a model rebuild waits for one). */
const frames: Array<() => void> = []

function open(markdown: string) {
  const root = document.createElement('div')
  root.className = 'vditor-reset vditor-ir'
  document.body.appendChild(root)
  const session = createModelSession({
    win: window,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => 'ir',
    isPreviewShowing: () => false,
    isStreaming: () => false,
    isComposing: () => false,
    e2e: true,
    countFallbackPublication: () => undefined,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    inViewport: () => false,
  })
  live.push(session)
  frames.length = 0
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  session.onHostText(markdown, 1)
  session.onEditDomComplete()
  const port = (session as WithPort).historyPort()
  const delta = session.deltaPort()
  let sequence = 0
  return {
    root,
    session,
    port,
    /** Sync the model with the DOM, as a publication does; returns the model text. */
    sync(): string | undefined {
      sequence += 1
      const result = delta.prepareDelta(sequence)
      expect(result.kind).not.toBe('fallback')
      return delta.modelText()
    },
    runFrames() {
      for (const cb of frames.splice(0)) cb()
    },
    /** The state a checkpoint stands for: the DOM and the model text. */
    state() {
      return { html: root.innerHTML, text: delta.modelText() }
    },
  }
}
type Rig = ReturnType<typeof open>

/** Types into a block the way the editor does: the pre-touch proof runs before the DOM changes. */
function typeInto(target: HTMLElement, text: string): void {
  target.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  ;(target.firstChild as Text).data = text
}

afterEach(() => {
  for (const session of live.splice(0)) session.dispose()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

const DOC = 'alpha\n\nbeta\n\n| a | b |\n| - | - |\n| c | d |\n| e | f |\n'

/** Edit, capture, sync; then both restores must return the two checkpoint states exactly. */
function roundTrip(r: Rig, edit: () => void) {
  const first = r.state()
  expect(r.port.capture()).toBeUndefined()
  edit()
  const capture = r.port.capture()
  expect(capture).toBeDefined()
  r.sync()
  const second = r.state()
  expect(second).not.toEqual(first)
  expect(r.port.restore(capture as HistoryCapture, 'before')).toBe(true)
  r.sync()
  expect(r.state()).toEqual(first)
  expect(r.port.restore(capture as HistoryCapture, 'after')).toBe(true)
  r.sync()
  expect(r.state()).toEqual(second)
  return capture as HistoryCapture
}

describe('capture and restore', () => {
  it('a cell edit: restore before then after returns the DOM and the model text', () => {
    const r = open(DOC)
    roundTrip(r, () => typeInto(r.root.querySelectorAll('td')[3], 'fX'))
  })

  it('a paragraph edit', () => {
    const r = open(DOC)
    roundTrip(r, () => typeInto(r.root.querySelectorAll('p')[1], 'beta!'))
  })

  it('an inserted paragraph (Enter)', () => {
    const r = open(DOC)
    roundTrip(r, () => {
      const added = document.createElement('p')
      added.setAttribute('data-block', '0')
      added.textContent = '​'
      r.root.querySelectorAll('p')[0].after(added)
      typeInto(added, 'new')
    })
  })

  it('a removed table row', () => {
    const r = open(DOC)
    roundTrip(r, () => r.root.querySelectorAll('tbody tr')[1].remove())
  })

  it('two separate edits in one interval are two windows of one capture', () => {
    const r = open(DOC)
    roundTrip(r, () => {
      typeInto(r.root.querySelectorAll('p')[0], 'alpha1')
      typeInto(r.root.querySelectorAll('td')[0], 'c1')
    })
  })

  it('captures are consecutive: the next capture holds only the change since the previous one', () => {
    const r = open(DOC)
    typeInto(r.root.querySelectorAll('p')[0], 'one')
    const first = r.port.capture() as HistoryCapture
    r.sync()
    expect(r.port.capture()).toBeUndefined()
    typeInto(r.root.querySelectorAll('p')[1], 'two')
    const second = r.port.capture() as HistoryCapture
    r.sync()
    const afterBoth = r.state()
    // Last in, first out: the second capture goes back first and leaves the first edit in place.
    expect(r.port.restore(second, 'before')).toBe(true)
    r.sync()
    expect(r.root.querySelectorAll('p')[0].textContent).toBe('one')
    expect(r.root.querySelectorAll('p')[1].textContent).toBe('beta')
    expect(r.port.restore(first, 'before')).toBe(true)
    r.sync()
    expect(r.root.querySelectorAll('p')[0].textContent).toBe('alpha')
    expect(r.port.restore(first, 'after')).toBe(true)
    expect(r.port.restore(second, 'after')).toBe(true)
    r.sync()
    expect(r.state()).toEqual(afterBoth)
  })
})

describe('restore refusals', () => {
  it('a foreign change of the window block returns false and writes nothing', () => {
    const r = open(DOC)
    typeInto(r.root.querySelectorAll('p')[1], 'beta!')
    const capture = r.port.capture() as HistoryCapture
    r.sync()
    typeInto(r.root.querySelectorAll('p')[1], 'foreign')
    const html = r.root.innerHTML
    expect(r.port.restore(capture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })

  it('a removed anchor returns false and writes nothing', () => {
    const r = open(DOC)
    typeInto(r.root.querySelectorAll('td')[3], 'fX')
    const capture = r.port.capture() as HistoryCapture
    r.sync()
    r.root.querySelector('table')?.remove()
    const html = r.root.innerHTML
    expect(r.port.restore(capture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })

  it('a capture from before a mode change cannot be restored', () => {
    const r = open(DOC)
    typeInto(r.root.querySelectorAll('p')[0], 'alpha!')
    const capture = r.port.capture() as HistoryCapture
    r.sync()
    r.session.onModeChange('wysiwyg')
    r.session.onModeChange('ir')
    const html = r.root.innerHTML
    expect(r.port.restore(capture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })

  it('an edit the pre-touch could not prove has no restorable before side', () => {
    const r = open(DOC)
    // No beforeinput: the model never saw the block's HTML before this edit.
    ;(r.root.querySelectorAll('p')[0].firstChild as Text).data = 'alpha?'
    const capture = r.port.capture()
    expect(capture).toBeDefined()
    // The model would answer a whole-text fallback for this edit, so there is no sync here.
    const html = r.root.innerHTML
    expect(r.port.restore(capture as HistoryCapture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })
})

describe('cost rules', () => {
  it('capture with nothing pending allocates no capture and reads no deep clone', () => {
    const r = open(DOC)
    const clone = vi.spyOn(Element.prototype, 'cloneNode')
    expect(r.port.capture()).toBeUndefined()
    expect(r.port.capture()).toBeUndefined()
    expect(clone).not.toHaveBeenCalled()
  })

  it('capture and restore take no deep clone of the root or of a table (rootClone, tableClone 0)', () => {
    const r = open(DOC)
    const clone = vi.spyOn(Element.prototype, 'cloneNode')
    const capture = roundTrip(r, () =>
      typeInto(r.root.querySelectorAll('td')[3], 'fX'),
    )
    expect(capture).toBeDefined()
    const deepOfTableOrRoot = clone.mock.contexts.filter(
      (el, index) =>
        clone.mock.calls[index][0] === true &&
        (el === r.root || (el as Element).localName === 'table'),
    )
    expect(deepOfTableOrRoot).toEqual([])
  })

  it('a restore is an ordinary edit: the next sync reports the text change', () => {
    const r = open(DOC)
    typeInto(r.root.querySelectorAll('p')[0], 'alpha!')
    const capture = r.port.capture() as HistoryCapture
    r.sync()
    expect(r.port.restore(capture, 'before')).toBe(true)
    const result = r.session.deltaPort().prepareDelta(9)
    expect(result.kind).toBe('changes')
    expect(r.session.deltaPort().modelText()).toBe(DOC)
  })
})

describe('SR-2: restore HTML comes only from the live DOM and runs no markup', () => {
  const HOSTILE = [
    'safe',
    '<script>globalThis.__sr2()</script>',
    '<img src="x" onerror="globalThis.__sr2()">',
    '[js](javascript:globalThis.__sr2())',
    '[data](data:text/html,<script>globalThis.__sr2()</script>)',
    '<svg onload="globalThis.__sr2()"><script>globalThis.__sr2()</script></svg>',
  ].join('\n\n')
  const count = (root: ParentNode) => ({
    scripts: root.querySelectorAll('script').length,
    handlers: Array.from(root.querySelectorAll('*')).filter((el) =>
      el.getAttributeNames().some((name) => name.startsWith('on')),
    ).length,
    scriptLinks: Array.from(root.querySelectorAll('a')).filter((a) =>
      /^(javascript|data):/iu.test(a.getAttribute('href') ?? ''),
    ).length,
  })

  it('edit, capture and restore keep the DOM equal to the full render and call no handler', () => {
    const spy = vi.fn()
    ;(globalThis as Record<string, unknown>).__sr2 = spy
    const r = open(HOSTILE)
    const full = document.createElement('div')
    full.innerHTML = lute.Md2VditorIRDOM(HOSTILE)
    const expected = count(full)
    typeInto(r.root.querySelectorAll('p')[0], 'safe!')
    const capture = r.port.capture() as HistoryCapture
    r.sync()
    expect(r.port.restore(capture, 'before')).toBe(true)
    expect(r.port.restore(capture, 'after')).toBe(true)
    expect(r.port.restore(capture, 'before')).toBe(true)
    expect(count(r.root)).toEqual(expected)
    expect(spy).not.toHaveBeenCalled()
    delete (globalThis as Record<string, unknown>).__sr2
  })
})

// Review repair (F2): in ordinary use a publication syncs the model between the edit and the
// checkpoint, and a sync replaces the table rows and rebinds list items in place. The "before" side
// must still describe the state before the edit.
describe('capture after a sync (structure edits)', () => {
  const LIST_DOC =
    'alpha\n\nbeta\n\n| a | b |\n| - | - |\n| c | d |\n| e | f |\n\n- one\n- two\n- three\n'

  /** Edit, sync, capture; both restores must return the two checkpoint states exactly. */
  function syncedRoundTrip(r: Rig, edit: () => void) {
    const first = r.state()
    edit()
    r.sync()
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    const second = r.state()
    expect(second).not.toEqual(first)
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    expect(r.state()).toEqual(first)
    expect(r.port.restore(capture, 'after')).toBe(true)
    r.sync()
    expect(r.state()).toEqual(second)
  }
  const touch = (el: Element) =>
    el.dispatchEvent(new Event('beforeinput', { bubbles: true }))

  it('a table row added', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => {
      const rows = r.root.querySelectorAll('tbody tr')
      touch(rows[0])
      const added = rows[1].cloneNode(true) as HTMLElement
      for (const cell of Array.from(added.children)) cell.textContent = 'new'
      rows[1].after(added)
    })
  })

  it('a table row removed', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => r.root.querySelectorAll('tbody tr')[0].remove())
  })

  it('Enter in a list item', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => {
      const items = r.root.querySelectorAll('li')
      touch(items[1])
      const added = items[1].cloneNode(false) as HTMLElement
      added.textContent = 'inserted'
      items[1].after(added)
    })
  })

  it('Backspace that merges two list items', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => {
      const items = r.root.querySelectorAll('li')
      touch(items[0])
      touch(items[1])
      items[0].textContent = `${items[0].textContent}${items[1].textContent}`
      items[1].remove()
    })
  })

  it('removal of the first list item', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => r.root.querySelectorAll('li')[0].remove())
  })

  it('Enter in a paragraph', () => {
    const r = open(LIST_DOC)
    syncedRoundTrip(r, () => {
      const first = r.root.querySelectorAll(':scope > p')[0]
      touch(first)
      const added = document.createElement('p')
      added.setAttribute('data-block', '0')
      added.textContent = 'new'
      first.after(added)
    })
  })
})

describe('restore post-render (F3)', () => {
  const ECHARTS = 'alpha\n\n```echarts\n{"series":[]}\n```\n\nomega\n'
  const MERMAID = 'alpha\n\n```mermaid\ngraph TD\nA-->B\n```\n\nomega\n'

  /** Replaces the block at `index` by a changed copy, the way a spin replaces an element. */
  function replaceBlock(
    r: Rig,
    index: number,
    mark: (clone: HTMLElement) => void,
  ) {
    const block = r.root.children[index] as HTMLElement
    const clone = block.cloneNode(true) as HTMLElement
    mark(clone)
    block.replaceWith(clone)
  }

  it('a rendered ECharts block is restored as pending: no dead instance, source copied back', () => {
    const r = open(ECHARTS)
    const block = r.root.children[1] as HTMLElement
    const preview = block.querySelector('.vditor-ir__preview') as HTMLElement
    preview.setAttribute('data-render', '1')
    const chart = document.createElement('div')
    chart.className = 'language-echarts'
    chart.setAttribute('_echarts_instance_', 'ec_1')
    chart.setAttribute('data-processed', 'true')
    chart.innerHTML = '<canvas></canvas>'
    preview.replaceChildren(chart)
    r.port.capture()
    replaceBlock(r, 1, (clone) => {
      const code = clone.querySelector('code') as HTMLElement
      code.textContent = '{"series":[1]}'
    })
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.port.restore(capture, 'before')).toBe(true)
    const restored = r.root.querySelector('.vditor-ir__preview') as HTMLElement
    expect(restored.getAttribute('data-render')).toBe('2')
    const target = restored.firstElementChild as HTMLElement
    expect(target.hasAttribute('_echarts_instance_')).toBe(false)
    expect(target.hasAttribute('data-processed')).toBe(false)
    expect(target.innerHTML).not.toContain('canvas')
  })

  it('a pending diagram is restored with its reserve attributes removed and queued to render', () => {
    const r = open(MERMAID)
    const block = r.root.children[1] as HTMLElement
    const preview = block.querySelector('.vditor-ir__preview') as HTMLElement
    preview.setAttribute('data-render', '1')
    const target = document.createElement('div')
    target.className = 'language-mermaid'
    target.setAttribute('data-processed', 'true')
    target.setAttribute('data-vmde-cache-reserve', 'x')
    target.textContent = 'stale'
    preview.replaceChildren(target)
    r.port.capture()
    replaceBlock(r, 1, (clone) => {
      ;(clone.querySelector('code') as HTMLElement).textContent =
        'graph TD\nA-->C'
    })
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.port.restore(capture, 'before')).toBe(true)
    const restored = r.root.querySelector('.vditor-ir__preview') as HTMLElement
    expect(restored.getAttribute('data-render')).toBe('2')
    const diagram = restored.firstElementChild as HTMLElement
    expect(diagram.hasAttribute('data-processed')).toBe(false)
    expect(diagram.hasAttribute('data-vmde-cache-reserve')).toBe(false)
    expect(diagram.textContent).toBe('graph TD\nA-->B\n')
  })
})

describe('a multi-step restore (F4)', () => {
  it('puts back the written steps when a later step no longer matches', () => {
    const r = open(DOC)
    // Step 1: an edit that the model keeps across a rebuild over the same DOM.
    typeInto(r.root.querySelectorAll('p')[0], 'alpha1')
    r.sync()
    r.session.onHostWriteOutcome({
      status: 'applied',
      epoch: 2,
      content: r.session.deltaPort().modelText(),
    })
    r.runFrames()
    // Step 2: an edit in the rebuilt model.
    typeInto(r.root.querySelectorAll('p')[1], 'beta1')
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    // A foreign change inside the window of the first step, which a 'before' restore reaches last.
    ;(r.root.querySelectorAll('p')[0].firstChild as Text).data = 'foreign'
    const html = r.root.innerHTML
    expect(r.port.restore(capture, 'before')).toBe(false)
    expect(r.root.innerHTML).toBe(html)
  })
})

describe('claimable (F1)', () => {
  it('is true while live and for a transient off, false for a permanent off reason', () => {
    const r = open(DOC)
    expect(r.port.claimable()).toBe(true)
    r.session.turnOff('not-mounted')
    expect(r.port.claimable()).toBe(true)
    r.session.turnOff('mode')
    expect(r.port.claimable()).toBe(true)
    for (const reason of [
      'scan-declined',
      'pairing-failed',
      'unit-without-kind',
      'sync-error',
    ] as const) {
      r.session.turnOff(reason)
      expect(r.port.claimable(), reason).toBe(false)
    }
  })

  it('a document the model declines (a reference definition) is not claimable', () => {
    const r = open('See [d].\n\n[d]: https://e.com\n')
    expect(r.session.isLive()).toBe(false)
    expect(r.port.claimable()).toBe(false)
  })
})

// Q-56: Lute serializes a task item as `- [ ]  one` (two spaces), so a restore that leaves the bytes to
// the canon would change the original `- [ ] one`. The capture hands the model the bytes it had.
describe('Undo restores the original bytes of a non-canonical unit', () => {
  const TASK = 'alpha\n\n- [ ] one\n- [ ] two\n\nomega\n'

  it('a task item toggled and restored keeps `- [ ] one`', () => {
    const r = open(TASK)
    expect(r.state().text).toBe(TASK)
    const first = r.state()
    const item = r.root.querySelectorAll('li')[0]
    item.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(item.querySelector('input') as HTMLInputElement).setAttribute(
      'checked',
      '',
    )
    r.sync()
    const second = r.state()
    expect(second.text).not.toBe(TASK)
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    expect(r.state()).toEqual(first)
  })

  it('a table cell restored in place keeps the bytes it had', () => {
    const r = open('| a | b |\n| - | - |\n| `x\\|y` | d |\n')
    const first = r.state()
    const cell = r.root.querySelectorAll('td')[0]
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    cell.textContent = 'changed'
    r.sync()
    const capture = r.port.capture() as HistoryCapture
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    expect(r.state()).toEqual(first)
  })
})

// Re-review N1: the render step must run on the live element, not on the one a re-spin replaced.
describe('restore render of a top-level ECharts block (N1)', () => {
  const ECHARTS = 'alpha\n\n```echarts\n{"series":[]}\n```\n\nomega\n'

  it('processCodeRender gets a connected, fresh preview after the block is re-spun', () => {
    const r = open(ECHARTS)
    const seen: Array<{ connected: boolean; render: string | null }> = []
    renderSpy.mockImplementation((preview: HTMLElement) => {
      seen.push({
        connected: preview.isConnected,
        render: preview.getAttribute('data-render'),
      })
    })
    ;(window as unknown as { vditor: unknown }).vditor = {
      vditor: { lute: { SpinVditorIRDOM: (html: string) => html } },
    }
    const block = r.root.children[1] as HTMLElement
    const preview = block.querySelector('.vditor-ir__preview') as HTMLElement
    preview.setAttribute('data-render', '1')
    r.port.capture()
    const clone = block.cloneNode(true) as HTMLElement
    ;(clone.querySelector('code') as HTMLElement).textContent = '{"series":[1]}'
    block.replaceWith(clone)
    const capture = r.port.capture() as HistoryCapture
    expect(r.port.restore(capture, 'before')).toBe(true)
    expect(seen).toEqual([{ connected: true, render: '2' }])
    delete (window as unknown as { vditor?: unknown }).vditor
    renderSpy.mockReset()
  })
})

// Re-review N3: a clean, never-proven unit that is edited later in the interval keeps its earlier HTML.
describe('a later edit inside a structure interval (N3)', () => {
  it('a list Enter and then an edit of another, unproven item restore to the first state', () => {
    const r = open('alpha\n\n- one\n- two\n- three\n')
    const first = r.state()
    const items = r.root.querySelectorAll('li')
    items[0].dispatchEvent(new Event('beforeinput', { bubbles: true }))
    const added = items[0].cloneNode(false) as HTMLElement
    added.textContent = 'inserted'
    items[0].after(added)
    // The second edit comes before any proof ran for item three.
    ;(items[2].firstChild as Text).data = 'three!'
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    const html = r.root.innerHTML
    // Either the whole state is restored, or the restore is refused with the DOM untouched.
    const restored = r.port.restore(capture, 'before')
    if (restored) {
      r.sync()
      expect(r.state()).toEqual(first)
    } else {
      expect(r.root.innerHTML).toBe(html)
    }
  })
})

// Re-review N2: a cell form stays with its unit and does not enter the index of top-level bytes.
describe('a cell form does not become the bytes of a new block (N2)', () => {
  it('a paragraph with the canon of a restored cell is written in its canon', () => {
    const r = open('| a | b |\n| - | - |\n| `x\\|y` | d |\n\nomega\n')
    const cell = r.root.querySelectorAll('td')[0]
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    cell.textContent = 'changed'
    r.sync()
    const capture = r.port.capture() as HistoryCapture
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    const holder = document.createElement('div')
    holder.innerHTML = lute.Md2VditorIRDOM('`x|y`\n')
    const paragraph = holder.firstElementChild as HTMLElement
    r.root.lastElementChild?.before(paragraph)
    r.sync()
    expect(r.state().text).toContain('\n`x|y`\n')
    expect(r.state().text).not.toContain('\n`x\\|y`\n')
  })
})

// A block spin replaces the whole table on every key, after the browser typed into the old cell.
describe('a cell typed into before its table is replaced (block spin)', () => {
  it('Undo returns the state before the first key', () => {
    const r = open(DOC)
    const first = r.state()
    const cell = r.root.querySelectorAll('td')[3]
    const range = document.createRange()
    range.setStart(cell.firstChild as Text, 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    ;(cell.firstChild as Text).data = 'fx'
    const table = r.root.querySelector('table') as HTMLElement
    table.replaceWith(table.cloneNode(true))
    ;(r.root.querySelectorAll('td')[3].firstChild as Text).data = 'fxy'
    const second = r.state()
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    // The DOM is the observable here: the model may answer a whole-text fallback after such a restore.
    expect(r.port.restore(capture, 'before')).toBe(true)
    expect(r.state().html).toBe(first.html)
    expect(r.port.restore(capture, 'after')).toBe(true)
    expect(r.state().html).toBe(second.html)
  })
})

// Lute numbers an ordered list 1, 2, 3 (and spaces it by its looseness): a restored list must give the
// bytes the document had (`1.` on every item), also when it is restored as part of a larger window.
describe('Undo of a replaced ordered list keeps its original bytes', () => {
  const LIST = 'alpha\n\n1. one\n1. two\n1. three\n\nomega\n'

  it('restore before returns `1.` on every item, and restore after the bytes of the edit', () => {
    const r = open(LIST)
    const first = r.state()
    expect(first.text).toBe(LIST)
    const list = r.root.querySelector('ol') as HTMLElement
    list.children[1].dispatchEvent(new Event('beforeinput', { bubbles: true }))
    const clone = list.cloneNode(true) as HTMLElement
    clone.children[1].textContent = 'two!'
    list.replaceWith(clone)
    r.sync()
    const second = r.state()
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    expect(r.state().text).toBe(first.text)
    expect(r.port.restore(capture, 'after')).toBe(true)
    r.sync()
    expect(r.state().text).toBe(second.text)
  })
})

// An exact action rebuilds the whole root: only the blocks whose source changed are one window, and
// the rest keep the bytes the document had (a table that Lute would space differently, for one).
describe('a rebuilt root restores only the changed blocks', () => {
  const MIXED =
    '| a | b |\n| - | - |\n| c|d |\n\nalpha\n\n1. one\n1. two\n\nomega\n'

  it('the window covers the changed paragraph, and Undo keeps the table and list bytes', () => {
    const r = open(MIXED)
    const first = r.state()
    expect(first.text).toBe(MIXED)
    r.root.innerHTML = r.root.innerHTML.replace('alpha', 'alpha!')
    // The observer reports the rebuild before the host's answer arrives.
    expect(r.port.pending()).toBe(true)
    // An exact action posts its text and the model takes the host's bytes (no sync of the new DOM).
    r.session.deltaPort().rebind(MIXED.replace('alpha', 'alpha!'))
    const second = r.state()
    // The caret is in the paragraph: the pre-touch proof of the next key proves its unit.
    const paragraph = Array.from(r.root.querySelectorAll('p')).find(
      (p) => p.textContent === 'alpha!',
    ) as HTMLElement
    const range = document.createRange()
    range.setStart(paragraph.firstChild as Text, 1)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    paragraph.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    const steps = (
      capture as unknown as { steps: Array<{ windows: unknown[] }> }
    ).steps
    expect(steps[0].windows).toHaveLength(1)
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.sync()
    expect(r.state().text).toBe(first.text)
    expect(r.port.restore(capture, 'after')).toBe(true)
    r.sync()
    expect(r.state().text).toBe(second.text)
  })
})

// A table action (a column move) rebuilds the root through `setValue`: Undo and Redo of the table must
// give back the bytes it had, not Lute's canon (padding and short delimiters stay as authored).
describe('Undo and Redo of a table action keep the table bytes', () => {
  const TABLE =
    'before\n\n|  Left  | Right   |\n| :--- | ---: |\n| *one* | `two` |\n\nafter\n'
  const MOVED = TABLE.replace(
    '|  Left  | Right   |\n| :--- | ---: |\n| *one* | `two` |',
    '| Right   |  Left  |\n| ---: | :--- |\n| `two` | *one* |',
  )

  it('restore before gives the original table bytes, restore after the moved ones', () => {
    const r = open(TABLE)
    expect(r.state().text).toBe(TABLE)
    // The action writes the moved document as the exact text and rebuilds the root from it.
    r.root.innerHTML = lute.Md2VditorIRDOM(MOVED)
    expect(r.port.pending()).toBe(true)
    r.session.deltaPort().rebind(MOVED)
    const capture = r.port.capture() as HistoryCapture
    expect(capture).toBeDefined()
    const table = r.root.querySelector('table') as HTMLElement
    const cell = table.querySelector('td') as HTMLElement
    const range = document.createRange()
    range.setStart(cell.firstChild as Node, 0)
    range.collapse(true)
    window.getSelection()?.removeAllRanges()
    window.getSelection()?.addRange(range)
    // Proof of the table's cells before the Undo, as the idle proofs give it in the editor.
    cell.dispatchEvent(new Event('beforeinput', { bubbles: true }))
    expect(r.port.restore(capture, 'before')).toBe(true)
    r.session.deltaPort().prepareDelta(40)
    expect(r.session.deltaPort().modelText()).toBe(TABLE)
    expect(r.port.restore(capture, 'after')).toBe(true)
    r.session.deltaPort().prepareDelta(41)
    expect(r.session.deltaPort().modelText()).toBe(MOVED)
  })
})
