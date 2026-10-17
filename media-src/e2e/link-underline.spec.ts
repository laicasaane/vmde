import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 647: every link is underlined at rest in Preview, Split's preview pane, WYSIWYG and IR
// (rendered state), in every content theme, with one look: `underline solid auto 2px`.
// Everything is asserted on COMPUTED style (exact strings), never on pixels.

const FIXTURE = `# Title

## Section Two

Inline: [L-inline](https://example.com/inline) end.

Code link: [\`Code.cs:53-58\`](../../../Module/Code.cs#L1-L5) end.

Mixed: [L-mixed \`x\` tail](https://example.com/mixed) end.

Bold link: [**L-bold**](https://example.com/bold) end.

Ref: [L-ref][r1] and collapsed [r1][] and shortcut [r1] end.

Autolink: <https://example.com/L-auto> end.

Bare: https://example.com/L-bare end.

HTML: <a href="https://example.com/html">L-html</a> end.

Anchor: [L-anchor](#section-two) end.

File: [L-file](src/foo.ts:42) and [L-fileL](src/foo.ts#L42) end.

Wiki: [[L-wiki]] end.

CodeRef in link: [\`src/foo.ts:44\`](https://example.com/refinlink) and [src/foo.ts:45](https://example.com/refinlink2) end.

### Head [L-heading](https://example.com/heading)

| h |
|---|
| [L-table](https://example.com/table) |

> quote [L-quote](https://example.com/quote)

- item [L-list](https://example.com/list)

Footnote: text[^1] end.

Controls: \`N-code\` and *N-em* and <a id="N-id">N-idtext</a> and <a name="N-name">N-nametext</a> and \`src/foo.ts:42\` and src/foo.ts:43 end.

[r1]: https://example.com/ref

[^1]: Footnote body.
`

type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'
type Cfg = readonly [name: string, contentTheme: string, themeKind: string]

// Auto light/dark/high-contrast/high-contrast-light, each named theme, and one high-contrast
// entry per named-theme group (A: declares no text-decoration, B: declares `none`).
const CFGS: readonly Cfg[] = [
  ['auto/light', 'auto', 'light'],
  ['auto/dark', 'auto', 'dark'],
  ['auto/hc', 'auto', 'high-contrast'],
  ['auto/hc-light', 'auto', 'high-contrast-light'],
  ['github-light', 'github-light', 'light'],
  ['github-dark', 'github-dark', 'dark'],
  ['material-dark', 'material-dark', 'dark'],
  ['vscode-light-2026', 'vscode-light-2026', 'light'],
  ['vscode-dark-2026', 'vscode-dark-2026', 'dark'],
  ['github-light+hc', 'github-light', 'high-contrast'],
  ['material-dark+hc', 'material-dark', 'high-contrast'],
]

const PANE: Record<Mode, string> = {
  ir: '.vditor-ir > .vditor-reset',
  wysiwyg: '.vditor-wysiwyg > .vditor-reset',
  sv: '.vditor-preview > .vditor-reset',
  preview: '.vditor-preview > .vditor-reset',
}

// [name, visible text, optional scope selector]
type Target = readonly [name: string, text: string, scope?: string]
const LINKS: readonly Target[] = [
  ['inline', 'L-inline'],
  ['code-in-link', 'Code.cs:53-58'],
  ['mixed-text', 'L-mixed'],
  ['mixed-code', 'x', 'span[data-type=a] code, a code'],
  ['bold-in-link', 'L-bold'],
  ['ref', 'L-ref'],
  ['collapsed-ref', 'r1'],
  ['autolink', 'https://example.com/L-auto'],
  ['anchor', 'L-anchor'],
  ['file-line', 'L-file'],
  ['file-hashL', 'L-fileL'],
  ['wiki', 'L-wiki'],
  ['coderef-in-link-code', 'src/foo.ts:44', 'code.vmde-code-ref'],
  ['coderef-in-link-text', 'src/foo.ts:45'],
  ['heading-link', 'L-heading'],
  ['table-link', 'L-table'],
  ['quote-link', 'L-quote'],
  ['list-link', 'L-list'],
]
// A raw HTML <a href> is a link element only where the markup is rendered (Preview, Split preview).
const HTML_LINK: Target = ['html-a-href', 'L-html']
// Controls: not links, rest look unchanged (no underline).
const CONTROLS: readonly Target[] = [
  ['N-code', 'N-code'],
  ['N-em', 'N-em'],
  ['N-id', 'N-idtext'],
  ['N-name', 'N-nametext'],
  ['bare-url', '~https://example.com/L-bare'],
]
const FOOTNOTE: Target = [
  'footnote-ref',
  '1',
  'sup[data-type=footnotes-ref], sup.footnotes-ref',
]
const CODEREFS: readonly Target[] = [
  ['coderef-code', 'src/foo.ts:42', 'code.vmde-code-ref'],
  ['coderef-chip', 'src/foo.ts:43', '.vmde-code-ref-chip'],
]

interface Decor {
  missing?: boolean
  line: string
  style: string
  color: string
  thick: string
  offset: string
  textColor: string
  ownLine: string
}

const LOOK = {
  line: 'underline',
  style: 'solid',
  thick: 'auto',
  offset: '2px',
} as const

// Page-side finder + measurer. The effective line is the first ancestor (up to a box boundary)
// that carries one, because a decoration on an ancestor is painted across inline descendants.
const PAGE_FNS = `
  window.__ul = {
    find(paneSel, tok, scope) {
      const root = document.querySelector(paneSel)
      if (!root) return null
      const scopes = scope ? [...root.querySelectorAll(scope)] : [root]
      const norm = (s) => s.replace(/[\\u200b\\s]+/g, ' ').trim()
      for (const sc of scopes) {
        const w = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT)
        let n
        while ((n = w.nextNode())) {
          const text = norm(n.data)
          if (tok.startsWith('~') ? !text.includes(tok.slice(1)) : text !== tok) continue
          const p = n.parentElement
          if (p.closest('.vditor-ir__marker')) continue
          const r = document.createRange()
          r.selectNodeContents(n)
          const rects = r.getClientRects()
          if (!rects.length || rects[0].width === 0) continue
          return n
        }
      }
      return null
    },
    measure(paneSel, tok, scope) {
      const n = window.__ul.find(paneSel, tok, scope)
      if (!n) return { missing: true }
      const root = document.querySelector(paneSel)
      const boundary = (cs) =>
        /inline-block|inline-flex|inline-grid|flex|grid|table/.test(cs.display) ||
        cs.cssFloat !== 'none' || cs.position === 'absolute' || cs.position === 'fixed'
      const own = getComputedStyle(n.parentElement)
      let el = n.parentElement
      while (el && el !== root.parentElement) {
        const cs = getComputedStyle(el)
        if (cs.textDecorationLine.includes('underline')) {
          return { line: cs.textDecorationLine, style: cs.textDecorationStyle, color: cs.textDecorationColor,
            thick: cs.textDecorationThickness, offset: cs.textUnderlineOffset, textColor: own.color, ownLine: own.textDecorationLine }
        }
        if (boundary(cs)) break
        el = el.parentElement
      }
      return { line: 'none', style: own.textDecorationStyle, color: own.textDecorationColor,
        thick: own.textDecorationThickness, offset: own.textUnderlineOffset, textColor: own.color, ownLine: own.textDecorationLine }
    },
    point(paneSel, tok, scope) {
      const n = window.__ul.find(paneSel, tok, scope)
      if (!n) return null
      n.parentElement.scrollIntoView({ block: 'center' })
      const r = document.createRange()
      r.selectNodeContents(n)
      const b = r.getClientRects()[0]
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    },
  }
`

function initFor(mode: Mode, content: string) {
  return {
    command: 'update',
    type: 'init',
    content,
    cdn: '/vditor',
    options: {
      showToolbar: true,
      useVscodeThemeColor: true,
      enableFullWidth: true,
      contentTheme: 'auto',
      defaultMode: mode,
    },
    theme: 'light',
    themeKind: 'light',
    wiki: { enabled: true, pageKeys: ['l-wiki'], displayNames: ['L-wiki'] },
  }
}

type Init = ReturnType<typeof initFor>

async function openMode(
  page: Page,
  mode: Mode,
  content = FIXTURE,
): Promise<{ init: Init; posted: any[] }> {
  const init = initFor(mode, content)
  await page.setViewportSize({ width: 1100, height: 800 })
  await page.addInitScript((i) => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => {
        ;(window as any).__posted.push(m)
        if (m?.command === 'ready') window.postMessage(i, '*')
        if (m?.command === 'resolve-code-refs') {
          window.postMessage(
            {
              command: 'code-refs-resolved',
              requestId: m.requestId,
              existing: m.paths,
            },
            '*',
          )
        }
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/prerender.html', { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(
    () =>
      !document.getElementById('vmde-prerender') &&
      !!document.querySelector('#app .vditor-reset'),
    undefined,
    { timeout: 20_000 },
  )
  // The real webview toggles content-theme links; the harness page has none, so add them
  // disabled (same ids/paths the webview uses) and let config-changed enable the active one.
  await page.evaluate((fns) => {
    // biome-ignore lint/security/noGlobalEval: page-side helper source
    window.eval(fns)
    const files: [string, string][] = [
      ['github-markdown-light', 'github-light'],
      ['github-markdown-dark', 'github-dark'],
      ['material-dark', 'material-dark'],
      ['vscode-light-2026', 'vscode-light-2026'],
      ['vscode-dark-2026', 'vscode-dark-2026'],
    ]
    for (const [file, id] of files) {
      if (document.getElementById(`ct-${id}`)) continue
      const l = document.createElement('link')
      l.id = `ct-${id}`
      l.rel = 'stylesheet'
      l.href = `/markdown-themes/${file}.css`
      l.disabled = true
      document.head.appendChild(l)
    }
  }, PAGE_FNS)
  await page.waitForTimeout(800)
  return { init, posted: [] }
}

async function applyCfg(page: Page, init: Init, cfg: Cfg) {
  const [, contentTheme, themeKind] = cfg
  await page.evaluate(
    ({ init, contentTheme, themeKind }) =>
      window.postMessage(
        {
          ...init,
          command: 'config-changed',
          themeKind,
          theme:
            themeKind === 'dark' || themeKind === 'high-contrast'
              ? 'dark'
              : 'light',
          options: { ...init.options, contentTheme },
        },
        '*',
      ),
    { init, contentTheme, themeKind },
  )
  await page.waitForTimeout(350)
}

async function measure(page: Page, pane: string, t: Target): Promise<Decor> {
  return page.evaluate(
    ([p, tok, scope]) => (window as any).__ul.measure(p, tok, scope ?? null),
    [pane, t[1], t[2] ?? null] as const,
  )
}

async function hoverMeasure(
  page: Page,
  pane: string,
  t: Target,
): Promise<Decor> {
  const pt = await page.evaluate(
    ([p, tok, scope]) => (window as any).__ul.point(p, tok, scope ?? null),
    [pane, t[1], t[2] ?? null] as const,
  )
  expect(pt, `${t[0]} has a hover point`).not.toBeNull()
  await page.mouse.move(pt.x, pt.y)
  return measure(page, pane, t)
}

const getValue = (page: Page): Promise<string> =>
  page.evaluate(() => (window as any).vditor.getValue())

// Acceptance 1 and 3 (every link kind underlined at rest and on hover, one look, link color
// source) plus acceptance 5 (document text unchanged, no edit posted) for each pane.
for (const mode of ['ir', 'wysiwyg', 'sv', 'preview'] as const) {
  test(`every link kind has the one link underline at rest and on hover (${mode})`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    const { init } = await openMode(page, mode)
    const pane = PANE[mode]
    const valueBefore = await getValue(page)
    const links =
      mode === 'sv' || mode === 'preview' ? [...LINKS, HTML_LINK] : LINKS
    for (const cfg of CFGS) {
      await applyCfg(page, init, cfg)
      await page.mouse.move(2, 2)
      const inline = await measure(page, pane, ['inline', 'L-inline'])
      for (const t of links) {
        const where = `${mode} ${cfg[0]} ${t[0]}`
        const rest = await measure(page, pane, t)
        expect(rest.missing, `${where} found`).toBeUndefined()
        expect(
          {
            line: rest.line,
            style: rest.style,
            thick: rest.thick,
            offset: rest.offset,
          },
          `${where} rest`,
        ).toEqual(LOOK)
        // Color source: the link's own color, or (text inside inline code, which has its own
        // text color) the same decoration color as a plain link in this pane and theme.
        const codeText =
          t[0] === 'code-in-link' ||
          t[0] === 'mixed-code' ||
          t[0] === 'coderef-in-link-code'
        if (codeText) expect(rest.color, `${where} color`).toBe(inline.color)
        else expect(rest.color, `${where} color`).toBe(rest.textColor)
        const hover = await hoverMeasure(page, pane, t)
        expect(
          {
            line: hover.line,
            style: hover.style,
            thick: hover.thick,
            offset: hover.offset,
          },
          `${where} hover`,
        ).toEqual(LOOK)
        expect(hover.color, `${where} hover color`).toBe(
          codeText ? inline.color : hover.textColor,
        )
        await page.mouse.move(2, 2)
      }
    }
    // CSS only: the document text is untouched and no edit was posted.
    expect(await getValue(page)).toBe(valueBefore)
    const edits = await page.evaluate(
      () =>
        (window as any).__posted.filter((m: any) => m?.command === 'edit')
          .length,
    )
    expect(edits).toBe(0)
  })
}

// Acceptance 2: the example's inline code is underlined with the link's own style and color, in
// IR and Preview.
for (const mode of ['ir', 'preview'] as const) {
  test(`inline code used as link text carries the link underline (${mode})`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const pane = PANE[mode]
    for (const cfg of CFGS.slice(0, 2).concat(CFGS.slice(4, 5))) {
      await applyCfg(page, init, cfg)
      const code = await measure(page, pane, ['code', 'Code.cs:53-58', 'code'])
      const plain = await measure(page, pane, ['inline', 'L-inline'])
      expect(code, `${mode} ${cfg[0]}`).toMatchObject(LOOK)
      expect(code.color, `${mode} ${cfg[0]} color`).toBe(plain.color)
      const tag = await page.evaluate(
        ([p]) => {
          const n = (window as any).__ul.find(p, 'Code.cs:53-58', 'code')
          return n.parentElement.tagName
        },
        [pane],
      )
      expect(tag).toBe('CODE')
    }
  })
}

// Acceptance 4: not-links keep today's look. Plain inline code, emphasis, <a id>/<a name>, a bare
// URL and the footnote marker have no underline at rest or on hover (footnote marker: unchanged
// per the Owner, so only IR/WYSIWYG superscripts are asserted as none); a code reference outside
// a link has none at rest and a 2px hover underline; inside a link the code reference has no
// second line of its own on hover.
for (const mode of ['ir', 'preview'] as const) {
  test(`non-links keep their look and a code reference inside a link draws no second line (${mode})`, async ({
    page,
  }) => {
    const { init } = await openMode(page, mode)
    const pane = PANE[mode]
    for (const cfg of CFGS.slice(0, 1).concat(CFGS.slice(4, 5))) {
      await applyCfg(page, init, cfg)
      await page.mouse.move(2, 2)
      for (const t of CONTROLS) {
        const rest = await measure(page, pane, t)
        expect(rest.line, `${mode} ${cfg[0]} ${t[0]} rest`).toBe('none')
        const hover = await hoverMeasure(page, pane, t)
        expect(hover.line, `${mode} ${cfg[0]} ${t[0]} hover`).toBe('none')
        await page.mouse.move(2, 2)
      }
      if (mode === 'ir') {
        const fn = await measure(page, pane, FOOTNOTE)
        expect(fn.line, `${mode} ${cfg[0]} footnote`).toBe('none')
      }
      for (const t of CODEREFS) {
        const rest = await measure(page, pane, t)
        expect(rest.line, `${mode} ${cfg[0]} ${t[0]} rest`).toBe('none')
        const hover = await hoverMeasure(page, pane, t)
        expect(
          { line: hover.line, style: hover.style, offset: hover.offset },
          `${mode} ${cfg[0]} ${t[0]} hover`,
        ).toEqual({ line: 'underline', style: 'solid', offset: '2px' })
        await page.mouse.move(2, 2)
      }
      const t = LINKS.find((l) => l[0] === 'coderef-in-link-code')!
      await hoverMeasure(page, pane, t)
      const own = await page.evaluate(
        ([p]) => {
          const n = (window as any).__ul.find(
            p,
            'src/foo.ts:44',
            'code.vmde-code-ref',
          )
          return getComputedStyle(n.parentElement).textDecorationLine
        },
        [pane],
      )
      expect(own, `${mode} ${cfg[0]} coderef-in-link own hover line`).toBe(
        'none',
      )
      await page.mouse.move(2, 2)
    }
  })
}

// Vditor's own bracket-marker color per configuration, recorded from the build before the fix.
const BRACKET_COLOR: Record<string, string> = {
  'auto/light': 'rgb(0, 0, 255)',
  'github-light': 'rgb(0, 0, 255)',
  'material-dark': 'rgb(40, 123, 222)',
  'material-dark+hc': 'rgb(40, 123, 222)',
}

// Acceptance 3 of the checklist (IR revealed state unchanged) plus focus state (a): with the caret
// inside a link the Markdown markers show, the node is not underlined, bracket markers keep
// Vditor's own underline and color, `.vditor-ir__link` stays undecorated; the caret outline
// (`.vmde-caret-inside`) is kept.
test('IR link with the caret inside keeps the revealed source look and the caret outline', async ({
  page,
}) => {
  const { init } = await openMode(page, 'ir')
  const pane = PANE.ir
  for (const cfg of [CFGS[0], CFGS[4], CFGS[6], CFGS[10]]) {
    await applyCfg(page, init, cfg)
    for (const tok of ['L-inline', 'Code.cs:53-58', 'L-ref'] as const) {
      await page.evaluate(
        ([p, text]) => {
          const n = (window as any).__ul.find(p, text, null)
          n.parentElement.scrollIntoView({ block: 'center' })
          const root = document.querySelector(p)!
          const r = document.createRange()
          r.setStart(n, Math.min(2, n.data.length))
          r.collapse(true)
          const s = getSelection()!
          s.removeAllRanges()
          s.addRange(r)
          document.dispatchEvent(new Event('selectionchange'))
          root.dispatchEvent(
            new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }),
          )
        },
        [pane, tok],
      )
      await page.waitForTimeout(300)
      const info = await page.evaluate(
        ([p]) => {
          const root = document.querySelector(p)!
          const a = root.querySelector(
            'span[data-type=a].vditor-ir__node--expand, span[data-type=link-ref].vditor-ir__node--expand',
          ) as HTMLElement | null
          if (!a) return null
          const cs = getComputedStyle(a)
          const bracket = a.querySelector(
            '.vditor-ir__marker--bracket',
          ) as HTMLElement
          const bcs = getComputedStyle(bracket)
          const link = a.querySelector('.vditor-ir__link') as HTMLElement | null
          const lcs = link && getComputedStyle(link)
          const outlined = [a, ...a.querySelectorAll('*')].some((e) =>
            e.classList.contains('vmde-caret-inside'),
          )
          return {
            nodeLine: cs.textDecorationLine,
            bracketLine: bcs.textDecorationLine,
            bracketColor: bcs.color,
            linkLine: lcs?.textDecorationLine ?? null,
            outlined,
          }
        },
        [pane],
      )
      const where = `${cfg[0]} ${tok}`
      expect(info, `${where} expanded`).not.toBeNull()
      expect(info!.nodeLine, `${where} node`).toBe('none')
      expect(info!.bracketLine, `${where} bracket`).toBe('underline')
      expect(info!.bracketColor, `${where} bracket color`).toBe(
        BRACKET_COLOR[cfg[0]],
      )
      // Focus state (a): the caret outline sits on the link text and is kept; the revealed
      // node itself is not underlined (requirement 4).
      if (tok === 'L-inline')
        expect(info!.outlined, `${where} caret outline`).toBe(true)
      if (info!.linkLine !== null)
        expect(info!.linkLine, `${where} link text`).toBe('none')
    }
  }
})

// Focus state (c): a wiki chip with the caret inside (expanded `[[ ]]`) keeps its underline and
// the caret outline.
test('wiki chip with the caret inside keeps its underline', async ({
  page,
}) => {
  const { init } = await openMode(page, 'ir')
  await applyCfg(page, init, CFGS[0])
  await page.evaluate(
    ([p]) => {
      const n = (window as any).__ul.find(p, 'L-wiki', null)
      const root = document.querySelector(p)!
      const r = document.createRange()
      r.setStart(n, 2)
      r.collapse(true)
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(r)
      document.dispatchEvent(new Event('selectionchange'))
      root.dispatchEvent(
        new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }),
      )
    },
    [PANE.ir],
  )
  await page.waitForTimeout(300)
  const chip = await page.evaluate(() => {
    const c = document.querySelector('.wiki-link-chip') as HTMLElement
    const cs = getComputedStyle(c)
    return {
      line: cs.textDecorationLine,
      offset: cs.textUnderlineOffset,
      outlined: c.classList.contains('vmde-caret-inside'),
      outline: cs.outlineStyle,
    }
  })
  expect(chip.line).toBe('underline')
  expect(chip.offset).toBe('2px')
  expect(chip.outlined).toBe(true)
  expect(chip.outline).toBe('solid')
})

// Focus state (b): a code reference inside a link with :focus-visible keeps its focus outline and
// adds no second line of its own; the link underline stays.
test('code reference inside a link with focus-visible keeps its outline and draws no second line', async ({
  page,
}) => {
  const { init } = await openMode(page, 'preview')
  await applyCfg(page, init, CFGS[4])
  const r = await page.evaluate(async (pane) => {
    const n = (window as any).__ul.find(
      pane,
      'src/foo.ts:44',
      'code.vmde-code-ref',
    )
    const code = n.parentElement as HTMLElement
    code.setAttribute('tabindex', '0')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    )
    code.focus()
    await new Promise((res) => requestAnimationFrame(() => res(null)))
    const cs = getComputedStyle(code)
    return {
      focusVisible: code.matches(':focus-visible'),
      ownLine: cs.textDecorationLine,
      outlineStyle: cs.outlineStyle,
      effective: (window as any).__ul.measure(
        pane,
        'src/foo.ts:44',
        'code.vmde-code-ref',
      ),
    }
  }, PANE.preview)
  expect(r.focusVisible).toBe(true)
  expect(r.ownLine).toBe('none')
  expect(r.outlineStyle).toBe('solid')
  expect(r.effective).toMatchObject(LOOK)
})

// ---------------------------------------------------------------------------------------------
// Task 662: forced colours and visited links.
//
// Under forced colours Chromium reports the author's `text-decoration-color` in computed style
// (not the colour it paints), so the underline COLOUR is read from painted pixels here; the line,
// style, thickness and offset are still asserted on computed style. A visited link cannot be
// produced by a click in the webview (VS Code and `link-click-fix` cancel every anchor click), so
// the visited case forces `:visited` through the DevTools protocol and reads pixels as well.
// ---------------------------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

const parseRgb = (s: string): Rgb => {
  const m = s.match(/\d+(\.\d+)?/g)
  if (!m || m.length < 3) throw new Error(`not a colour: ${s}`)
  return [Number(m[0]), Number(m[1]), Number(m[2])]
}
const rgbKey = (c: Rgb): string => c.join(',')

function luminance([r, g, b]: Rgb): number {
  const f = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a: Rgb, b: Rgb): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

// Resolved system colours (probe elements), so the assertions hold for any palette.
async function systemColors(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {}
    for (const k of [
      'LinkText',
      'VisitedText',
      'ActiveText',
      'CanvasText',
      'Canvas',
    ]) {
      const e = document.createElement('span')
      e.style.color = k
      document.body.appendChild(e)
      out[k] = getComputedStyle(e).color
      e.remove()
    }
    return out
  })
}

interface PaintedRow {
  y: number
  color: string
  share: number
}

// Scrolls the target into view, screenshots a clip around its text and returns every pixel row
// whose dominant colour differs from the clip's background (its most common colour) over at least
// 70% of the text width (an underline; glyph rows never span that much, and skip-ink gaps at
// descenders stay below it).
async function paintedRows(
  page: Page,
  pane: string,
  t: Target,
): Promise<PaintedRow[]> {
  const box = await page.evaluate(
    ([p, tok, scope]) => {
      const n = (window as any).__ul.find(p, tok, scope)
      n.parentElement.scrollIntoView({ block: 'center' })
      const r = document.createRange()
      r.selectNodeContents(n)
      const b = r.getClientRects()[0]
      return { x: b.x, y: b.y, w: b.width, h: b.height }
    },
    [pane, t[1], t[2] ?? null] as const,
  )
  await page.mouse.move(2, 2)
  const png = await page.screenshot({
    clip: {
      x: Math.floor(box.x),
      y: Math.floor(box.y),
      width: Math.max(1, Math.floor(box.w)),
      height: Math.ceil(box.h) + 6,
    },
  })
  return page.evaluate(async (b64) => {
    const im = new Image()
    im.src = `data:image/png;base64,${b64}`
    await im.decode()
    const c = document.createElement('canvas')
    c.width = im.width
    c.height = im.height
    const ctx = c.getContext('2d')!
    ctx.drawImage(im, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const key = (x: number, y: number): string => {
      const i = (y * c.width + x) * 4
      return `${d[i]},${d[i + 1]},${d[i + 2]}`
    }
    const modal = (m: Map<string, number>): [string, number] =>
      [...m.entries()].sort((p, q) => q[1] - p[1])[0]
    const tally = (y0: number, y1: number, skip: string | null) => {
      const m = new Map<string, number>()
      for (let y = y0; y < y1; y++)
        for (let x = 0; x < c.width; x++) {
          const k = key(x, y)
          if (k !== skip) m.set(k, (m.get(k) ?? 0) + 1)
        }
      return m
    }
    const bg = modal(tally(0, c.height, null))[0]
    const rows: { y: number; color: string; share: number }[] = []
    for (let y = 0; y < c.height; y++) {
      const m = tally(y, y + 1, bg)
      const off = [...m.values()].reduce((p, q) => p + q, 0)
      if (off / c.width >= 0.7)
        rows.push({ y, color: modal(m)[0], share: off / c.width })
    }
    return rows
  }, png.toString('base64'))
}

type ForcedCfg = readonly [...Cfg, scheme: 'light' | 'dark']
const FORCED_CFGS: readonly ForcedCfg[] = [
  ['auto/light', 'auto', 'light', 'light'],
  ['auto/dark', 'auto', 'dark', 'dark'],
  ['github-light', 'github-light', 'light', 'light'],
  ['material-dark', 'material-dark', 'dark', 'dark'],
]

// Acceptance 3 and 4 (forced colours, Preview and IR): the one underline stays in a legible
// colour for every link kind, at rest and on hover.
for (const mode of ['ir', 'preview'] as const) {
  test(`forced colors: every link kind keeps the one underline in a legible colour (${mode})`, async ({
    page,
  }) => {
    test.setTimeout(240_000)
    await page.emulateMedia({ forcedColors: 'active' })
    const { init } = await openMode(page, mode)
    const pane = PANE[mode]
    const valueBefore = await getValue(page)
    const links = mode === 'preview' ? [...LINKS, HTML_LINK] : LINKS
    for (const cfg of FORCED_CFGS) {
      await page.emulateMedia({ forcedColors: 'active', colorScheme: cfg[3] })
      await applyCfg(page, init, [cfg[0], cfg[1], cfg[2]])
      await page.mouse.move(2, 2)
      const sys = await systemColors(page)
      const canvas = parseRgb(sys.Canvas)
      // Calibration: the emulation really replaces author colours (the link text is a system
      // colour), otherwise every assertion below would pass vacuously.
      expect(
        await page.evaluate(
          () => matchMedia('(forced-colors: active)').matches,
        ),
        `${mode} ${cfg[0]} forced colors active`,
      ).toBe(true)
      const inline = await measure(page, pane, ['inline', 'L-inline'])
      expect(
        [sys.LinkText, sys.VisitedText, sys.CanvasText, sys.ActiveText],
        `${mode} ${cfg[0]} link text is a system colour`,
      ).toContain(inline.textColor)
      const plainRows = await paintedRows(page, pane, ['inline', 'L-inline'])
      expect(
        plainRows.length,
        `${mode} ${cfg[0]} inline painted line`,
      ).toBeGreaterThan(0)
      const plainLine = plainRows[plainRows.length - 1].color
      for (const t of links) {
        const where = `${mode} ${cfg[0]} ${t[0]}`
        const rest = await measure(page, pane, t)
        expect(rest.missing, `${where} found`).toBeUndefined()
        expect(
          {
            line: rest.line,
            style: rest.style,
            thick: rest.thick,
            offset: rest.offset,
          },
          `${where} rest`,
        ).toEqual(LOOK)
        // Painted colour: the link text colour; text inside inline code has its own text colour,
        // so it must match the plain link's painted line instead (as in the 647 case).
        const codeText =
          t[0] === 'code-in-link' ||
          t[0] === 'mixed-code' ||
          t[0] === 'coderef-in-link-code'
        const expected = codeText ? plainLine : rgbKey(parseRgb(rest.textColor))
        const rows = await paintedRows(page, pane, t)
        expect(rows.length, `${where} painted underline`).toBeGreaterThan(0)
        expect(
          rows.map((r) => r.color),
          `${where} painted underline colour`,
        ).toContain(expected)
        const lineColor = parseRgb(expected)
        expect(
          contrast(lineColor, canvas),
          `${where} underline contrast against Canvas`,
        ).toBeGreaterThanOrEqual(3)
        if (t[0] === 'inline' || t[0] === 'code-in-link') {
          const hover = await hoverMeasure(page, pane, t)
          expect(
            {
              line: hover.line,
              style: hover.style,
              thick: hover.thick,
              offset: hover.offset,
            },
            `${where} hover`,
          ).toEqual(LOOK)
          await page.mouse.move(2, 2)
        }
      }
      for (const t of CONTROLS.filter(
        (c) => c[0] === 'N-code' || c[0] === 'N-em',
      )) {
        const rest = await measure(page, pane, t)
        expect(rest.line, `${mode} ${cfg[0]} ${t[0]} stays plain`).toBe('none')
      }
    }
    // CSS only: the document text is untouched and no edit was posted.
    expect(await getValue(page)).toBe(valueBefore)
    const edits = await page.evaluate(
      () =>
        (window as any).__posted.filter((m: any) => m?.command === 'edit')
          .length,
    )
    expect(edits).toBe(0)
  })
}

// Acceptance 1: a visited link in Preview keeps its underline, painted in the visited text colour.
// `:visited` is forced through the DevTools protocol; the page-local rule gives the visited state
// a text colour that can be told apart from the unvisited one (only colour is honoured there).
test('visited links keep the underline (preview)', async ({ page }) => {
  const { init } = await openMode(page, 'preview')
  await applyCfg(page, init, CFGS[0])
  const pane = PANE.preview
  await page.addStyleTag({
    content: '.vditor-preview a:visited { color: rgb(255, 0, 0) !important; }',
  })
  const target: Target = ['inline', 'L-inline']
  const unvisited = await paintedRows(page, pane, target)
  expect(unvisited.length, 'unvisited painted underline').toBeGreaterThan(0)
  expect(unvisited.map((r) => r.color)).not.toContain('255,0,0')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', {
    nodeId: root.nodeId,
    selector: '.vditor-preview a[href="https://example.com/inline"]',
  })
  expect(nodeIds.length, 'the L-inline anchor').toBe(1)
  await cdp.send('CSS.forcePseudoState', {
    nodeId: nodeIds[0],
    forcedPseudoClasses: ['visited'],
  })
  const rest = await measure(page, pane, target)
  // Chromium reports the unvisited value for a visited link; kept as a sanity check only.
  expect(rest).toMatchObject(LOOK)
  const visited = await paintedRows(page, pane, target)
  expect(visited.length, 'visited painted underline').toBeGreaterThan(0)
  expect(
    visited.map((r) => r.color),
    'visited underline is painted in the visited text colour',
  ).toContain('255,0,0')
})

// Acceptance 2: a rendered IR link is a span, never an anchor, so `:visited` cannot apply to it.
// The only real anchor in IR is inside a rendered HTML block; its look is recorded, not asserted.
test('visited cannot apply to an IR link (rendered links are spans)', async ({
  page,
}) => {
  await openMode(page, 'ir')
  const info = await page.evaluate(
    ([pane, targets]) => {
      const root = document.querySelector(pane)!
      return (targets as [string, string, string | null][]).map(
        ([name, tok, scope]) => {
          const n = (window as any).__ul.find(pane, tok, scope)
          const el = n?.parentElement as HTMLElement | undefined
          const anchor = el?.closest('a[href]') ?? null
          return {
            name,
            found: !!el,
            inAnchor: !!anchor && root.contains(anchor),
            visitedMatch:
              !!el &&
              [el, ...el.querySelectorAll('*')].some((e) =>
                e.matches(':visited'),
              ),
          }
        },
      )
    },
    [PANE.ir, LINKS.map((l) => [l[0], l[1], l[2] ?? null])] as const,
  )
  for (const i of info) {
    expect(i.found, `${i.name} found`).toBe(true)
    expect(i.inAnchor, `${i.name} is not inside an anchor`).toBe(false)
    expect(i.visitedMatch, `${i.name} never matches :visited`).toBe(false)
  }
  // The fixture's inline `<a href>` is shown as source in IR, so the pane holds no anchor at all;
  // an anchor appearing there later would need its own visited evidence (Task 647 coverage).
  const anchors = await page.evaluate(
    (pane) => document.querySelectorAll(`${pane} a[href]`).length,
    PANE.ir,
  )
  test.info().annotations.push({
    type: 'ir-anchors',
    description: `${anchors} a[href] in the IR pane`,
  })
  expect(anchors, 'no anchor in the IR pane').toBe(0)
})
