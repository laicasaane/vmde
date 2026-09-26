import { engineLangSet } from '../diagram-kit/engine-registry'

const CONTEXT_ATTRIBUTE = 'data-vscode-context'
const RENDERED_PANE_SELECTOR =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview, .vmde-diagram-fullscreen-stage'
const DIAGRAM_LANGS = engineLangSet((engine) => engine.diagram)
const ownedContexts = new WeakMap<HTMLElement, string>()

function setContext(
  element: HTMLElement,
  context: Record<string, string>,
): void {
  const value = JSON.stringify(context)
  if (element.getAttribute(CONTEXT_ATTRIBUTE) !== value) {
    element.setAttribute(CONTEXT_ATTRIBUTE, value)
  }
  ownedContexts.set(element, value)
}

function clearOwnedContext(element: HTMLElement): void {
  const previous = ownedContexts.get(element)
  if (previous && element.getAttribute(CONTEXT_ATTRIBUTE) === previous) {
    element.removeAttribute(CONTEXT_ATTRIBUTE)
  }
  ownedContexts.delete(element)
}

function languageOf(element: HTMLElement): string | null {
  const token = [...element.classList].find((name) =>
    name.startsWith('language-'),
  )
  return token ? token.slice('language-'.length) : null
}

function matchesWithin(root: HTMLElement, selector: string): HTMLElement[] {
  return [
    ...(root.matches(selector) ? [root] : []),
    ...root.querySelectorAll<HTMLElement>(selector),
  ]
}

function diagramContextOf(
  element: HTMLElement,
): { webviewSection: 'diagram'; lang: string } | null {
  for (
    let candidate: HTMLElement | null = element;
    candidate;
    candidate = candidate.parentElement
  ) {
    const lang = languageOf(candidate)
    if (
      lang &&
      DIAGRAM_LANGS.has(lang) &&
      candidate.closest(RENDERED_PANE_SELECTOR)
    ) {
      return { webviewSection: 'diagram', lang }
    }
  }
  return null
}

// Desired contexts for `scope`, in stamping order: a later entry for the same element wins, so a
// diagram overrides its code-block wrapper.
function desiredContexts(
  root: HTMLElement,
  scope: HTMLElement,
): Map<HTMLElement, Record<string, string>> {
  const desired = new Map<HTMLElement, Record<string, string>>()
  desired.set(root, { webviewSection: 'editor' })
  // Source mode has no rendered child region to inherit from; stamp its editable surface directly.
  for (const source of matchesWithin(scope, '.vditor-sv'))
    desired.set(source, { webviewSection: 'editor' })
  for (const block of matchesWithin(
    scope,
    '[data-type="code-block"], pre:not(.vditor-reset)',
  ))
    desired.set(block, { webviewSection: 'code' })
  for (const candidate of matchesWithin(scope, '[class*="language-"]')) {
    const context = diagramContextOf(candidate)
    // A diagram sits inside a code-block wrapper. Its nearest context must override that
    // wrapper so the native menu can distinguish a rendered diagram from editable source.
    if (context) desired.set(candidate, context)
  }
  for (const image of matchesWithin(scope, 'img')) {
    // Leaflet tiles and renderer-owned image output inherit the enclosing diagram context;
    // only authored image regions receive the image discriminator.
    desired.set(image, diagramContextOf(image) ?? { webviewSection: 'image' })
  }
  for (const chip of matchesWithin(scope, '[data-wiki-link="1"]'))
    desired.set(chip, { webviewSection: 'wiki' })
  return desired
}

// Reconcile in place: clear only contexts that are no longer wanted and write only changed values.
// Restamping runs on every presentation class change (Vditor toggles code-block classes as the
// caret moves); clearing and re-adding an identical attribute would be DOM churn that the shared
// source block index must treat as an edit (Task 574).
function stampWebviewContexts(root: HTMLElement, scope = root): void {
  const desired = desiredContexts(root, scope)
  for (const element of matchesWithin(scope, `[${CONTEXT_ATTRIBUTE}]`))
    if (!desired.has(element)) clearOwnedContext(element)
  for (const [element, context] of desired) setContext(element, context)
}

function stampMutationRecord(root: HTMLElement, record: MutationRecord): void {
  if (record.type === 'attributes' && record.target instanceof HTMLElement) {
    stampWebviewContexts(root, record.target)
  }
  if (record.type !== 'childList') return
  for (const node of record.addedNodes) {
    if (node instanceof HTMLElement) stampWebviewContexts(root, node)
  }
}

/**
 * Stamps visibility-only context for VS Code's native webview menu. The values deliberately
 * contain no authored source or node identity: webview/context does not give our commands a
 * trustworthy clicked-node argument, so existing commands must continue to use live selection.
 */
export function installWebviewContext(root: HTMLElement | null): () => void {
  if (!root) return () => undefined
  stampWebviewContexts(root)
  const observer = new MutationObserver((records) =>
    records.forEach((record) => {
      stampMutationRecord(root, record)
    }),
  )
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-type', 'data-wiki-link'],
  })
  return () => observer.disconnect()
}
