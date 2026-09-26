// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest'
import { Disposables } from '../util/disposables'

const installDiagramRuntime = vi.fn()
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

const installVditorHistoryCoupling = vi.fn()
vi.mock('../editing/undo-keybind', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../editing/undo-keybind')>()),
  installVditorHistoryCoupling,
}))
vi.mock('../diagrams/diagram-runtime', () => ({ installDiagramRuntime }))
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
vi.mock('../editing/undo-boundaries', () => ({ installUndoBoundaries }))
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
vi.mock('../editing/edit-activity', () => ({
  installEditActivity: () => vi.fn(),
}))

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>'
  installDiagramRuntime.mockClear()
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
  ;(window as unknown as { vditor: unknown }).vditor = {}
  ;(
    globalThis as unknown as {
      vscode: { postMessage: ReturnType<typeof vi.fn> }
    }
  ).vscode = { postMessage: vi.fn() }
})

it('delegates the diagram lifecycle to the phased runtime installer', async () => {
  const { runFinishInit } = await import('./finish-init')
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
  // Task 574 Checkpoint 6: the bubble gets the shared source index (created before it) and the
  // plain (uncounted) snapshotPair, not the counted block-handle wrapper.
  expect(installSelectionBubble).toHaveBeenCalledWith(
    expect.objectContaining({
      enabled: true,
      wikiEnabled: false,
      snapshotPair: expect.any(Function),
      index: expect.objectContaining({
        currentKey: expect.any(Function),
        peek: expect.any(Function),
        read: expect.any(Function),
      }),
    }),
  )
  // The bubble gets the plain deps.snapshotPair, not the counted block-handle wrapper.
  const bubbleCallArgs = installSelectionBubble.mock.calls[0][0]
  expect(bubbleCallArgs.snapshotPair).toBe(snapshotPair)
  observers.disposeAll()
  expect(selectionBubbleDispose).toHaveBeenCalledOnce()
  expect(calloutAuthoringDispose).toHaveBeenCalledOnce()
})

it('installs Preview task-checkbox handling with the effective resource option and disposes it', async () => {
  const { runFinishInit } = await import('./finish-init')
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
  const { runFinishInit } = await import('./finish-init')
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
  const { runFinishInit } = await import('./finish-init')
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
  const { runFinishInit } = await import('./finish-init')
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
    exactHostSnapshot,
  )
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
  const { runFinishInit } = await import('./finish-init')
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
  const { runFinishInit } = await import('./finish-init')
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

it('tells edit-sync about history transitions before posting them to the host', async () => {
  const { runFinishInit } = await import('./finish-init')
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
