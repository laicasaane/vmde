/**
 * Task 733 (task 002) — computed styles of the states that used to be read through `:has()`.
 *
 * Eight document-wide `:has()` partner rules were replaced by sibling selectors or by state that the
 * owning module writes (class `vmde-emoji-open`, attribute `data-vmde-source-pane`, `aria-expanded`,
 * class `vmde-toolbar-item--collapse`). The declarations did not change, so each test case reads
 * `getComputedStyle` in the real webview and compares it with the declarations of the replaced rule:
 *   - emoji picker open (toolbar `z-index` 101, `position` relative) and closed, also closed by
 *     opening another toolbar menu;
 *   - Preview only, Split and editor only (`.vditor-preview` `overflow` and `max-width`, the inner
 *     reset `overflow`);
 *   - a toolbar submenu open (button background equals the hover background) and closed, and the
 *     collapse toggle (no highlight);
 *   - the collapse toggle item (`margin-inline-start` auto, `align-self`, `padding-inline-start`);
 *   - a WYSIWYG code block with the source shown (preview `display` none) and hidden, and a diagram;
 *   - an IR plain code preview (`display` block, `overflow-x` auto, 1em padding) against a diagram
 *     preview (rule not applied).
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PREVIEW_BUTTON,
  setConfig,
} from './preview-mode-helpers'
import { reopenVmdeFixture, settle, type wf } from './webview-helpers'

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'

const FIXTURE = `# State rules

A paragraph before the blocks.

\`\`\`ts
const answer = 42
\`\`\`

\`\`\`mermaid
graph TD; A-->B;
\`\`\`

\`\`\`nomnoml
[a]->[b]
\`\`\`

A paragraph after the blocks.
`

async function open(
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  workbox: Parameters<typeof reopenVmdeFixture>[1],
  baseDir: string,
  name: string,
  defaultMode: Mode,
): Promise<Frame> {
  // The document opens in the mode a test needs; a toolbar mode click is persisted as the user's
  // default, so afterEach resets the setting (see preview-overflow.spec.ts).
  await setConfig(evaluateInVSCode, 'editor.defaultMode', defaultMode)
  const file = path.join(baseDir, name)
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await expect(frame.locator('.vditor-toolbar')).toBeVisible({
    timeout: 60_000,
  })
  return frame
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
})

const currentMode = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { vditor: { vditor: { currentMode: string } } })
          .vditor.vditor.currentMode,
    )

// Mode-switch click: the panel path the user takes (see preview-overflow.spec.ts).
async function switchMode(frame: Frame, mode: Mode) {
  if ((await currentMode(frame)) === mode) return
  await frame.locator('body').evaluate((_body, wanted) => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor
    v.vditor.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector(`button[data-mode="${wanted}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await expect.poll(() => currentMode(frame)).toBe(mode)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 30_000 })
}

const style = (frame: Frame, selector: string, props: string[]) =>
  frame
    .locator(selector)
    .first()
    .evaluate((el, names) => {
      const cs = getComputedStyle(el)
      return Object.fromEntries(
        names.map((name) => [name, cs.getPropertyValue(name)]),
      )
    }, props)

/** Turn full Preview off when it is on (the pane spans the viewport; Split's side pane does not). */
async function leavePreview(frame: Frame) {
  const full = await frame.locator('body').evaluate(() => {
    const p = document.querySelector<HTMLElement>('.vditor-preview')
    return (
      !!p &&
      getComputedStyle(p).display !== 'none' &&
      p.getBoundingClientRect().width >
        document.documentElement.clientWidth * 0.8
    )
  })
  if (full) await frame.locator(PREVIEW_BUTTON).click()
}

const toolbarOf = (frame: Frame) => frame.locator('.vditor-toolbar')
const PARK = { x: 400, y: 400 }

test('emoji picker raises the toolbar while open and not after Escape or another menu opens', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-emoji.md',
    'ir',
  )
  const toolbar = toolbarOf(frame)
  const z = () => style(frame, '.vditor-toolbar', ['z-index', 'position'])
  expect((await z())['z-index']).not.toBe('101')
  await expect(toolbar).not.toHaveClass(/vmde-emoji-open/)

  await toolbar.locator('[data-type="emoji"]').click()
  await expect(toolbar).toHaveClass(/vmde-emoji-open/)
  expect(await z()).toEqual({ 'z-index': '101', position: 'relative' })

  await workbox.keyboard.press('Escape')
  await expect(toolbar).not.toHaveClass(/vmde-emoji-open/)
  expect((await z())['z-index']).not.toBe('101')

  // Closed by another toolbar menu: Vditor's hidePanel writes display none on the picker panel.
  await toolbar.locator('[data-type="emoji"]').click()
  await expect(toolbar).toHaveClass(/vmde-emoji-open/)
  await toolbar.locator('[data-type="headings"]').click()
  await expect(toolbar).not.toHaveClass(/vmde-emoji-open/)
  expect((await z())['z-index']).not.toBe('101')
  // The Headings menu opened above stays open otherwise.
  await workbox.keyboard.press('Escape')
})

test('Preview only, Split and editor only apply the preview pane rules by the source-pane state', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-pane.md',
    'ir',
  )
  const content = frame.locator('.vditor-content').first()
  const pane = () =>
    style(frame, '.vditor-preview', ['overflow-x', 'overflow-y', 'max-width'])
  const reset = () =>
    style(frame, '.vditor-preview .vditor-reset', [
      'overflow-y',
      'height',
      'margin-left',
    ])

  try {
    // Editor only (IR): the source pane is hidden, the attribute is set and the preview pane is off.
    await switchMode(frame, 'ir')
    await expect(content).toHaveAttribute('data-vmde-source-pane', 'hidden')

    // Preview only.
    await frame.locator(PREVIEW_BUTTON).click()
    await expect(frame.locator('.vditor-preview')).toBeVisible()
    await expect(content).toHaveAttribute('data-vmde-source-pane', 'hidden')
    expect(await pane()).toMatchObject({
      'overflow-x': 'hidden',
      'overflow-y': 'hidden',
      'max-width': 'none',
    })
    expect((await reset())['overflow-y']).toBe('auto')
    const narrow = await frame
      .locator('body')
      .evaluate(() => document.body.getAttribute('data-full-width') === '0')
    if (narrow) expect((await reset())['margin-left']).toBe('0px')

    // Back to the editor, then Split: the source pane is shown, the rules do not apply.
    await frame.locator(PREVIEW_BUTTON).click()
    await switchMode(frame, 'sv')
    await expect(frame.locator('.vditor-sv')).toBeVisible()
    await expect(content).not.toHaveAttribute('data-vmde-source-pane', /.*/)
    await expect(frame.locator('.vditor-preview')).toBeVisible()
    expect((await pane())['overflow-y']).not.toBe('hidden')
  } finally {
    // Leave Preview off and the editor-only mode: Preview-left-on is remembered by the host.
    await leavePreview(frame)
  }
})

test('an open toolbar submenu highlights its trigger like a hover, a closed one and the collapse toggle do not', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-submenu.md',
    'ir',
  )
  const toolbar = toolbarOf(frame)
  const bg = (selector: string) =>
    style(frame, selector, ['background-color']).then(
      (v) => v['background-color'],
    )
  const headings = '.vditor-toolbar [data-type="headings"]'

  // The hover background is read from a hovered ordinary button.
  await toolbar.locator('[data-type="bold"]').hover()
  const hoverBg = await bg('.vditor-toolbar [data-type="bold"]')
  await workbox.mouse.move(PARK.x, PARK.y)
  const idleBg = await bg(headings)
  expect(idleBg).not.toBe(hoverBg)

  await toolbar.locator('[data-type="headings"]').click()
  await expect(toolbar.locator('[data-type="headings"]')).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  await workbox.mouse.move(PARK.x, PARK.y)
  expect(await bg(headings)).toBe(hoverBg)

  await workbox.keyboard.press('Escape')
  await frame.locator('body').click({ position: PARK })
  await expect(toolbar.locator('[data-type="headings"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  )
  expect(await bg(headings)).toBe(idleBg)

  // The collapse toggle has aria-expanded="true" but is no menu trigger: no highlight.
  const toggle = '.vditor-toolbar [data-type="collapse-toolbar"]'
  await expect(frame.locator(toggle)).toHaveAttribute('aria-expanded', 'true')
  await workbox.mouse.move(PARK.x, PARK.y)
  expect(await bg(toggle)).not.toBe(hoverBg)
})

test('the collapse toggle item keeps its auto margin, top alignment and gap, expanded and collapsed', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-collapse.md',
    'ir',
  )
  const toolbar = toolbarOf(frame)
  const item = '.vditor-toolbar .vmde-toolbar-item--collapse'
  const read = async () => {
    const gap = await frame
      .locator('.vditor-toolbar')
      .evaluate(
        (el) =>
          getComputedStyle(el).getPropertyValue('--vmde-toggle-gap').trim() ||
          '12px',
      )
    return {
      gap,
      ...(await style(frame, item, [
        'margin-inline-start',
        'align-self',
        'padding-inline-start',
      ])),
    }
  }
  await expect(frame.locator(item)).toHaveCount(1)
  try {
    for (const state of ['expanded', 'collapsed'] as const) {
      const got = await read()
      expect(got['margin-inline-start'], `${state} margin`).not.toBe('0px')
      expect(got['align-self'], `${state} align-self`).toBe('flex-start')
      expect(got['padding-inline-start'], `${state} gap`).toBe(got.gap)
      if (state === 'expanded') {
        await toolbar.locator('[data-type="collapse-toolbar"]').click()
        await expect(toolbar).toHaveClass(/vmde-toolbar--collapsed/)
      }
    }
  } finally {
    // The collapse state is one user-level value shared by every editor and later runs: leave it
    // expanded so any spec after this one starts as in a fresh instance.
    if (
      await toolbar.evaluate((el) =>
        el.classList.contains('vmde-toolbar--collapsed'),
      )
    ) {
      await toolbar.locator('[data-type="collapse-toolbar"]').click()
      await expect(toolbar).not.toHaveClass(/vmde-toolbar--collapsed/)
    }
  }
})

test('a WYSIWYG code block hides its preview while the source is shown, a diagram keeps it', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-wysiwyg.md',
    'wysiwyg',
  )
  const blocks = frame.locator('.vditor-wysiwyg .vditor-wysiwyg__block')
  await expect(blocks.first()).toBeVisible({ timeout: 30_000 })
  const code = blocks.filter({ has: frame.locator('code.language-ts') }).first()
  const previewDisplay = (block: typeof code) =>
    block
      .locator('pre.vditor-wysiwyg__preview')
      .first()
      .evaluate((el) => getComputedStyle(el).display)

  // Caret outside: preview shown.
  await expect.poll(() => previewDisplay(code)).toBe('block')
  // Caret inside: the source is shown and the preview of a code block is hidden.
  await code.locator('pre.vditor-wysiwyg__preview').first().click()
  await expect(code.locator('pre.vditor-wysiwyg__pre')).not.toHaveCSS(
    'display',
    'none',
  )
  expect(await previewDisplay(code)).toBe('none')

  // A diagram keeps its preview next to the source (the rule needs a direct code child).
  const mermaid = blocks
    .filter({ has: frame.locator('.language-mermaid') })
    .first()
  await mermaid.locator('pre.vditor-wysiwyg__preview').first().click()
  await expect(mermaid.locator('pre.vditor-wysiwyg__pre')).not.toHaveCSS(
    'display',
    'none',
  )
  expect(await previewDisplay(mermaid)).not.toBe('none')

  // Caret outside again: the code preview returns.
  await frame
    .locator('.vditor-wysiwyg p', { hasText: 'after the blocks' })
    .click()
  await expect.poll(() => previewDisplay(code)).toBe('block')
})

test('an IR plain code preview has the highlighted box before .hljs lands, a diagram preview has not', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const frame = await open(
    evaluateInVSCode,
    workbox,
    baseDir,
    'has-ir-code.md',
    'ir',
  )
  const plain = frame.locator('.vditor-ir__preview > code.language-ts').first()
  await expect(plain).toBeVisible({ timeout: 30_000 })
  // Read the box of a not-yet-highlighted preview `code` (no `.hljs`) from a probe placed outside the
  // editable surface: the rule needs only a `.vditor-reset` ancestor, and the probe cannot touch the
  // document, the highlighter or Vditor's mutation handling.
  const probe = await frame.locator('body').evaluate(() => {
    const wrap = document.createElement('div')
    wrap.className = 'vditor-reset'
    const pre = document.createElement('pre')
    pre.className = 'vditor-ir__preview'
    const code = document.createElement('code')
    code.className = 'language-ts'
    code.textContent = 'const x = 1'
    pre.append(code)
    wrap.append(pre)
    document.body.append(wrap)
    const cs = getComputedStyle(code)
    const out = {
      display: cs.display,
      overflowX: cs.overflowX,
      paddingTop: cs.paddingTop,
      fontSize: cs.fontSize,
    }
    wrap.remove()
    return out
  })
  expect(probe.display).toBe('block')
  expect(probe.overflowX).toBe('auto')
  expect(probe.paddingTop).toBe(probe.fontSize)

  // A diagram preview is not a plain code preview: after rendering its child is the figure holder
  // `.language-nomnoml` (a `div`, which `> code` never matches) or, before that, a `code` that
  // carries the class itself and is excluded by `:not(.language-nomnoml)`.
  const diagram = '.vditor-ir__preview > .language-nomnoml'
  await frame
    .locator(diagram)
    .first()
    .waitFor({ state: 'attached', timeout: 60_000 })
  await settle(frame, 500)
  const tag = await frame
    .locator(diagram)
    .first()
    .evaluate((el) => el.tagName)
  if (tag === 'CODE') {
    const padding = await frame
      .locator(diagram)
      .first()
      .evaluate((el) => getComputedStyle(el).paddingTop)
    expect(padding).toBe('0px')
  } else expect(tag).toBe('DIV')
})
