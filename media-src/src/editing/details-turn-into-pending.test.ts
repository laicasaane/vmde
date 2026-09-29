// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import {
  currentBlockProjection,
  resolveBlockHandleUnits,
} from '../nav/block-handle'
import { createSourceBlockIndex } from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import {
  applyBlockTransformChoice,
  bindBlockTransformSource,
  cancelBlockTransformChoice,
  configureBlockTransformCommand,
  requestBlockTransformOptions,
  requestBlockTransformOptionsAtSource,
} from './block-transform-command'
import { invalidateCaret } from './caret'
import {
  configureDetailsToggle,
  installDetailsToggleControls,
} from './details-toggle'

// Task 604 N3(iii): the real large document rejects exact units, so passive Details state
// needs its marker fallback after Find releases focus. Keep all fixture evidence boolean.
const FIXTURE = readFileSync(
  'test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
  'utf8',
)
const TOKEN = 'mtnnwcr'
let lutes: Record<'ir' | 'wysiwyg', RealLute>
const disposers: Array<() => void> = []

beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
})
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose()
  invalidateCaret()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  document.body.replaceChildren()
  delete (window as any).vditor
})

function mount(mode: 'ir' | 'wysiwyg', markdown = FIXTURE) {
  vi.useFakeTimers()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    window.setTimeout(() => callback(performance.now()), 16),
  )
  vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
  const real = lutes[mode]
  document.body.innerHTML =
    '<div class="vditor-toolbar"><button data-type="details"></button></div><div class="vmde-find-replace"><input></div>'
  const button = document.querySelector<HTMLButtonElement>(
    '[data-type="details"]',
  )!
  const input = document.querySelector('input')!
  const root = document.createElement('pre')
  root.className = 'vditor-reset'
  root.setAttribute('contenteditable', 'true')
  root.tabIndex = 0
  root.innerHTML = real.render(markdown)
  document.body.append(root)
  let exact = markdown
  let revision = {}
  const getValue = vi.fn(() => real.serialize(root.innerHTML))
  const setValue = vi.fn((source: string) => {
    root.innerHTML = real.render(source)
  })
  ;(window as any).vditor = {
    vditor: {
      currentMode: mode,
      lute: real.lute,
      [mode]: { element: root },
      options: { undoDelay: 800 },
    },
    getValue,
    setValue,
  }
  const posted: string[] = []
  const snapshotExactMarkdown = () => exact
  disposers.push(
    configureBlockTransformCommand({
      snapshotExactMarkdown,
      snapshotRevision: () => revision,
      setApplying: () => undefined,
      postExact: (source) => {
        posted.push(source)
        exact = source
        revision = {}
      },
      onError: (error) => {
        throw error
      },
    }),
  )
  const snapshotPair = () => ({ exact, rendered: getValue() })
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: currentBlockProjection,
    snapshotPair,
    snapshotRevision: () => revision,
    resolveUnits: (element, source, rendered) =>
      resolveBlockHandleUnits(
        element,
        source,
        rendered,
        currentBlockProjection(),
      ),
  })
  disposers.push(
    () => index.dispose(),
    bindBlockTransformSource({ index, snapshotPair }),
  )
  const entry = index.read()!
  configureDetailsToggle({
    snapshotMarkdown: snapshotExactMarkdown,
    setApplying: () => undefined,
    postExact: () => undefined,
    onError: (error) => {
      throw error
    },
  })
  disposers.push(installDetailsToggleControls(index))

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let target: Text | undefined
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (
      node.parentElement?.closest('p') &&
      node.textContent?.toLowerCase().includes(TOKEN)
    )
      target = node as Text
  expect(Boolean(target)).toBe(true)
  const offset = target!.data.toLowerCase().indexOf(TOKEN)
  const range = document.createRange()
  range.setStart(target!, offset)
  range.setEnd(target!, offset + TOKEN.length)
  input.focus()
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(40)
  // Chromium restores the retained Find range into the editor when the native command arrives.
  const restored = range.cloneRange()
  root.focus()
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(restored)
  document.dispatchEvent(new Event('selectionchange'))
  const options = requestBlockTransformOptions(window)!
  expect(Boolean(options)).toBe(true)
  return { root, button, options, entry, posted, setValue }
}

function selectionEndpoints() {
  const selection = getSelection()!
  return {
    anchorNode: selection.anchorNode,
    anchorOffset: selection.anchorOffset,
    focusNode: selection.focusNode,
    focusOffset: selection.focusOffset,
  }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  for (const outcome of ['apply', 'cancel'] as const) {
    it(`${mode}: keeps the pending Turn Into range intact and resumes Details after ${outcome}`, {
      timeout: 60_000,
    }, () => {
      const view = mount(mode)
      expect(view.entry.units === null).toBe(true)
      const before = selectionEndpoints()
      const insertNode = vi.spyOn(Range.prototype, 'insertNode')
      const mutations = new MutationObserver(() => undefined)
      mutations.observe(view.root, {
        subtree: true,
        childList: true,
        characterData: true,
      })
      vi.advanceTimersByTime(40)
      expect(insertNode).not.toHaveBeenCalled()
      expect(mutations.takeRecords()).toHaveLength(0)
      mutations.disconnect()
      const after = selectionEndpoints()
      expect(
        after.anchorNode === before.anchorNode &&
          after.focusNode === before.focusNode,
      ).toBe(true)
      expect(
        after.anchorOffset === before.anchorOffset &&
          after.focusOffset === before.focusOffset,
      ).toBe(true)
      expect(getSelection()!.toString().toLowerCase() === TOKEN).toBe(true)
      // A normal selection notification must not invalidate a token whose endpoints stayed put.
      document.dispatchEvent(new Event('selectionchange'))
      if (outcome === 'cancel') {
        cancelBlockTransformChoice(view.options.token + 1)
        vi.advanceTimersByTime(40)
        expect(insertNode).not.toHaveBeenCalled()
        cancelBlockTransformChoice(view.options.token)
      } else {
        expect(
          applyBlockTransformChoice(window, view.options.token, { type: 'h2' }),
        ).toBe(true)
        const expected = `${FIXTURE.slice(0, view.options.span.start)}## ${FIXTURE.slice(view.options.span.start)}`
        expect(view.posted.length === 1 && view.posted[0] === expected).toBe(
          true,
        )
      }
      // Lifecycle completion must schedule the deferred fallback without a fresh selection event.
      vi.advanceTimersByTime(40)
      expect(insertNode.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  }
}

it('resumes deferred Details after the host cancels a handle-origin token', {
  timeout: 60_000,
}, () => {
  const view = mount('ir')
  const handle = requestBlockTransformOptionsAtSource(
    window,
    view.options.span.start,
    view.options.span.end,
    (exact, _rendered, editor) => exact === FIXTURE && editor === view.root,
  )!
  expect(Boolean(handle)).toBe(true)
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  const moved = getSelection()!.getRangeAt(0).cloneRange()
  moved.setStart(moved.startContainer, moved.startOffset + 1)
  getSelection()!.removeAllRanges()
  getSelection()!.addRange(moved)
  document.dispatchEvent(new Event('selectionchange'))
  vi.advanceTimersByTime(40)
  expect(insertNode).not.toHaveBeenCalled()
  cancelBlockTransformChoice(handle.token + 1)
  vi.advanceTimersByTime(40)
  expect(insertNode).not.toHaveBeenCalled()
  cancelBlockTransformChoice(handle.token)
  vi.advanceTimersByTime(40)
  expect(insertNode.mock.calls.length).toBeGreaterThanOrEqual(2)
})

it('keeps indexed Details state active while a Turn Into choice is pending', {
  timeout: 60_000,
}, () => {
  const view = mount('ir', `plain ${TOKEN} paragraph\n`)
  expect(view.entry.units !== null).toBe(true)
  const insertNode = vi.spyOn(Range.prototype, 'insertNode')
  vi.advanceTimersByTime(40)
  expect(view.button.disabled).toBe(false)
  expect(view.button.getAttribute('aria-pressed')).toBe('false')
  expect(insertNode).not.toHaveBeenCalled()
  cancelBlockTransformChoice(view.options.token)
  vi.advanceTimersByTime(40)
  expect(insertNode).not.toHaveBeenCalled()
})

it.each(['find', 'outside'] as const)(
  'resumes deferred Details when a changed selection cancels the choice during %s focus transfer',
  { timeout: 60_000 },
  (destination) => {
    const view = mount('ir')
    const insertNode = vi.spyOn(Range.prototype, 'insertNode')
    // First acknowledge the original selection. A second DOM change can precede its queued
    // selectionchange event when focus leaves, so the focus handler must invalidate the token.
    document.dispatchEvent(new Event('selectionchange'))
    vi.advanceTimersByTime(40)
    expect(insertNode).not.toHaveBeenCalled()
    const changed = getSelection()!.getRangeAt(0).cloneRange()
    changed.setStart(changed.startContainer, changed.startOffset + 1)
    getSelection()!.removeAllRanges()
    getSelection()!.addRange(changed)
    view.root.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget:
          destination === 'find'
            ? document.querySelector('input')
            : document.body,
      }),
    )
    expect(
      applyBlockTransformChoice(window, view.options.token, { type: 'h2' }),
    ).toBe(false)
    expect(view.setValue).not.toHaveBeenCalled()
    expect(insertNode).not.toHaveBeenCalled()
    vi.advanceTimersByTime(40)
    expect(insertNode.mock.calls.length).toBeGreaterThanOrEqual(2)
  },
)
