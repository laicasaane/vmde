// Task 207 — YAML front matter as a read-only two-column properties table. Lute renders front matter
// as a plain source block with no rendered half (IR: `div.vditor-ir__node[data-type=yaml-front-matter]
// > pre > code`; WYSIWYG: `div.vditor-wysiwyg__block[...] > pre > code`; Preview:
// `pre.vditor-yml-front-matter > code`). This module injects a non-editable preview directly AFTER
// that `pre` (Vditor's keyup arrow rule and `showCode` read `previousElementSibling` of a preview, so
// the position is load-bearing) carrying `data-render="1"` + `contenteditable="false"`, which Lute's
// serializers skip (skill vmde-lute-features; verified for both serializers). The saved markdown is
// therefore the untouched source. CSS (main.css, keyed on `data-vmde-front-matter`) swaps source and
// table the way mermaid/math blocks do: caret inside → YAML source, caret outside → table.
//
// Performance: the YAML parser (~95 KB) lives in a lazy bundle (front-matter-entry.ts) loaded only
// when a front-matter block exists. It runs once per committed text (open, caret leave, external
// update) and never while the caret is inside the block: typing re-injects a cached clone of the last
// committed preview and does not parse (the callouts task-179 pattern).
import type {
  FrontMatterParseResult,
  FrontMatterValueView,
} from '../../../src/shared/front-matter'
import type { WebviewMessage } from '../../../src/shared/protocol'
import {
  observeScopedMutations,
  queryIncludingSelf,
} from '../util/mutation-impact'
import { reportError } from '../util/webview-log'

export const FRONT_MATTER_COPY_CONFIRM_MS = 1500

export interface FrontMatterDeps {
  loadParser: () => Promise<(yamlText: string) => FrontMatterParseResult>
}

// Codicons `copy` and `check` (16x16). Codicon artwork is CC BY 4.0 (its code is MIT; notice in
// media/codicons.LICENSE); the <path> data are lifted from microsoft/vscode-codicons
// src/icons/copy.svg and check.svg, like the toolbar icons in chrome/toolbar-icons.ts.
const copyIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" focusable="false"><path d="M3 5V12.73C2.4 12.38 2 11.74 2 11V5C2 2.79 3.79 1 6 1H9C9.74 1 10.38 1.4 10.73 2H6C4.35 2 3 3.35 3 5ZM11 15H6C4.897 15 4 14.103 4 13V5C4 3.897 4.897 3 6 3H11C12.103 3 13 3.897 13 5V13C13 14.103 12.103 15 11 15ZM12 5C12 4.448 11.552 4 11 4H6C5.448 4 5 4.448 5 5V13C5 13.552 5.448 14 6 14H11C11.552 14 12 13.552 12 13V5Z"/></svg>'
const checkIcon =
  '<svg viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" focusable="false"><path d="M13.6572 3.13573C13.8583 2.9465 14.175 2.95614 14.3643 3.15722C14.5535 3.35831 14.5438 3.675 14.3428 3.86425L5.84277 11.8642C5.64597 12.0494 5.33756 12.0446 5.14648 11.8535L1.64648 8.35351C1.45121 8.15824 1.45121 7.84174 1.64648 7.64647C1.84174 7.45121 2.15825 7.45121 2.35351 7.64647L5.50976 10.8027L13.6572 3.13573Z"/></svg>'

const BLOCK_SELECTOR =
  'div[data-type="yaml-front-matter"], pre.vditor-yml-front-matter'
const STATE_ATTR = 'data-vmde-front-matter'
const EDITING_ATTR = 'data-vmde-front-matter-editing'
const TABLE_CLASS = 'vmde-front-matter'
const WARNING_CLASS = 'vmde-front-matter__warning'
const COPY_SELECTOR = '.vmde-front-matter__copy'
const FOLD_CLASS = 'vmde-front-matter__fold'
const FOLD_SELECTOR = `.${FOLD_CLASS}`
const FOLDED_ATTR = 'data-vmde-fm-folded'
const TOML_CLASS = 'vmde-front-matter__warning--toml'
const TOML_WARNING =
  'Front matter could not be parsed: TOML front matter is not supported'
const ZWSP = /​/g

type Mode = 'ir' | 'wysiwyg' | 'preview'
type Parser = (yamlText: string) => FrontMatterParseResult

/** Task 724: the document's stored front-matter fold (the section fold store, section-fold.ts). */
export interface FrontMatterFoldStore {
  /** The stored state; undefined when the document has none. */
  stored: () => boolean | undefined
  store: (folded: boolean) => void
}

// Task 724: one fold state per document for every surface (IR, WYSIWYG, Split View preview and
// Preview), as Task 721 D1 has it for headings and lists. The store and the setting default are
// module state because the editor and the Preview pane each run their own observer; a change
// re-syncs every observer's blocks through `foldRefreshers`.
let foldStore: FrontMatterFoldStore | null = null
let foldDefault = false
const foldRefreshers = new Set<() => void>()

/** Task 724 D1: a stored state wins; the setting applies only to a document with none stored. */
export function resolveFrontMatterFolded(
  stored: boolean | undefined,
  fallback: boolean,
): boolean {
  return stored ?? fallback
}

/** The folded block's one line; N is the number of top-level keys. */
export function frontMatterSummary(count: number): string {
  return `Properties (${count})`
}

function frontMatterFolded(): boolean {
  return resolveFrontMatterFolded(foldStore?.stored(), foldDefault)
}

function refreshFolds(): void {
  for (const refresh of foldRefreshers) refresh()
}

/** `vmde.editor.frontMatterFolded`, applied on init and on every live configuration change. */
export function setFrontMatterFoldDefault(folded: boolean): void {
  if (foldDefault === folded) return
  foldDefault = folded
  refreshFolds()
}

function modeOf(block: HTMLElement): Mode {
  if (block.classList.contains('vditor-ir__node')) return 'ir'
  if (block.classList.contains('vditor-wysiwyg__block')) return 'wysiwyg'
  return 'preview'
}

/** The source `pre`: the block itself in Preview, its child `pre` in IR/WYSIWYG. */
function preOf(block: HTMLElement): HTMLElement | null {
  return block.tagName === 'PRE'
    ? block
    : block.querySelector<HTMLElement>(':scope > pre')
}

/** The YAML text between the `---` lines; editor-only zero-width characters removed. */
function sourceTextOf(block: HTMLElement): string {
  const code = preOf(block)?.querySelector('code')
  return (code?.textContent ?? '').replace(ZWSP, '')
}

/** Our injected node: always the element directly after the `pre`. */
function injectedOf(pre: HTMLElement): HTMLElement | null {
  const next = pre.nextElementSibling
  return next?.classList.contains(TABLE_CLASS) ||
    next?.classList.contains(WARNING_CLASS)
    ? (next as HTMLElement)
    : null
}

/** Write an attribute only when it differs, so a repeat decoration is no DOM mutation. */
function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value)
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function iconSpan(kind: 'copy' | 'check', svg: string): HTMLElement {
  const span = el(
    'span',
    `vmde-front-matter__icon vmde-front-matter__icon--${kind}`,
  )
  span.setAttribute('aria-hidden', 'true')
  span.innerHTML = svg // static Codicons artwork above, never document content
  return span
}

function copyButton(
  title: string,
  label: string,
  copyText: string,
): HTMLButtonElement {
  const button = el('button', 'vmde-front-matter__copy')
  button.type = 'button'
  button.setAttribute('title', title)
  button.setAttribute('aria-label', label)
  button.setAttribute('data-copy-text', copyText)
  button.append(iconSpan('copy', copyIcon), iconSpan('check', checkIcon))
  return button
}

function foldButton(count: number): HTMLButtonElement {
  const button = el('button', FOLD_CLASS)
  button.type = 'button'
  button.setAttribute('aria-label', frontMatterSummary(count))
  button.setAttribute('aria-expanded', 'true')
  button.setAttribute('title', 'Fold properties')
  return button
}

/** Task 724: show the fold state on a table preview. Attribute writes only, and only on a change. */
function syncFold(preview: HTMLElement): void {
  const button = preview.querySelector<HTMLElement>(`:scope > ${FOLD_SELECTOR}`)
  if (!button) return
  const folded = frontMatterFolded()
  if (folded) setAttr(preview, FOLDED_ATTR, '')
  else preview.removeAttribute(FOLDED_ATTR)
  setAttr(button, 'aria-expanded', folded ? 'false' : 'true')
  setAttr(button, 'title', folded ? 'Unfold properties' : 'Fold properties')
}

function viewNode(view: FrontMatterValueView): HTMLElement {
  if (view.kind === 'text')
    return el('span', 'vmde-front-matter__text', view.text)
  if (view.kind === 'list') {
    const list = el('span', 'vmde-front-matter__list')
    for (const item of view.items) {
      const chip = el('span', 'vmde-front-matter__chip')
      if (item.kind === 'text') chip.textContent = item.text
      else chip.appendChild(viewNode(item))
      list.appendChild(chip)
    }
    return list
  }
  const inner = el('table', 'vmde-front-matter__inner')
  const body = inner.createTBody()
  for (const row of view.rows) {
    const tr = body.insertRow()
    const th = document.createElement('th')
    th.setAttribute('scope', 'row')
    th.textContent = row.key
    const td = document.createElement('td')
    td.appendChild(viewNode(row.value))
    tr.append(th, td)
  }
  return inner
}

/** Vditor's own class for a rendered half: its keyup/click rules look for these on the preview. */
function modeClassOf(mode: Mode): string {
  if (mode === 'ir') return ' vditor-ir__preview'
  return mode === 'wysiwyg' ? ' vditor-wysiwyg__preview' : ''
}

function buildTable(
  rows: Extract<FrontMatterParseResult, { status: 'table' }>['rows'],
  mode: Mode,
  sig: string,
): HTMLElement {
  const modeClass = modeClassOf(mode)
  const root = el('div', TABLE_CLASS + modeClass)
  root.setAttribute('data-render', '1')
  root.setAttribute('contenteditable', 'false')
  root.setAttribute('data-sig', sig)
  const table = el('table', 'vmde-front-matter__table')
  const body = table.createTBody()
  for (const row of rows) {
    const tr = el('tr', 'vmde-front-matter__row')
    const key = el('th', 'vmde-front-matter__key')
    key.setAttribute('scope', 'row')
    key.append(
      el('span', 'vmde-front-matter__content', row.key),
      copyButton('Copy name', `Copy name: ${row.key}`, row.keyCopy),
    )
    const value = el('td', 'vmde-front-matter__value')
    const content = el('span', 'vmde-front-matter__content')
    content.appendChild(viewNode(row.value))
    value.append(
      content,
      copyButton('Copy value', `Copy value of ${row.key}`, row.valueCopy),
    )
    tr.append(key, value)
    body.appendChild(tr)
  }
  // Task 724: the fold control sits in the left gutter (CSS) and the summary line shows only
  // while folded; both live inside this `data-render` node, so the serializers skip them too.
  root.append(
    foldButton(rows.length),
    el('div', 'vmde-front-matter__summary', frontMatterSummary(rows.length)),
    table,
  )
  syncFold(root)
  return root
}

function buildWarning(message: string, sig: string): HTMLElement {
  const warning = el('div', WARNING_CLASS, message)
  warning.setAttribute('data-render', '1')
  warning.setAttribute('contenteditable', 'false')
  warning.setAttribute('role', 'note')
  warning.setAttribute('data-sig', sig)
  return warning
}

function place(
  pre: HTMLElement,
  existing: HTMLElement | null,
  node: HTMLElement,
) {
  if (existing) existing.replaceWith(node)
  else pre.after(node)
}

/**
 * Pure DOM: apply a parse result to one front-matter block. `null` clears the decoration. The block
 * is the IR node, the WYSIWYG block or the Preview `pre`. A repeat call with the same source text
 * and state writes nothing.
 */
export function decorateFrontMatter(
  block: HTMLElement,
  result: FrontMatterParseResult | null,
): void {
  const pre = preOf(block)
  if (!pre) return
  const existing = injectedOf(pre)
  if (result === null) {
    existing?.remove()
    block.removeAttribute(STATE_ATTR)
    return
  }
  const text = sourceTextOf(block)
  if (result.status === 'empty') {
    existing?.remove()
    setAttr(block, STATE_ATTR, 'empty')
    return
  }
  if (result.status === 'table') {
    // The mode class is part of "current": a preview built in another mode (a cached IR clone that
    // survived a switch to WYSIWYG) lacks Vditor's `vditor-wysiwyg__preview`, so Vditor's click rule
    // never opened the source (measured in real VS Code, task 207).
    const modeClass = modeClassOf(modeOf(block)).trim()
    const current =
      existing?.classList.contains(TABLE_CLASS) &&
      existing.getAttribute('data-sig') === text &&
      (modeClass === ''
        ? existing.className === TABLE_CLASS
        : existing.classList.contains(modeClass))
    if (!current)
      place(pre, existing, buildTable(result.rows, modeOf(block), text))
    else if (existing) syncFold(existing)
    setAttr(block, STATE_ATTR, 'table')
    return
  }
  const current =
    existing?.classList.contains(WARNING_CLASS) &&
    existing.getAttribute('data-sig') === text &&
    existing.textContent === result.warning
  if (!current) place(pre, existing, buildWarning(result.warning, text))
  setAttr(block, STATE_ATTR, 'error')
}

function caretInside(block: HTMLElement): boolean {
  const selection = block.ownerDocument.getSelection?.()
  const anchor = selection?.rangeCount ? selection.anchorNode : null
  const host = anchor
    ? anchor.nodeType === Node.ELEMENT_NODE
      ? (anchor as Element)
      : anchor.parentElement
    : null
  return (
    !!host &&
    block.contains(host) &&
    !host.closest(`.${TABLE_CLASS}, .${WARNING_CLASS}`)
  )
}

/** The paragraph's text with `<br>` as a newline (Preview) and our own span left out. */
function paragraphLines(p: HTMLElement): string[] {
  let text = ''
  for (const child of p.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) text += (child as Text).data
    else if ((child as Element).tagName === 'BR') text += '\n'
    else if (!(child as Element).classList?.contains(TOML_CLASS))
      text += child.textContent ?? ''
  }
  return text.split('\n').map((line) => line.trim())
}

/** Q1: TOML front matter is a paragraph to Lute (`+++` ... `+++`), always the first block. */
function isTomlParagraph(p: HTMLElement): boolean {
  if (
    p.tagName !== 'P' ||
    p.parentElement?.firstElementChild !== p ||
    !p.parentElement.classList.contains('vditor-reset')
  )
    return false
  const lines = paragraphLines(p)
  return lines[0] === '+++' && lines.slice(1).includes('+++')
}

function tomlSpanOf(p: HTMLElement): HTMLElement | null {
  return p.querySelector<HTMLElement>(`:scope > .${TOML_CLASS}`)
}

function syncToml(p: HTMLElement): void {
  // Same rule as the YAML block: nothing is rewritten while the caret is in the paragraph, because
  // typing respins the block and a rebuilt span would only be dropped again.
  if (caretInside(p)) return
  const span = tomlSpanOf(p)
  if (!isTomlParagraph(p)) {
    span?.remove()
    return
  }
  if (span) return
  // Inline injection rule (skill vmde-lute-features): a `data-render` span is skipped by both
  // serializers, so the saved markdown keeps the `+++` source unchanged.
  const warning = el('span', `${WARNING_CLASS} ${TOML_CLASS}`, TOML_WARNING)
  warning.setAttribute('data-render', '1')
  warning.setAttribute('contenteditable', 'false')
  warning.setAttribute('role', 'note')
  p.appendChild(warning)
}

/** Leading paragraphs of the editing surfaces / Preview below `root` (the root itself if it is one). */
function leadingParagraphs(root: HTMLElement): HTMLElement[] {
  const surfaces = root.classList.contains('vditor-reset')
    ? [root]
    : [...root.querySelectorAll<HTMLElement>('.vditor-reset')]
  const out: HTMLElement[] = []
  for (const surface of surfaces) {
    const first = surface.firstElementChild
    if (first?.tagName === 'P') out.push(first as HTMLElement)
  }
  return out
}

interface Committed {
  mode: Mode
  text: string
  result: FrontMatterParseResult
  /** Clone of the injected node (or null for the empty state) re-inserted while the caret is inside. */
  node: HTMLElement | null
  state: string
}

export function observeFrontMatter(
  root: HTMLElement | null | undefined,
  deps: FrontMatterDeps,
): () => void {
  if (!root)
    return () => {
      /* no-op disposer */
    }
  const doc = root.ownerDocument
  let parse: Parser | null = null
  let loading = false
  let disposed = false
  let committed: Committed | null = null

  const ensureLoaded = () => {
    if (loading) return
    loading = true
    deps
      .loadParser()
      .then((loaded) => {
        parse = loaded
        if (!disposed) applyAll()
      })
      .catch((error) => {
        // The block stays the plain code block: no warning for a bundle that failed to load.
        reportError(error, 'front-matter parser')
      })
  }

  const commit = (
    block: HTMLElement,
    text: string,
    result: FrontMatterParseResult,
  ) => {
    decorateFrontMatter(block, result)
    const pre = preOf(block)
    const injected = pre ? injectedOf(pre) : null
    committed = {
      mode: modeOf(block),
      text,
      result,
      node: injected ? (injected.cloneNode(true) as HTMLElement) : null,
      state: block.getAttribute(STATE_ATTR) ?? '',
    }
  }

  // Why: in WYSIWYG, Vditor's `showCode` sets the source `pre` to display:block on entry and hides it
  // again only ~200 ms after the caret leaves (highlightToolbarWYSIWYG), so the table and the source
  // would show together for that long. Hiding it on the same tick keeps them exclusive.
  const hideWysiwygSource = (block: HTMLElement) => {
    if (modeOf(block) !== 'wysiwyg') return
    if (block.getAttribute(STATE_ATTR) !== 'table') return
    const pre = preOf(block)
    if (pre && pre.style.display !== 'none') pre.style.display = 'none'
  }

  const restoreWhileEditing = (block: HTMLElement) => {
    // Typing respins the block and drops our nodes: put the last committed preview back, no parse.
    const pre = preOf(block)
    if (
      committed?.node &&
      committed.mode === modeOf(block) &&
      pre &&
      !injectedOf(pre) &&
      !block.hasAttribute(STATE_ATTR)
    ) {
      const clone = committed.node.cloneNode(true) as HTMLElement
      // The clone carries the fold of its commit time; the state may have changed since.
      syncFold(clone)
      pre.after(clone)
      block.setAttribute(STATE_ATTR, committed.state)
    }
    // Why: WYSIWYG opens with the caret at the document start, inside the front matter, without
    // Vditor's `showCode` having run, so the CSS-hidden source would hold an invisible caret while
    // the table is hidden too (measured in real VS Code, task 207). Show the source like showCode.
    if (
      pre &&
      modeOf(block) === 'wysiwyg' &&
      block.getAttribute(STATE_ATTR) === 'table' &&
      pre.style.display !== 'block'
    )
      pre.style.display = 'block'
  }

  const apply = (block: HTMLElement) => {
    const editing = caretInside(block)
    if (editing !== block.hasAttribute(EDITING_ATTR)) {
      if (editing) block.setAttribute(EDITING_ATTR, '')
      else block.removeAttribute(EDITING_ATTR)
    }
    if (editing) {
      restoreWhileEditing(block)
      return
    }
    const text = sourceTextOf(block)
    if (committed && committed.text === text) {
      decorateFrontMatter(block, committed.result)
    } else if (parse) {
      commit(block, text, parse(text))
    } else {
      ensureLoaded()
      return
    }
    hideWysiwygSource(block)
  }

  const applyAll = () => {
    for (const block of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR))
      apply(block)
    applyToml()
  }

  // A TOML warning needs no parser: a cheap prefix test on the leading paragraph only, and stale
  // spans (paragraph edited or no longer first) are swept.
  const applyToml = () => {
    for (const p of leadingParagraphs(root)) {
      if (tomlSpanOf(p) || p.textContent?.startsWith('+++')) syncToml(p)
    }
    for (const span of root.querySelectorAll<HTMLElement>(`.${TOML_CLASS}`)) {
      const p = span.parentElement
      if (p && !isTomlParagraph(p) && !caretInside(p)) span.remove()
    }
  }

  const disposeObserver = observeScopedMutations(root, {
    full: applyAll,
    within: (scope) => {
      for (const block of queryIncludingSelf<HTMLElement>(
        scope,
        BLOCK_SELECTOR,
      ))
        apply(block)
      applyToml()
    },
  })

  // A bare caret move in or out of the block changes no DOM the mutation observer sees.
  const onSelectionChange = () => {
    if (root.querySelector(BLOCK_SELECTOR)) applyAll()
    else applyToml()
  }
  doc.addEventListener('selectionchange', onSelectionChange)

  // Task 724: a fold change from any surface, or a live setting change, reaches this root's tables.
  const refreshFold = () => {
    for (const block of root.querySelectorAll<HTMLElement>(BLOCK_SELECTOR)) {
      const pre = preOf(block)
      const injected = pre ? injectedOf(pre) : null
      if (injected?.classList.contains(TABLE_CLASS)) syncFold(injected)
    }
  }
  foldRefreshers.add(refreshFold)

  return () => {
    disposed = true
    disposeObserver()
    doc.removeEventListener('selectionchange', onSelectionChange)
    foldRefreshers.delete(refreshFold)
  }
}

/**
 * Mouse and keyboard activation of a button inside the front-matter preview. The button is inside
 * the editable surface, so the editor must never see the events that activate it.
 */
function installButtonActivation(
  doc: Document,
  selector: string,
  activate: (button: HTMLButtonElement) => void,
): () => void {
  const buttonOf = (event: Event): HTMLButtonElement | null =>
    (event.target as Element | null)?.closest<HTMLButtonElement>(selector) ??
    null
  // Why: the native mousedown default would put the caret into the block; in IR that expands the
  // source and hides the table (and this button) before mouseup (Task 207 D1: a click never moves the
  // caret). Same reasoning as clipboard/code-copy.ts; capture phase so it is decided before any
  // editor listener. Other mouse buttons keep their defaults (context menu).
  const onMouseDown = (event: MouseEvent): void => {
    if (event.button !== 0 || !buttonOf(event)) return
    event.preventDefault()
  }
  // Why capture + stopPropagation: Vditor's IR/WYSIWYG click handlers would expand the block and move
  // the caret; the button click must be consumed first.
  const onClick = (event: MouseEvent): void => {
    const button = buttonOf(event)
    if (!button) return
    event.preventDefault()
    event.stopPropagation()
    activate(button)
  }
  const isActivationKey = (event: KeyboardEvent) =>
    event.key === 'Enter' || event.key === ' '
  // Why: Vditor's editor keydown must never see Enter/Space on a focused button (it would edit the
  // document). Handling it here also replaces the synthesized click.
  const onKeyDown = (event: KeyboardEvent): void => {
    const button = buttonOf(event)
    if (!button || !isActivationKey(event)) return
    event.preventDefault()
    event.stopPropagation()
    activate(button)
  }
  // Chrome fires the synthesized click for Space on keyup; suppress it so Space activates once.
  const onKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== ' ' || !buttonOf(event)) return
    event.preventDefault()
    event.stopPropagation()
  }

  doc.addEventListener('mousedown', onMouseDown, true)
  doc.addEventListener('click', onClick, true)
  doc.addEventListener('keydown', onKeyDown, true)
  doc.addEventListener('keyup', onKeyUp, true)
  return () => {
    doc.removeEventListener('mousedown', onMouseDown, true)
    doc.removeEventListener('click', onClick, true)
    doc.removeEventListener('keydown', onKeyDown, true)
    doc.removeEventListener('keyup', onKeyUp, true)
  }
}

export function installFrontMatterCopy(
  target: Window & typeof globalThis,
  post: (
    message: Extract<WebviewMessage, { command: 'copy-property' }>,
  ) => void,
): () => void {
  const timers = new WeakMap<HTMLButtonElement, number>()
  const copy = (button: HTMLButtonElement) => {
    post({
      command: 'copy-property',
      content: button.getAttribute('data-copy-text') ?? '',
    })
    // The attribute change is invisible to the childList/characterData observers: no observer wakes.
    button.setAttribute('data-copied', '')
    const pending = timers.get(button)
    if (pending !== undefined) target.clearTimeout(pending)
    timers.set(
      button,
      target.setTimeout(() => {
        button.removeAttribute('data-copied')
        timers.delete(button)
      }, FRONT_MATTER_COPY_CONFIRM_MS),
    )
  }
  return installButtonActivation(target.document, COPY_SELECTOR, copy)
}

/**
 * Task 724: the fold control. A click, Enter or Space flips the document's front-matter fold, stores
 * it in the section fold store (so it is saved per file with the heading and list folds) and
 * re-syncs every surface. The fold only flips attributes on our `data-render` node: the saved
 * Markdown and the Lute round-trip never change.
 */
export function installFrontMatterFold(
  target: Window & typeof globalThis,
  store: FrontMatterFoldStore,
): () => void {
  foldStore = store
  const dispose = installButtonActivation(
    target.document,
    FOLD_SELECTOR,
    () => {
      store.store(!frontMatterFolded())
      refreshFolds()
    },
  )
  refreshFolds()
  return () => {
    dispose()
    if (foldStore === store) foldStore = null
  }
}
