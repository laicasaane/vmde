import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { docText, reopenVmdeFixture, settle, type wf } from './webview-helpers'

// Task 647 — every link is underlined at rest (`underline solid auto 2px`) in IR (rendered state)
// and Preview, in the real VS Code webview. Chromium (media-src/e2e/link-underline.spec.ts) proves
// the rules; this proves what only the real webview has: VS Code's injected link rules, the
// `--vmde-link` value in `auto`, `a:focus-visible`, and that the CSS-only change leaves the
// document, caret, dirty state and Undo history alone. Computed style only, exact strings.

const DOC = [
  '# Title',
  '',
  '## Section Two',
  '',
  'Inline: [L-inline](https://example.com/inline) end.',
  '',
  'Code link: [`Code.cs:53-58`](../Module/Code.cs#L1-L5) end.',
  '',
  'Mixed: [L-mixed `x` tail](https://example.com/mixed) end.',
  '',
  'Ref: [L-ref][r1] end.',
  '',
  'Autolink: <https://example.com/L-auto> end.',
  '',
  'HTML: <a href="https://example.com/html">L-html</a> end.',
  '',
  'Anchor: [L-anchor](#section-two) end.',
  '',
  'File: [L-file](src/foo.ts:42) end.',
  '',
  'CodeRef in link: [`src/foo.ts:44`](https://example.com/refinlink) end.',
  '',
  '> quote [L-quote](https://example.com/quote)',
  '',
  'Controls: `N-code` and *N-em* and <a id="N-id">N-idtext</a> and `src/foo.ts:42` end.',
  '',
  '[r1]: https://example.com/ref',
  '',
].join('\n')

type Target = readonly [name: string, text: string, scope?: string]
const LINKS: readonly Target[] = [
  ['inline', 'L-inline'],
  ['code-in-link', 'Code.cs:53-58', 'code'],
  ['mixed-code', 'x', 'span[data-type=a] code, a code'],
  ['mixed-text', 'L-mixed'],
  ['ref', 'L-ref'],
  ['autolink', 'https://example.com/L-auto'],
  ['anchor', 'L-anchor'],
  ['file-line', 'L-file'],
  ['coderef-in-link', 'src/foo.ts:44', 'code'],
  ['quote-link', 'L-quote'],
]
const CODE_TEXT = new Set(['code-in-link', 'mixed-code', 'coderef-in-link'])
const CONTROLS: readonly Target[] = [
  ['N-code', 'N-code'],
  ['N-em', 'N-em'],
  ['N-id', 'N-idtext'],
]
const LOOK = {
  line: 'underline',
  style: 'solid',
  thick: 'auto',
  offset: '2px',
} as const

interface Decor {
  found: boolean
  line: string
  style: string
  thick: string
  offset: string
  color: string
  textColor: string
}

function makeDoc(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vmde-647-'))
  mkdirSync(path.join(dir, 'src'))
  writeFileSync(path.join(dir, 'src', 'foo.ts'), 'export {}\n')
  const file = path.join(dir, 'doc.md')
  writeFileSync(file, DOC)
  return file
}

async function setContentTheme(
  evaluateInVSCode: Parameters<typeof docText>[0],
  theme: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), a: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'theme.content',
          a[0] || undefined,
          vscode.ConfigurationTarget.Global,
        )
    },
    [theme] as [string],
  )
}

/** Computed decoration of the text node `text` (inside `scope` if given): the first ancestor, up
 *  to a box boundary, that carries an underline, as the browser paints it. */
function measureIn(
  frame: ReturnType<typeof wf>,
  pane: string,
  t: Target,
  hover = false,
): Promise<Decor> {
  return frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one self-contained page-side script (find the text node, then walk to the decorating ancestor)
    (_b, a) => {
      const [paneSel, tok, scope, doHover] = a as [
        string,
        string,
        string | null,
        boolean,
      ]
      const root = document.querySelector(paneSel)
      const norm = (s: string) => s.replace(/[​\s]+/g, ' ').trim()
      let node: Text | null = null
      const scopes =
        scope && root ? [...root.querySelectorAll(scope)] : root ? [root] : []
      outer: for (const sc of scopes) {
        const w = document.createTreeWalker(sc, NodeFilter.SHOW_TEXT)
        for (let n: Node | null = w.nextNode(); n; n = w.nextNode()) {
          const tn = n as Text
          if (
            norm(tn.data) !== tok &&
            !(tok.startsWith('~') && norm(tn.data).includes(tok.slice(1)))
          )
            continue
          if (tn.parentElement?.closest('.vditor-ir__marker')) continue
          const r = document.createRange()
          r.selectNodeContents(tn)
          const rect = r.getClientRects()[0]
          if (!rect || rect.width === 0) continue
          node = tn
          break outer
        }
      }
      const none = {
        found: false,
        line: '',
        style: '',
        thick: '',
        offset: '',
        color: '',
        textColor: '',
      }
      if (!node || !root) return none
      const own = getComputedStyle(node.parentElement as Element)
      const boundary = (cs: CSSStyleDeclaration) =>
        /inline-block|inline-flex|inline-grid|flex|grid|table/.test(
          cs.display,
        ) ||
        cs.cssFloat !== 'none' ||
        cs.position === 'absolute' ||
        cs.position === 'fixed'
      let el: Element | null = node.parentElement
      let hit: CSSStyleDeclaration = own
      let line = 'none'
      while (el && el !== root.parentElement) {
        const cs = getComputedStyle(el)
        if (cs.textDecorationLine.includes('underline')) {
          hit = cs
          line = cs.textDecorationLine
          break
        }
        if (boundary(cs)) break
        el = el.parentElement
      }
      void doHover
      return {
        found: true,
        line,
        style: hit.textDecorationStyle,
        thick: hit.textDecorationThickness,
        offset: hit.textUnderlineOffset,
        color: hit.textDecorationColor,
        textColor: own.color,
      }
    },
    [pane, t[1], t[2] ?? null, hover] as const,
  ) as Promise<Decor>
}

async function hoverText(
  frame: ReturnType<typeof wf>,
  pane: string,
  t: Target,
): Promise<void> {
  const scope = t[2] ?? ''
  void scope
  const pt = await frame.locator('body').evaluate(
    (_b, a) => {
      const [paneSel, tok] = a as [string, string]
      const root = document.querySelector(paneSel) as Element
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n: Node | null = w.nextNode(); n; n = w.nextNode()) {
        const tn = n as Text
        if (tn.data.replace(/[​\s]+/g, ' ').trim() !== tok) continue
        if (tn.parentElement?.closest('.vditor-ir__marker')) continue
        tn.parentElement?.scrollIntoView({ block: 'center' })
        const r = document.createRange()
        r.selectNodeContents(tn)
        const b = r.getClientRects()[0]
        if (b?.width) return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
      }
      return null
    },
    [pane, t[1]] as const,
  )
  expect(pt, `${t[0]} hover point`).not.toBeNull()
  await frame
    .locator('body')
    .hover({ position: pt as { x: number; y: number } })
}

async function expectAllUnderlined(
  frame: ReturnType<typeof wf>,
  pane: string,
  links: readonly Target[],
  label: string,
) {
  const plain = await measureIn(frame, pane, ['inline', 'L-inline'])
  for (const t of links) {
    const d = await measureIn(frame, pane, t)
    const where = `${label} ${t[0]}`
    expect(d.found, `${where} found`).toBe(true)
    expect(
      { line: d.line, style: d.style, thick: d.thick, offset: d.offset },
      `${where} rest`,
    ).toEqual(LOOK)
    expect(d.color, `${where} color`).toBe(
      CODE_TEXT.has(t[0]) ? plain.color : d.textColor,
    )
  }
}

async function expectControlsPlain(
  frame: ReturnType<typeof wf>,
  pane: string,
  label: string,
) {
  for (const t of CONTROLS) {
    const d = await measureIn(frame, pane, t)
    expect(d.found, `${label} ${t[0]} found`).toBe(true)
    expect(d.line, `${label} ${t[0]} rest`).toBe('none')
  }
}

test('IR rendered: every link kind and the code link text are underlined, controls are not', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const file = makeDoc()
  await setContentTheme(evaluateInVSCode, 'auto')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await settle(frame, 2500)
  const pane = '.vditor-ir > .vditor-reset'
  await expectAllUnderlined(frame, pane, LINKS, 'IR auto')
  await expectControlsPlain(frame, pane, 'IR auto')
  // `--vmde-link` in `auto` resolves to a color (the IR node line mirrors `.vditor-ir__link`).
  const vmdeLink = await frame.locator('body').evaluate(() =>
    getComputedStyle(
      document.querySelector('.vditor-ir > .vditor-reset') as Element,
    )
      .getPropertyValue('--vmde-link')
      .trim(),
  )
  test
    .info()
    .annotations.push({ type: 'vmde-link(auto)', description: vmdeLink })
  // Hover keeps the one look and the code reference inside a link adds no line of its own.
  await hoverText(frame, pane, LINKS[1])
  const hovered = await measureIn(frame, pane, LINKS[1], true)
  expect({ line: hovered.line, offset: hovered.offset }).toEqual({
    line: 'underline',
    offset: '2px',
  })
  await hoverText(frame, pane, LINKS[8])
  const own = await frame.locator('body').evaluate((_b, p) => {
    const w = document.createTreeWalker(
      document.querySelector(p as string) as Element,
      NodeFilter.SHOW_TEXT,
    )
    for (let n: Node | null = w.nextNode(); n; n = w.nextNode())
      if ((n as Text).data === 'src/foo.ts:44')
        return getComputedStyle((n as Text).parentElement as Element)
          .textDecorationLine
    return 'missing'
  }, pane)
  expect(own).toBe('none')
  expect(await docText(evaluateInVSCode, file)).toBe(DOC)
})

test('IR caret inside a link: revealed source look is kept; caret, dirty state and Undo history are unchanged', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const file = makeDoc()
  await setContentTheme(evaluateInVSCode, 'auto')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await settle(frame, 2500)
  const pane = '.vditor-ir > .vditor-reset'
  const place = () =>
    frame.locator('body').evaluate((_b, p) => {
      const root = document.querySelector(p as string) as Element
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n: Node | null = w.nextNode(); n; n = w.nextNode()) {
        const tn = n as Text
        if (tn.data !== 'L-inline') continue
        const r = document.createRange()
        r.setStart(tn, 2)
        r.collapse(true)
        const s = getSelection() as Selection
        s.removeAllRanges()
        s.addRange(r)
        document.dispatchEvent(new Event('selectionchange'))
        return true
      }
      return false
    }, pane)
  expect(await place()).toBe(true)
  await settle(frame, 400)
  const snapshot = () =>
    frame.locator('body').evaluate((_b, p) => {
      const root = document.querySelector(p as string) as Element
      const a = root.querySelector(
        'span[data-type=a].vditor-ir__node--expand',
      ) as HTMLElement | null
      const sel = getSelection() as Selection
      const v = (window as any).vditor?.vditor
      return {
        expanded: !!a,
        nodeLine: a ? getComputedStyle(a).textDecorationLine : null,
        bracketLine: a
          ? getComputedStyle(
              a.querySelector('.vditor-ir__marker--bracket') as Element,
            ).textDecorationLine
          : null,
        linkLine: a
          ? getComputedStyle(a.querySelector('.vditor-ir__link') as Element)
              .textDecorationLine
          : null,
        outlined: !!root.querySelector('.vmde-caret-inside'),
        caret: {
          text: sel.anchorNode?.textContent ?? null,
          offset: sel.anchorOffset,
        },
        undo: v?.undo?.[v.currentMode]?.undoStack?.length ?? -1,
        value: (window as any).vditor.getValue() as string,
      }
    }, pane)
  const before = await snapshot()
  expect(before).toMatchObject({
    expanded: true,
    nodeLine: 'none',
    bracketLine: 'underline',
    linkLine: 'none',
    outlined: true,
  })
  // Hover another (rendered) link: CSS only, so selection, text and Undo stack must not move.
  await hoverText(frame, pane, LINKS[6])
  await settle(frame, 300)
  const after = await snapshot()
  expect({ caret: after.caret, undo: after.undo, value: after.value }).toEqual({
    caret: before.caret,
    undo: before.undo,
    value: before.value,
  })
  const dirty = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), a: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === a[0])
        ?.isDirty ?? null,
    [file] as [string],
  )
  expect(dirty).toBe(false)
  expect(await docText(evaluateInVSCode, file)).toBe(DOC)
})

test('Preview: every link kind is underlined in github-light and auto; hover and focus keep one line', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  const file = makeDoc()
  const pane = '.vditor-preview > .vditor-reset'
  const preview = [...LINKS, ['html-a-href', 'L-html'] as Target]
  for (const theme of ['github-light', 'auto']) {
    await setContentTheme(evaluateInVSCode, theme)
    // Preview is remembered across opens (task 651), so the second open may already be in Preview:
    // wait for the page, then toggle only when it is off.
    const frame = await reopenVmdeFixture(
      evaluateInVSCode,
      workbox,
      file,
      60_000,
      '.vditor-toolbar',
      false,
    )
    await settle(frame, 2500)
    const previewButton = frame
      .locator('.vditor-toolbar [data-type="preview"]')
      .first()
    const previewOn = () =>
      previewButton.evaluate((el) =>
        el.classList.contains('vditor-menu--current'),
      )
    if (!(await previewOn())) await previewButton.click()
    await expect.poll(previewOn, { timeout: 30_000 }).toBe(true)
    await frame.locator('.vditor-preview').first().waitFor({ timeout: 30_000 })
    await expect
      .poll(
        () =>
          measureIn(frame, pane, ['inline', 'L-inline']).then((d) => d.found),
        { timeout: 30_000 },
      )
      .toBe(true)
    await settle(frame, 1500)
    await expectAllUnderlined(frame, pane, preview, `Preview ${theme}`)
    await expectControlsPlain(frame, pane, `Preview ${theme}`)
    // Hover keeps the look; a code reference inside a link draws no line of its own.
    await hoverText(frame, pane, LINKS[8])
    const h = await measureIn(frame, pane, LINKS[8], true)
    expect({ line: h.line, offset: h.offset }).toEqual({
      line: 'underline',
      offset: '2px',
    })
    // a:focus-visible: VS Code's injected focus outline shows and the underline stays.
    const focus = await frame.locator('body').evaluate((_b, p) => {
      const a = document.querySelector(
        `${p as string} a[href="https://example.com/inline"]`,
      ) as HTMLElement
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      )
      a.focus()
      const cs = getComputedStyle(a)
      return {
        focusVisible: a.matches(':focus-visible'),
        outlineStyle: cs.outlineStyle,
        line: cs.textDecorationLine,
        offset: cs.textUnderlineOffset,
      }
    }, pane)
    expect(focus, `${theme} focus`).toMatchObject({
      focusVisible: true,
      line: 'underline',
      offset: '2px',
    })
    expect(focus.outlineStyle, `${theme} focus outline`).not.toBe('none')
    expect(await docText(evaluateInVSCode, file)).toBe(DOC)
    await previewButton.click()
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      },
      [file] as [string],
    )
  }
  await setContentTheme(evaluateInVSCode, '')
  expect(readFileSync(file, 'utf8')).toBe(DOC)
})
