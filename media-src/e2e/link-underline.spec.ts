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
