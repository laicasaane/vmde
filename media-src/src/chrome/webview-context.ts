import { engineLangSet } from '../diagram-kit/engine-registry'
import { writeQuietly } from '../util/mutation-impact'

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
  // Task 706: a `pre` inside a diagram label (a d2 `|md` label's svg foreignObject) is diagram
  // content; it inherits the diagram context. Stamping it `code` offered code actions on the
  // picture and made cache-painted copies differ from the edit view. `closest('svg')`: HTML
  // reaches an svg only through foreignObject, and that mixed-case type selector does not match
  // in jsdom. Checked only on blocks already found.
  for (const block of matchesWithin(
    scope,
    '[data-type="code-block"], pre:not(.vditor-reset)',
  ))
    if (!block.closest('svg')) desired.set(block, { webviewSection: 'code' })
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
  // `data-vscode-context` is view-only: quiet, so the unit-DOM shadow model sees no edit.
  writeQuietly(() => {
    for (const element of matchesWithin(scope, `[${CONTEXT_ATTRIBUTE}]`))
      if (!desired.has(element)) clearOwnedContext(element)
    for (const [element, context] of desired) setContext(element, context)
  })
}

// The context `element` alone wants, by the rules of `desiredContexts` in the same order (a later
// rule wins); reads only the element and its ancestors, never its subtree.
function desiredContextOf(
  root: HTMLElement,
  element: HTMLElement,
): Record<string, string> | null {
  let context: Record<string, string> | null =
    element === root ? { webviewSection: 'editor' } : null
  if (element.matches('.vditor-sv')) context = { webviewSection: 'editor' }
  if (
    element.matches('[data-type="code-block"], pre:not(.vditor-reset)') &&
    !element.closest('svg')
  )
    context = { webviewSection: 'code' }
  if (element.matches('[class*="language-"]'))
    context = diagramContextOf(element) ?? context
  if (element.localName === 'img')
    context = diagramContextOf(element) ?? { webviewSection: 'image' }
  if (element.matches('[data-wiki-link="1"]'))
    context = { webviewSection: 'wiki' }
  return context
}

function stampElement(root: HTMLElement, element: HTMLElement): void {
  const context = desiredContextOf(root, element)
  writeQuietly(() => {
    if (context) setContext(element, context)
    else if (element.hasAttribute(CONTEXT_ATTRIBUTE)) clearOwnedContext(element)
  })
}

const PANE_CLASSES = new Set([
  'vditor-ir__preview',
  'vditor-wysiwyg__preview',
  'vditor-preview',
  'vmde-diagram-fullscreen-stage',
])

function movesDescendantContexts(token: string): boolean {
  return token.startsWith('language-') || PANE_CLASSES.has(token)
}

// Task 733 / 031: only a rendered pane or a `language-` element decides its descendants' contexts
// (`diagramContextOf` walks up to them), so an attribute change restamps the subtree only when the
// target is, or was before this class change, one of them; any other attribute change restamps the
// target alone, so a class toggle on the edit surface queries nothing.
function attributeMovesSubtree(record: MutationRecord): boolean {
  const target = record.target as HTMLElement
  if (target.matches(RENDERED_PANE_SELECTOR)) return true
  for (const token of target.classList)
    if (movesDescendantContexts(token)) return true
  if (record.attributeName !== 'class' || !record.oldValue) return false
  for (const token of record.oldValue.split(/\s+/))
    if (movesDescendantContexts(token)) return true
  return false
}

// Task 733 / 031: one observer batch stamps each scope once. Subtree scopes are the added elements and
// the attribute targets that move descendant contexts; a scope inside another subtree scope, or seen
// twice, is dropped. The arrays are allocated only for a batch that names an element.
interface BatchScopes {
  subtrees: HTMLElement[] | undefined
  singles: HTMLElement[] | undefined
}

function collectRecordScopes(
  record: MutationRecord,
  scopes: BatchScopes,
): void {
  if (record.type === 'attributes') {
    if (!(record.target instanceof HTMLElement)) return
    if (attributeMovesSubtree(record)) {
      scopes.subtrees ??= []
      scopes.subtrees.push(record.target)
    } else {
      scopes.singles ??= []
      scopes.singles.push(record.target)
    }
    return
  }
  if (record.type !== 'childList') return
  for (const node of record.addedNodes)
    if (node instanceof HTMLElement) {
      scopes.subtrees ??= []
      scopes.subtrees.push(node)
    }
}

// Whether `element` is held by a subtree scope: one that contains it, or the same element earlier
// than `upTo` (a duplicate).
function coveredBySubtree(
  subtrees: readonly HTMLElement[] | undefined,
  element: HTMLElement,
  upTo: number,
): boolean {
  if (!subtrees) return false
  for (let i = 0; i < subtrees.length; i++) {
    const scope = subtrees[i]
    if (scope === element ? i < upTo : scope.contains(element)) return true
  }
  return false
}

function stampMutationBatch(
  root: HTMLElement,
  records: readonly MutationRecord[],
): void {
  const scopes: BatchScopes = { subtrees: undefined, singles: undefined }
  for (const record of records) collectRecordScopes(record, scopes)
  const { subtrees, singles } = scopes
  if (subtrees)
    for (let i = 0; i < subtrees.length; i++)
      if (!coveredBySubtree(subtrees, subtrees[i], i))
        stampWebviewContexts(root, subtrees[i])
  if (!singles) return
  for (let i = 0; i < singles.length; i++) {
    const element = singles[i]
    if (singles.indexOf(element) < i) continue
    if (coveredBySubtree(subtrees, element, Number.POSITIVE_INFINITY)) continue
    stampElement(root, element)
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
    stampMutationBatch(root, records),
  )
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    // The old class value tells whether a removed `language-` or pane class moved descendant contexts.
    attributeOldValue: true,
    attributeFilter: ['class', 'data-type', 'data-wiki-link'],
  })
  return () => observer.disconnect()
}
