import { engineLangs } from '../diagram-kit/engine-registry'
import {
  controllerForDiagram,
  type DiagramViewportController,
} from './diagram-viewport-controller'
import {
  DIAGRAM_FULLSCREEN_CHANGE_EVENT,
  fullscreenActionFor,
  type DiagramFullscreenAction,
} from './diagram-fullscreen'
import {
  classifyAndRecordEditorSurfaceMutations,
  forEachChangeScope,
  forEachRecordScope,
  liveFeedOf,
  onLiveChange,
  recordHelperMutationPass,
} from '../util/mutation-impact'
import {
  type BackgroundJob,
  backgroundSchedulerOf,
} from '../util/background-budget'

// Task 576 feedback-path pass: DiagramFullscreenAction now lives in diagram-fullscreen.ts.
// Re-exported here so every existing importer of `DiagramFullscreenAction` from this module keeps
// working unchanged.
export type { DiagramFullscreenAction }

const CONTROL_ATTR = 'data-vmde-diagram-controls'
const PREVIEW_PANES =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview'
const ZOOMABLE_SELECTOR = engineLangs((engine) => engine.zoom !== 'none')
  .map((lang) => `.language-${lang}`)
  .join(', ')
const ownedBars = new WeakSet<HTMLElement>()

// Task 733 (022): with a live feed the helper still records its pass statistics (end-to-end runs
// only): 'local' with the blocks it queued, else 'skipped'. A feed change passes no records.
const NO_RECORDS: readonly MutationRecord[] = []
function recordScopedPass(
  records: readonly MutationRecord[],
  queued: number,
): void {
  recordHelperMutationPass(
    'diagram-controls',
    records,
    queued > 0 ? 'local' : 'skipped',
    queued,
  )
}

function iconButton(label: string, icon: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.setAttribute('data-render', '1')
  const glyph = document.createElement('span')
  glyph.setAttribute('aria-hidden', 'true')
  glyph.textContent = icon
  button.appendChild(glyph)
  return button
}

export function mountDiagramControls(
  wrapper: HTMLElement,
  controller: DiagramViewportController,
  fullscreen?: DiagramFullscreenAction,
): HTMLElement {
  const existing = wrapper.querySelector<HTMLElement>(
    `:scope > [${CONTROL_ATTR}]`,
  )
  if (existing && ownedBars.has(existing)) return existing
  // Renderer/cache DOM cloning keeps markup but not listeners. Replace that inert clone rather than
  // treating its attribute as ownership; the new bar binds to the wrapper's retained controller.
  existing?.remove()
  const bar = document.createElement('div')
  bar.className = 'vmde-diagram-controls'
  bar.setAttribute(CONTROL_ATTR, '1')
  bar.setAttribute('data-render', '1')
  bar.setAttribute('role', 'toolbar')
  bar.setAttribute('aria-label', 'Diagram viewport controls')

  const pan = iconButton('Pan diagram', '✥')
  pan.setAttribute('aria-pressed', String(controller.isPanEnabled()))
  pan.addEventListener('click', () => {
    controller.setPanEnabled(!controller.isPanEnabled())
    pan.setAttribute('aria-pressed', String(controller.isPanEnabled()))
  })
  const zoomOut = iconButton('Zoom out', '−')
  zoomOut.addEventListener('click', () => controller.zoomOut())
  const zoomIn = iconButton('Zoom in', '+')
  zoomIn.addEventListener('click', () => controller.zoomIn())
  bar.append(pan, zoomOut, zoomIn)

  if (fullscreen) {
    const label = () =>
      fullscreen.isActive() ? 'Exit fullscreen' : 'Fullscreen diagram'
    const button = iconButton(label(), '⛶')
    const sync = () => {
      button.title = label()
      button.setAttribute('aria-label', label())
    }
    wrapper.addEventListener(DIAGRAM_FULLSCREEN_CHANGE_EVENT, sync)
    button.addEventListener('click', () => {
      fullscreen.toggle()
      sync()
    })
    bar.appendChild(button)
  }
  const reset = iconButton('Reset view', '↺')
  reset.addEventListener('click', () => controller.reset())
  bar.appendChild(reset)

  // Controls live inside contenteditable preview wrappers. Stop every pointer/click before Vditor's
  // block-expansion handler so using viewport chrome can never open or mutate source.
  for (const type of ['pointerdown', 'mousedown', 'click', 'dblclick']) {
    bar.addEventListener(type, (event) => {
      event.preventDefault()
      event.stopPropagation()
    })
  }
  wrapper.style.position ||= 'relative'
  wrapper.appendChild(bar)
  ownedBars.add(bar)
  return bar
}

function decorateAll(root: ParentNode): void {
  for (const wrapper of root.querySelectorAll<HTMLElement>(ZOOMABLE_SELECTOR)) {
    if (!wrapper.closest(PREVIEW_PANES)) continue
    const controller = controllerForDiagram(wrapper)
    if (controller)
      mountDiagramControls(wrapper, controller, fullscreenActionFor(wrapper))
  }
}

/** One zoomable wrapper of a full pass: its bar, when it is inside a preview pane. */
function decorateOne(wrapper: HTMLElement): void {
  if (!wrapper.isConnected || !wrapper.closest(PREVIEW_PANES)) return
  const controller = controllerForDiagram(wrapper)
  if (controller)
    mountDiagramControls(wrapper, controller, fullscreenActionFor(wrapper))
}

/**
 * Task 733 (012-13, D-13 M1/M2): the full pass (open, a record outside the feed root the classifier
 * cannot scope, a pending block that left the document without a live feed) runs as the frame job
 * `diagram-decorate`, one wrapper per unit. While the unit feed is live, records inside its root are
 * left to the feed (binding rule 6); the change scopes and the render subtrees the feed never
 * reports (`forEachRecordScope`) get their bars in the next frame.
 */
export function observeDiagramControls(app: HTMLElement | null): () => void {
  if (!app)
    return () => {
      /* no editor root to decorate */
    }
  const scheduler = backgroundSchedulerOf(window)
  let disposed = false
  let wrappers: NodeListOf<HTMLElement> | undefined
  let next = 0
  const fullPass: BackgroundJob = {
    name: 'diagram-decorate',
    lane: 'frame',
    step(budget) {
      if (disposed || !app.isConnected) {
        wrappers = undefined
        return false
      }
      if (!wrappers) {
        if (budget.spent()) return true
        wrappers = app.querySelectorAll<HTMLElement>(ZOOMABLE_SELECTOR)
        next = 0
      }
      while (next < wrappers.length) {
        if (budget.spent()) return true
        decorateOne(wrappers[next++])
      }
      wrappers = undefined
      return false
    },
  }
  const postFull = () => {
    wrappers = undefined
    scheduler.post(fullPass)
  }
  let frame = 0
  const pendingBlocks = new Set<HTMLElement>()
  const run = () => {
    frame = 0
    const live = liveFeedOf(app) !== undefined
    for (const block of pendingBlocks) {
      if (block.isConnected) decorateAll(block)
      else if (!live) {
        postFull()
        break
      }
    }
    pendingBlocks.clear()
  }
  const queue = (block: Element) => {
    if (block instanceof HTMLElement) pendingBlocks.add(block)
  }
  const flushSoon = (before: number) => {
    if (pendingBlocks.size > before && !frame)
      frame = requestAnimationFrame(run)
  }
  const observer = new MutationObserver((records) => {
    const before = pendingBlocks.size
    if (liveFeedOf(app)) {
      forEachRecordScope(app, records, queue)
      const added = pendingBlocks.size - before
      recordScopedPass(records, added)
      flushSoon(before)
      return
    }
    const classified = classifyAndRecordEditorSurfaceMutations(
      'diagram-controls',
      records,
    )
    if (!classified || classified.pass === 'skipped') return
    if (classified.impact.full) {
      postFull()
      return
    }
    for (const block of classified.impact.blocks) queue(block)
    flushSoon(before)
  })
  observer.observe(app, { childList: true, subtree: true })
  const offFeed = onLiveChange(app, (change) => {
    if (change.whole) {
      recordHelperMutationPass('diagram-controls', NO_RECORDS, 'full')
      postFull()
      return
    }
    const before = pendingBlocks.size
    forEachChangeScope(change, queue)
    const added = pendingBlocks.size - before
    recordScopedPass(NO_RECORDS, added)
    flushSoon(before)
  })
  postFull()
  return () => {
    disposed = true
    observer.disconnect()
    offFeed()
    scheduler.cancel(fullPass)
    if (frame) cancelAnimationFrame(frame)
  }
}
