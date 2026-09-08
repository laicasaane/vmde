import { engineLangSet } from '../diagram-kit/engine-registry'

const CONTEXT_ATTRIBUTE = 'data-vscode-context'
const RENDERED_PANE_SELECTOR =
  '.vditor-ir__preview, .vditor-wysiwyg__preview, .vditor-preview, .vmde-diagram-fullscreen-stage'
const DIAGRAM_LANGS = engineLangSet((engine) => engine.diagram)

function setContext(
  element: HTMLElement,
  context: Record<string, string>,
): void {
  const value = JSON.stringify(context)
  if (element.getAttribute(CONTEXT_ATTRIBUTE) !== value) {
    element.setAttribute(CONTEXT_ATTRIBUTE, value)
  }
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

function stampWebviewContexts(root: HTMLElement, scope = root): void {
  setContext(root, { webviewSection: 'editor' })

  for (const block of matchesWithin(
    scope,
    '[data-type="code-block"], pre:not(.vditor-reset)',
  )) {
    setContext(block, { webviewSection: 'code' })
  }
  for (const image of matchesWithin(scope, 'img')) {
    setContext(image, { webviewSection: 'image' })
  }
  for (const chip of matchesWithin(scope, '[data-wiki-link="1"]')) {
    setContext(chip, { webviewSection: 'wiki' })
  }
  for (const candidate of matchesWithin(scope, '[class*="language-"]')) {
    const lang = languageOf(candidate)
    if (!lang || !DIAGRAM_LANGS.has(lang)) continue
    if (!candidate.closest(RENDERED_PANE_SELECTOR)) continue
    // A diagram sits inside a code-block wrapper. Its nearest context must override that
    // wrapper so the native menu can distinguish a rendered diagram from editable source.
    setContext(candidate, { webviewSection: 'diagram', lang })
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
