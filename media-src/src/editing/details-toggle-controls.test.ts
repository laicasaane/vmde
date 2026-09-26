// @vitest-environment jsdom
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import {
  resolveBlockHandleUnits,
  type BlockProjection,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'

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
  options: { resolverRejects?: boolean; noRevision?: boolean } = {},
) {
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  const button = document.createElement('button')
  button.dataset.type = 'details'
  toolbar.append(button)
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = real.render(SOURCE)
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

it('captures exact source once on button pointerdown and toggles from that capture', () => {
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
  expect(view.work().insertNode).toBe(2)
  expect(view.postExact).toHaveBeenCalledOnce()
  expect(view.postExact.mock.calls[0][0]).toContain(
    '<details>\n<summary>Details</summary>\n\nAlpha paragraph one\n\n</details>',
  )
})

it('shows the pressed unwrap state after toggling a whole immediate body', () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
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

it('keeps the toggled result as the target when the exact capture fails and for a collapsed caret', () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  // A capture right after setValue can fail in the real webview; the result still applies.
  calloutCapture.fail = true
  document.dispatchEvent(new Event('vmde-toggle-details'))
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

it('does not apply a retained result after the exact bytes changed invisibly', () => {
  const view = mount()
  const beta = view.paragraph('Beta')
  view.keyStep(beta, 0, beta, beta.length)
  view.button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  document.dispatchEvent(new Event('vmde-toggle-details'))
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
