// @vitest-environment jsdom

import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Disposables } from '../util/disposables'

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
vi.mock('../editing/rewrap-command', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editing/rewrap-command')>()),
  bindRewrapSource,
}))

const installVditorHistoryCoupling = vi.fn()
vi.mock('../editing/undo-keybind', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editing/undo-keybind')>()),
  installVditorHistoryCoupling,
}))
vi.mock('../diagrams/diagram-runtime', () => ({ installDiagramRuntime }))
vi.mock('./toolbar-flow-install', () => ({ installToolbarFlow }))
vi.mock('../editing/initial-caret', () => ({ placeInitialCaret }))
vi.mock('../testing/e2e-readiness', () => ({ markEditorReady }))
// Task 412 — finish-init.ts registers this directly (not through installDiagramRuntime's per-lang
// adapter table, mocked above), so it needs its own mock here.
vi.mock('../diagrams/diagram-retheme', () => ({
  disposeDiagramRethemeGate: vi.fn(),
}))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: innerVditorMock,
}))
vi.mock('../util/source-map', () => ({
  activeModeElement: (): HTMLElement | undefined => undefined,
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
vi.mock('../editing/edit-activity', () => ({
  installEditActivity: () => vi.fn(),
  flushPendingEditorRespin,
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

afterEach(async () => {
  // The mocked hljs load resolves one microtask after `runFinishInit`; let that selectionchange land.
  await Promise.resolve()
  await Promise.resolve()
  const pending = vi.getTimerCount()
  vi.clearAllTimers()
  vi.useRealTimers()
  expect(pending, 'timers left pending; dispose the observers').toBe(0)
})
