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
import { classifyAndRecordEditorSurfaceMutations } from '../util/mutation-impact'

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

export function observeDiagramControls(app: HTMLElement | null): () => void {
  if (!app)
    return () => {
      /* no editor root to decorate */
    }
  let frame = 0
  let pendingFull = true
  const pendingBlocks = new Set<HTMLElement>()
  const run = () => {
    frame = 0
    if (pendingFull || [...pendingBlocks].some((block) => !block.isConnected))
      decorateAll(app)
    else for (const block of pendingBlocks) decorateAll(block)
    pendingFull = false
    pendingBlocks.clear()
  }
  const schedule = (records: MutationRecord[] = []) => {
    const classified = classifyAndRecordEditorSurfaceMutations(
      'diagram-controls',
      records,
    )
    if (!classified) return
    const { impact, pass } = classified
    if (pass === 'skipped') return
    if (impact.full) pendingFull = true
    if (!pendingFull)
      for (const block of impact.blocks) pendingBlocks.add(block)
    if (!frame) frame = requestAnimationFrame(run)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(app, { childList: true, subtree: true })
  schedule()
  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
