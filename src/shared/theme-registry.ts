// Single source of truth for the content (markdown-rendering) themes — task 84.
//
// Theme knowledge used to be scattered across ~6 sites (the manifest enum,
// CONTENT_THEME_FILES, effectiveThemeKind, codeHljsStyle, two font-size resolvers,
// bodyClass), each an if/else ladder keyed on the theme string. Adding a theme meant
// editing all of them, and they drifted. This module holds the table; every site
// derives from it (OCP: add a row, not an `if`).
//
// Intentionally dependency-free and isomorphic so BOTH build units can import it:
// the host (`src/`, tsc/CommonJS) directly, and the webview (`media-src/`,
// esbuild/ESM) via `../../src/theme-registry` — esbuild bundles it inline, which is
// why the two font-size resolvers can finally collapse into one (DRY).

interface ThemeDef {
  /** The `vmde.theme.content` enum value. */
  value: string
  /** Stylesheet path (host side, fed to toUri) → the `ct-<value>` <link>. */
  file: string
  /** Effective editor light/dark mode the theme pins (effectiveThemeKind). */
  mode: 'dark' | 'light'
  /** highlight.js style paired with this theme for an `auto` code theme. */
  code: string
  /**
   * Default reading font-size (px) when the `fontSize` setting is unset/"editor".
   * null → follow the VS Code editor font size (the default for VS Code-flavoured
   * themes). GitHub themes read at GitHub's own 16px.
   */
  fontDefaultPx: number | null
  /**
   * Diagram palette id (see `mermaid-palettes.ts`) auto-paired with this content theme —
   * the SHARED layer-1 mapping reused by every diagram renderer (mermaid, task 86; echarts,
   * task 90). Each engine has its own translation of the palette DATA into its theme format.
   * undefined → no pairing (the engine falls back to its own light/dark).
   */
  palette?: string
}

// Order here is the order the `ct-<value>` <link>s are emitted; `auto` is implicit
// (no row → no link, no markdown-body class, the VS Code-colour path).
export const CONTENT_THEMES: readonly ThemeDef[] = [
  {
    value: 'github-light',
    file: 'media/markdown-themes/github-markdown-light.css',
    mode: 'light',
    code: 'github',
    fontDefaultPx: 16,
    palette: 'github-light',
  },
  {
    value: 'github-dark',
    file: 'media/markdown-themes/github-markdown-dark.css',
    mode: 'dark',
    code: 'github-dark',
    fontDefaultPx: 16,
    palette: 'github-dark',
  },
  {
    value: 'material-dark',
    file: 'media/markdown-themes/material-dark.css',
    mode: 'dark',
    code: 'atom-one-dark',
    fontDefaultPx: null,
    palette: 'one-dark',
  },
  {
    value: 'vscode-light-2026',
    file: 'media/markdown-themes/vscode-light-2026.css',
    mode: 'light',
    code: 'vs',
    fontDefaultPx: null,
    palette: 'vscode-light-2026',
  },
  {
    value: 'vscode-dark-2026',
    file: 'media/markdown-themes/vscode-dark-2026.css',
    mode: 'dark',
    code: 'vs2015',
    fontDefaultPx: null,
    palette: 'vscode-dark-2026',
  },
]

const BY_VALUE = new Map<string, ThemeDef>(
  CONTENT_THEMES.map((t) => [t.value, t]),
)

/** All named theme values (i.e. every `theme.content` value except `auto`). */
export const NAMED_THEME_VALUES: readonly string[] = CONTENT_THEMES.map(
  (t) => t.value,
)

/** The theme def for a value, or undefined for `auto`/unknown. */
export function themeDef(value: string | undefined): ThemeDef | undefined {
  return value ? BY_VALUE.get(value) : undefined
}

/** True for any named theme (not `auto`/unset) — i.e. one that gets markdown-body. */
export function isNamedTheme(value: string | undefined): boolean {
  return !!value && value !== 'auto' && BY_VALUE.has(value)
}

/**
 * Old → new `theme.content` migrations. The `vscode-*-modern` themes were renamed to
 * `vscode-*-2026` (the VS Code 1.123+ default palette). VS Code keeps a stale settings.json value
 * even after it leaves the manifest enum, so we map it at read time.
 */
const RENAMED_CONTENT_THEMES: Record<string, string> = {
  'vscode-light-modern': 'vscode-light-2026',
  'vscode-dark-modern': 'vscode-dark-2026',
}

/**
 * Normalise a raw `theme.content` value to a currently-valid one: empty/unset → `auto`; a renamed
 * old theme → its new name; any OTHER unknown (non-`auto`, non-registered) value → `auto`. Without
 * this, a stale value (e.g. an old `vscode-dark-modern`, or a typo) lands in a broken in-between —
 * the body gets `markdown-body` (value !== 'auto') but no theme stylesheet matches AND the
 * VS Code-colour `auto` path is off → an unstyled render. Read EVERY `theme.content` through this.
 */
export function resolveContentTheme(value: string | undefined): string {
  const migrated = (value && RENAMED_CONTENT_THEMES[value]) || value || 'auto'
  return migrated === 'auto' || isNamedTheme(migrated) ? migrated : 'auto'
}

/**
 * Pair a recognized VS Code color-theme id with the equivalent VMark content theme.
 * Unknown themes deliberately remain on the CSS-variable-driven `auto` path. The mode is
 * the fallback for GitHub ids whose variant is not included in the id (some theme extensions
 * expose only a family name), and keeps the result aligned with the active workbench theme.
 */
export function resolveAutoContentTheme(
  colorThemeId: string | undefined,
  mode: 'dark' | 'light',
): string {
  const id = colorThemeId?.trim().toLowerCase().replace(/\s+/g, ' ')
  if (!id) return 'auto'

  if (id.includes('github')) {
    if (id.includes('light')) return 'github-light'
    if (id.includes('dark')) return 'github-dark'
    return mode === 'dark' ? 'github-dark' : 'github-light'
  }

  if (VSCODE_LIGHT_THEME_IDS.has(id)) return 'vscode-light-2026'
  if (VSCODE_DARK_THEME_IDS.has(id)) return 'vscode-dark-2026'
  return 'auto'
}

// This is VS Code's own default for `markdown.preview.fontFamily`. Keep it in the shared
// registry so the host's initial HTML and the webview's live config use the same fallback.
const DEFAULT_MARKDOWN_PREVIEW_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Segoe WPC', 'Segoe UI', system-ui, 'Ubuntu', 'Droid Sans', sans-serif"

const VSCODE_LIGHT_THEME_IDS = new Set([
  'default light modern',
  'light modern',
  'light+',
  'light (visual studio)',
  '2026 light',
])

const VSCODE_DARK_THEME_IDS = new Set([
  'default dark modern',
  'dark modern',
  'dark+',
  'dark (visual studio)',
  '2026 dark',
])

export function resolveMarkdownPreviewFontFamily(
  value: string | undefined,
): string {
  const trimmed = value?.trim()
  return trimmed || DEFAULT_MARKDOWN_PREVIEW_FONT_FAMILY
}

/** Default font stack for the Split View source panel (`vmde.editor.sourceFontFamily`). */
export const DEFAULT_SOURCE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

/**
 * Resolve the `sourceFontFamily` setting into a CSS font-family list for `--me-source-font-family`.
 * Shared by the host (initial body style) and the webview (live applyBodyOptions) so both
 * sanitise identically. Non-string, empty or whitespace-only values give the default; characters
 * that could end the declaration or the surrounding HTML/style context become spaces.
 */
export function resolveSourceFontFamily(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_SOURCE_FONT_FAMILY
  const cleaned = value.replace(/[;<>{}\r\n]/g, ' ').trim()
  return cleaned || DEFAULT_SOURCE_FONT_FAMILY
}

const EDITOR_FONT_SIZE = 'var(--vscode-editor-font-size, 14px)'

/**
 * Resolve the `fontSize` setting into a CSS value for `--me-font-size`. Shared by the
 * host (initial body style) and the webview (live applyBodyOptions) so they can't
 * diverge. "editor"/unset → the theme default (GitHub 16px, else the VS Code editor
 * size); "vditor" → 16px; a positive number → px; anything else → the default. An
 * explicit number/"vditor" always wins, so the setting still scales a GitHub theme.
 */
export function resolveFontSize(
  value: string | number | undefined,
  contentTheme?: string,
): string {
  const px = themeDef(contentTheme)?.fontDefaultPx
  const def = px ? `${px}px` : EDITOR_FONT_SIZE
  if (value === undefined || value === '' || value === 'editor') return def
  if (value === 'vditor') return '16px'
  const n = typeof value === 'number' ? value : parseFloat(value)
  return Number.isFinite(n) && n > 0 ? `${n}px` : def
}

/**
 * The highlight.js style for an `auto` code theme: the content theme's paired style,
 * else github/github-dark by the effective mode (which itself follows the content
 * theme via effectiveThemeKind). An explicit `codeTheme` is handled by the caller.
 */
function autoCodeStyle(
  mode: 'dark' | 'light',
  contentTheme: string | undefined,
): string {
  return (
    themeDef(contentTheme)?.code ?? (mode === 'dark' ? 'github-dark' : 'github')
  )
}

/**
 * The FULL code-style resolution: an explicit `theme.code` wins, `auto`/unset falls back to the
 * content theme's pairing (autoCodeStyle above).
 *
 * Task 431: this exists so the HOST and the WEBVIEW cannot drift. The host now emits the
 * `#vditorHljsStyle` link in the initial HTML (html-builder.ts) while the webview still calls Vditor's
 * `setCodeTheme` at init — and `setCodeTheme` compares the raw `href` string and REMOVES + re-adds the
 * link when it differs (vditor/src/ts/ui/setCodeTheme.ts:12). Two independent copies of this rule would
 * therefore not merely disagree cosmetically; a near-miss would recreate the very stylesheet-swap flash
 * shipping the link early is meant to close. One function, both callers.
 */
export function resolveCodeStyle(
  mode: 'dark' | 'light',
  codeTheme: string | undefined,
  contentTheme: string | undefined,
): string {
  if (codeTheme && codeTheme !== 'auto') return codeTheme
  return autoCodeStyle(mode, contentTheme)
}

/**
 * The highlight.js stylesheet URL for a resolved style, byte-identical to what Vditor's `setCodeTheme`
 * builds from the same `cdn` — see the note on resolveCodeStyle for why "byte-identical" is load-bearing
 * (no cache-bust suffix here: `setCodeTheme` compares the raw attribute).
 */
export function codeStyleHref(cdn: string, style: string): string {
  return `${cdn}/dist/js/highlight.js/styles/${style}.min.css`
}

/**
 * The diagram palette auto-paired with a content theme — the SHARED layer-1 mapping for
 * every diagram renderer (mermaid task 86, echarts task 90). undefined when the content
 * theme has no pairing (e.g. `auto`/VS Code colours), so the caller falls back to the
 * engine's own light/dark. Unlike `autoCodeStyle` there's no binary palette fallback here.
 */
export function pairedPalette(
  contentTheme: string | undefined,
): string | undefined {
  return themeDef(contentTheme)?.palette
}
