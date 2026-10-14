// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { resolveBlockHandleUnits } from '../nav/block-handle'
import {
  createSourceBlockIndex,
  type SourceBlockIndexHandle,
} from '../nav/source-block-index'
import { createRealLute, type RealLute } from '../testing/real-lute'
import {
  bindUndoSnapshotNeutral,
  isUndoSnapshotMarkerMutation,
} from './undo-snapshot-neutral'

// Task 610: Vditor's `addCaret` writes and removes a `span.vditor-wbr` marker (splitting the
// caret's Text node) on the LIVE root. The integration marks exactly that as source-neutral, so
// the shared source index keeps its entry. These tests run the REAL patched Vditor Undo class
// (bundled from the vendored source with the repository's own patch registry) and the REAL Lute.

const ROOT = path.resolve(__dirname, '../../..')
const LARGE_FIXTURE = path.join(
  ROOT,
  'test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
)
const SMALL = [
  'Alpha paragraph with enough words to split inside.',
  '',
  'Second paragraph with **bold text** and more.',
  '',
  '- list item one',
  '- list item two',
  '',
].join('\n')

type Mode = 'ir' | 'wysiwyg'
type UndoClass = new () => any
let lutes: Record<Mode, RealLute>
let Undo: UndoClass
let large: string

// The class is bundled with the same registry transform the production build applies to
// vditor/src/ts/undo/index.ts, so the test runs the patched `addCaret` / `addToUndoStack`.
// esbuild refuses to run inside the jsdom environment (its realm check fails), so a child Node
// process bundles it and prints the CommonJS text.
const BUNDLE_SCRIPT = `
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[1]
const shared = await import(pathToFileURL(path.join(root, 'media-src/esbuild-shared.mjs')).href)
const entry = shared.VDITOR_TS_PATCHES.find((candidate) => candidate.file.test('vditor/src/ts/undo/index.ts'))
const { plugins, ...config } = shared.vditorSourceConfig
const result = await build({
  entryPoints: [path.join(root, 'media-src/node_modules/vditor/src/ts/undo/index.ts')],
  bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'error',
  ...config,
  plugins: [plugins[0], { name: 'undo-patches', setup(builder) {
    builder.onLoad({ filter: entry.file }, async (args) => ({
      loader: 'ts', contents: entry.transform(await readFile(args.path, 'utf8'), args.path),
    }))
  } }],
})
process.stdout.write(result.outputFiles[0].text)
`

function loadPatchedUndo(): UndoClass {
  const text = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', BUNDLE_SCRIPT, ROOT],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  )
  const module = { exports: {} as { Undo: UndoClass } }
  new Function('module', 'exports', text)(module, module.exports)
  return module.exports.Undo
}

beforeAll(() => {
  lutes = { ir: createRealLute('ir'), wysiwyg: createRealLute('wysiwyg') }
  Undo = loadPatchedUndo()
  large = readFileSync(LARGE_FIXTURE, 'utf8')
}, 60_000)

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
  document.body.replaceChildren()
  getSelection()?.removeAllRanges()
  delete (window as any).vditor
})

function mount(mode: Mode, source: string, bind = true) {
  const real = lutes[mode]
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = real.render(source)
  document.body.append(root)
  const undo = new Undo()
  const vditor = {
    currentMode: mode,
    [mode]: { element: root },
    toolbar: { elements: {} },
    lute: real.lute,
  }
  ;(window as any).vditor = { vditor: { ...vditor, undo }, getValue: vi.fn() }
  const revision = {}
  const snapshotPair = vi.fn(() => ({
    exact: source,
    rendered: real.serialize(root.innerHTML),
  }))
  const index = createSourceBlockIndex({
    getActiveRoot: () => root,
    projection: () => ({ owner: real.lute, mode }),
    snapshotPair,
    snapshotRevision: () => revision,
    resolveUnits: (target, exact, rendered) =>
      resolveBlockHandleUnits(target, exact, rendered, {
        owner: real.lute,
        mode,
        render: real.render,
        serialize: real.serialize,
      }),
  })
  // An independent observer proves the snapshot really wrote DOM, so a green case is not vacuous.
  const recorder = new MutationObserver(() => undefined)
  recorder.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  })
  const unbind = bind ? bindUndoSnapshotNeutral(window, index) : () => undefined
  cleanups.push(() => {
    unbind()
    index.dispose()
    recorder.disconnect()
  })
  return {
    real,
    root,
    undo,
    vditor: (window as any).vditor.vditor,
    index,
    snapshotPair,
    snapshot: () => undo.addToUndoStack((window as any).vditor.vditor),
    // The records of everything written since the previous call.
    written: () => recorder.takeRecords(),
  }
}

type View = ReturnType<typeof mount>

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if (node instanceof Text) nodes.push(node)
  return nodes
}

// A plain paragraph Text node long enough to split in the middle, outside IR markers/previews.
function proseText(root: HTMLElement, minimum = 12): Text {
  const found = textNodes(root).find(
    (node) =>
      node.data.length >= minimum &&
      node.parentElement?.closest('p') &&
      !node.parentElement.closest(
        '.vditor-ir__marker, .vditor-ir__preview, pre, code',
      ),
  )
  if (!found) throw new Error('No prose text node')
  return found
}

function collapseAt(node: Node, offset: number): void {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const selection = getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

const isMarker = (node: Node): boolean =>
  node instanceof HTMLElement && node.classList.contains('vditor-wbr')
const wroteMarker = (records: MutationRecord[]): boolean =>
  records.some((record) => Array.from(record.addedNodes).some(isMarker)) &&
  records.some((record) => Array.from(record.removedNodes).some(isMarker))

async function expectKept(view: View, warm: unknown, revision: number) {
  // The index observer would deliver any record the wrapper left queued in this microtask.
  await Promise.resolve()
  expect(view.index.peek()).toBe(warm)
  expect(view.index.currentKey()?.domRevision).toBe(revision)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  describe(`${mode}: real Undo snapshots on the large fixture`, () => {
    // Contract 2-4 and the Owner target: a snapshot leaves the warmed entry, the build count and
    // the serialization alone, for each way the caret can sit.
    it('keeps the warmed entry, 0 rebuilds and identical serialization across split, element-anchor and first-position snapshots', async () => {
      const view = mount(mode, large)
      const warm = view.index.read()!
      const revision = view.index.currentKey()!.domRevision
      expect(view.snapshotPair).toHaveBeenCalledOnce()
      const htmlBefore = view.root.innerHTML
      const markdownBefore = view.real.serialize(htmlBefore)
      view.written()

      // Split: the caret sits inside a Text node, so the marker insert splits it.
      const text = proseText(view.root)
      collapseAt(text, 5)
      view.snapshot()
      expect(wroteMarker(view.written())).toBe(true)
      expect(text.nextSibling).toBeInstanceOf(Text)
      await expectKept(view, warm, revision)

      // Element anchor: the caret sits between children of an element, so nothing splits.
      const paragraph = text.parentElement!
      collapseAt(paragraph, 1)
      view.snapshot()
      expect(wroteMarker(view.written())).toBe(true)
      await expectKept(view, warm, revision)

      // First-position recording takes its own marker snapshot on the first keydown.
      collapseAt(proseText(view.root, 20), 7)
      view.undo.recordFirstPosition(
        view.vditor,
        new KeyboardEvent('keydown', { key: 'a' }),
      )
      expect(wroteMarker(view.written())).toBe(true)
      await expectKept(view, warm, revision)

      expect(view.index.read()).toBe(warm)
      expect(view.snapshotPair).toHaveBeenCalledOnce()
      const markdownAfter = view.real.serialize(view.root.innerHTML)
      expect(markdownAfter === markdownBefore).toBe(true)
      expect(view.root.innerHTML === htmlBefore).toBe(true)
    }, 120_000)

    // Contract 1/3: neutral means marker-only. A real edit, or a block replacement, in the same
    // task still invalidates and rebuilds.
    it('still invalidates for a real edit or a block replacement made in the same task as a snapshot', async () => {
      const view = mount(mode, large)
      const first = view.index.read()!
      const text = proseText(view.root)

      text.data = `${text.data} edited`
      collapseAt(text, 3)
      view.snapshot()
      await Promise.resolve()
      expect(view.root.textContent).toContain(' edited')
      expect(view.index.peek()).toBeNull()
      const second = view.index.read()!
      expect(second).not.toBe(first)
      expect(view.snapshotPair).toHaveBeenCalledTimes(2)

      const paragraph = proseText(view.root).parentElement!.closest('p')!
      paragraph.replaceWith(paragraph.cloneNode(true))
      collapseAt(proseText(view.root), 3)
      view.snapshot()
      await Promise.resolve()
      expect(view.index.peek()).toBeNull()
    }, 120_000)
  })
}

describe('edge cases on a small document', () => {
  // Record edge: other selection shapes. Each case writes (or skips) the marker; none changes
  // the source, so the entry survives.
  it.each(['ir', 'wysiwyg'] as const)(
    '%s: keeps the entry for non-collapsed, cross-node and outside-root selections and for a present wbr',
    async (mode) => {
      const view = mount(mode, SMALL)
      const warm = view.index.read()!
      const revision = view.index.currentKey()!.domRevision
      const text = proseText(view.root)
      view.written()

      // Non-collapsed inside one Text node: insertNode splits at the range start.
      const inside = document.createRange()
      inside.setStart(text, 2)
      inside.setEnd(text, 6)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(inside)
      view.snapshot()
      expect(wroteMarker(view.written())).toBe(true)
      await expectKept(view, warm, revision)

      // Non-collapsed across two Text nodes (a paragraph and the next block's text).
      const [first, second] = textNodes(view.root).filter(
        (node) => node.data.trim().length > 4 && node.isConnected,
      )
      const across = document.createRange()
      across.setStart(first, 1)
      across.setEnd(second, 1)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(across)
      view.snapshot()
      expect(wroteMarker(view.written())).toBe(true)
      await expectKept(view, warm, revision)

      // Selection outside the root: addCaret writes no marker at all.
      const outside = document.createElement('p')
      outside.textContent = 'outside'
      document.body.append(outside)
      collapseAt(outside.firstChild!, 2)
      view.snapshot()
      expect(view.written()).toEqual([])
      await expectKept(view, warm, revision)

      // A `wbr` already in the root: no insert, and only the removal of a stale marker follows.
      view.root.append(document.createElement('wbr'))
      const stale = document.createElement('span')
      stale.className = 'vditor-wbr'
      view.root.append(stale)
      const staleWarm = view.index.read()!
      const staleRevision = view.index.currentKey()!.domRevision
      view.written()
      collapseAt(proseText(view.root), 4)
      view.snapshot()
      const removal = view.written()
      expect(removal.some((record) => record.removedNodes.length > 0)).toBe(
        true,
      )
      expect(removal.every((record) => record.addedNodes.length === 0)).toBe(
        true,
      )
      await expectKept(view, staleWarm, staleRevision)
    },
  )

  // Record edge: a DOM-writing listener inside the scope is rejected by `accept`.
  it.each(['ir', 'wysiwyg'] as const)(
    '%s: rejects a snapshot whose scope also wrote an element or edited text',
    async (mode) => {
      const view = mount(mode, SMALL, false)
      const inner = view.undo.addCaret.bind(view.undo)
      let write = (): void => undefined
      view.undo.addCaret = (...args: unknown[]) => {
        const result = inner(...args)
        write()
        return result
      }
      const unbind = bindUndoSnapshotNeutral(window, view.index)
      cleanups.push(unbind)

      for (const kind of ['element', 'text'] as const) {
        const warm = view.index.read()!
        write = () => {
          if (kind === 'element')
            view.root.append(document.createElement('div'))
          else proseText(view.root).data += '!'
        }
        collapseAt(proseText(view.root), 4)
        view.snapshot()
        await Promise.resolve()
        expect(view.index.peek(), kind).toBeNull()
        expect(view.index.read(), kind).not.toBe(warm)
      }
    },
  )

  // Record edge: Undo/Redo `renderDiff` replaces innerHTML outside the scope and must still
  // invalidate.
  it.each(['ir', 'wysiwyg'] as const)(
    '%s: Undo and Redo still invalidate the warmed entry',
    async (mode) => {
      const view = mount(mode, SMALL)
      // renderDiff also drives Vditor's after-render, TOC and toolbar helpers. Minimal stand-ins
      // keep them inert (a composing lock and frozen timers stop the deferred callbacks), so the
      // only DOM write left is renderDiff's own innerHTML replacement.
      vi.useFakeTimers()
      cleanups.push(() => vi.useRealTimers())
      const other = mode === 'ir' ? 'wysiwyg' : 'ir'
      Object.assign(view.vditor, {
        options: {
          preview: { markdown: { imageCaption: false } },
          comment: { enable: false },
          typewriterMode: false,
          undoDelay: 0,
        },
        outline: { render: () => '' },
        hint: { element: document.createElement('div') },
        toolbar: { elements: {}, element: document.createElement('div') },
        [mode]: { element: view.root, composingLock: true },
        [other]: {},
      })
      collapseAt(proseText(view.root), 3)
      view.snapshot()
      proseText(view.root).data += ' changed'
      view.snapshot()
      expect(view.undo[mode].undoStack.length).toBe(2)

      const warm = view.index.read()!
      view.undo.undo(view.vditor)
      await Promise.resolve()
      expect(view.index.peek()).toBeNull()

      const afterUndo = view.index.read()!
      expect(afterUndo).not.toBe(warm)
      view.undo.redo(view.vditor)
      await Promise.resolve()
      expect(view.index.peek()).toBeNull()
    },
  )

  // Record edge: SV has no source index; the wrapper must not throw there.
  it('does not throw in SV, where the index has no root', () => {
    const root = document.createElement('div')
    root.textContent = 'plain source'
    document.body.append(root)
    const undo = new Undo()
    const vditor = {
      currentMode: 'sv',
      sv: { element: root },
      toolbar: { elements: {} },
    }
    ;(window as any).vditor = { vditor: { ...vditor, undo } }
    const index = createSourceBlockIndex({
      getActiveRoot: () => null,
      projection: () => null,
      snapshotPair: () => ({ exact: '', rendered: '' }),
      snapshotRevision: () => undefined,
      resolveUnits: () => null,
    })
    cleanups.push(bindUndoSnapshotNeutral(window, index), () => index.dispose())
    collapseAt(root.firstChild!, 3)

    expect(() => undo.addToUndoStack(vditor)).not.toThrow()
    expect(undo.sv.undoStack).toHaveLength(1)
  })
})

describe('the wrapper contract', () => {
  function fakeUndo() {
    const calls: unknown[][] = []
    const undo = {
      addCaret: vi.fn(function (this: unknown, ...args: unknown[]) {
        calls.push([this, ...args])
        return '<p>snapshot</p>'
      }),
    }
    return { undo, calls, win: { vditor: { vditor: { undo } } } }
  }
  function fakeIndex() {
    const scope = vi.fn(
      (run: () => unknown, accept?: (records: MutationRecord[]) => boolean) => {
        void accept
        return run()
      },
    )
    return { sourceNeutral: scope } as unknown as SourceBlockIndexHandle & {
      sourceNeutral: typeof scope
    }
  }

  it('fails loudly when the Undo instance has no addCaret, and does nothing without an Undo', () => {
    expect(() =>
      bindUndoSnapshotNeutral(
        { vditor: { vditor: { undo: {} } } },
        fakeIndex(),
      ),
    ).toThrow(/addCaret/)
    const unbind = bindUndoSnapshotNeutral({ vditor: {} }, fakeIndex())
    expect(unbind).toBeTypeOf('function')
    expect(() => unbind()).not.toThrow()
  })

  it('wraps addCaret once per Undo object, keeping this, arguments and the result', () => {
    const { undo, win, calls } = fakeUndo()
    const index = fakeIndex()
    bindUndoSnapshotNeutral(win, index)
    const wrapped = undo.addCaret
    bindUndoSnapshotNeutral(win, index)
    expect(undo.addCaret).toBe(wrapped)

    const result = (undo.addCaret as (...a: unknown[]) => unknown)('v', true)
    expect(result).toBe('<p>snapshot</p>')
    expect(calls).toEqual([[undo, 'v', true]])
    expect(index.sourceNeutral).toHaveBeenCalledOnce()
    expect(index.sourceNeutral.mock.calls[0][1]).toBe(
      isUndoSnapshotMarkerMutation,
    )
  })

  it('scopes every registered index, drops one on unbind, and passes through when none remain', () => {
    const { undo, win, calls } = fakeUndo()
    const first = fakeIndex()
    const second = fakeIndex()
    const unbindFirst = bindUndoSnapshotNeutral(win, first)
    const unbindSecond = bindUndoSnapshotNeutral(win, second)
    const wrapped = undo.addCaret

    ;(undo.addCaret as () => unknown)()
    expect(first.sourceNeutral).toHaveBeenCalledOnce()
    expect(second.sourceNeutral).toHaveBeenCalledOnce()

    unbindFirst()
    unbindFirst()
    ;(undo.addCaret as () => unknown)()
    expect(first.sourceNeutral).toHaveBeenCalledOnce()
    expect(second.sourceNeutral).toHaveBeenCalledTimes(2)

    unbindSecond()
    expect((undo.addCaret as () => unknown)()).toBe('<p>snapshot</p>')
    expect(second.sourceNeutral).toHaveBeenCalledTimes(2)
    expect(calls).toHaveLength(3)
    // A later registration reuses the same wrapper.
    bindUndoSnapshotNeutral(win, first)
    expect(undo.addCaret).toBe(wrapped)
  })
})

// Contract 3: `accept` verifies the marking; anything outside the exact marker/split shape
// invalidates. Each case drives real jsdom mutation records.
describe('isUndoSnapshotMarkerMutation', () => {
  function records(
    setup: (root: HTMLElement) => void,
    run: (root: HTMLElement) => void,
  ) {
    const root = document.createElement('div')
    root.innerHTML = '<p>Hello world</p><p>Second</p>'
    document.body.append(root)
    setup(root)
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    run(root)
    const taken = observer.takeRecords()
    observer.disconnect()
    return taken
  }
  const marker = (): HTMLElement => {
    const span = document.createElement('span')
    span.className = 'vditor-wbr'
    return span
  }
  const noSetup = (): void => undefined

  it('accepts an empty batch, a marker insert-and-remove, and a marker with a Text split', () => {
    expect(isUndoSnapshotMarkerMutation([])).toBe(true)
    const pair = records(noSetup, (root) => {
      const span = marker()
      root.firstElementChild!.append(span)
      span.remove()
    })
    expect(pair.length).toBeGreaterThan(0)
    expect(isUndoSnapshotMarkerMutation(pair)).toBe(true)
    const split = records(noSetup, (root) => {
      const text = root.firstElementChild!.firstChild as Text
      const range = document.createRange()
      range.setStart(text, 5)
      range.collapse(true)
      const span = marker()
      range.insertNode(span)
      span.remove()
    })
    expect(split.some((record) => record.type === 'characterData')).toBe(true)
    expect(isUndoSnapshotMarkerMutation(split)).toBe(true)
  })

  it.each([
    [
      'a marker left connected',
      noSetup,
      (root: HTMLElement) => root.firstElementChild!.append(marker()),
    ],
    [
      'another element added',
      noSetup,
      (root: HTMLElement) => root.append(document.createElement('div')),
    ],
    [
      'a non-marker element removed',
      noSetup,
      (root: HTMLElement) => root.lastElementChild!.remove(),
    ],
    [
      'a marker with children',
      noSetup,
      (root: HTMLElement) => {
        const span = marker()
        span.textContent = 'x'
        root.firstElementChild!.append(span)
        span.remove()
      },
    ],
    [
      'a Text node removed (a normalize merge)',
      (root: HTMLElement) => root.firstElementChild!.append('tail'),
      (root: HTMLElement) => root.firstElementChild!.normalize(),
    ],
    [
      'a Text node added without a split',
      noSetup,
      (root: HTMLElement) =>
        root.firstElementChild!.append(document.createTextNode('more')),
    ],
    [
      'a Text node added after an element',
      (root: HTMLElement) => root.firstElementChild!.append(marker()),
      (root: HTMLElement) =>
        root.firstElementChild!.append(document.createTextNode('more')),
    ],
    [
      'a text edit without a split',
      noSetup,
      (root: HTMLElement) => {
        ;(root.firstElementChild!.firstChild as Text).data = 'edited'
      },
    ],
    [
      'a Comment edit',
      (root: HTMLElement) => root.append(document.createComment('c')),
      (root: HTMLElement) => {
        ;(root.lastChild as Comment).data = 'changed'
      },
    ],
    [
      'an attribute write',
      noSetup,
      (root: HTMLElement) => root.firstElementChild!.setAttribute('href', 'x'),
    ],
  ])('rejects %s', (_label, setup, run) => {
    const taken = records(setup, run)
    expect(taken.length).toBeGreaterThan(0)
    expect(isUndoSnapshotMarkerMutation(taken)).toBe(false)
  })
})
