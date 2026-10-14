import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CONTENT_THEMES,
  NAMED_THEME_VALUES,
  isNamedTheme,
  resolveAutoContentTheme,
  resolveContentTheme,
  resolveMarkdownPreviewFontFamily,
  resolveSourceFontFamily,
  DEFAULT_SOURCE_FONT_FAMILY,
} from '../../src/shared/theme-registry'

// `theme.content` migration + normalisation. The `vscode-*-modern` themes were renamed to
// `vscode-*-2026`; VS Code keeps a stale settings.json value after it leaves the manifest enum, so
// resolveContentTheme maps it at read time and folds any other unknown value to `auto` (avoids the
// broken in-between where `markdown-body` is applied but no theme stylesheet matches).
describe('resolveContentTheme (theme.content migration)', () => {
  it('empty / unset → auto', () => {
    expect(resolveContentTheme(undefined)).toBe('auto')
    expect(resolveContentTheme('')).toBe('auto')
    expect(resolveContentTheme('auto')).toBe('auto')
  })

  it('migrates the renamed vscode-*-modern themes to their -2026 names', () => {
    expect(resolveContentTheme('vscode-dark-modern')).toBe('vscode-dark-2026')
    expect(resolveContentTheme('vscode-light-modern')).toBe('vscode-light-2026')
  })

  it('passes through every currently-valid named theme unchanged', () => {
    for (const v of NAMED_THEME_VALUES) {
      expect(resolveContentTheme(v)).toBe(v)
    }
  })

  it('folds any other unknown value to auto (no broken in-between)', () => {
    expect(resolveContentTheme('garbage')).toBe('auto')
    expect(resolveContentTheme('vscode-dark-modern-x')).toBe('auto')
    expect(resolveContentTheme('GitHub-Dark')).toBe('auto') // case-sensitive
  })

  it('every migration target is a real, currently-registered named theme', () => {
    for (const target of ['vscode-dark-2026', 'vscode-light-2026']) {
      expect(isNamedTheme(target)).toBe(true)
    }
  })
})

describe('resolveAutoContentTheme', () => {
  it('pairs the built-in VS Code Modern themes with VMark themes', () => {
    expect(resolveAutoContentTheme('Default Light Modern', 'light')).toBe(
      'vscode-light-2026',
    )
    expect(resolveAutoContentTheme('Default Dark Modern', 'dark')).toBe(
      'vscode-dark-2026',
    )
  })

  it('pairs the standard VS Code dark and light theme names too', () => {
    for (const id of [
      'Dark+',
      'Dark Modern',
      'Dark (Visual Studio)',
      '2026 Dark',
    ]) {
      expect(resolveAutoContentTheme(id, 'dark')).toBe('vscode-dark-2026')
    }
    for (const id of [
      'Light+',
      'Light Modern',
      'Light (Visual Studio)',
      '2026 Light',
    ]) {
      expect(resolveAutoContentTheme(id, 'light')).toBe('vscode-light-2026')
    }
  })

  it('pairs GitHub light and dark themes with their VMark themes', () => {
    expect(resolveAutoContentTheme('GitHub Light Default', 'light')).toBe(
      'github-light',
    )
    expect(resolveAutoContentTheme('GitHub Dark Default', 'dark')).toBe(
      'github-dark',
    )
  })

  it('keeps unrelated VS Code themes on the variable-driven auto path', () => {
    expect(resolveAutoContentTheme('Abyss', 'dark')).toBe('auto')
    expect(resolveAutoContentTheme(undefined, 'light')).toBe('auto')
  })
})

describe('resolveMarkdownPreviewFontFamily', () => {
  it('uses VS Code Markdown Preview default when unset', () => {
    expect(resolveMarkdownPreviewFontFamily(undefined)).toContain('Segoe WPC')
  })

  it('preserves an explicitly configured Markdown Preview font family', () => {
    expect(resolveMarkdownPreviewFontFamily('Arial, sans-serif')).toBe(
      'Arial, sans-serif',
    )
  })
})

// Task 634: the Split View source font. The default stack is the contract literal, not read back
// from the code under test.
describe('resolveSourceFontFamily (task 634)', () => {
  const DEFAULT =
    'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'

  it('exposes the contract default stack', () => {
    expect(DEFAULT_SOURCE_FONT_FAMILY).toBe(DEFAULT)
  })

  it('returns the default for unset, empty, whitespace and non-string values', () => {
    for (const v of [
      undefined,
      null,
      '',
      '   ',
      '\t\n',
      14,
      true,
      ['Fira Code'],
      {},
    ])
      expect(resolveSourceFontFamily(v)).toBe(DEFAULT)
  })

  it('preserves a custom stack, trimmed, with quoted names intact', () => {
    expect(resolveSourceFontFamily('  Fira Code, monospace ')).toBe(
      'Fira Code, monospace',
    )
    expect(
      resolveSourceFontFamily('"JetBrains Mono", \'Fira Code\', monospace'),
    ).toBe('"JetBrains Mono", \'Fira Code\', monospace')
  })

  it('replaces declaration and markup breakers with a space', () => {
    expect(resolveSourceFontFamily('a;b')).toBe('a b')
    expect(resolveSourceFontFamily('Fira}</style><script>x')).toBe(
      'Fira  /style  script x',
    )
    expect(resolveSourceFontFamily('Fira\nCode\r\nMono')).toBe(
      'Fira Code  Mono',
    )
  })

  it('replaces a colon with a space (a font-family value never needs one)', () => {
    expect(resolveSourceFontFamily('a:b')).toBe('a b')
    expect(resolveSourceFontFamily('Evil body display:none')).toBe(
      'Evil body display none',
    )
    expect(resolveSourceFontFamily('x, y:z')).toBe('x, y z')
  })

  it('keeps a url() value as plain text (the browser drops it as a font-family)', () => {
    expect(resolveSourceFontFamily('url(x)')).toBe('url(x)')
  })

  it('falls back to the default when only stripped punctuation remains', () => {
    for (const v of [';', '{}', '<>;', ' ;\n{ } ', ':', ' : ;'])
      expect(resolveSourceFontFamily(v)).toBe(DEFAULT)
  })
})

// Task 443: the two vscode-*-2026 files are hand-maintained TWINS — the light one is a colour swap of
// the dark one — so a declaration added to only one of them is a silent, per-mode inconsistency (and
// the kind of drift no colour assertion catches). Pin the prose-typography contract in both: VS Code's
// preview leading (markdown.preview.lineHeight default 1.6, against Vditor's own 1.5) and its font
// stack (markdown.preview.fontFamily, whose leading "Segoe WPC" is absent from the GitHub stack
// main.css forces on named themes). The COMPUTED cascade is asserted by the harness spec
// (media-src/e2e/content-theme.spec.ts) and against VS Code's real preview by
// test/vscode-e2e/font-parity.spec.ts; this is the cheap both-files-agree gate.
describe('vscode-*-2026 prose typography contract (task 443)', () => {
  const vscodeThemes = CONTENT_THEMES.filter((t) =>
    t.value.startsWith('vscode-'),
  )

  it('covers both vscode themes', () => {
    expect(vscodeThemes.map((t) => t.value)).toEqual([
      'vscode-light-2026',
      'vscode-dark-2026',
    ])
  })

  for (const theme of vscodeThemes) {
    it(`${theme.value} declares the preview leading + font stack`, () => {
      const css = readFileSync(join(__dirname, '..', '..', theme.file), 'utf8')
      expect(css).toMatch(/line-height:\s*1\.6\s*;/)
      expect(css).toContain('"Segoe WPC"')
      // both must ride the same selector that out-ranks main.css's !important bridge
      expect(css).toContain('body.markdown-body .vditor .vditor-reset {')
    })
  }
})
