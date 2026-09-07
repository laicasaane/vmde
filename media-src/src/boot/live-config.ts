// Live application of config-driven webview state without re-initialising Vditor
// (tasks 12/26). main.ts uses these from the init payload and from the host's
// `config-changed` / `reload-css` messages (posted on onDidChangeConfiguration
// and external-CSS file changes), so setting/CSS edits apply to open editors
// without reopening.

// `--me-font-size` resolution lives in the shared theme registry so the webview and
// the host can't diverge (task 84). Re-exported so existing importers/tests are
// unchanged — the old duplicate definition is gone.
import {
  resolveFontSize,
  resolveMarkdownPreviewFontFamily,
} from '../../../src/shared/theme-registry'
import type { VmdeConfigOptions } from '../../../src/shared/protocol'
import { innerVditor, type InnerVditor } from '../util/inner-vditor'
export { resolveFontSize }

// Derived from the shared config type (task 151 item 4) so a renamed setting key
// propagates as a compile error here instead of silently reading `undefined`.
// `fontSize` is widened to also accept a number (resolveFontSize handles both).
type BodyOptions = Pick<
  VmdeConfigOptions,
  | 'useVscodeThemeColor'
  | 'contentTheme'
  | 'markdownPreviewFontFamily'
  | 'enableFullWidth'
  | 'highlightHeadings'
  | 'showHeadingMarkers'
  | 'outlineWidth'
  | 'findMatchColor'
  | 'findMatchOpacity'
  | 'findCurrentMatchColor'
  | 'findCurrentMatchOpacity'
> & { fontSize?: string | number }

function configuredColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const color = value.trim()
  if (!color) return undefined
  const probe = document.createElement('span')
  probe.style.color = color
  return probe.style.color ? color : undefined
}

function configuredOpacity(value: unknown): string | undefined {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? String(value)
    : undefined
}

// Rendering theme (task 82): apply a markdown content theme by toggling the
// `markdown-body` class on <body> (the class the vendored theme stylesheets target)
// and enabling exactly one of the pre-emitted `ct-<value>` <link> stylesheets via
// `link.disabled`. `auto` disables all + drops the class → the VS Code-colour path
// (data-use-vscode-theme-color) renders, unchanged. New themes need no change here.
function applyContentTheme(contentTheme: string | undefined): void {
  const ct = contentTheme || 'auto'
  document.body.classList.toggle('markdown-body', ct !== 'auto')
  const links = document.querySelectorAll<HTMLLinkElement>('link[id^="ct-"]')
  links.forEach((l) => {
    // Only WRITE when the state actually changes. On first init this runs while the
    // instant-paint overlay is still on screen and the links are ALREADY in their
    // correct enabled/disabled state (the initial HTML emitted them that way) — and
    // assigning `link.disabled` even to its current value makes some browsers re-
    // evaluate the stylesheet, momentarily dropping the active theme's `--vmde-*`
    // vars so var-driven elements (hr, inline code, …) flash to Vditor's fallback
    // colour. Guarding the write keeps the overlay→live swap flicker-free.
    const want = l.id !== `ct-${ct}`
    if (l.disabled !== want) l.disabled = want
  })
}

// Apply the body-attribute / CSS-var driven options. Mirrors what the CSS keys
// off (`data-*` attributes, `--me-outline-width`). Vditor is untouched.
export function applyBodyOptions(options: BodyOptions | undefined): void {
  const body = document.body
  // Write only on change. On first init this runs while the instant-paint overlay is
  // still on screen, and the body already carries the matching attributes/vars from the
  // initial HTML (html-builder emits the same values). Re-setting an attribute or CSS var
  // to its current value can still trigger a style recalc / stylesheet re-eval, which
  // flashes the overlay (text colour, hr, inline-code — whatever a theme drives). Guarding
  // every write keeps the overlay→live swap flicker-free; live config changes still apply.
  const setAttr = (name: string, val: string) => {
    if (body.getAttribute(name) !== val) body.setAttribute(name, val)
  }
  const setVar = (name: string, val: string) => {
    if (body.style.getPropertyValue(name) !== val) {
      body.style.setProperty(name, val)
    }
  }
  setAttr(
    'data-use-vscode-theme-color',
    options?.useVscodeThemeColor ? '1' : '0',
  )
  applyContentTheme(options?.contentTheme)
  setAttr('data-full-width', options?.enableFullWidth ? '1' : '0')
  setAttr('data-highlight-headings', options?.highlightHeadings ? '1' : '0')
  setAttr(
    'data-heading-markers',
    options?.showHeadingMarkers === false ? '0' : '1',
  )
  if (typeof options?.outlineWidth === 'number' && options.outlineWidth > 0) {
    setVar('--me-outline-width', `${options.outlineWidth}px`)
  }
  setVar(
    '--me-font-size',
    resolveFontSize(options?.fontSize, options?.contentTheme),
  )
  setVar(
    '--me-markdown-preview-font-family',
    resolveMarkdownPreviewFontFamily(options?.markdownPreviewFontFamily),
  )
  const ordinaryColor = configuredColor(options?.findMatchColor)
  const ordinaryOpacity = configuredOpacity(options?.findMatchOpacity)
  const currentColor = configuredColor(options?.findCurrentMatchColor)
  const currentOpacity = configuredOpacity(options?.findCurrentMatchOpacity)
  if (ordinaryColor) setVar('--vmde-find-match-color', ordinaryColor)
  else body.style.removeProperty('--vmde-find-match-color')
  if (ordinaryOpacity) setVar('--vmde-find-match-opacity', ordinaryOpacity)
  else body.style.removeProperty('--vmde-find-match-opacity')
  if (currentColor) setVar('--vmde-find-current-match-color', currentColor)
  else body.style.removeProperty('--vmde-find-current-match-color')
  if (currentOpacity)
    setVar('--vmde-find-current-match-opacity', currentOpacity)
  else body.style.removeProperty('--vmde-find-current-match-opacity')
}

const HARD_BREAK_MARKER_BASE = 'VMDE_HARD_BREAK_83'

// Vditor Preview.render serializes the live edit DOM before feeding Markdown back to Md2HTML.
// That serializer flattens an IR/WYSIWYG `<br>` to the same `\n` as a soft break, erasing the
// distinction the preview setting needs. Replace only inline `<br>` nodes in a detached clone with
// a collision-free marker, serialize through the mode's real Lute path, then restore them as
// CommonMark two-space hard breaks. The live DOM and the saved Markdown path are never mutated.
export function previewMarkdownWithHardBreaks(
  vditor: InnerVditor,
): string | undefined {
  if ((window as any).__vmdeReflowPreview !== true) return undefined
  const mode = vditor.currentMode
  const element = mode === 'ir' ? vditor.ir?.element : vditor.wysiwyg?.element
  const serialize =
    mode === 'ir'
      ? vditor.lute?.VditorIRDOM2Md.bind(vditor.lute)
      : mode === 'wysiwyg'
        ? vditor.lute?.VditorDOM2Md.bind(vditor.lute)
        : undefined
  if (!element || !serialize) return undefined

  const clone = element.cloneNode(true) as HTMLElement
  let marker = HARD_BREAK_MARKER_BASE
  while (clone.textContent?.includes(marker)) marker += '_'
  for (const br of clone.querySelectorAll('br')) {
    // Empty-block/caret scaffolding is not an authored line break. A real inline hard break has
    // content on both sides; preserving only that shape avoids manufacturing text in blank blocks.
    if (!br.previousSibling || !br.nextSibling) continue
    br.replaceWith(document.createTextNode(marker))
  }
  return serialize(clone.innerHTML).split(marker).join('  \n')
}

function installPreviewMarkdownBridge(): void {
  ;(window as any).__vmdePreviewMarkdown = previewMarkdownWithHardBreaks
}

// Task 83 — the Vditor source patches read the runtime flag and hard-break bridge only while
// rendering Preview surfaces. A changed value re-renders an already-visible preview; the editor
// instance, edit-surface Lutes, selection and scroll remain untouched. Hidden previews pick it up
// when Vditor next opens/renders them, so there is no needless background render.
export function applyPreviewReflowSetting(enabled: boolean | undefined): void {
  installPreviewMarkdownBridge()
  const next = enabled === true
  const previous = (window as any).__vmdeReflowPreview === true
  ;(window as any).__vmdeReflowPreview = next
  if (previous === next) return
  ;(window as any).__vmdeInvalidatePreview?.('config')

  const vditor = innerVditor()
  if (!vditor) return
  const preview = vditor.preview
  if (preview?.element?.style.display === 'none') return
  preview?.render?.(vditor)
}

export function effectivePreviewReflow(
  options: Pick<VmdeConfigOptions, 'autoWrap' | 'reflowLineBreaks'> | undefined,
): boolean {
  return options?.reflowLineBreaks === true
}

// Settings that are Vditor *constructor* options (toolbar, counter, code-block
// line numbers, outline init) — they can't be toggled on the live instance, so
// a change to any of these means main.ts must re-initialise Vditor.
export const INIT_ONLY_OPTIONS = [
  'showToolbar',
  'wordCount',
  'codeBlockLineNumbers',
  'outlinePosition',
  'showOutlineByDefault',
  'outlineHighlight',
  'wikiEnabled',
  'markdownToc',
  'markdownMark',
  'markdownSupSub',
  // NOTE: mermaidTheme is applied LIVE (applyMermaidTheme + offscreen reRenderMermaid in
  // handleConfigChanged), NOT via re-init — re-init scrolls the editor to the top on big
  // docs (task 59 follow-up: the reported mermaid-theme scroll jump).
] as const

export function initOnlyChanged(
  prev: Record<string, any> | undefined,
  next: Record<string, any> | undefined,
): boolean {
  return INIT_ONLY_OPTIONS.some((k) => prev?.[k] !== next?.[k])
}

// Swap (creating if needed) an id'd <style> node so host-driven CSS — the
// `customCss` setting and external CSS files — can be replaced live.
export function swapStyle(id: string, css: string): void {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.appendChild(el)
  }
  el.textContent = css ?? ''
}
