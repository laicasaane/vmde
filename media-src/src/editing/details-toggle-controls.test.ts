// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  resolveBlockHandleUnits,
  type BlockProjection,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import {
  hasLiveCaretIntent,
  requestCaret,
  resetCaretAuthorityForTests,
} from './caret'

// Task 574 Checkpoint 5c: the Details toolbar controller reads passive state from the shared
// source index. Every exact-source route is spied: the callout capture (marker path), live marker
// insertion, Vditor's full serializer, the edit-sync snapshot and the index's snapshot pair.
const calloutCapture = vi.hoisted(() => ({ calls: 0, fail: false }))
vi.mock('./callouts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./callouts')>()
  return {
    ...actual,
    captureCalloutActionTarget: (win: Window) => {
      calloutCapture.calls++
      return calloutCapture.fail ? null : actual.captureCalloutActionTarget(win)
    },
  }
})

import {
  configureDetailsToggle,
  installDetailsToggleControls,
} from './details-toggle'

const SOURCE = [
  'Alpha paragraph one',
  '',
  'Beta paragraph two',
  '',
  '<details>',
  '<summary>Wrapped</summary>',
  '',
  'Inside body',
  '',
  '</details>',
  '',
  'Gamma paragraph three',
  '',
].join('\n')

let real: RealLute
beforeAll(() => {
  real = createRealLute('ir')
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  calloutCapture.calls = 0
  calloutCapture.fail = false
})

// A failed assertion must not leave a controller listening on the shared document.
const disposers: Array<() => void> = []

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  delete (window as any).vditor
})

function mount(
  options: {
    resolverRejects?: boolean
    noRevision?: boolean
    source?: string
  } = {},
) {
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  const button = document.createElement('button')
  button.dataset.type = 'details'
  toolbar.append(button)
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = real.render(options.source ?? SOURCE)
  root.normalize()
  document.body.append(toolbar, root)
  const inner = {
    currentMode: 'ir',
    ir: { element: root },
    lute: real.lute,
    toolbar: { elements: {} },
    undo: { addToUndoStack: vi.fn() },
  }
  const getValue = vi.fn(() => real.serialize(root.innerHTML))
  const setValue = vi.fn((markdown: string) => {
    root.innerHTML = real.render(markdown)
  })
  ;(window as any).vditor = { vditor: inner, getValue, setValue }
  const proof: BlockProjection = {
    owner: real.lute,
    mode: 'ir',
    render: real.render,
    serialize: real.serialize,
  }
  const source = { revision: {} as object, exact: null as string | null }
  const snapshotPair = vi.fn(() => {
    const rendered = real.serialize(root.innerHTML)
    return { exact: source.exact ?? rendered, rendered }
  })
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: () => ({ owner: real.lute, mode: 'ir' }),
    snapshotPair,
    snapshotRevision: () => (options.noRevision ? undefined : source.revision),
    resolveUnits: (target, exact, rendered) =>
      options.resolverRejects
        ? null
        : resolveBlockHandleUnits(target, exact, rendered, proof),
  })
  const snapshotMarkdown = vi.fn(() => real.serialize(root.innerHTML))
  const postExact = vi.fn()
  configureDetailsToggle({
    setApplying: vi.fn(),
    // Task 630: no host here; the live exact bytes are the acquired pair.
    acquireExactAuthority: async () => ({
      exact: source.exact ?? real.serialize(root.innerHTML),
      rendered: real.serialize(root.innerHTML),
    }),
    postExact,
    snapshotMarkdown,
    onError: (error) => {
      throw error
    },
  })
  const dispose = installDetailsToggleControls(index)
  disposers.push(() => {
    dispose()
    index.dispose()
  })
  vi.advanceTimersByTime(16)
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  const reset = () => {
    getValue.mockClear()
    snapshotPair.mockClear()
    snapshotMarkdown.mockClear()
    insertNode.mockClear()
    calloutCapture.calls = 0
  }
  const paragraph = (text: string) =>
    Array.from(root.querySelectorAll('p')).find((element) =>
      element.textContent?.startsWith(text),
    )!.firstChild as Text
  const select = (start: Text, from: number, end: Text, to: number) => {
    const range = document.createRange()
    range.setStart(start, from)
    range.setEnd(end, to)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }
  // One OS-style key step: keydown, selection change, keyup, then the settle frame.
  const keyStep = (start: Text, from: number, end: Text, to: number) => {
    document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }))
    select(start, from, end, to)
    vi.advanceTimersByTime(16)
    document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }))
    vi.advanceTimersByTime(40)
  }
  const work = () => ({
    getValue: getValue.mock.calls.length,
    snapshotPair: snapshotPair.mock.calls.length,
    snapshotMarkdown: snapshotMarkdown.mock.calls.length,
    insertNode: insertNode.mock.calls.length,
    calloutCapture: calloutCapture.calls,
  })
  const state = () => ({
    disabled: button.disabled,
    pressed: button.getAttribute('aria-pressed'),
  })
  return {
    root,
    source,
    button,
    index,
    postExact,
    reset,
    paragraph,
    select,
    keyStep,
    work,
    state,
  }
}

const NO_WORK = {
  getValue: 0,
  snapshotPair: 0,
  snapshotMarkdown: 0,
  insertNode: 0,
  calloutCapture: 0,
}

it('serves 30 expanded selections, retained reads and passive mutations from a warm index', () => {
  const view = mount()
  view.index.read()
  view.reset()
  const alpha = view.paragraph('Alpha')
  const gamma = view.paragraph('Gamma')

  for (let step = 1; step <= 30; step++)
    view.keyStep(alpha, 0, step < 19 ? alpha : gamma, step < 19 ? step : 3)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })

  // Collapsed selections read the retained state; presentation attributes are not source.
  view.select(alpha, 2, alpha, 2)
  vi.advanceTimersByTime(60)
  alpha.parentElement!.setAttribute('class', 'vditor-ir__node--expand')
  alpha.parentElement!.setAttribute('aria-live', 'off')
  view.keyStep(alpha, 0, alpha, 5)
  vi.advanceTimersByTime(60)

  expect(view.work()).toEqual(NO_WORK)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })
})

it('builds nothing while the primary button is held and builds once at release', () => {
  const view = mount()
  view.reset()
  const alpha = view.paragraph('Alpha')
  alpha.parentElement!.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      isPrimary: true,
    }),
  )
  for (let step = 1; step <= 12; step++) {
    view.select(alpha, 0, alpha, step)
    alpha.parentElement!.dispatchEvent(
      new MouseEvent('mousemove', { bubbles: true, buttons: 1 }),
    )
    vi.advanceTimersByTime(40)
  }
  expect(view.work()).toEqual(NO_WORK)

  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  vi.advanceTimersByTime(16)

  expect(view.work()).toEqual({ ...NO_WORK, snapshotPair: 1 })
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })
})

it('runs the exact fallback once per settled selection for an unknown state', () => {
  const view = mount({ resolverRejects: true })
  view.index.read()
  view.reset()
  const alpha = view.paragraph('Alpha')

  document.dispatchEvent(new KeyboardEvent('keydown', { code: 'ShiftLeft' }))
  view.select(alpha, 0, alpha, 4)
  vi.advanceTimersByTime(40)
  expect(view.work().calloutCapture).toBe(0)
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'ShiftLeft' }))
  vi.advanceTimersByTime(40)
  expect(view.work().calloutCapture).toBe(1)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })

  // Further updates within the same settled selection reuse that result.
  document.dispatchEvent(new Event('input'))
  vi.advanceTimersByTime(40)
  expect(view.work().calloutCapture).toBe(1)

  // The exact capture's markers split text nodes (old-path behavior); re-read the paragraph.
  view.root.normalize()
  const again = view.paragraph('Alpha')
  view.keyStep(again, 0, again, 6)
  expect(view.work().calloutCapture).toBe(2)
})

it('captures exact source once on button pointerdown and toggles from that capture', async () => {
  const view = mount()
  view.index.read()
  const alpha = view.paragraph('Alpha')
  view.keyStep(alpha, 0, alpha, 5)
  view.reset()

  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  // Two live markers (start and end) for exactly one capture; the warm entry supplies the
  // authoritative rendered bytes, so neither the full serializer nor the snapshot runs.
  expect(view.work()).toEqual({ ...NO_WORK, insertNode: 2 })

  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  expect(view.work().insertNode).toBe(2)
  expect(view.postExact).toHaveBeenCalledOnce()
  expect(view.postExact.mock.calls[0][0]).toContain(
    '<details>\n<summary>Details</summary>\n\nAlpha paragraph one\n\n</details>',
  )
})

// Task 609 contract 4 (S2b): the toggle's own undo checkpoints arm a caret intent for the caret that
// existed BEFORE the rewrite (the checkpoint restores through the caret authority in the real
// webview). The toggle then writes the wrapped body as the selection directly; a live intent would
// re-assert the old caret over it. A deliberate selection supersedes the intent, and the normal
// intent path stays available afterwards.
it('drops a caret intent armed by its checkpoint before writing the selection, and the intent path still works', async () => {
  const view = mount()
  const inner = (window as any).vditor.vditor
  inner.undo.addToUndoStack.mockImplementation(() =>
    requestCaret({ textOffset: 0 }),
  )
  const alpha = view.paragraph('Alpha')
  view.keyStep(alpha, 0, alpha, 5)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()

  const selection = document.getSelection()!
  expect(selection.isCollapsed).toBe(false)
  expect(selection.toString()).toBe('Alpha paragraph one')
  expect(hasLiveCaretIntent()).toBe(false)

  // A later request arms and writes as before.
  expect(requestCaret({ textOffset: 0 })).toBe(true)
  expect(hasLiveCaretIntent()).toBe(true)
  resetCaretAuthorityForTests()
})

it('shows the pressed unwrap state after toggling a whole immediate body', async () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  vi.advanceTimersByTime(60)

  expect(view.state()).toEqual({ disabled: false, pressed: 'true' })
})

it('keeps the explicit source capture in SV and never reads the index there', () => {
  const view = mount()
  const alpha = view.paragraph('Alpha')
  const inner = (window as any).vditor.vditor
  inner.currentMode = 'sv'
  inner.sv = { element: view.root }
  view.reset()

  view.keyStep(alpha, 0, alpha, 4)

  expect(view.work().calloutCapture).toBeGreaterThan(0)
  expect(view.work().snapshotPair).toBe(0)
})

it('keeps the toggled result as the target when the exact capture fails and for a collapsed caret', async () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  // A capture right after setValue can fail in the real webview; the result still applies.
  calloutCapture.fail = true
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: false, pressed: 'true' })

  const body = view.paragraph('Beta')
  view.select(body, 1, body, 1)
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: false, pressed: 'true' })

  // Pointer entry into the editor drops the retained result, as before Task 574.
  body.parentElement!.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      isPrimary: true,
    }),
  )
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  view.select(body, 2, body, 2)
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: true, pressed: 'false' })
})

it('settles after a synthetic keydown without a keyup and after a Meta chord missing its keyup', () => {
  const view = mount({ resolverRejects: true })
  view.index.read()
  view.reset()
  const alpha = view.paragraph('Alpha')

  // The IR table panel dispatches synthetic keydowns with no code and no keyup.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: '=' }))
  view.select(alpha, 0, alpha, 3)
  vi.advanceTimersByTime(60)
  expect(view.work().calloutCapture).toBe(1)

  // macOS drops the letter's keyup while Cmd is held; releasing Cmd must still settle.
  view.root.normalize()
  const again = view.paragraph('Alpha')
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'MetaLeft', metaKey: true }),
  )
  document.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'KeyA', metaKey: true }),
  )
  view.select(again, 0, again, 5)
  vi.advanceTimersByTime(60)
  expect(view.work().calloutCapture).toBe(1)
  document.dispatchEvent(new KeyboardEvent('keyup', { code: 'MetaLeft' }))
  vi.advanceTimersByTime(60)
  expect(view.work().calloutCapture).toBe(2)
})

it('does not apply a retained result after the exact bytes changed invisibly', async () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  vi.advanceTimersByTime(60)
  expect(view.postExact).toHaveBeenCalledOnce()
  // The post-toggle exact capture split text nodes; re-read the paragraph.
  view.root.normalize()
  const body = view.paragraph('Beta')
  view.select(body, 1, body, 1)
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: false, pressed: 'true' })

  // An external update changes only bytes the rendered text cannot show.
  view.source.exact = (window as any).vditor.getValue().replace(/\n/gu, '\r\n')
  view.source.revision = {}
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  expect(view.postExact).toHaveBeenCalledOnce()
})

it('uses the exact capture once settled when the index has no key', () => {
  const view = mount({ noRevision: true })
  view.reset()
  const alpha = view.paragraph('Alpha')
  view.keyStep(alpha, 0, alpha, 4)
  expect(view.work().calloutCapture).toBe(1)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })
})

// Task 577: a settled build waits while the selection bubble holds index builds.
function dragSelect(view: ReturnType<typeof mount>, text: Text, to: number) {
  text.parentElement!.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      button: 0,
      isPrimary: true,
    }),
  )
  view.select(text, 0, text, to)
  document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
  // jsdom queues its own selectionchange, which re-arms the settle frame once more.
  vi.advanceTimersByTime(60)
}

it('defers the settled build while builds are held and applies it after release', () => {
  const view = mount()
  view.reset()
  const release = view.index.holdBuilds()

  dragSelect(view, view.paragraph('Alpha'), 5)
  expect(view.work()).toEqual(NO_WORK)
  expect(view.state()).toEqual({ disabled: true, pressed: 'false' })

  release()

  expect(view.work()).toEqual({ ...NO_WORK, snapshotPair: 1 })
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })
})

it('discards a held settled result after an edit or a reselection', () => {
  const view = mount()
  view.reset()
  const alpha = view.paragraph('Alpha')

  let release = view.index.holdBuilds()
  dragSelect(view, alpha, 5)
  document.dispatchEvent(new Event('input'))
  release()
  expect(view.work().snapshotPair).toBe(1)
  expect(view.state()).toEqual({ disabled: true, pressed: 'false' })
  // The edit's own update then resolves the current selection from the warm entry.
  vi.advanceTimersByTime(16)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })

  view.select(alpha, 2, alpha, 2)
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: true, pressed: 'false' })
  view.root.setAttribute('data-cold', 'true')
  view.reset()
  release = view.index.holdBuilds()
  dragSelect(view, alpha, 6)
  // Applying the stale request would read this live, expandable selection and enable the button.
  const gamma = view.paragraph('Gamma')
  view.select(gamma, 0, gamma, 4)
  release()
  expect(view.work().snapshotPair).toBe(1)
  expect(view.state()).toEqual({ disabled: true, pressed: 'false' })
  vi.advanceTimersByTime(60)
  expect(view.state()).toEqual({ disabled: false, pressed: 'false' })
})

it.each(['ir', 'sv'] as const)(
  'defers passive %s Details reads while Find owns focus and refreshes once on return',
  (mode) => {
    const view = mount({ resolverRejects: true })
    const inner = (window as any).vditor.vditor
    inner.currentMode = mode
    if (mode === 'sv') inner.sv = { element: view.root }
    view.root.tabIndex = 0
    const widget = document.createElement('div')
    widget.className = 'vmde-find-replace'
    const input = document.createElement('input')
    widget.append(input)
    document.body.append(widget)
    input.focus()
    const before = view.state()
    const peek = vi.spyOn(view.index, 'peek')
    const read = vi.spyOn(view.index, 'read')
    const readWhenReady = vi.spyOn(view.index, 'readWhenReady')
    view.reset()
    const alpha = view.paragraph('Alpha')
    view.select(alpha, 0, alpha, 5)
    vi.advanceTimersByTime(60)
    expect(view.work()).toEqual(NO_WORK)
    expect(peek).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(readWhenReady).not.toHaveBeenCalled()
    expect(view.state()).toEqual(before)

    // jsdom collapses the document Range on div.focus(), unlike this browser focus return.
    // Supply the focus state/event while retaining the match; the real webview covers delivery.
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(view.root)
    view.root.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    vi.advanceTimersByTime(60)
    expect(view.work().calloutCapture).toBe(1)
    expect(readWhenReady).toHaveBeenCalledTimes(mode === 'ir' ? 1 : 0)
  },
)

it('still captures and applies an explicit Details action while Find owns focus', async () => {
  const view = mount()
  view.index.read()
  const widget = document.createElement('div')
  widget.className = 'vmde-find-replace'
  const input = document.createElement('input')
  widget.append(input)
  document.body.append(widget)
  input.focus()
  const alpha = view.paragraph('Alpha')
  view.select(alpha, 0, alpha, 5)
  vi.advanceTimersByTime(60)
  view.reset()
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  expect(view.work().insertNode).toBe(2)
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await flushMicrotasks()
  expect(view.postExact).toHaveBeenCalledOnce()
  expect(view.postExact.mock.calls[0][0]).toContain(
    '<summary>Details</summary>\n\nAlpha paragraph one',
  )
})

// Task 630 S1 (RED): the toggle acquires exact authority, plans on the acquired exact text and posts
// with the owned `before` plus a rollback. The module has no acquire seam yet, so the dependency is
// declared here (`acquireExactAuthority`, `postExact(markdown, opts)`) and cast onto the product type.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type ExactDeps = Parameters<typeof configureDetailsToggle>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

// Extra blank lines and `***` normalize away, so rendered offsets differ from host offsets.
const HOST_EXACT =
  'Alpha paragraph one\n\n\n\nBeta paragraph two\n\n***\n\nGamma paragraph three\n'
const HOST_DRIFTED = `${HOST_EXACT}Delta paragraph four\n`
const GAMMA_WRAPPED =
  '<details>\n<summary>Details</summary>\n\nGamma paragraph three\n\n</details>'

async function flushMicrotasks() {
  for (let turn = 0; turn < 10; turn++) await Promise.resolve()
}

// A host that keeps its own bytes: an exact edit is applied only while the host still holds the
// edit's `before` (explicit, else the base the last acquisition adopted); a refusal rebuilds the DOM
// from the host text and runs the caller's rollback, as edit-sync does.
function exactHost(view: ReturnType<typeof mount>, delayed: boolean) {
  const host = { text: HOST_EXACT, owned: null as string | null, restored: 0 }
  const rendered = () => (window as any).vditor.getValue() as string
  const acquireExactAuthority = vi.fn(
    async (): Promise<AcquiredPair | null> => {
      if (delayed) await new Promise((done) => window.setTimeout(done, 5))
      host.owned = host.text
      return { exact: host.text, rendered: rendered() }
    },
  )
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      ;(window as any).vditor.setValue(host.text)
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  configureDetailsToggle({
    setApplying: vi.fn(),
    postExact,
    snapshotMarkdown: () => rendered(),
    acquireExactAuthority,
    onError: (error) => {
      throw error
    },
  } as ExactDeps)
  return { host, acquireExactAuthority, postExact, view }
}

async function pressDetailsOnGamma(view: ReturnType<typeof mount>) {
  view.index.read()
  const gamma = view.paragraph('Gamma')
  view.keyStep(gamma, 0, gamma, gamma.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
  await vi.advanceTimersByTimeAsync(20)
  await flushMicrotasks()
}

it.each([
  ['after a trusted edit (host round trip)', true],
  ['on a fresh document (owned pair)', false],
] as const)(
  'Details toggle %s acquires authority and plans on the acquired exact text',
  async (_name, delayed) => {
    const view = mount({ source: HOST_EXACT })
    const { host, acquireExactAuthority, postExact } = exactHost(view, delayed)
    if (delayed) {
      document.dispatchEvent(new Event('input'))
      view.source.revision = {}
    }
    await pressDetailsOnGamma(view)

    expect(acquireExactAuthority).toHaveBeenCalledOnce()
    expect(postExact).toHaveBeenCalledOnce()
    expect(postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    // Only the wrapped paragraph changes: the blank-line run and `***` stay the host's bytes.
    expect(host.text).toBe(
      HOST_EXACT.replace('Gamma paragraph three', GAMMA_WRAPPED),
    )
  },
)

it('Details toggle refuses a stale host: no write, rollback runs, the DOM shows the host text', async () => {
  const view = mount({ source: HOST_EXACT })
  const { host, acquireExactAuthority, postExact } = exactHost(view, false)
  // The host changes after the pair was adopted and before the action posts.
  acquireExactAuthority.mockImplementationOnce(async () => {
    const pair = {
      exact: HOST_EXACT,
      rendered: (window as any).vditor.getValue() as string,
    }
    host.owned = HOST_EXACT
    host.text = HOST_DRIFTED
    return pair
  })
  await pressDetailsOnGamma(view)

  expect(acquireExactAuthority).toHaveBeenCalledOnce()
  expect(postExact.mock.calls[0][1]).toEqual({
    rollback: { restore: expect.any(Function) },
  })
  expect(host.restored).toBe(1)
  expect(host.text).toBe(HOST_DRIFTED)
  expect(real.serialize(view.root.innerHTML)).toBe(
    real.serialize(real.render(HOST_DRIFTED)),
  )
  expect(view.root.textContent).not.toContain('Details')
})

it('Details toggle declines without a write or a DOM change when acquisition fails', async () => {
  const view = mount({ source: HOST_EXACT })
  const { postExact, acquireExactAuthority } = exactHost(view, false)
  acquireExactAuthority.mockResolvedValueOnce(null)
  const text = view.root.textContent
  const setValue = (window as any).vditor.setValue as ReturnType<typeof vi.fn>
  setValue.mockClear()
  await pressDetailsOnGamma(view)

  expect(acquireExactAuthority).toHaveBeenCalledOnce()
  expect(setValue).not.toHaveBeenCalled()
  expect(postExact).not.toHaveBeenCalled()
  expect(view.root.textContent).toBe(text)
})
