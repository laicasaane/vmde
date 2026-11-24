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
import { execFileSync } from 'node:child_process'
import { Disposables } from '../util/disposables'
import { sessionState } from './editor-session-state'

const installDiagramRuntime = vi.fn()
const installToolbarFlow = vi.fn()
const placeInitialCaret = vi.fn()
const installDiagramZoomGate = vi.fn()
const markEditorReady = vi.fn()
const outlineViewportDispose = vi.fn()
const installOutlineViewportSync = vi.fn(() => outlineViewportDispose)
const innerVditorMock = vi.fn(() => ({
  currentMode: 'ir',
  preview: { previewElement: undefined as HTMLElement | undefined },
}))
const sectionHoistDispose = vi.fn()
const installSectionHoist = vi.fn(() => ({ dispose: sectionHoistDispose }))
const readingPositionDispose = vi.fn()
const installReadingPosition = vi.fn(() => ({
  save: vi.fn(),
  cancelRestore: vi.fn(),
  dispose: readingPositionDispose,
}))
const undoBoundariesDispose = vi.fn()
const installUndoBoundaries = vi.fn(() => undoBoundariesDispose)
const calloutAuthoringDispose = vi.fn()
const installCalloutAuthoringControls = vi.fn(() => calloutAuthoringDispose)
const selectionBubbleDispose = vi.fn()
const installSelectionBubble = vi.fn(
  (..._args: any[]) => selectionBubbleDispose,
)
const previewTaskCheckboxDispose = vi.fn()
const installPreviewTaskCheckboxes = vi.fn(() => ({
  dispose: previewTaskCheckboxDispose,
}))
const installPreviewState = vi.fn(() => vi.fn())
const unbindTurnIntoSource = vi.fn()
const bindBlockTransformSource = vi.fn(
  (_source: unknown) => unbindTurnIntoSource,
)
vi.mock('../editing/block-transform-command', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../editing/block-transform-command')
  >()),
  bindBlockTransformSource,
}))

const unbindRewrapSource = vi.fn()
const bindRewrapSource = vi.fn((_source: unknown) => unbindRewrapSource)
const rewrapTransitionPending = vi.fn((_inner: unknown) => false)
vi.mock('../editing/rewrap-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editing/rewrap-command')>()),
  bindRewrapSource,
  hasRewrapDocumentHistoryTransition: rewrapTransitionPending,
}))

const compositionActive = vi.fn(() => false)
vi.mock('../util/caret-gesture', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../util/caret-gesture')>()),
  isCompositionActive: compositionActive,
}))

const installVditorHistoryCoupling = vi.fn()
vi.mock('../editing/undo-keybind', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editing/undo-keybind')>()),
  installVditorHistoryCoupling,
}))
vi.mock('../diagrams/diagram-runtime', () => ({ installDiagramRuntime }))
vi.mock('./toolbar-flow-install', () => ({ installToolbarFlow }))
vi.mock('../editing/initial-caret', () => ({ placeInitialCaret }))
const recordE2ESwitches = vi.fn()
vi.mock('../testing/e2e-readiness', () => ({
  markEditorReady,
  recordE2ESwitches,
}))
// Task 412 — finish-init.ts registers this directly (not through installDiagramRuntime's per-lang
// adapter table, mocked above), so it needs its own mock here.
vi.mock('../diagrams/diagram-retheme', () => ({
  disposeDiagramRethemeGate: vi.fn(),
}))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: innerVditorMock,
}))
// Task 733 / 045: the Source consumer cases below point edit-sync at their Source root.
const activeModeElementMock = vi.fn((): HTMLElement | undefined => undefined)
vi.mock('../util/source-map', () => ({
  activeModeElement: () => activeModeElementMock(),
  blockModeElement: (): HTMLElement | null => null,
}))
vi.mock('../chrome/responsive-tables', () => ({ fixResponsiveTables: vi.fn() }))
vi.mock('../chrome/table-resize', () => ({
  installTableColumnResize: () => vi.fn(),
}))
vi.mock('../editing/table-wysiwyg-controls', () => ({
  installTableWysiwygControls: () => vi.fn(),
}))
vi.mock('../chrome/toolbar-actions', () => ({
  handleToolbarClick: vi.fn(),
  reportEditorMode: vi.fn(),
}))
vi.mock('../util/utils', () => ({ fixPanelHover: vi.fn() }))
vi.mock('../chrome/toolbar-scroll-guard', () => ({
  guardToolbarScroll: vi.fn(),
}))
vi.mock('../editing/fix-table-ir', () => ({ fixTableIr: vi.fn() }))
vi.mock('../nav/outline', () => ({ setupOutlineFlash: vi.fn() }))
vi.mock('../nav/outline-viewport-sync', () => ({ installOutlineViewportSync }))
vi.mock('../nav/section-hoist', () => ({ installSectionHoist }))
vi.mock('../nav/reading-position', () => ({ installReadingPosition }))
const preparePendingHistory = vi.fn()
vi.mock('../editing/undo-boundaries', () => ({
  installUndoBoundaries,
  preparePendingHistory,
}))
vi.mock('../nav/outline-resize', () => ({ setupOutlineResize: vi.fn() }))
vi.mock('../editing/preview-morph', () => ({ installPreviewMorph: vi.fn() }))
vi.mock('../editing/preview-state', () => ({ installPreviewState }))
vi.mock('../editing/preview-task-checkboxes', () => ({
  installPreviewTaskCheckboxes,
}))
vi.mock('../nav/split-scroll-sync', () => ({ setupSplitScrollSync: vi.fn() }))
vi.mock('../nav/preview-scroll-preserve', () => ({
  setupPreviewScrollPreserve: vi.fn(),
}))
vi.mock('../editing/selection-bubble', () => ({ installSelectionBubble }))
vi.mock('../editing/callouts', () => ({
  installCalloutAuthoringControls,
  observeCallouts: () => vi.fn(),
}))
vi.mock('../diagrams/diagram-zoom', () => ({
  observeDiagramZoom: () => vi.fn(),
}))
vi.mock('../diagrams/diagram-controls', () => ({
  observeDiagramControls: () => vi.fn(),
}))
vi.mock('../editing/html-comment', () => ({
  observeHtmlComments: () => vi.fn(),
  observePreviewComments: () => vi.fn(),
}))
vi.mock('../editing/code-source', () => ({ observeCodeSource: () => vi.fn() }))
vi.mock('../editing/wysiwyg-code-highlight', () => ({
  ensureHljsLoaded: () => Promise.resolve(),
  observeWysiwygCodeHighlight: () => vi.fn(),
  wrapLuteFlatten: vi.fn(),
}))
vi.mock('../editing/gap-paragraph', () => ({
  observeTrailingParagraph: () => vi.fn(),
}))
vi.mock('../diagrams/diagram-zoom-gate', () => ({ installDiagramZoomGate }))
// list-backspace imports Vditor internals (constants.ts → the esbuild-defined VDITOR_VERSION global),
// so it must be mocked here like the other installers — the real thing is covered by list-backspace.spec.
vi.mock('../editing/list-backspace', () => ({
  installListBackspace: () => vi.fn(),
}))
vi.mock('../diagrams/echarts-fit', () => ({
  installEchartsResize: () => vi.fn(),
}))
vi.mock('../diagrams/smiles-render', () => ({ observeSmiles: () => vi.fn() }))
vi.mock('../diagrams/custom-diagrams', () => ({
  observeCustomDiagrams: () => vi.fn(),
}))
vi.mock('../diagrams/render-cache-client', () => ({
  installRenderCache: () => vi.fn(),
}))
vi.mock('../diagrams/markmap-fit', () => ({
  installMarkmapResize: () => vi.fn(),
}))
vi.mock('../diagrams/abc-fit', () => ({ observeAbc: () => vi.fn() }))
vi.mock('../diagrams/echarts-retheme', () => ({
  observeMindmaps: () => vi.fn(),
}))
vi.mock('../diagrams/mermaid/mermaid-retheme', () => ({
  disposeMermaidDeferObserver: vi.fn(),
}))
const flushPendingEditorRespin = vi.fn()
// The end-to-end readiness ledger is set by the unit-spin stats tests; the counters would wrap the jsdom prototypes.
vi.mock('../testing/edit-counters', () => ({ installEditCounters: vi.fn() }))
vi.mock('../editing/edit-activity', () => ({
  installEditActivity: () => vi.fn(),
  flushPendingEditorRespin,
  isSettleRespinning: () => false,
}))

// Loading finish-init pulls in its partly unmocked module graph (about 2 s alone, far more under
// parallel load). Doing it in a hook with its own timeout keeps that one-off cost out of whichever
// test happens to run first, where it hit the 5 s test timeout and leaked a late call into the
// following tests. A static import cannot be used: the vi.mock factories above read top-level mocks.
let runFinishInit: typeof import('./finish-init').runFinishInit
beforeAll(async () => {
  ;({ runFinishInit } = await import('./finish-init'))
}, 60_000)

beforeEach(() => {
  // Task 687: fake only the timers, so a debounce a test leaves installed (the link popover's
  // 32 ms refresh) is counted in `afterEach` instead of firing after the jsdom teardown.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  document.body.innerHTML = '<div id="app"></div>'
  installDiagramRuntime.mockClear()
  installToolbarFlow.mockClear()
  placeInitialCaret.mockClear()
  innerVditorMock.mockReset().mockReturnValue({
    currentMode: 'ir',
    preview: { previewElement: undefined },
  })
  installSelectionBubble.mockClear()
  selectionBubbleDispose.mockClear()
  installOutlineViewportSync.mockClear()
  outlineViewportDispose.mockClear()
  installSectionHoist.mockClear()
  sectionHoistDispose.mockClear()
  installCalloutAuthoringControls.mockClear()
  calloutAuthoringDispose.mockClear()
  installPreviewTaskCheckboxes.mockClear()
  previewTaskCheckboxDispose.mockClear()
  installPreviewState.mockClear()
  bindBlockTransformSource.mockClear()
  unbindTurnIntoSource.mockClear()
  bindRewrapSource.mockClear()
  unbindRewrapSource.mockClear()
  ;(window as unknown as { vditor: unknown }).vditor = {}
  ;(
    globalThis as unknown as {
      vscode: { postMessage: ReturnType<typeof vi.fn> }
    }
  ).vscode = { postMessage: vi.fn() }
})

it('delegates the diagram lifecycle to the phased runtime installer', async () => {
  const observers = new Disposables()
  const snapshotPair = vi.fn(() => ({ exact: '', rendered: '' }))

  runFinishInit(
    { content: 'Known initial Markdown\n', options: {} } as Parameters<
      typeof runFinishInit
    >[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair,
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installDiagramRuntime).toHaveBeenCalledOnce()
  expect(placeInitialCaret).toHaveBeenCalledWith(
    window.vditor,
    'Known initial Markdown\n',
  )
  expect(installDiagramZoomGate.mock.invocationCallOrder[0]).toBeLessThan(
    installDiagramRuntime.mock.invocationCallOrder[0],
  )
  const runtimeContext = installDiagramRuntime.mock.calls[0][0]
  expect(runtimeContext).toMatchObject({
    app: document.getElementById('app'),
    win: window,
    observers,
  })

  runtimeContext.postCacheMessage({ command: 'diagram-cache-get' })
  expect(vscode.postMessage).toHaveBeenCalledWith({
    command: 'diagram-cache-get',
  })
  expect(markEditorReady).toHaveBeenCalledWith('ir')
  expect(installCalloutAuthoringControls).toHaveBeenCalledWith()
  // Task 574 Checkpoint 6: the bubble gets the shared source index (created before it). Task 630:
  // Link/Wiki Link acquires exact authority instead of reading a pair.
  expect(installSelectionBubble).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: true,
      wikiEnabled: false,
      acquireExactAuthority: expect.any(Function),
      index: expect.objectContaining({
        currentKey: expect.any(Function),
        peek: expect.any(Function),
        read: expect.any(Function),
      }),
    }),
  )
  const bubbleCallArgs = installSelectionBubble.mock.calls[0][0]
  expect(bindBlockTransformSource).toHaveBeenCalledWith({
    index: bubbleCallArgs.index,
    snapshotPair,
  })
  // Task 606: Rewrap proves against the same shared source and unbinds with the layer.
  expect(bindRewrapSource).toHaveBeenCalledWith({
    index: bubbleCallArgs.index,
    snapshotPair,
  })
  observers.disposeAll()
  expect(unbindTurnIntoSource).toHaveBeenCalledOnce()
  expect(unbindRewrapSource).toHaveBeenCalledOnce()
  expect(selectionBubbleDispose).toHaveBeenCalledOnce()
  expect(calloutAuthoringDispose).toHaveBeenCalledOnce()
})

it('installs Preview task-checkbox handling with the effective resource option and disposes it', async () => {
  const observers = new Disposables()
  const owner = { preview: { previewElement: document.createElement('div') } }
  vi.mocked((await import('../util/inner-vditor')).innerVditor).mockReturnValue(
    owner as any,
  )

  runFinishInit(
    {
      content: '',
      options: { interactivePreviewCheckboxes: true },
    } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installPreviewTaskCheckboxes).toHaveBeenCalledWith(owner, true)
  observers.disposeAll()
  expect(previewTaskCheckboxDispose).toHaveBeenCalledOnce()
})

it('registers outline viewport synchronization in the shared disposer lifecycle', async () => {
  const observers = new Disposables()

  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installOutlineViewportSync).toHaveBeenCalledWith(window.vditor)
  observers.disposeAll()
  expect(outlineViewportDispose).toHaveBeenCalledOnce()
})

it('registers section hoisting before the diagram runtime in the shared lifecycle', async () => {
  const observers = new Disposables()

  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installSectionHoist).toHaveBeenCalledWith(window.vditor)
  expect(installSectionHoist.mock.invocationCallOrder[0]).toBeLessThan(
    installDiagramRuntime.mock.invocationCallOrder[0],
  )
  observers.disposeAll()
  expect(sectionHoistDispose).toHaveBeenCalledOnce()
})

it('captures Preview source through the exact host Markdown snapshot', async () => {
  const observers = new Disposables()
  const renderedSource = '\n\n- [ ]  one'
  const exactHostSnapshot = vi.fn(() => '\n\n\n- [ ] one')

  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: exactHostSnapshot,
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(renderedSource).not.toBe(exactHostSnapshot())
  expect(installPreviewState).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(Function),
  )
  const previewSource = (
    installPreviewState.mock.calls[0] as unknown[]
  )[1] as () => string
  exactHostSnapshot.mockClear()
  expect(previewSource()).toBe('\n\n\n- [ ] one')
  expect(exactHostSnapshot).toHaveBeenCalledOnce()
  observers.disposeAll()
})

function mountBlockHandleFixture(mode: 'ir' | 'sv') {
  const root = document.createElement('div')
  root.className = 'vditor-reset'
  root.innerHTML = '<p data-block="0">A</p>'
  document.body.append(root)
  const inner = {
    currentMode: mode,
    ir: { element: root },
    wysiwyg: { element: root },
    preview: { previewElement: undefined as HTMLElement | undefined },
    // A projection owner gives the shared source index a cacheable key.
    lute: {
      Md2VditorIRDOM: () => '',
      Md2VditorDOM: () => '',
      VditorIRDOM2Md: () => '',
      VditorDOM2Md: () => '',
    },
  }
  innerVditorMock.mockReturnValue(inner)
  const rendered = 'A\\n'
  const getValue = vi.fn(() => rendered)
  ;(window as any).vditor = { vditor: inner, getValue }
  const snapshotPair = vi.fn(() => ({ exact: rendered, rendered }))
  return { root, rendered, getValue, snapshotPair }
}

it('shares one counted source-index build across hovers and disposes it with the layer', async () => {
  const observers = new Disposables()
  const { root, rendered, getValue, snapshotPair } =
    mountBlockHandleFixture('ir')
  const metrics = { blockHandleSnapshotCalls: 0 }
  const revision = {}
  ;(window as any).__vmdeBlockHandleCacheMetrics = metrics

  runFinishInit(
    { content: rendered, options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: () => rendered,
      snapshotPair,
      snapshotRevision: () => revision,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  getValue.mockClear()
  root.firstElementChild!.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true }),
  )
  expect(metrics.blockHandleSnapshotCalls).toBe(1)
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(getValue).not.toHaveBeenCalled()
  root.firstElementChild!.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true }),
  )
  expect(snapshotPair).toHaveBeenCalledOnce()
  expect(metrics).toEqual({ blockHandleSnapshotCalls: 1, indexBuilds: 1 })

  observers.disposeAll()
  root.firstElementChild!.textContent = 'B'
  root.firstElementChild!.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true }),
  )
  expect(snapshotPair).toHaveBeenCalledOnce()
  root.remove()
  delete (window as any).__vmdeBlockHandleCacheMetrics
})

it('never takes a snapshot pair for block-handle hover in SV', async () => {
  const observers = new Disposables()
  const { root, rendered, snapshotPair } = mountBlockHandleFixture('sv')

  runFinishInit(
    { content: rendered, options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: () => rendered,
      snapshotPair,
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  root.firstElementChild!.dispatchEvent(
    new MouseEvent('mousemove', { bubbles: true }),
  )
  expect(snapshotPair).not.toHaveBeenCalled()
  observers.disposeAll()
  root.remove()
})

// Task 601: the history wrapper prepares through the undo-boundaries instance, which gets the
// edit-sync history flush and edit-activity's re-spin flush.
it('wires the pending-checkpoint preparation into the history wrapper and undo boundaries', async () => {
  const observers = new Disposables()
  const flushHistoryInput = vi.fn(() => true)
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      flushHistoryInput,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  expect(installVditorHistoryCoupling.mock.calls.at(-1)?.[2]).toBe(
    preparePendingHistory,
  )
  const boundaryCall = installUndoBoundaries.mock.calls.at(-1) as
    | unknown[]
    | undefined
  expect(boundaryCall?.[2]).toEqual({
    flushHistoryInput,
    flushRespin: flushPendingEditorRespin,
    // Task 733 / 009: the boundary publishes through the model while it is live.
    publishNow: expect.any(Function),
    // Task 733 / 036: a tagged exact move takes no outstanding-input flush.
    exactMove: expect.any(Function),
  })
  observers.disposeAll()
})

// Task 602: transitions use edit-sync's text form, every recorded entry flushes a pending edit,
// and a history base is posted to the host without marking a DOM change.
it('wires the history text, the checkpoint flush and the history base post', async () => {
  const observers = new Disposables()
  const flushHistoryInput = vi.fn(() => true)
  const historyText = vi.fn(() => 'text')
  const markEditorChange = vi.fn()
  const postMessage = vi.fn()
  ;(window as any).vscode = { postMessage }
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      markEditorChange,
      flushHistoryInput,
      historyText,
      hostRevision: () => 7,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  const options = installVditorHistoryCoupling.mock.calls.at(-1)?.[3]
  expect(options.readText).toBe(historyText)
  options.onEntryRecorded()
  // Task 677: only the recorded-entry flush names itself, so edit-sync can keep auto-wrap's typing.
  expect(flushHistoryInput).toHaveBeenCalledOnce()
  expect(flushHistoryInput).toHaveBeenCalledWith({ recordedEntry: true })
  options.onHistoryBase('sv', 'base-id-1')
  expect(postMessage).toHaveBeenCalledWith({
    command: 'history-base',
    mode: 'sv',
    baseId: 'base-id-1',
    revision: 7,
  })
  expect(markEditorChange).not.toHaveBeenCalled()
  observers.disposeAll()
})

// Task 700 (G1, safety test): an entry whose checkpoint flush was deferred (automatic wrap) did not
// publish, so it gets no history base.
it('reports a not-published checkpoint flush so the entry gets no base (Task 700 G1)', () => {
  const observers = new Disposables()
  ;(window as any).vscode = { postMessage: vi.fn() }
  const flushHistoryInput = vi.fn((): boolean | 'deferred' => 'deferred')
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      flushHistoryInput,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  const options = installVditorHistoryCoupling.mock.calls.at(-1)?.[3]
  expect(options.onEntryRecorded()).toBe(false)
  flushHistoryInput.mockReturnValue(true)
  expect(options.onEntryRecorded()).toBe(true)
  flushHistoryInput.mockReturnValue(false)
  expect(options.onEntryRecorded()).toBe(true)
  observers.disposeAll()
})

// Task 700 (G2, safety test): while the Preview-first edit view is deferred or being reconstructed,
// `editViewDeferred` is true and no base is posted.
it('posts no history base while the edit view is deferred or reconstructing (Task 700 G2)', () => {
  const observers = new Disposables()
  const postMessage = vi.fn()
  ;(window as any).vscode = { postMessage }
  let deferred = true
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      editViewDeferred: () => deferred,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  const options = installVditorHistoryCoupling.mock.calls.at(-1)?.[3]
  options.onHistoryBase('ir', 'id-1')
  expect(postMessage).not.toHaveBeenCalled()
  deferred = false
  options.onHistoryBase('ir', 'id-2')
  expect(postMessage).toHaveBeenCalledOnce()
  observers.disposeAll()
})

it('tells edit-sync about history transitions before posting them to the host', async () => {
  const observers = new Disposables()
  const markEditorChange = vi.fn()
  const postMessage = vi.fn()
  ;(globalThis as any).vscode = { postMessage }
  ;(window as any).vscode = { postMessage }

  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      markEditorChange,
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  const post = installVditorHistoryCoupling.mock.calls.at(-1)?.[1]
  expect(post).toBeTypeOf('function')
  const message = {
    command: 'history-transition' as const,
    kind: 'undo' as const,
    before: 'b',
    after: 'a',
  }
  post(message)

  expect(markEditorChange).toHaveBeenCalledOnce()
  expect(postMessage).toHaveBeenCalledWith(message)
  expect(markEditorChange.mock.invocationCallOrder[0]).toBeLessThan(
    postMessage.mock.invocationCallOrder[0],
  )
  observers.disposeAll()
})

it('(j) installs the toolbar flow once, before Find, and still wires the late toolbar helpers after it', async () => {
  const observers = new Disposables()
  const set = vi.spyOn(observers, 'set')
  const toolbar = document.createElement('div')
  toolbar.className = 'vditor-toolbar'
  document.body.append(toolbar)
  innerVditorMock.mockReturnValue({
    currentMode: 'ir',
    preview: { previewElement: undefined },
    toolbar: { element: toolbar },
  } as never)

  runFinishInit(
    { content: 'text\n', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installToolbarFlow).toHaveBeenCalledTimes(1)
  expect(installToolbarFlow).toHaveBeenCalledWith(observers)
  const keys = set.mock.calls.map(([key]) => key)
  const findOrder = set.mock.invocationCallOrder[keys.indexOf('find-replace')]
  expect(installToolbarFlow.mock.invocationCallOrder[0]).toBeLessThan(findOrder)
  for (const key of [
    'emoji-picker',
    'toolbar-menu-position',
    'toolbar-row-hover',
  ]) {
    expect(keys, key).toContain(key)
    expect(installToolbarFlow.mock.invocationCallOrder[0], key).toBeLessThan(
      set.mock.invocationCallOrder[keys.indexOf(key)],
    )
  }
  // The flow controller itself is no longer installed from here.
  expect(keys).not.toContain('toolbar-overflow')
  expect(keys).not.toContain('toolbar-collapse')
  expect(keys).not.toContain('escape-toolbar')
  observers.disposeAll()
})

// Task 733 / 002: the unit-spin hook installed by finish-init, over a fake model session.
type SpinHook = (
  vditor: unknown,
  range: Range,
  block: HTMLElement,
  event: InputEvent | undefined,
) => boolean
const STAT_KEYS = [
  'spun',
  'model-off',
  'not-a-unit',
  'event',
  'shape',
  'nested',
  'disabled',
]

async function installHookOverCell(
  lute: unknown,
  readiness: boolean,
): Promise<{
  observers: Disposables
  cell: HTMLElement
  table: HTMLElement
  range: Range
  stats: () => Record<string, unknown> | undefined
  hook: SpinHook
}> {
  document.body.innerHTML =
    '<div id="app"><table data-block="0"><thead><tr><th>old<wbr></th></tr></thead></table></div>'
  const table = document.querySelector('table') as HTMLElement
  const cell = document.querySelector('th') as HTMLElement
  const fakeSession = {
    liveUnitOf: () => ({ el: cell, members: [cell], kind: 'cell', top: table }),
    isLive: () => true,
    onUnitsChanged: () => () => undefined,
  }
  sessionState.modelSession = fakeSession as never
  innerVditorMock.mockReturnValue({
    currentMode: 'ir',
    lute,
    preview: { previewElement: undefined },
  } as never)
  const win = window as unknown as Record<string, unknown>
  if (readiness) win.__vmdeE2EReadiness = {}
  const observers = new Disposables()
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )
  const range = document.createRange()
  range.setStart(cell.firstChild as Node, 1)
  range.collapse(true)
  return {
    observers,
    cell,
    table,
    range,
    stats: () =>
      (win.__vmdeUnitSpinStats as Record<string, unknown> | undefined) && {
        ...(win.__vmdeUnitSpinStats as Record<string, unknown>),
      },
    hook: win.__vmdeSpinUnit as SpinHook,
  }
}

function endUnitSpinTest(observers: Disposables): void {
  observers.disposeAll()
  const win = window as unknown as Record<string, unknown>
  delete win.__vmdeE2EReadiness
  delete win.__vmdeUnitSpinStats
  delete win.__vmdeSpinUnit
  sessionState.modelSession = null
}

it('unit spin: without a live Lute the cell spin is refused as shape and the block spin runs', async () => {
  const t = await installHookOverCell(undefined, true)
  expect(t.hook({}, t.range, t.table, undefined)).toBe(false)
  expect(t.cell.innerHTML).toBe('old<wbr>')
  expect(t.stats()).toEqual({ spun: 0, shape: 1 })
  endUnitSpinTest(t.observers)
})

it('unit spin: stats hold reason names and numbers only', async () => {
  const lute = {
    SpinVditorIRDOM: () =>
      '<table data-block="0"><thead><tr><th>new<wbr></th></tr></thead></table>',
  }
  const t = await installHookOverCell(lute, true)
  expect(t.hook({}, t.range, t.table, undefined)).toBe(true)
  expect(t.cell.innerHTML).toBe('new<wbr>')
  const stats = t.stats() ?? {}
  expect(stats.spun).toBe(1)
  for (const [key, value] of Object.entries(stats)) {
    expect(STAT_KEYS, key).toContain(key)
    expect(typeof value, key).toBe('number')
  }
  endUnitSpinTest(t.observers)
})

it('unit spin: no stats object and no counting without the end-to-end readiness ledger', async () => {
  const lute = {
    SpinVditorIRDOM: () =>
      '<table data-block="0"><thead><tr><th>new<wbr></th></tr></thead></table>',
  }
  const t = await installHookOverCell(lute, false)
  expect(t.hook({}, t.range, t.table, undefined)).toBe(true)
  expect(t.stats()).toBeUndefined()
  endUnitSpinTest(t.observers)
})

// Task 733 / 024: real-VS-Code specs read the shipped switches from the readiness ledger.
it('records the four shipped switches once when the end-to-end readiness ledger exists', async () => {
  const { DEFINITION_UNITS, SOURCE_UNITS, WYSIWYG_UNITS } = await import(
    '../util/unit-changes'
  )
  const { VDITOR_SINGLE_SELECTION_WRITE } = await import(
    '../util/selection-write'
  )
  recordE2ESwitches.mockClear()
  const win = window as unknown as Record<string, unknown>
  win.__vmdeE2EReadiness = {}
  const observers = new Disposables()
  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
      snapshotRevision: () => ({}),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  // Read before the cleanup, so a failing expectation still disposes the observers.
  const calls = recordE2ESwitches.mock.calls.slice()
  observers.disposeAll()
  delete win.__vmdeE2EReadiness
  delete win.__vmdeUnitSpinStats
  delete win.__vmdeSpinUnit

  expect(calls).toEqual([
    [
      {
        wysiwygUnits: WYSIWYG_UNITS,
        sourceUnits: SOURCE_UNITS,
        definitionUnits: DEFINITION_UNITS,
        singleSelectionWrite: VDITOR_SINGLE_SELECTION_WRITE,
      },
    ],
  ])
})

afterEach(async () => {
  // The mocked hljs load resolves one microtask after `runFinishInit`; let that selectionchange land.
  await Promise.resolve()
  await Promise.resolve()
  const pending = vi.getTimerCount()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(pending, 'timers left pending; dispose the observers').toBe(0)
})

// Task 733 / 009: the boundary's `publishNow` (finish-init's publishBoundaryNow) is read at call time.
describe('publishBoundaryNow', () => {
  let active: Disposables | undefined
  const run = () => {
    const observers = new Disposables()
    active = observers
    runFinishInit(
      { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
      {
        observers,
        cdn: 'test',
        reportDocMode: vi.fn(),
        snapshotExactMarkdown: vi.fn(() => ''),
        snapshotPair: vi.fn(() => ({ exact: '', rendered: '' })),
        snapshotRevision: () => ({}),
        setApplying: vi.fn(),
        postExact: vi.fn(),
      },
    )
    const call = installUndoBoundaries.mock.calls.at(-1) as
      | unknown[]
      | undefined
    const options = call?.[2] as { publishNow?: () => boolean } | undefined
    const publishNow = options?.publishNow
    if (!publishNow) throw new Error('publishNow not wired')
    // The session the hook reads at call time (installed after init, as a later model would be).
    sessionState.editSync = { flush } as unknown as typeof sessionState.editSync
    sessionState.modelSession = {
      canPublishDelta,
    } as unknown as typeof sessionState.modelSession
    return { observers, publishNow }
  }
  const saved = {
    editSync: sessionState.editSync,
    modelSession: sessionState.modelSession,
  }
  let flush: ReturnType<typeof vi.fn>
  let canPublishDelta: ReturnType<typeof vi.fn>

  beforeEach(() => {
    flush = vi.fn()
    canPublishDelta = vi.fn(() => true)
    compositionActive.mockReturnValue(false)
    rewrapTransitionPending.mockReturnValue(false)
  })
  afterEach(() => {
    active?.disposeAll()
    active = undefined
    sessionState.editSync = saved.editSync
    sessionState.modelSession = saved.modelSession
    compositionActive.mockReturnValue(false)
    rewrapTransitionPending.mockReturnValue(false)
  })

  it('flushes edit-sync exactly once and answers true while the model can publish a delta', () => {
    const { publishNow } = run()
    expect(publishNow()).toBe(true)
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('answers false without a delta-capable model, and does not flush', () => {
    const { publishNow } = run()
    canPublishDelta.mockReturnValue(false)
    expect(publishNow()).toBe(false)
    sessionState.modelSession = undefined
    expect(publishNow()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })

  it('answers false while Vditor holds its composing lock', () => {
    const { publishNow } = run()
    innerVditorMock.mockReturnValue({
      currentMode: 'ir',
      ir: { composingLock: true },
      preview: { previewElement: undefined },
    } as never)
    expect(publishNow()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })

  it('answers false during a composition', () => {
    const { publishNow } = run()
    compositionActive.mockReturnValue(true)
    expect(publishNow()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })

  it('answers false while a rewrap-document history transition waits for its replay', () => {
    const { publishNow } = run()
    rewrapTransitionPending.mockReturnValue(true)
    expect(publishNow()).toBe(false)
    expect(flush).not.toHaveBeenCalled()
  })
})

// Task 733 / 036 (step C, fix design 2.6): a programmatic insert during a replay is handled at the
// editor API entry as a keyboard paste: its endpoints render and its intent is captured before it writes.
describe('036 C programmatic paste during a replay', () => {
  it('runs the replay input step before insertValue writes, and only while a replay is live', async () => {
    const { installReplayInsertHook } = await import('./finish-init')
    const order: string[] = []
    const original = vi.fn((value: string) => {
      order.push(`insert:${value}`)
    })
    const previousVditor = window.vditor
    const previousSession = sessionState.modelSession
    ;(window as unknown as { vditor: unknown }).vditor = {
      insertValue: original,
    }
    const live = { value: true }
    sessionState.modelSession = {
      replayLive: () => live.value,
      beforeReplayInput: (event: Event) => order.push(`input:${event.type}`),
    } as never
    try {
      const uninstall = installReplayInsertHook()
      window.vditor?.insertValue('[]()')
      live.value = false
      window.vditor?.insertValue('x')
      expect(order).toEqual(['input:paste', 'insert:[]()', 'insert:x'])
      uninstall()
      expect(window.vditor?.insertValue).toBe(original)
    } finally {
      ;(window as unknown as { vditor: unknown }).vditor = previousVditor
      sessionState.modelSession = previousSession
    }
  })
  // H2 fix design rev2 (review point 4): after a mismatch the abandoned replay refuses every edit before the DOM.
  it('the insert hook refuses a programmatic insert while the session refuses edits', async () => {
    const { installReplayInsertHook } = await import('./finish-init')
    const original = vi.fn()
    const previousVditor = window.vditor
    const previousSession = sessionState.modelSession
    ;(window as unknown as { vditor: unknown }).vditor = {
      insertValue: original,
    }
    const refused = { value: true }
    const beforeReplayInput = vi.fn()
    sessionState.modelSession = {
      editsRefused: () => refused.value,
      replayLive: () => false,
      beforeReplayInput,
    } as never
    try {
      const uninstall = installReplayInsertHook()
      window.vditor?.insertValue('x')
      expect(original).not.toHaveBeenCalled()
      expect(beforeReplayInput).not.toHaveBeenCalled()
      refused.value = false
      window.vditor?.insertValue('y')
      expect(original).toHaveBeenCalledOnce()
      uninstall()
    } finally {
      ;(window as unknown as { vditor: unknown }).vditor = previousVditor
      sessionState.modelSession = previousSession
    }
  })
})

// 036 core C2 (R4.3, stop test `mode-switch-visible-insertion`, hook case): the patched `setEditMode`
// calls the hook first; a user switch to another mode flushes the user edits, a programmatic one does not.
describe('036 core C2 flush before setEditMode', () => {
  it('flushes on a user switch to another mode only', async () => {
    const { installBeforeEditMode } = await import('./finish-init')
    const previousSession = sessionState.modelSession
    const flushUserEdits = vi.fn()
    sessionState.modelSession = { flushUserEdits } as never
    try {
      const uninstall = installBeforeEditMode()
      const vditor = { currentMode: 'ir' }
      window.__vmdeBeforeEditMode?.(vditor, 'sv', true)
      expect(flushUserEdits).toHaveBeenCalledTimes(1)
      // A programmatic switch with given Markdown is host-driven; the same mode is no switch.
      window.__vmdeBeforeEditMode?.(vditor, 'sv', false)
      window.__vmdeBeforeEditMode?.(vditor, 'ir', true)
      expect(flushUserEdits).toHaveBeenCalledTimes(1)
      uninstall()
      expect(window.__vmdeBeforeEditMode).toBeUndefined()
    } finally {
      sessionState.modelSession = previousSession
    }
  })
})

// 036 core C4 (M1, R2.1): `programmatic-insert-unproven-unit` and `recheck-before-write` at the insert hook:
// prepared, then admitted right before the original write; a refusal writes nothing and is counted.
describe('036 core C4 insert admission', () => {
  it('refuses an insertValue the session does not admit, before the write', async () => {
    const { installReplayInsertHook } = await import('./finish-init')
    const original = vi.fn()
    const previousVditor = window.vditor
    const previousSession = sessionState.modelSession
    const text = document.createTextNode('text')
    const selection = vi
      .spyOn(document, 'getSelection')
      .mockReturnValue({ anchorNode: text, focusNode: text } as never)
    ;(window as unknown as { vditor: unknown }).vditor = {
      insertValue: original,
    }
    const admitted = { value: false }
    const order: string[] = []
    const refuseReplayInput = vi.fn()
    sessionState.modelSession = {
      editsRefused: () => false,
      replayLive: () => true,
      beforeReplayInput: () => order.push('prepare'),
      replayAcceptsInput: () => {
        order.push('admit')
        return admitted.value
      },
      refuseReplayInput,
    } as never
    try {
      const uninstall = installReplayInsertHook()
      window.vditor?.insertValue('x')
      expect(original).not.toHaveBeenCalled()
      expect(refuseReplayInput).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['prepare', 'admit'])
      admitted.value = true
      window.vditor?.insertValue('y')
      expect(original).toHaveBeenCalledTimes(1)
      uninstall()
    } finally {
      ;(window as unknown as { vditor: unknown }).vditor = previousVditor
      sessionState.modelSession = previousSession
      selection.mockRestore()
    }
  })
})

// 036 core C4 (M1, Q-269): the replay admission the editor commands call.
describe('036 core C4 replay admission for editor commands', () => {
  it('prepares, admits and counts a refusal; true outside a replay', async () => {
    const { installReplayAdmission } = await import('./finish-init')
    const previousSession = sessionState.modelSession
    const text = document.createTextNode('text')
    const selection = vi
      .spyOn(document, 'getSelection')
      .mockReturnValue({ anchorNode: text, focusNode: text } as never)
    const live = { value: true }
    const admitted = { value: false }
    const order: string[] = []
    const refuseReplayInput = vi.fn()
    sessionState.modelSession = {
      replayLive: () => live.value,
      editsRefused: () => false,
      beforeReplayInput: () => order.push('prepare'),
      replayAcceptsInput: () => {
        order.push('admit')
        return admitted.value
      },
      refuseReplayInput,
    } as never
    try {
      const uninstall = installReplayAdmission()
      expect(window.__vmdeReplayAdmit?.(true)).toBe(false)
      expect(refuseReplayInput).toHaveBeenCalledTimes(1)
      expect(order).toEqual(['prepare', 'admit'])
      admitted.value = true
      expect(window.__vmdeReplayAdmit?.(false)).toBe(true)
      live.value = false
      expect(window.__vmdeReplayAdmit?.(true)).toBe(true)
      uninstall()
      expect(window.__vmdeReplayAdmit).toBeUndefined()
    } finally {
      sessionState.modelSession = previousSession
      selection.mockRestore()
    }
  })
})

// Task 733 / 045 (F2): the installed consumer. A real edit-sync controller, the production installer
// (the capture and bubble marks of every editor input and the two Source hooks), Vditor's own Source
// editor listeners (`sv/index.ts`), input handler, mode switch (`toolbar/EditMode.ts`), `setValue` and
// Undo engine, all bundled with the production patch registry, and real Lute. The browser's part (the
// DOM change, then the event) is played by the case; a trusted event goes through jsdom's own dispatch.
describe('045 Source edit signals (installed consumer)', () => {
  // Vditor's Source modules as the bundle ships them: esbuild with the production `vditorSourceConfig`
  // and every source patch of its registry for the files bundled (`patchSvRenderEditSignal` and
  // `patchSvCompositionEndRebuild` among them). esbuild refuses the jsdom realm, so a child Node process
  // bundles them, as undo-snapshot-neutral.test.ts does for Undo. A mocked module would not do: the test
  // runner loads Vditor's own imports natively, unmocked.
  const SOURCE_BUNDLE_SCRIPT = `
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'
const shared = await import(new URL('./media-src/esbuild-shared.mjs', 'file://' + process.cwd() + '/').href)
const { plugins, ...config } = shared.vditorSourceConfig
const patches = { name: 'source-patches', setup(builder) {
  builder.onLoad({ filter: /vditor[\\/\\\\]src[\\/\\\\].*\\.ts$/ }, async (args) => {
    const entries = shared.VDITOR_TS_PATCHES.filter((entry) => entry.file.test(args.path))
    if (entries.length === 0) return undefined
    let contents = await readFile(args.path, 'utf8')
    for (const entry of entries) contents = entry.transform(contents, args.path)
    return { loader: 'ts', contents }
  })
} }
const result = await build({
  stdin: {
    contents: "export { Editor } from './sv/index'; export { inputEvent } from './sv/inputEvent'; " +
      "export { processAfterRender, processSpinVditorSVDOM, processToolbar } from './sv/process'; " +
      "export { Undo } from './undo/index'; export { setEditMode } from './toolbar/EditMode'; " +
      "export { default as Vditor } from '../index';",
    resolveDir: process.cwd() + '/media-src/node_modules/vditor/src/ts',
    loader: 'ts',
    sourcefile: 'source-entry.ts',
  },
  bundle: true, write: false, format: 'cjs', platform: 'browser', logLevel: 'error',
  ...config,
  plugins: [plugins[0], patches],
})
process.stdout.write(result.outputFiles[0].text)
`
  type SourceModules = {
    Editor: new (vditor: unknown) => { element: HTMLElement }
    inputEvent(vditor: unknown, event?: Event): void
    processAfterRender(vditor: unknown, options?: Record<string, boolean>): void
    processSpinVditorSVDOM(markdown: string, vditor: unknown): string
    processToolbar(
      vditor: unknown,
      button: Element,
      prefix: string,
      suffix: string,
    ): void
    Undo: new () => any
    setEditMode(vditor: unknown, type: string, event: Event | string): void
    Vditor: { prototype: { setValue(markdown: string): void } }
  }
  let bundled: SourceModules | undefined
  const shippedSource = (): SourceModules => {
    if (bundled) return bundled
    const text = execFileSync(
      process.execPath,
      ['--input-type=module', '-e', SOURCE_BUNDLE_SCRIPT],
      { cwd: process.cwd(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    )
    const module = { exports: {} as SourceModules }
    new Function('module', 'exports', text)(module, module.exports)
    bundled = module.exports
    return bundled
  }
  // jsdom marks `dispatchEvent` events untrusted (DOM standard); its own events go through the
  // target's internal dispatch with the trusted flag set. Each case checks the flag it relied on.
  const implOf = (object: object): any =>
    (object as any)[
      Object.getOwnPropertySymbols(object).find(
        (symbol) => String(symbol) === 'Symbol(impl)',
      ) as symbol
    ]
  const dispatchTrusted = (target: EventTarget, event: Event): void => {
    implOf(event).isTrusted = true
    implOf(target)._dispatch(implOf(event))
  }
  beforeEach(() => {
    // The file's own hooks fake `setTimeout` and check that no timer is left after each case.
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    )
    vi.stubGlobal('cancelAnimationFrame', (id: number) => clearTimeout(id))
    // Vditor's caret marker (`Lute.Caret`), read from the global as in the webview.
    vi.stubGlobal('Lute', { Caret: '‸' })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    compositionActive.mockReset()
    compositionActive.mockImplementation(() => false)
  })

  type Pair = { exact: string | null; rendered: string }
  const setup = async (o: {
    opened: string
    /** The Source text Vditor shows; the opened text with LF line endings when omitted. */
    source?: string
    trusted?: boolean
    previewHidden?: boolean
  }) => {
    const { installSourceEditSignals } = await import('./finish-init')
    const { createEditSync } = await import('../bridge/edit-sync')
    const { createRealLute } = await import('../testing/real-lute')
    const { Editor, processSpinVditorSVDOM } = shippedSource()
    const previewElement = document.createElement('div')
    previewElement.style.display = o.previewHidden ? 'none' : 'block'
    const reads: Pair[] = []
    const parented = () => {
      const parent = document.createElement('div')
      const element = document.createElement('div')
      parent.append(element)
      return { element }
    }
    const vditor: Record<string, any> = {
      currentMode: 'sv',
      lute: createRealLute('sv').lute,
      options: {
        placeholder: '',
        debugger: false,
        typewriterMode: false,
        counter: { enable: false },
        cache: { enable: false },
        undoDelay: 800,
        preview: { mode: 'both', maxWidth: 800 },
        outline: { enable: false, position: 'left' },
        // boot/vditor-init.ts `input()`: Vditor's input option schedules the edit-sync post.
        input: () => sessionState.editSync?.schedule(),
      },
      hint: { render: () => undefined, element: document.createElement('div') },
      // Vditor's Preview.render returns at once while the pane is hidden (preview/index.ts); the patched
      // one reads `__vmdePreviewSnapshot` (finish-init: the model text, else `legacyExactMarkdown`).
      preview: {
        element: previewElement,
        render: () => {
          const sync = sessionState.editSync
          if (sync && previewElement.style.display !== 'none')
            reads.push(sync.snapshotPair())
        },
      },
      toolbar: { elements: {}, element: document.createElement('div') },
      outline: {
        element: document.createElement('div'),
        render: () => '',
        toggle: () => undefined,
      },
      wysiwyg: parented(),
      ir: parented(),
      undo: { addToUndoStack: vi.fn(), resetIcon: () => undefined },
    }
    vditor.sv = new Editor(vditor as never)
    const root = vditor.sv.element as HTMLElement
    root.innerHTML = processSpinVditorSVDOM(
      o.source ?? o.opened.replace(/\r\n?/g, '\n'),
      vditor as never,
    )
    const dialog = document.createElement('input')
    document.body.append(root, dialog)
    innerVditorMock.mockImplementation(() => vditor as never)
    activeModeElementMock.mockImplementation(() => root)
    const post = vi.fn()
    ;(window as unknown as { vscode: unknown }).vscode = { postMessage: post }
    ;(window as unknown as { vditor: unknown }).vditor = {
      getValue: () => root.textContent ?? '',
      getCurrentMode: () => vditor.currentMode,
    }
    const es = createEditSync({
      isSuppressed: () => false,
      docMode: { cvActive: false, streamActive: false, docChars: 100 },
      initialMarkdown: o.opened,
    })
    const previous = sessionState.editSync
    sessionState.editSync = es
    const marks = vi.spyOn(es, 'markUserInput')
    const notes = vi.spyOn(es, 'noteSourceEdit')
    const trust = { value: o.trusted ?? true }
    // The production options: only the editor filter (boot/main.ts), read at call time like
    // `isActiveEditorInput` (the active Source element may be replaced).
    const uninstall = installSourceEditSignals({
      isEditorInput: (event) =>
        (vditor.sv.element as HTMLElement).contains(event.target as Node),
    })
    const edits = () =>
      post.mock.calls
        .filter((call) => call[0]?.command === 'edit')
        .map((call) => call[0].content as string)
    // The text node holding `text` in the Source DOM.
    const textNode = (text: string): Text => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if ((node as Text).data.includes(text)) return node as Text
      throw new Error(`no text node holds ${JSON.stringify(text)}`)
    }
    const caret = (node: Node, offset: number, end?: number) => {
      const range = document.createRange()
      range.setStart(node, offset)
      if (end === undefined) range.collapse(true)
      else range.setEnd(node, end)
      getSelection()!.removeAllRanges()
      getSelection()!.addRange(range)
    }
    const dispatch = (event: Event, trusted = trust.value) => {
      if (trusted) dispatchTrusted(root, event)
      else root.dispatchEvent(event)
      expect(event.isTrusted).toBe(trusted)
    }
    // A browser text insertion at the caret: the DOM change, the caret after it, then the `input`.
    const type = (data: string, init: InputEventInit = {}) => {
      const range = getSelection()!.getRangeAt(0)
      const node = range.startContainer as Text
      node.insertData(range.startOffset, data)
      caret(node, range.startOffset + data.length)
      const event = new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data,
        ...init,
      })
      dispatch(event)
      return event
    }
    const compose = (
      type: 'compositionstart' | 'compositionend',
      data = '',
    ) => {
      const event = new CompositionEvent(type, { bubbles: true, data })
      dispatch(event)
      return event
    }
    const cleanup = () => {
      getSelection()?.removeAllRanges()
      vi.clearAllTimers()
      uninstall()
      root.remove()
      dialog.remove()
      es.dispose()
      sessionState.editSync = previous
      activeModeElementMock.mockReset()
      activeModeElementMock.mockImplementation(() => undefined)
      innerVditorMock.mockReset()
      innerVditorMock.mockImplementation(() => ({
        currentMode: 'ir',
        preview: { previewElement: undefined },
      }))
    }
    return {
      es,
      vditor,
      root,
      dialog,
      reads,
      marks,
      notes,
      trust,
      edits,
      textNode,
      caret,
      dispatch,
      type,
      compose,
      cleanup,
      /** Source text as edit-sync reads it (without Vditor's editable terminal newline span). */
      sourceText: () => es.snapshotMarkdown(),
    }
  }
  type Harness = Awaited<ReturnType<typeof setup>>
  const run = async (
    o: Parameters<typeof setup>[0],
    body: (t: Harness) => void | Promise<void>,
  ) => {
    const t = await setup(o)
    try {
      await body(t)
    } finally {
      t.cleanup()
    }
  }

  describe('user-input marks', () => {
    it('marks a trusted Source edit once, in capture, so the first preview read rebases it', () =>
      run({ opened: '# T\r\n\r\nalpha beta\r\n' }, async (t) => {
        t.caret(t.textNode('#'), 0)
        t.type('Z')
        expect(t.marks.mock.calls).toEqual([[true]])
        expect(t.reads).toEqual([
          {
            exact: 'Z# T\r\n\r\nalpha beta\r\n',
            rendered: 'Z# T\n\nalpha beta\n',
          },
        ])
        expect(t.notes).toHaveBeenCalledTimes(1)
        // After bubble and before the 250 ms post: the rebased exact bytes still stand.
        expect(t.es.snapshotExactMarkdown()).toBe('Z# T\r\n\r\nalpha beta\r\n')
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['Z# T\n\nalpha beta\n'])
      }))

    it('marks an attached synthetic Source input once, untrusted; its first read never owns the pre-edit bytes', () =>
      run(
        { opened: '# T\r\n\r\nalpha beta\r\n', trusted: false },
        async (t) => {
          t.caret(t.textNode('alpha'), 0)
          t.type('Z')
          expect(t.marks.mock.calls).toEqual([[false]])
          expect(t.reads).toEqual([
            { exact: null, rendered: '# T\n\nZalpha beta\n' },
          ])
          await vi.advanceTimersByTimeAsync(300)
          expect(t.edits()).toEqual(['# T\n\nZalpha beta\n'])
        },
      ))

    it('marks a trusted IR input once, at bubble, with its trust', () =>
      run({ opened: 'a\n' }, (t) => {
        // The Source element stands in for the IR one; its own Vditor handler needs a caret.
        t.caret(t.textNode('a'), 0)
        t.vditor.currentMode = 'ir'
        t.dispatch(new InputEvent('input', { bubbles: true }))
        t.dispatch(new InputEvent('input', { bubbles: true }), false)
        expect(t.marks.mock.calls).toEqual([[true], [false]])
      }))

    it('marks a trusted non-bubbling composing Source input once, in capture, without a render', () =>
      run({ opened: '|a|\r\n|-|\r\n', source: '| a |\n| - |\n' }, (t) => {
        t.caret(t.textNode('a'), 0)
        t.compose('compositionstart')
        t.dispatch(
          new InputEvent('input', { bubbles: false, isComposing: true }),
        )
        expect(t.marks.mock.calls).toEqual([[true]])
        expect(t.notes).not.toHaveBeenCalled()
      }))

    it('marks nested Source inputs once each', () =>
      run({ opened: 'a\n' }, (t) => {
        t.caret(t.textNode('a'), 0)
        const nest = () => {
          t.root.removeEventListener('input', nest)
          t.type('Y')
        }
        t.root.addEventListener('input', nest)
        t.type('X')
        expect(t.marks.mock.calls).toEqual([[true], [true]])
      }))

    it('gives a stopped Source input dispatched again in IR its bubble mark', () =>
      run({ opened: 'a\n' }, (t) => {
        t.caret(t.textNode('a'), 0)
        const stop = (event: Event) => event.stopPropagation()
        t.root.addEventListener('input', stop)
        const event = t.type('X')
        t.root.removeEventListener('input', stop)
        expect(t.marks).toHaveBeenCalledTimes(1)
        t.vditor.currentMode = 'ir'
        t.dispatch(event)
        expect(t.marks.mock.calls).toEqual([[true], [true]])
      }))

    it('marks at bubble when no controller took the capture mark', () =>
      run({ opened: 'a\n' }, (t) => {
        t.caret(t.textNode('a'), 0)
        const es = sessionState.editSync
        sessionState.editSync = undefined
        const restore = () => {
          sessionState.editSync = es
        }
        // Back at the target, before Vditor's handler renders (capture listeners run first there).
        t.root.addEventListener('input', restore, { capture: true, once: true })
        t.type('X')
        expect(t.marks.mock.calls).toEqual([[true]])
      }))

    it('does not mark a toolbar dialog input', () =>
      run({ opened: 'a\n' }, (t) => {
        dispatchTrusted(t.dialog, new InputEvent('input', { bubbles: true }))
        t.dialog.dispatchEvent(new InputEvent('input', { bubbles: true }))
        expect(t.marks).not.toHaveBeenCalled()
      }))
  })

  describe('edits without an input event', () => {
    it('signals a toolbar List edit before its preview read and publishes it', () =>
      run({ opened: '# T\n\nalpha beta\n' }, async (t) => {
        t.caret(t.textNode('alpha'), 2)
        const button = document.createElement('button')
        button.setAttribute('data-type', 'list')
        shippedSource().processToolbar(t.vditor as never, button, '', '')
        expect(t.marks).not.toHaveBeenCalled()
        expect(t.notes).toHaveBeenCalledTimes(1)
        expect(t.reads).toEqual([
          { exact: null, rendered: '# T\n\n* alpha beta\n' },
        ])
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['# T\n\n* alpha beta\n'])
      }))

    it('signals a Paste Plain insertion (Vditor `insertValue`: a Range write, then `inputEvent`)', () =>
      run({ opened: '# T\n\nalpha beta\n' }, async (t) => {
        t.caret(t.textNode('alpha'), 0)
        // Vditor `src/index.ts` insertValue, Source branch.
        const range = getSelection()!.getRangeAt(0)
        range.insertNode(document.createTextNode('P'))
        range.collapse(false)
        shippedSource().inputEvent(t.vditor as never)
        expect(t.marks).not.toHaveBeenCalled()
        expect(t.notes).toHaveBeenCalledTimes(1)
        expect(t.reads).toEqual([
          { exact: null, rendered: '# T\n\nPalpha beta\n' },
        ])
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['# T\n\nPalpha beta\n'])
      }))
  })

  describe('IME composition', () => {
    // Chromium: drafts are composing `input` events (Vditor's handler returns on its composing lock),
    // then `compositionend`, whose Vditor handler calls `inputEvent` and renders.
    const draft = (t: Harness, data: string) =>
      t.type(data, { isComposing: true, inputType: 'insertCompositionText' })

    it('posts nothing for the start and the drafts', () =>
      run({ opened: 'a\r\nb\r\n' }, async (t) => {
        t.caret(t.textNode('a'), 0)
        t.compose('compositionstart')
        draft(t, 'か')
        await vi.advanceTimersByTimeAsync(300)
        expect(t.notes).not.toHaveBeenCalled()
        expect(t.reads).toEqual([])
        expect(t.edits()).toEqual([])
      }))

    it('signals the end of a composition with drafts and publishes the committed text once', () =>
      run({ opened: 'a\r\nb\r\n' }, async (t) => {
        t.caret(t.textNode('a'), 0)
        t.compose('compositionstart')
        draft(t, '仮')
        expect(t.notes).not.toHaveBeenCalled()
        t.compose('compositionend', '仮')
        expect(t.notes).toHaveBeenCalledTimes(1)
        expect(t.reads.at(-1)).toEqual({
          exact: '仮a\r\nb\r\n',
          rendered: '仮a\nb\n',
        })
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['仮a\nb\n'])
      }))

    it('signals a commit with no observed input and never pairs it with the pre-edit bytes', () =>
      run({ opened: 'a\r\nb\r\n' }, async (t) => {
        const a = t.textNode('a')
        t.caret(a, 0)
        t.compose('compositionstart')
        a.insertData(0, '仮')
        t.caret(a, 1)
        t.compose('compositionend', '仮')
        expect(t.notes).toHaveBeenCalledTimes(1)
        expect(t.reads.at(-1)).toEqual({ exact: null, rendered: '仮a\nb\n' })
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['仮a\nb\n'])
      }))

    it('signals a cancel over a selected range, which leaves the selection deleted', () =>
      run({ opened: 'alpha\n\nbravo\n' }, async (t) => {
        const bravo = t.textNode('bravo')
        t.caret(bravo, 0, 5)
        t.compose('compositionstart')
        // Chromium replaces the selection with the draft, and the cancel removes the draft again.
        bravo.deleteData(0, 5)
        t.caret(bravo, 0)
        t.dispatch(
          new InputEvent('input', {
            bubbles: true,
            isComposing: true,
            inputType: 'insertCompositionText',
            data: '',
          }),
        )
        t.compose('compositionend', '')
        expect(t.notes).toHaveBeenCalledTimes(1)
        await vi.advanceTimersByTimeAsync(300)
        expect(t.edits()).toEqual(['alpha\n\n\n'])
      }))

    describe('a composition that changed nothing (no draft, unchanged text)', () => {
      const opened = '|a|\r\n|-|\r\n'
      const source = '| a |\n| - |\n'
      // The caret in the table block, or on the Source root (the split spec's
      // `selectNodeContents(root)` collapsed to its start; no block).
      const place = (t: Harness, at: 'block' | 'root') => {
        if (at === 'block') t.caret(t.textNode('a'), 1)
        else {
          const range = document.createRange()
          range.selectNodeContents(t.root)
          range.collapse(true)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
        }
      }
      it.each([
        ['block', false, false],
        ['block', false, true],
        ['block', true, false],
        ['block', true, true],
        ['root', false, false],
        ['root', false, true],
        ['root', true, false],
        ['root', true, true],
      ] as const)(
        'keeps the pair (caret %s, read before %s, preview hidden %s) through natural settle and Save, and posts nothing',
        (at, anchored, previewHidden) =>
          run({ opened, source, previewHidden }, async (t) => {
            const before = t.sourceText()
            if (anchored)
              expect(t.es.snapshotPair()).toEqual({
                exact: opened,
                rendered: before,
              })
            place(t, at)
            t.compose('compositionstart')
            t.compose('compositionend', '')
            // Vditor's end handler skipped its rebuild: no re-spin, no render, no signal.
            expect(t.reads).toEqual([])
            expect(t.notes).not.toHaveBeenCalled()
            expect(t.marks).not.toHaveBeenCalled()
            expect(t.sourceText()).toBe(before)
            expect(t.vditor.sv.composingLock).toBe(false)
            await vi.advanceTimersByTimeAsync(900)
            expect(t.edits()).toEqual([])
            expect(t.es.snapshotPair()).toEqual({
              exact: opened,
              rendered: before,
            })
            t.es.flush()
            expect(t.edits()).toEqual([])
          }),
      )

      it('rebuilds an end after a draft the cancel erased again (the text is back)', () =>
        run({ opened, source }, async (t) => {
          const a = t.textNode('a')
          t.caret(a, 1)
          t.compose('compositionstart')
          draft(t, 'か')
          // The cancel removes the draft: another composing input, and the block text is back.
          const node = t.textNode('か')
          node.deleteData(node.data.indexOf('か'), 1)
          t.caret(node, 1)
          draft(t, '')
          t.compose('compositionend', '')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(300)
          // The trusted drafts left typing pending: the unchanged rendering is published (Task 628).
          expect(t.edits()).toEqual([t.sourceText()])
        }))

      it('rebuilds an end whose draft input changed another block than the caret’s', () =>
        run({ opened: 'alpha\n\nbravo\n' }, async (t) => {
          t.caret(t.textNode('alpha'), 2)
          t.compose('compositionstart')
          t.textNode('bravo').appendData('!')
          t.dispatch(
            new InputEvent('input', {
              bubbles: true,
              isComposing: true,
              inputType: 'insertCompositionText',
              data: '',
            }),
          )
          t.compose('compositionend', '')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(300)
          expect(t.edits()).toEqual(['alpha\n\nbravo!\n'])
        }))

      // Rev 5 review binding 2: the evidence belongs to one composition, one end and this Source root.
      it('signals a later changed end with no composition of its own, after a completed no-op', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          t.compose('compositionend', '')
          expect(t.notes).not.toHaveBeenCalled()
          const second = t.textNode('second')
          second.insertData(2, '!')
          t.caret(second, 3)
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['first\n\nse!cond\n'])
          // Save keeps it: nothing owns the old bytes.
          t.es.flush()
          expect(t.es.snapshotPair().exact).toBeNull()
          expect(t.edits().at(-1)).toBe('first\n\nse!cond\n')
        }))

      it('signals a later changed end after a stopped no-op end', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          t.root.addEventListener(
            'compositionend',
            (event) => event.stopImmediatePropagation(),
            { capture: true, once: true },
          )
          t.compose('compositionend', '')
          expect(t.reads).toEqual([])
          const second = t.textNode('second')
          second.insertData(2, '!')
          t.caret(second, 3)
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['first\n\nse!cond\n'])
        }))

      it('takes no evidence from a start whose caret is in a block outside this Source root', () =>
        run({ opened, source }, async (t) => {
          const foreign = document.createElement('div')
          foreign.setAttribute('data-block', '0')
          foreign.textContent = 'elsewhere'
          document.body.append(foreign)
          try {
            t.caret(foreign.firstChild as Text, 2)
            t.compose('compositionstart')
            // A commit inside Source with no observed input.
            const node = t.textNode('a')
            node.insertData(1, '!')
            t.caret(node, 2)
            t.compose('compositionend', '!')
            expect(t.notes).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(900)
            expect(t.edits()).toEqual([t.sourceText()])
          } finally {
            foreign.remove()
          }
        }))

      it('takes no evidence from a start over a selected range, even when nothing changed', () =>
        run({ opened, source }, async (t) => {
          t.caret(t.textNode('a'), 0, 1)
          t.compose('compositionstart')
          t.compose('compositionend', '')
          expect(t.notes).toHaveBeenCalledTimes(1)
        }))

      // Rev 6 review binding 2 (Q-289): evidence keyed by the end event, taken at window capture, used
      // only by Vditor's handler of that event, voided by any Source input up to that decision.
      it('rebuilds a changed outer end when a nested no-op end in another block is stopped', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          const first = t.textNode('first')
          first.insertData(2, '!')
          t.caret(first, 3)
          t.root.addEventListener(
            'compositionend',
            () => {
              t.caret(t.textNode('second'), 2)
              t.compose('compositionstart')
              const stopInner = (event: Event) =>
                event.stopImmediatePropagation()
              t.root.addEventListener('compositionend', stopInner, {
                capture: true,
                once: true,
              })
              t.compose('compositionend', '')
              t.caret(t.textNode('fi!rst'), 3)
            },
            { capture: true, once: true },
          )
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['fi!rst\n\nsecond\n'])
        }))

      it('keeps an owned no-op at a root caret when a dialog end is dispatched during it', () =>
        run({ opened, source }, async (t) => {
          const before = t.sourceText()
          expect(t.es.snapshotPair().exact).toBe(opened)
          const range = document.createRange()
          range.selectNodeContents(t.root)
          range.collapse(true)
          getSelection()!.removeAllRanges()
          getSelection()!.addRange(range)
          t.compose('compositionstart')
          t.root.addEventListener(
            'compositionend',
            () => {
              dispatchTrusted(
                t.dialog,
                new CompositionEvent('compositionend', { bubbles: true }),
              )
            },
            { capture: true, once: true },
          )
          t.compose('compositionend', '')
          expect(t.notes).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(900)
          t.es.flush()
          expect(t.edits()).toEqual([])
          expect(t.es.snapshotPair()).toEqual({
            exact: opened,
            rendered: before,
          })
        }))

      it('keeps a no-op whose start is followed by a dialog composition end before its own end', () =>
        run({ opened, source }, async (t) => {
          const before = t.sourceText()
          expect(t.es.snapshotPair().exact).toBe(opened)
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          dispatchTrusted(
            t.dialog,
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          t.compose('compositionend', '')
          expect(t.notes).not.toHaveBeenCalled()
          await vi.advanceTimersByTimeAsync(900)
          t.es.flush()
          expect(t.edits()).toEqual([])
          expect(t.es.snapshotPair()).toEqual({
            exact: opened,
            rendered: before,
          })
        }))

      // Rev 7 review binding 2: one dispatch, a start valid on the current root, no overlap.
      it('rebuilds the same end object dispatched again after its first dispatch stopped before Vditor', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          t.root.addEventListener(
            'compositionend',
            (event) => event.stopImmediatePropagation(),
            { capture: true, once: true },
          )
          const end = t.compose('compositionend', '')
          expect(t.reads).toEqual([])
          const second = t.textNode('second')
          second.insertData(2, '!')
          t.caret(second, 3)
          t.dispatch(end)
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['first\n\nse!cond\n'])
          const replies: string[] = []
          t.es.flushForSave((outcome) => replies.push(outcome))
          expect(replies).not.toEqual(['clean'])
        }))

      it('takes no evidence from a start whose caret block is moved into the Source root before the end', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          const foreign = document.createElement('div')
          foreign.setAttribute('data-block', '0')
          foreign.textContent = 'elsewhere'
          document.body.append(foreign)
          t.caret(foreign.firstChild as Text, 2)
          t.compose('compositionstart')
          t.root.append(foreign)
          const first = t.textNode('first')
          first.insertData(2, '!')
          t.caret(first, 3)
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits().at(-1)).toContain('fi!rst')
        }))

      it('takes no evidence from a foreign caret outside any block (no root fallback for it)', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          const foreign = document.createElement('span')
          foreign.textContent = 'elsewhere'
          document.body.append(foreign)
          try {
            t.caret(foreign.firstChild as Text, 2)
            t.compose('compositionstart')
            const first = t.textNode('first')
            first.insertData(2, '!')
            t.caret(first, 3)
            t.compose('compositionend', '!')
            expect(t.notes).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(900)
            expect(t.edits()).toEqual(['fi!rst\n\nsecond\n'])
          } finally {
            foreign.remove()
          }
        }))

      it('rebuilds the end of a start whose caret is outside every block and the Source root', () =>
        run({ opened: 'alpha\n' }, (t) => {
          const foreign = document.createElement('span')
          foreign.textContent = 'foreign'
          document.body.append(foreign)
          try {
            t.caret(foreign.firstChild as Text, 1)
            t.compose('compositionstart')
            t.caret(t.textNode('alpha'), 1)
            t.compose('compositionend', '')
            expect(t.notes).toHaveBeenCalledTimes(1)
          } finally {
            foreign.remove()
          }
        }))

      it('rebuilds the end of overlapping starts (a second start before any end)', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          const first = t.textNode('first')
          first.insertData(2, '!')
          t.caret(t.textNode('second'), 2)
          t.compose('compositionstart')
          t.caret(t.textNode('fi!rst'), 3)
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['fi!rst\n\nsecond\n'])
        }))

      it('rebuilds a later changed end after a first end stopped at window capture', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          const stop = (event: Event) => event.stopImmediatePropagation()
          window.addEventListener('compositionend', stop, { capture: true })
          t.compose('compositionend', '')
          window.removeEventListener('compositionend', stop, { capture: true })
          const second = t.textNode('second')
          second.insertData(2, '!')
          t.caret(second, 3)
          t.compose('compositionend', '!')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['first\n\nse!cond\n'])
        }))

      it('rebuilds an end when a Source input arrives after its window capture, before Vditor’s handler', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          t.root.addEventListener(
            'compositionend',
            () => {
              const second = t.textNode('second')
              t.caret(second, 2)
              draft(t, '!')
              t.caret(t.textNode('first'), 2)
            },
            { capture: true, once: true },
          )
          t.compose('compositionend', '')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual(['first\n\nse!cond\n'])
        }))

      it('rebuilds a changed end on a replacement Source root while the old root stays connected', () =>
        run({ opened: 'first\n\nsecond\n' }, async (t) => {
          const { Editor, processSpinVditorSVDOM } = shippedSource()
          t.caret(t.textNode('first'), 2)
          t.compose('compositionstart')
          // A re-init that keeps the old Source element connected (hidden).
          const replacement = new Editor(t.vditor as never)
          replacement.element.innerHTML = processSpinVditorSVDOM(
            'first\n\nse!cond\n',
            t.vditor as never,
          )
          t.root.style.display = 'none'
          document.body.append(replacement.element)
          t.vditor.sv = replacement
          activeModeElementMock.mockImplementation(() => replacement.element)
          try {
            const walker = document.createTreeWalker(
              replacement.element,
              NodeFilter.SHOW_TEXT,
            )
            let node = walker.nextNode() as Text | null
            while (node && !node.data.includes('first'))
              node = walker.nextNode() as Text | null
            t.caret(node as Text, 2)
            const end = new CompositionEvent('compositionend', {
              bubbles: true,
              data: '!',
            })
            dispatchTrusted(replacement.element, end)
            expect(t.notes).toHaveBeenCalledTimes(1)
            await vi.advanceTimersByTimeAsync(900)
            expect(t.edits()).toEqual(['first\n\nse!cond\n'])
          } finally {
            replacement.element.remove()
          }
        }))

      it('signals a changed composition that dispatches the same end event object again', () =>
        run({ opened, source }, async (t) => {
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          const end = t.compose('compositionend', '')
          expect(t.notes).not.toHaveBeenCalled()
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          const node = t.textNode('a')
          node.insertData(1, '!')
          t.caret(node, 2)
          t.dispatch(end)
          expect(t.notes).toHaveBeenCalledTimes(1)
          expect(t.reads.at(-1)?.exact).toBeNull()
          await vi.advanceTimersByTimeAsync(300)
          expect(t.edits()).toEqual([t.sourceText()])
        }))

      it('rebuilds the same end event object dispatched again without a new start, after a change', () =>
        run({ opened, source }, async (t) => {
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          // Stopped at the target before Vditor's handler: nothing renders during this dispatch.
          t.root.addEventListener(
            'compositionend',
            (event) => event.stopImmediatePropagation(),
            { capture: true, once: true },
          )
          const end = t.compose('compositionend', '')
          expect(t.reads).toEqual([])
          const node = t.textNode('a')
          node.insertData(1, '!')
          t.caret(node, 2)
          t.dispatch(end)
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(300)
          expect(t.edits()).toEqual([t.sourceText()])
        }))

      it('rebuilds the end when an editor input arrives during it, before Vditor renders', () =>
        run({ opened, source }, async (t) => {
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          // A target capture listener runs before Vditor's end handler; Vditor's input handler still
          // holds its composing lock, so only the end handler's rebuild renders.
          t.root.addEventListener(
            'compositionend',
            () => {
              t.type('!')
            },
            { capture: true, once: true },
          )
          t.compose('compositionend', '')
          expect(t.notes).toHaveBeenCalledTimes(1)
          await vi.advanceTimersByTimeAsync(300)
          expect(t.sourceText()).toContain('!')
          expect(t.edits()).toEqual([t.sourceText()])
        }))

      it.each([
        ['after Vditor’s end handler', false, false],
        ['before Vditor’s end handler', true, false],
        ['before Vditor’s end handler, with the end stopped', true, true],
      ] as const)(
        'signals an eventless in-block edit made %s, at its first preview read, and posts it',
        (_order, capture, stop) =>
          run({ opened, source }, async (t) => {
            t.caret(t.textNode('a'), 1)
            t.compose('compositionstart')
            let first: { notes: number; pair: Pair | undefined } | undefined
            t.root.addEventListener(
              'compositionend',
              (event) => {
                t.textNode('a').appendData('!')
                shippedSource().processAfterRender(t.vditor as never)
                first = {
                  notes: t.notes.mock.calls.length,
                  pair: t.reads.at(-1),
                }
                if (stop) event.stopImmediatePropagation()
              },
              { capture, once: true },
            )
            t.compose('compositionend', '')
            expect(first?.notes).toBeGreaterThanOrEqual(1)
            expect(first?.pair?.exact).toBeNull()
            await vi.advanceTimersByTimeAsync(900)
            expect(t.sourceText()).toContain('!')
            expect(t.edits()).toEqual([t.sourceText()])
          }),
      )

      it('signals a toolbar List edit made before Vditor’s end handler, at its first preview read', () =>
        run({ opened, source }, async (t) => {
          t.caret(t.textNode('a'), 1)
          t.compose('compositionstart')
          let first: { notes: number; pair: Pair | undefined } | undefined
          t.root.addEventListener(
            'compositionend',
            () => {
              const button = document.createElement('button')
              button.setAttribute('data-type', 'list')
              shippedSource().processToolbar(t.vditor as never, button, '', '')
              first = { notes: t.notes.mock.calls.length, pair: t.reads.at(-1) }
            },
            { capture: true, once: true },
          )
          t.compose('compositionend', '')
          expect(first?.notes).toBe(1)
          expect(first?.pair?.exact).toBeNull()
          await vi.advanceTimersByTimeAsync(900)
          expect(t.edits()).toEqual([t.sourceText()])
        }))
    })

    // Task 601: a real edit's checkpoint is pending for `undoDelay`; a composition that changed nothing
    // in that window must leave it armed, so the edit keeps its own Undo and Redo entry.
    describe('the pending checkpoint of an earlier edit', () => {
      const undoAround = async (
        t: Harness,
        between: (t: Harness) => void,
      ): Promise<{
        prior: number
        prepared: number
        undone: string
        redone: string
        redo: number
      }> => {
        const { installUndoBoundaries, preparePendingHistory } =
          await vi.importActual<typeof import('../editing/undo-boundaries')>(
            '../editing/undo-boundaries',
          )
        const undo = new (shippedSource().Undo)()
        t.vditor.undo = undo
        const dispose = installUndoBoundaries(
          { vditor: t.vditor, getValue: () => t.sourceText() } as never,
          window,
          { flushHistoryInput: () => t.es.flushHistoryInput() } as never,
        )
        try {
          t.caret(t.textNode('alpha'), 1)
          undo.addToUndoStack(t.vditor)
          const tail = t.textNode('lpha')
          t.caret(tail, tail.data.indexOf('lpha'))
          t.type('Z')
          between(t)
          const prior = undo.sv.undoStack.length
          expect(preparePendingHistory(t.vditor, 'undo')).toBe(true)
          const prepared = undo.sv.undoStack.length
          undo.undo(t.vditor)
          const undone = t.sourceText()
          const redo = undo.sv.redoStack.length
          undo.redo(t.vditor)
          return { prior, prepared, undone, redone: t.sourceText(), redo }
        } finally {
          dispose()
        }
      }
      const control = {
        prepared: 2,
        undone: 'alpha\n',
        redone: 'aZlpha\n',
        redo: 1,
      }

      it.each([
        ['nothing', (_t: Harness) => undefined],
        [
          'a composition that changed nothing',
          (t: Harness) => {
            t.caret(t.textNode('Z'), 1)
            t.compose('compositionstart')
            t.compose('compositionend', '')
          },
        ],
      ])(
        'keeps one checkpoint for the edit, with %s in its window: Undo and Redo, and the host holds the edit',
        (_name, between) =>
          run({ opened: 'alpha\n' }, async (t) => {
            const result = await undoAround(t, between)
            expect(result).toMatchObject({ prior: 1, ...control })
            // Task 601: the edit is published before the history move, once, with its full text.
            expect(t.edits()).toEqual(['aZlpha\n'])
          }),
      )

      it('still refuses the history move during an active composition', () =>
        run({ opened: 'alpha\n' }, async (t) => {
          const { installUndoBoundaries, preparePendingHistory } =
            await vi.importActual<typeof import('../editing/undo-boundaries')>(
              '../editing/undo-boundaries',
            )
          t.vditor.undo = new (shippedSource().Undo)()
          const dispose = installUndoBoundaries(
            { vditor: t.vditor, getValue: () => t.sourceText() } as never,
            window,
            { flushHistoryInput: () => t.es.flushHistoryInput() } as never,
          )
          try {
            t.caret(t.textNode('alpha'), 1)
            t.type('Z')
            t.compose('compositionstart')
            compositionActive.mockImplementation(() => true)
            expect(preparePendingHistory(t.vditor, 'undo')).toBe(false)
            expect(t.edits()).toEqual([])
          } finally {
            dispose()
          }
        }))
    })
  })

  // The `@probe` marker resolver (sv-first-edit.spec.ts, design section 6.2): the one added element
  // whose direct text children, joined, hold the marker. A typed key splits the span into two text
  // nodes; a paste keeps one.
  const directText = (element: Element): string[] =>
    Array.from(element.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => (child as Text).data)
  const markerElement = (
    records: MutationRecord[],
    marker: string,
  ): Element[] => {
    const added = records
      .flatMap((record) => Array.from(record.addedNodes))
      .filter((node): node is Element => node instanceof Element)
      .flatMap((element) => [element, ...element.querySelectorAll('*')])
    return [...new Set(added)].filter((element) =>
      directText(element).join('').includes(marker),
    )
  }
  it.each([
    ['key', 'zq045', ['z', 'q045 target paragraph']],
    ['paste', 'q045p', ['q045p', 'q045 target paragraph']],
  ] as const)(
    'resolves the %s cell marker to one element and its direct text nodes',
    (cell, marker, fragments) =>
      run({ opened: '# T\n\nq045 target paragraph\n' }, async (t) => {
        const records: MutationRecord[] = []
        const observer = new MutationObserver((list) => records.push(...list))
        observer.observe(t.root, { childList: true, subtree: true })
        try {
          t.caret(t.textNode('q045'), 0)
          if (cell === 'key') t.type('z')
          else {
            const range = getSelection()!.getRangeAt(0)
            range.insertNode(document.createTextNode('q045p'))
            range.collapse(false)
            shippedSource().inputEvent(t.vditor as never)
          }
          records.push(...observer.takeRecords())
          const found = markerElement(records, marker)
          expect(found).toHaveLength(1)
          expect(directText(found[0])).toEqual(fragments)
          expect(found[0].isConnected).toBe(true)
        } finally {
          observer.disconnect()
        }
      }),
  )

  describe('render-only paths', () => {
    const opened = '|a|\r\n|-|\r\n'
    const source = '| a |\n| - |\n'

    it('keeps the pair of a clean canonicalized Source entry (Vditor setEditMode) through settle and Save', () =>
      run({ opened, source: '' }, async (t) => {
        t.vditor.currentMode = 'ir'
        shippedSource().setEditMode(t.vditor as never, 'sv', source)
        expect(t.vditor.currentMode).toBe('sv')
        expect(t.notes).not.toHaveBeenCalled()
        expect(t.reads).toEqual([{ exact: opened, rendered: `${source}\n` }])
        await vi.advanceTimersByTimeAsync(900)
        t.es.flush()
        expect(t.edits()).toEqual([])
      }))

    it('owns the host bytes after a replacement through Vditor setValue, reseed and the visible refresh', () =>
      run({ opened, source }, async (t) => {
        expect(t.es.snapshotPair().exact).toBe(opened)
        // message-router `applyHostUpdate`: Source `setValue`, the reseed with the host bytes, then the
        // visible preview refresh (preview-state `refreshVisiblePreview` calls `preview.render`).
        shippedSource().Vditor.prototype.setValue.call(
          { vditor: t.vditor },
          '| x |\n| - |\n',
        )
        t.es.reseed(undefined, '|x|\r\n|-|\r\n')
        t.vditor.preview.render(t.vditor)
        expect(t.notes).not.toHaveBeenCalled()
        expect(t.reads.at(-1)).toEqual({
          exact: '|x|\r\n|-|\r\n',
          rendered: '| x |\n| - |\n\n',
        })
        await vi.advanceTimersByTimeAsync(900)
        t.es.flush()
        expect(t.edits()).toEqual([])
      }))
  })
  // Rev 10 review binding 3: an inactive end retires its own start, an ambiguous one too, and no other.
  it.each([
    ['caret', 'inactive'],
    ['range', 'inactive'],
    ['range', 'active'],
    ['overlap', 'inactive'],
    ['overlap', 'active'],
  ])(
    'keeps a new genuine no-op after a prior %s start whose end came while Source was %s',
    (shape, kind) =>
      run({ opened: '|a|\r\n|-|\r\n', previewHidden: true }, async (t) => {
        const vd = t.vditor,
          ir = vd.ir.element as HTMLElement,
          parent = ir.parentElement!,
          panel = document.createElement('div')
        vd.options.preview.markdown = { imageCaption: false }
        vd.options.preview.hljs = {}
        vd.options.preview.mode = 'editor'
        document.body.append(parent, panel)
        const switchMode = (mode: string) => {
          shippedSource().setEditMode(
            vd,
            mode,
            new MouseEvent('click', { cancelable: true }),
          )
          t.es.noteModeSwitch()
        }
        vd.currentMode = 'ir'
        vd.lute.SetVditorSV(false)
        vd.lute.SetVditorIR(true)
        ir.innerHTML = vd.lute.Md2VditorIRDOM('|a|\r\n|-|\r\n')
        activeModeElementMock.mockImplementation(
          () => vd[vd.currentMode].element,
        )
        ;(window.vditor as any).getValue = () =>
          vd.currentMode === 'ir'
            ? vd.lute.VditorIRDOM2Md(ir.innerHTML)
            : t.root.textContent
        const delivery = [],
          answers = []
        const tap = (e) => delivery.push([vd.currentMode, e.target === t.root])
        const hook = window.__vmdeSourceCompositionEnd
        window.__vmdeSourceCompositionEnd = (e) => {
          const answer = hook!(e)
          answers.push([vd.currentMode, answer])
          return answer
        }
        window.addEventListener('compositionend', tap, true)
        try {
          switchMode('sv')
          const _prior = t.es.snapshotPair(),
            _s0 = t.root.textContent
          if (shape === 'range') {
            const n = t.textNode('a')
            t.caret(n, 0, 1)
          } else t.caret(t.root, 0)
          t.compose('compositionstart')
          if (shape === 'overlap') t.compose('compositionstart')
          if (kind === 'inactive') switchMode('ir')
          t.root.addEventListener(
            'compositionend',
            (ev) => ev.stopImmediatePropagation(),
            { once: true, capture: true },
          )
          t.root.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          if (kind === 'active') switchMode('ir')
          switchMode('sv')
          const before = t.es.snapshotPair(),
            _beforeDOM = t.root.innerHTML
          t.caret(t.root, 0)
          t.compose('compositionstart')
          t.root.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          await vi.advanceTimersByTimeAsync(900)
          const after = t.es.snapshotPair(),
            _idle = t.edits(),
            save = []
          t.es.flushForSave((x) => save.push(x))
          expect.soft(answers).toEqual([['sv', false]])
          expect.soft(after).toEqual(before)
          expect(t.edits()).toEqual([])
        } finally {
          window.removeEventListener('compositionend', tap, true)
          window.__vmdeSourceCompositionEnd = hook
          parent.remove()
          panel.remove()
        }
      }),
  )

  it.each(['source', 'source-child', 'ir', 'ir-child', 'dialog'])(
    'retires a pending start only at its own Source surface while Source is inactive (%s target)',
    (kind) =>
      run({ opened: '|a|\r\n|-|\r\n', previewHidden: true }, async (t) => {
        const vd = t.vditor,
          ir = vd.ir.element as HTMLElement,
          parent = ir.parentElement!,
          panel = document.createElement('div')
        vd.options.preview.markdown = { imageCaption: false }
        vd.options.preview.hljs = {}
        vd.options.preview.mode = 'editor'
        document.body.append(parent, panel)
        const switchMode = (mode: string) => {
          shippedSource().setEditMode(
            vd,
            mode,
            new MouseEvent('click', { cancelable: true }),
          )
          t.es.noteModeSwitch()
        }
        vd.currentMode = 'ir'
        vd.lute.SetVditorSV(false)
        vd.lute.SetVditorIR(true)
        ir.innerHTML = vd.lute.Md2VditorIRDOM('|a|\r\n|-|\r\n')
        activeModeElementMock.mockImplementation(
          () => vd[vd.currentMode].element,
        )
        ;(window.vditor as any).getValue = () =>
          vd.currentMode === 'ir'
            ? vd.lute.VditorIRDOM2Md(ir.innerHTML)
            : t.root.textContent
        const delivery = [],
          answers = []
        const tap = (e) => delivery.push([vd.currentMode, e.target === t.root])
        const hook = window.__vmdeSourceCompositionEnd
        window.__vmdeSourceCompositionEnd = (e) => {
          const answer = hook!(e)
          answers.push([vd.currentMode, answer])
          return answer
        }
        window.addEventListener('compositionend', tap, true)
        try {
          switchMode('sv')
          const _prior = t.es.snapshotPair(),
            _s0 = t.root.textContent
          t.caret(t.root, 0)
          t.compose('compositionstart')
          switchMode('ir')
          const targets: Record<string, () => Element | null> = {
            source: () => t.root,
            'source-child': () => t.root.querySelector('span'),
            dialog: () => t.dialog,
            ir: () => ir,
            'ir-child': () => ir.querySelector('*'),
          }
          const target = targets[kind]()!
          target.addEventListener(
            'compositionend',
            (ev) => ev.stopImmediatePropagation(),
            { once: true, capture: true },
          )
          target.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          switchMode('sv')
          t.caret(t.root, 0)
          t.root.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          await vi.advanceTimersByTimeAsync(900)
          expect(answers).toEqual([['sv', kind.startsWith('source')]])
        } finally {
          window.removeEventListener('compositionend', tap, true)
          window.__vmdeSourceCompositionEnd = hook
          parent.remove()
          panel.remove()
        }
      }),
  )

  // Rev 9 review binding 2: an end observed while Source is inactive drops its dispatch key and retires
  // its own pending start, so the next Source end has no stale evidence.
  it.each([false, true])(
    'rebuilds an end first observed while Source is inactive at its Source target (reused end object %s)',
    (reuse) =>
      run({ opened: '|a|\r\n|-|\r\n', previewHidden: true }, async (t) => {
        const vd = t.vditor,
          ir = vd.ir.element as HTMLElement,
          parent = ir.parentElement!,
          panel = document.createElement('div')
        vd.options.preview.markdown = { imageCaption: false }
        vd.options.preview.hljs = {}
        vd.options.preview.mode = 'editor'
        document.body.append(parent, panel)
        const switchMode = (mode: string) => {
          shippedSource().setEditMode(
            vd,
            mode,
            new MouseEvent('click', { cancelable: true }),
          )
          t.es.noteModeSwitch()
        }
        vd.currentMode = 'ir'
        vd.lute.SetVditorSV(false)
        vd.lute.SetVditorIR(true)
        ir.innerHTML = vd.lute.Md2VditorIRDOM('|a|\r\n|-|\r\n')
        activeModeElementMock.mockImplementation(
          () => vd[vd.currentMode].element,
        )
        ;(window.vditor as any).getValue = () =>
          vd.currentMode === 'ir'
            ? vd.lute.VditorIRDOM2Md(ir.innerHTML)
            : t.root.textContent
        const delivery = [],
          answers = []
        const tap = (e) => delivery.push([vd.currentMode, e.target === t.root])
        const hook = window.__vmdeSourceCompositionEnd
        window.__vmdeSourceCompositionEnd = (e) => {
          const answer = hook!(e)
          answers.push([vd.currentMode, answer])
          return answer
        }
        window.addEventListener('compositionend', tap, true)
        try {
          switchMode('sv')
          t.es.snapshotPair()
          t.caret(t.root, 0)
          t.compose('compositionstart')
          const e = new CompositionEvent('compositionend', { bubbles: true })
          t.root.addEventListener(
            'compositionend',
            (ev) => ev.stopImmediatePropagation(),
            { once: true, capture: true },
          )
          t.root.dispatchEvent(e)
          switchMode('ir')
          expect(vd.currentMode).toBe('ir')
          t.root.addEventListener(
            'compositionend',
            () => {
              switchMode('sv')
              t.caret(t.root, 0)
            },
            { once: true, capture: true },
          )
          t.root.dispatchEvent(
            reuse
              ? e
              : new CompositionEvent('compositionend', { bubbles: true }),
          )
          await vi.advanceTimersByTimeAsync(900)
          expect(delivery).toEqual([
            ['sv', true],
            ['ir', true],
          ])
          expect(answers).toEqual([['sv', true]])
        } finally {
          window.removeEventListener('compositionend', tap, true)
          window.__vmdeSourceCompositionEnd = hook
          parent.remove()
          panel.remove()
        }
      }),
  )

  it.each([false, true])(
    'rebuilds a fresh unmatched end after an end of the same start observed while Source is inactive (%s)',
    (inactive) =>
      run({ opened: '|a|\r\n|-|\r\n', previewHidden: true }, async (t) => {
        const vd = t.vditor,
          ir = vd.ir.element as HTMLElement,
          parent = ir.parentElement!,
          panel = document.createElement('div')
        vd.options.preview.markdown = { imageCaption: false }
        vd.options.preview.hljs = {}
        vd.options.preview.mode = 'editor'
        document.body.append(parent, panel)
        const switchMode = (mode: string) => {
          shippedSource().setEditMode(
            vd,
            mode,
            new MouseEvent('click', { cancelable: true }),
          )
          t.es.noteModeSwitch()
        }
        vd.currentMode = 'ir'
        vd.lute.SetVditorSV(false)
        vd.lute.SetVditorIR(true)
        ir.innerHTML = vd.lute.Md2VditorIRDOM('|a|\r\n|-|\r\n')
        activeModeElementMock.mockImplementation(
          () => vd[vd.currentMode].element,
        )
        ;(window.vditor as any).getValue = () =>
          vd.currentMode === 'ir'
            ? vd.lute.VditorIRDOM2Md(ir.innerHTML)
            : t.root.textContent
        const delivery = [],
          answers = []
        const tap = (e) => delivery.push([vd.currentMode, e.target === t.root])
        const hook = window.__vmdeSourceCompositionEnd
        window.__vmdeSourceCompositionEnd = (e) => {
          const answer = hook!(e)
          answers.push([vd.currentMode, answer])
          return answer
        }
        window.addEventListener('compositionend', tap, true)
        try {
          switchMode('sv')
          t.es.snapshotPair()
          t.caret(t.root, 0)
          t.compose('compositionstart')
          const e = new CompositionEvent('compositionend', { bubbles: true })
          if (inactive) switchMode('ir')
          t.root.addEventListener(
            'compositionend',
            (ev) => ev.stopImmediatePropagation(),
            { once: true, capture: true },
          )
          t.root.dispatchEvent(e)
          if (!inactive) switchMode('ir')
          switchMode('sv')
          t.caret(t.root, 0)
          t.root.dispatchEvent(
            new CompositionEvent('compositionend', { bubbles: true }),
          )
          await vi.advanceTimersByTimeAsync(900)
          expect(delivery).toEqual([
            [inactive ? 'ir' : 'sv', true],
            ['sv', true],
          ])
          expect(answers).toEqual([['sv', true]])
        } finally {
          window.removeEventListener('compositionend', tap, true)
          window.__vmdeSourceCompositionEnd = hook
          parent.remove()
          panel.remove()
        }
      }),
  )
})
