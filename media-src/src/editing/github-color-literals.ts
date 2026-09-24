import { coalescePerFrameWithRecords } from '../util/observe-coalesce'
import { queryIncludingSelf, scopeMutations } from '../util/mutation-impact'

const HEX_LITERAL = /^#([\da-f]{6})$/iu
const RGB_LITERAL = /^rgb\(([\d]{1,3}) *, *([\d]{1,3}) *, *([\d]{1,3})\)$/u
const HSL_LITERAL = /^hsl\(([\d]{1,3}) *, *([\d]{1,3})% *, *([\d]{1,3})%\)$/u
const COLOR_CLASS = 'vmde-github-color-literal'
const COLOR_PROPERTY = '--vmde-github-color-literal'
const WYSIWYG_CARET_MARKER = '\u200b'

/**
 * Parse GitHub's documented inline color forms using a deliberately small grammar.
 * Only ASCII spaces around comma separators are accepted; the source string itself
 * is never normalized or replaced by this presentation-only value.
 */
export function parseGithubColorLiteral(source: string): string | null {
  const hex = HEX_LITERAL.exec(source)
  if (hex) return `#${hex[1]}`

  const rgb = RGB_LITERAL.exec(source)
  if (rgb) {
    const [red, green, blue] = rgb.slice(1).map(Number)
    if (
      [red, green, blue].every(
        (component) => component >= 0 && component <= 255,
      )
    ) {
      return `rgb(${red}, ${green}, ${blue})`
    }
    return null
  }

  const hsl = HSL_LITERAL.exec(source)
  if (hsl) {
    const [hue, saturation, lightness] = hsl.slice(1).map(Number)
    if (hue <= 360 && saturation <= 100 && lightness <= 100) {
      return `hsl(${hue}, ${saturation}%, ${lightness}%)`
    }
  }

  return null
}

function sourceText(code: HTMLElement): string {
  const text = code.textContent ?? ''
  // Vditor adds one leading U+200B only to its WYSIWYG inline-code element. Keep
  // every other zero-width character part of the literal so malformed source rejects.
  return code.hasAttribute('data-marker') &&
    text.startsWith(WYSIWYG_CARET_MARKER)
    ? text.slice(WYSIWYG_CARET_MARKER.length)
    : text
}

function clearColorDecoration(code: HTMLElement): void {
  code.classList.remove(COLOR_CLASS)
  code.style.removeProperty(COLOR_PROPERTY)
}

/** Apply validated swatches as attributes only; no text or child node is changed. */
export function applyGithubColorLiterals(
  root: Element,
  enabled: boolean,
): void {
  for (const code of queryIncludingSelf<HTMLElement>(root, 'code')) {
    // A Vditor editor root can itself be <pre class="vditor-reset">, so only a
    // nested non-reset <pre> identifies a fenced/preformatted code block.
    const fenced = code.closest('pre:not(.vditor-reset)') !== null
    const sourceMode = code.closest('.vditor-sv') !== null
    const cssColor =
      enabled && !fenced && !sourceMode
        ? parseGithubColorLiteral(sourceText(code))
        : null

    if (!cssColor) {
      clearColorDecoration(code)
      continue
    }

    code.classList.add(COLOR_CLASS)
    if (code.style.getPropertyValue(COLOR_PROPERTY) !== cssColor)
      code.style.setProperty(COLOR_PROPERTY, cssColor)
  }
}

let enabled = false
const activeReappliers = new Set<() => void>()

/** Live config changes reapply or clear the attribute-only decoration immediately. */
export function setGithubColorLiteralsEnabled(next: boolean): void {
  if (enabled === next) return
  enabled = next
  for (const reapply of activeReappliers) reapply()
}

/**
 * Reapply after Lute replaces or edits a block. Scoped observation keeps a small inline edit
 * from scanning every code element in a large document; the #app root survives mode rebuilds.
 */
export function observeGithubColorLiterals(
  root: HTMLElement | null | undefined,
): () => void {
  if (!root) return () => undefined

  const applyAll = () => applyGithubColorLiterals(root, enabled)
  const run = coalescePerFrameWithRecords((records) => {
    const scope = scopeMutations(records)
    if (scope.full) applyAll()
    else {
      for (const block of scope.blocks) applyGithubColorLiterals(block, enabled)
    }
  })
  const observer = new MutationObserver(run)
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
  })
  activeReappliers.add(applyAll)
  run([])

  return () => {
    observer.disconnect()
    run.cancel()
    activeReappliers.delete(applyAll)
  }
}
