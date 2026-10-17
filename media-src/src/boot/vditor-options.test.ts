import { test, expect, describe } from 'vitest'
import { buildVditorOptions, codeHljsStyle } from './vditor-options.ts'

describe('codeHljsStyle', () => {
  test('follows the VS Code theme when codeTheme is auto/unset', () => {
    expect(codeHljsStyle('dark', {})).toBe('github-dark')
    expect(codeHljsStyle('light', {})).toBe('github')
    expect(codeHljsStyle('dark', { codeTheme: 'auto' })).toBe('github-dark')
  })

  test('uses an explicit codeTheme when set', () => {
    expect(codeHljsStyle('light', { codeTheme: 'dracula' })).toBe('dracula')
  })

  test('auto follows the content theme paired code style (task 82)', () => {
    // material-dark pins atom-one-dark to match its One Dark palette
    expect(
      codeHljsStyle('dark', {
        codeTheme: 'auto',
        contentTheme: 'material-dark',
      }),
    ).toBe('atom-one-dark')
    // vscode-light-2026/dark pair the Visual Studio hljs themes
    expect(
      codeHljsStyle('light', {
        codeTheme: 'auto',
        contentTheme: 'vscode-light-2026',
      }),
    ).toBe('vs')
    expect(
      codeHljsStyle('dark', {
        codeTheme: 'auto',
        contentTheme: 'vscode-dark-2026',
      }),
    ).toBe('vs2015')
    // an explicit codeTheme still wins over the content-theme pairing
    expect(
      codeHljsStyle('dark', {
        codeTheme: 'nord',
        contentTheme: 'material-dark',
      }),
    ).toBe('nord')
  })
})

describe('buildVditorOptions — codeLineNumbers is authoritative', () => {
  test('setting on enables the line-number gutter', () => {
    const opts = buildVditorOptions({
      options: { codeBlockLineNumbers: true },
    })
    expect(opts.preview.hljs.lineNumber).toBe(true)
  })

  test('setting off disables the line-number gutter', () => {
    const opts = buildVditorOptions({
      options: { codeBlockLineNumbers: false },
    })
    expect(opts.preview.hljs.lineNumber).toBe(false)
  })

  test('setting unset defaults the gutter off', () => {
    const opts = buildVditorOptions({ options: {} })
    expect(opts.preview.hljs.lineNumber).toBe(false)
  })

  test('setting off OVERRIDES a stale saved preview.hljs.lineNumber:true (the bug)', () => {
    // saveVditorOptions persists the whole preview object, so a session that once
    // had line numbers on spreads lineNumber:true back into msg.options. The
    // current (off) setting must win, not the saved value.
    const opts = buildVditorOptions({
      options: {
        codeBlockLineNumbers: false,
        preview: { hljs: { lineNumber: true } },
      },
    })
    expect(opts.preview.hljs.lineNumber).toBe(false)
  })

  test('a non-boolean truthy saved value cannot leak through as on', () => {
    const opts = buildVditorOptions({
      options: {
        codeBlockLineNumbers: undefined,
        preview: { hljs: { lineNumber: true } },
      },
    })
    expect(opts.preview.hljs.lineNumber).toBe(false)
  })

  test('preserves the resolved hljs style alongside the line-number flag', () => {
    const opts = buildVditorOptions({
      theme: 'dark',
      options: { codeBlockLineNumbers: true, codeTheme: 'nord' },
    })
    expect(opts.preview.hljs.style).toBe('nord')
    expect(opts.preview.hljs.lineNumber).toBe(true)
  })
})

describe('buildVditorOptions — preview.delay is config-derived (task 187)', () => {
  test('defaults to 500 ms (snappier sv/preview refresh than the Vditor 1000 default)', () => {
    const opts = buildVditorOptions({ options: {} })
    expect(opts.preview.delay).toBe(500)
  })

  test('OVERRIDES a stale saved preview.delay (whole-preview-blob persistence trap)', () => {
    const opts = buildVditorOptions({
      options: { preview: { delay: 1000 } },
    })
    expect(opts.preview.delay).toBe(500)
  })
})

describe('buildVditorOptions — repository callouts stay authoritative', () => {
  test('disables Vditor native callouts and overrides a stale saved true value', () => {
    const opts = buildVditorOptions({
      options: { preview: { markdown: { callout: true } } },
    })
    expect(opts.preview.markdown.callout).toBe(false)
  })
})

describe('buildVditorOptions — bundled Markdown extensions are explicit and authoritative', () => {
  test('keeps toc, mark, sup, and sub off by default', () => {
    expect(buildVditorOptions({ options: {} }).preview.markdown).toMatchObject({
      toc: false,
      mark: false,
      sup: false,
      sub: false,
    })
  })

  test('enables each configured flag and overrides stale saved values', () => {
    const enabled = buildVditorOptions({
      options: {
        markdownToc: true,
        markdownMark: true,
        markdownSupSub: true,
        preview: {
          markdown: { toc: false, mark: false, sup: false, sub: false },
        },
      },
    })
    expect(enabled.preview.markdown).toMatchObject({
      toc: true,
      mark: true,
      sup: true,
      sub: true,
    })
  })
})

describe('buildVditorOptions — image preview is disabled under CSP (task 212)', () => {
  test('overrides a stale saved image.isPreview:true', () => {
    const opts = buildVditorOptions({
      options: { image: { isPreview: true } },
    })
    expect(opts.image.isPreview).toBe(false)
  })
})

describe('buildVditorOptions — codeTheme (hljs style) is authoritative', () => {
  test('auto/unset follows the VS Code theme', () => {
    expect(
      buildVditorOptions({ theme: 'dark', options: {} }).preview.hljs.style,
    ).toBe('github-dark')
    expect(
      buildVditorOptions({ theme: 'light', options: {} }).preview.hljs.style,
    ).toBe('github')
  })

  test('explicit codeTheme wins', () => {
    const opts = buildVditorOptions({
      theme: 'light',
      options: { codeTheme: 'dracula' },
    })
    expect(opts.preview.hljs.style).toBe('dracula')
  })

  test('codeTheme OVERRIDES a stale saved preview.hljs.style (the bug class)', () => {
    // saveVditorOptions persists hljs.style; the current setting must win, not the
    // saved value spread in from msg.options.
    const opts = buildVditorOptions({
      theme: 'light',
      options: {
        codeTheme: 'dracula',
        preview: { hljs: { style: 'monokai' } },
      },
    })
    expect(opts.preview.hljs.style).toBe('dracula')
  })

  test('auto + stale saved style still resolves to the theme default, not the saved value', () => {
    const opts = buildVditorOptions({
      theme: 'dark',
      options: { preview: { hljs: { style: 'monokai' } } },
    })
    expect(opts.preview.hljs.style).toBe('github-dark')
  })
})

// Task 282 — the configured open mode. The gotcha this pins: buildInitOptions spreads the SAVED
// Vditor options (which include `mode`) on TOP of the config, so unless the config-derived mode is
// the LAST merge, whatever mode the previous session ended in wins and the setting looks broken.
// Same class of bug as the saved `preview.hljs.lineNumber` one-way switch.
describe('buildVditorOptions — defaultMode (task 282)', () => {
  const msg = (options: Record<string, unknown>) => ({
    theme: 'light',
    options,
  })

  test('leaves the mode alone when no defaultMode is resolved (= "remember")', () => {
    expect(buildVditorOptions(msg({ mode: 'wysiwyg' })).mode).toBe('wysiwyg')
  })

  test('the configured mode WINS over a saved mode spread in from a previous session', () => {
    expect(
      buildVditorOptions(msg({ mode: 'wysiwyg', defaultMode: 'sv' })).mode,
    ).toBe('sv')
  })

  test('"preview" maps to ir — it is an overlay, not one of Vditor three modes', () => {
    expect(
      buildVditorOptions(msg({ mode: 'wysiwyg', defaultMode: 'preview' })).mode,
    ).toBe('ir')
  })

  test('applies the configured mode when nothing was saved at all', () => {
    expect(buildVditorOptions(msg({ defaultMode: 'wysiwyg' })).mode).toBe(
      'wysiwyg',
    )
  })
})

// Task 650 Decision 2 / "Where the rule lives": a remembered boolean decides the Outline open
// state; absent or non-boolean means the `vmde.outline.defaultOpen` setting decides.
describe('buildVditorOptions — remembered Outline open state (task 650)', () => {
  const enable = (options: Record<string, unknown>) =>
    buildVditorOptions({ options }).outline.enable
  const cases: Array<[unknown, boolean, boolean]> = [
    [true, false, true],
    [true, true, true],
    [false, true, false],
    [false, false, false],
    [undefined, true, true],
    [undefined, false, false],
    ['true', true, true],
    ['true', false, false],
    [1, false, false],
  ]
  test.each(cases)(
    'stored %j, setting %j gives %j',
    (stored, setting, want) => {
      expect(
        enable({ outlineOpen: stored, showOutlineByDefault: setting }),
      ).toBe(want)
    },
  )
})
