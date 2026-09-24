// @vitest-environment jsdom

import { beforeEach, expect, it, vi } from 'vitest'
import { Disposables } from '../util/disposables'

const installDiagramRuntime = vi.fn()
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
const installSelectionBubble = vi.fn(() => selectionBubbleDispose)
const previewTaskCheckboxDispose = vi.fn()
const installPreviewTaskCheckboxes = vi.fn(() => ({
  dispose: previewTaskCheckboxDispose,
}))
const installPreviewState = vi.fn(() => vi.fn())

vi.mock('../diagrams/diagram-runtime', () => ({ installDiagramRuntime }))
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

  runFinishInit(
    { content: '', options: {} } as Parameters<typeof runFinishInit>[0],
    {
      observers,
      cdn: 'test',
      reportDocMode: vi.fn(),
      snapshotExactMarkdown: vi.fn(() => ''),
      setApplying: vi.fn(),
      postExact: vi.fn(),
    },
  )

  expect(installDiagramRuntime).toHaveBeenCalledOnce()
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
  expect(installSelectionBubble).toHaveBeenCalledWith(
    expect.objectContaining({ enabled: true, wikiEnabled: false }),
  )
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
