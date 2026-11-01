import { ENGINES, engineLangs } from '../diagram-kit/engine-registry'
import {
  nativeSourceForLive,
  renderedDiagramTargets,
} from '../diagram-kit/diagram-surfaces'
import { announce } from '../util/screen-reader'

const DIAGRAMS = ENGINES.filter((engine) => engine.diagram)
const DIAGRAM_SELECTOR = engineLangs((engine) => engine.diagram)
  .map((lang) => `.language-${lang}`)
  .join(', ')
const announcedErrors = new WeakSet<Element>()

function firstSourceLine(source: string | null): string {
  return (
    source
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
      ?.slice(0, 160) ?? ''
  )
}

function announceErrors(root: ParentNode): void {
  for (const error of root.querySelectorAll<HTMLElement>(
    '.vmde-diagram-error',
  )) {
    if (announcedErrors.has(error)) continue
    announcedErrors.add(error)
    const title =
      error.querySelector('.vmde-diagram-error__title')?.textContent?.trim() ||
      'Diagram'
    const message =
      error.querySelector('.vmde-diagram-error__msg')?.textContent?.trim() ||
      'Render failed'
    announce(`${title} diagram error: ${message}`)
  }
}

export function applyDiagramSemantics(root: ParentNode): void {
  for (const engine of DIAGRAMS) {
    for (const wrapper of renderedDiagramTargets(root, engine.lang)) {
      const line = firstSourceLine(nativeSourceForLive(wrapper, engine.lang))
      const label = `${engine.errorTitle} diagram${line ? `: ${line}` : ''}`
      // The viewport toolbar lives inside this wrapper. `role="img"` on the wrapper would make
      // every descendant presentational and hide those controls from assistive tech, so the
      // wrapper is a named figure and only its rendered visual gets image semantics.
      wrapper.setAttribute('role', 'figure')
      wrapper.setAttribute('aria-label', `${engine.errorTitle} diagram`)
      const visual = wrapper.querySelector<HTMLElement>(
        'svg, canvas, .leaflet-container',
      )
      visual?.setAttribute('role', 'img')
      visual?.setAttribute('aria-label', label)
    }
  }
  announceErrors(root)
}

// An added ELEMENT can carry a diagram anywhere in its subtree, so its subtree is searched. An added
// TEXT node cannot; only its parent can be (or sit inside) a diagram, and searching the parent's whole
// subtree for one is O(document) per node. Whitespace text nodes between blocks are added in the
// hundreds per streamed Preview chunk (Task 643), which made that search quadratic for a large one.
function touchesDiagram(records: MutationRecord[]): boolean {
  return records.some((record) =>
    [...record.addedNodes].some((node) => {
      const element = node instanceof Element ? node : node.parentElement
      if (!element) return false
      if (
        element.matches(DIAGRAM_SELECTOR) ||
        element.closest(DIAGRAM_SELECTOR) ||
        element.matches('.vmde-diagram-error')
      )
        return true
      return (
        node instanceof Element &&
        Boolean(
          element.querySelector(DIAGRAM_SELECTOR) ||
            element.querySelector('.vmde-diagram-error'),
        )
      )
    }),
  )
}

export function observeDiagramSemantics(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root) return () => undefined
  let frame = 0
  const run = () => {
    frame = 0
    applyDiagramSemantics(root)
  }
  const observer = new MutationObserver((records) => {
    if (!touchesDiagram(records) || frame) return
    frame = requestAnimationFrame(run)
  })
  observer.observe(root, { childList: true, subtree: true })
  applyDiagramSemantics(root)
  return () => {
    observer.disconnect()
    if (frame) cancelAnimationFrame(frame)
  }
}
