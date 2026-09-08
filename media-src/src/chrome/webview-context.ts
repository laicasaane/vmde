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

function stampWebviewContexts(root: HTMLElement, scope = root): void {
  for (const element of matchesWithin(scope, `[${CONTEXT_ATTRIBUTE}]`)) {
    clearOwnedContext(element)
  }
  setContext(root, { webviewSection: 'editor' })

  // Source mode has no rendered child region to inherit from; stamp its editable surface directly.
  for (const source of matchesWithin(scope, '.vditor-sv')) {
    setContext(source, { webviewSection: 'editor' })
  }

  for (const block of matchesWithin(
    scope,
    '[data-type="code-block"], pre:not(.vditor-reset)',
  )) {
    setContext(block, { webviewSection: 'code' })
  }
  for (const candidate of matchesWithin(scope, '[class*="language-"]')) {
    const context = diagramContextOf(candidate)
    if (!context) continue
    // A diagram sits inside a code-block wrapper. Its nearest context must override that
    // wrapper so the native menu can distinguish a rendered diagram from editable source.
    setContext(candidate, context)
  }
  for (const image of matchesWithin(scope, 'img')) {
    // Leaflet tiles and renderer-owned image output inherit the enclosing diagram context;
    // only authored image regions receive the image discriminator.
    setContext(image, diagramContextOf(image) ?? { webviewSection: 'image' })
  }
  for (const chip of matchesWithin(scope, '[data-wiki-link="1"]')) {
    setContext(chip, { webviewSection: 'wiki' })
  }
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
