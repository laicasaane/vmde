import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { settle, wf } from './webview-helpers'

// Task 655 — bare URLs are shown as links in IR, WYSIWYG, Preview and Split preview behind
// `vmde.markdown.autolinkBareUrls`, and the saved Markdown stays byte-identical. Real webview:
// VS Code's injected `a` colour, the content themes, the webview message pipe and the custom-editor
// save path exist only here, not in the Chromium harness.

const dir = path.join(tmpdir(), `vmde-bare-url-${process.pid}`)
mkdirSync(dir, { recursive: true })
const FIXTURE = path.join(__dirname, 'fixtures', 'bare-url-autolink.md')
// The fixture table is already in Lute's padded form: Lute re-pads an unpadded table on save with
// or without the decorator (existing drift, see the task record), which would hide this task's check.
const ORIGINAL = readFileSync(FIXTURE, 'utf8')
const LARGE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)

test.use({ baseDir: dir })

type Evaluate = (fn: unknown, args: [string]) => Promise<unknown>
type Frame = ReturnType<typeof wf>

const SETTING = 'markdown.autolinkBareUrls'

// Hosts that must never be decorated (code, links, autolinks, fences, raw inline HTML).
const PLAIN_HOSTS = [
  'link.example.com',
  'auto.example.com',
  'code.example.com',
  'fence.example.com',
]
// Hosts that must be decorated in the editing panes. Preview additionally links the raw <kbd> body,
// which IR and WYSIWYG skip (accepted difference, Task 655 residual risks).
const LINKED = [
  'https://example.com',
  'www.example.com/a_b_c',
  'user@example.com',
  'https://en.wikipedia.org/wiki/Foo_(bar)',
  'https://cjk.example.com',
  'https://quote.example.com/path?q=1&r=2#frag',
  'https://item.example.com',
  'www.item2.example.com',
  'https://cell.example.com',
  'www.cell2.example.com',
]

let bootCount = 0

function freshCopy(source: string, ext = 'md'): string {
  const target = path.join(dir, `case-${bootCount++}.${ext}`)
  copyFileSync(source, target)
  return target
}

async function openFile(
  evaluateInVSCode: Evaluate,
  workbox: import('@playwright/test').Page,
  file: string,
): Promise<Frame> {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // Retained: clicking the mode control right after boot is the lost-click family.
  await settle(frame, 2000)
  return frame
}

async function setMode(frame: Frame, mode: 'wysiwyg' | 'sv' | 'ir') {
  await frame.locator('body').evaluate((_el, target) => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector(`button[data-mode="${target}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await frame
    .locator(`.vditor-${mode}`)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
}

const togglePreview = (frame: Frame) =>
  frame.locator('.vditor-toolbar [data-type="preview"]').first().click()

async function setSetting(evaluateInVSCode: Evaluate, value: boolean | null) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          args[0],
          args[1] === 'unset' ? undefined : args[1] === 'true',
          vscode.ConfigurationTarget.Global,
        )
    },
    [SETTING, value === null ? 'unset' : String(value)] as unknown as [string],
  )
}

interface Decorated {
  text: string
  href: string | null
  tag: string
  line: string
}

// Every `.vmde-bare-url` under `scope`, with its element kind, href and computed underline.
function decorated(frame: Frame, scope: string): Promise<Decorated[]> {
  return frame.locator('body').evaluate((_el, sel) => {
    const root = document.querySelector(sel as string)
    return Array.from(root?.querySelectorAll('.vmde-bare-url') ?? []).map(
      (el) => ({
        text: el.textContent ?? '',
        href: el.getAttribute('data-bare-url-href') ?? el.getAttribute('href'),
        tag: el.tagName.toLowerCase(),
        line: getComputedStyle(el).textDecorationLine,
      }),
    )
  }, scope)
}

async function expectPane(
  frame: Frame,
  scope: string,
  tag: 'span' | 'a',
  extraPlain: string[] = ['kbd.example.com'],
) {
  await expect
    .poll(async () => (await decorated(frame, scope)).length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(LINKED.length)
  const found = await decorated(frame, scope)
  const texts = found.map((d) => d.text)
  for (const linked of LINKED)
    expect(texts, `${scope} ${linked}`).toContain(linked)
  for (const host of [...PLAIN_HOSTS, ...extraPlain])
    expect(
      texts.some((t) => t.includes(host)),
      `${scope} must not decorate ${host}`,
    ).toBe(false)
  for (const d of found) {
    expect(d.tag).toBe(tag)
    expect(d.line).toBe('underline')
  }
  const first = found.find((d) => d.text === 'https://example.com')!
  expect(first.href).toBe('https://example.com')
  const www = found.find((d) => d.text === 'www.example.com/a_b_c')!
  expect(www.href).toBe('http://www.example.com/a_b_c')
  const mail = found.find((d) => d.text === 'user@example.com')!
  expect(mail.href).toBe('mailto:user@example.com')
  // CJK host-only: the link stops before the full-width full stop; the sentence stays plain.
  const cjk = found.find((d) => d.text === 'https://cjk.example.com')!
  expect(cjk.href).toBe('https://cjk.example.com')
}

// Capture `open-link` posts from the webview without forwarding them to the host.
async function captureOpenLinks(frame: Frame) {
  await frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __bareMsgs?: unknown[]
      vscode: { postMessage(m: { command: string }): unknown }
    }
    w.__bareMsgs = []
    const api = w.vscode
    w.vscode = {
      ...api,
      postMessage: (m: { command: string }) => {
        if (m.command === 'open-link') {
          w.__bareMsgs?.push(m)
          return true
        }
        return api.postMessage(m)
      },
    }
  })
}

const openLinkPosts = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(() => (window as unknown as { __bareMsgs: unknown[] }).__bareMsgs)

async function saveAndRead(evaluateInVSCode: Evaluate, file: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as unknown as [string],
  )
  return readFileSync(file, 'utf8')
}

// The setting is Global; every case restores it so later specs start from the default.
test.afterEach(async ({ evaluateInVSCode }) => {
  await setSetting(evaluateInVSCode, null)
})

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('bare URLs are links in IR, WYSIWYG, Preview and Split preview', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const frame = await openFile(evaluateInVSCode, workbox, freshCopy(FIXTURE))

  // IR: leave every URL paragraph so the caret-block skip does not hide the decoration.
  await frame
    .locator('.vditor-ir p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await expectPane(frame, '.vditor-ir .vditor-reset', 'span')
  await expect(
    frame.locator('.vditor-ir .vditor-reset a.vmde-bare-url'),
  ).toHaveCount(0)

  // IR: Ctrl+click posts exactly one open-link; a plain click posts none.
  await captureOpenLinks(frame)
  const irUrl = frame
    .locator(
      '.vditor-ir span.vmde-bare-url[data-bare-url-href="https://example.com"]',
    )
    .first()
  await irUrl.click()
  expect(await openLinkPosts(frame)).toEqual([])
  await frame
    .locator('.vditor-ir p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await irUrl.click({ modifiers: ['Control'] })
  await expect
    .poll(() => openLinkPosts(frame), { timeout: 10_000 })
    .toEqual([{ command: 'open-link', href: 'https://example.com' }])

  // Preview overlay: a real anchor; Ctrl+click follows the modifier policy like every link.
  await togglePreview(frame)
  await expectPane(frame, '.vditor-preview', 'a', [])
  await captureOpenLinks(frame)
  await frame
    .locator('.vditor-preview a.vmde-bare-url[href="https://example.com"]')
    .first()
    .click({ modifiers: ['Control'] })
  await expect
    .poll(() => openLinkPosts(frame), { timeout: 10_000 })
    .toEqual([{ command: 'open-link', href: 'https://example.com' }])
  await togglePreview(frame)

  // WYSIWYG.
  await setMode(frame, 'wysiwyg')
  await frame
    .locator('.vditor-wysiwyg p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await expectPane(frame, '.vditor-wysiwyg .vditor-reset', 'span')
  await expect(
    frame.locator('.vditor-wysiwyg .vditor-reset a.vmde-bare-url'),
  ).toHaveCount(0)

  // Split preview: the source pane shows source text, the preview pane the anchors.
  await setMode(frame, 'sv')
  await expectPane(frame, '.vditor-preview', 'a', [])
  await expect(frame.locator('.vditor-sv .vmde-bare-url')).toHaveCount(0)
})

test('editing and saving keeps bare URL bytes identical (IR and WYSIWYG)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  for (const mode of ['ir', 'wysiwyg'] as const) {
    const file = freshCopy(FIXTURE)
    const frame = await openFile(evaluateInVSCode, workbox, file)
    if (mode === 'wysiwyg') await setMode(frame, 'wysiwyg')
    const pane = `.vditor-${mode}`
    // One character at the end of a paragraph without a URL ...
    await frame
      .locator(`${pane} p`, { hasText: 'Edit paragraph' })
      .first()
      .click()
    await workbox.keyboard.press('End')
    await workbox.keyboard.type('Q')
    // ... and one at the end of a URL paragraph; then move away so the URL is decorated again.
    await frame.locator(`${pane} p`, { hasText: 'Visit' }).first().click()
    await workbox.keyboard.press('End')
    await workbox.keyboard.type('Z')
    await frame
      .locator(`${pane} p`, { hasText: 'Edit paragraph' })
      .first()
      .click()
    await expect
      .poll(
        async () => (await decorated(frame, `${pane} .vditor-reset`)).length,
        {
          timeout: 15_000,
        },
      )
      .toBeGreaterThanOrEqual(LINKED.length)
    await expect
      .poll(
        async () => (await saveAndRead(evaluateInVSCode, file)).includes('Q'),
        { timeout: 15_000 },
      )
      .toBe(true)
    const expected = ORIGINAL.replace(
      'Visit https://example.com today.',
      'Visit https://example.com today.Z',
    ).replace('Edit paragraph here.', 'Edit paragraph here.Q')
    expect(readFileSync(file, 'utf8'), mode).toBe(expected)
  }
})

test('turning the setting off removes every decoration live, and on restores it', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const frame = await openFile(evaluateInVSCode, workbox, freshCopy(FIXTURE))
  await frame
    .locator('.vditor-ir p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  await expectPane(frame, '.vditor-ir .vditor-reset', 'span')

  await setSetting(evaluateInVSCode, false)
  await expect
    .poll(async () => (await decorated(frame, '.vditor-ir')).length, {
      timeout: 20_000,
    })
    .toBe(0)
  // Preview overlay, WYSIWYG and Split preview stay plain too.
  await togglePreview(frame)
  expect(await decorated(frame, '.vditor-preview')).toEqual([])
  await togglePreview(frame)
  await setMode(frame, 'wysiwyg')
  expect(await decorated(frame, '.vditor-wysiwyg')).toEqual([])
  await setMode(frame, 'sv')
  expect(await decorated(frame, '.vditor-preview')).toEqual([])
  expect(await decorated(frame, '.vditor-sv')).toEqual([])

  await setSetting(evaluateInVSCode, true)
  await expect
    .poll(async () => (await decorated(frame, '.vditor-preview')).length, {
      timeout: 20_000,
    })
    .toBeGreaterThanOrEqual(LINKED.length)
})

test('a URL followed by full-width punctuation links only the host (CJK)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const frame = await openFile(evaluateInVSCode, workbox, freshCopy(FIXTURE))
  await frame
    .locator('.vditor-ir p', { hasText: 'Edit paragraph' })
    .first()
    .click()
  const cjkParagraph = frame.locator('.vditor-ir p', {
    hasText: 'cjk.example.com',
  })
  await expect(cjkParagraph.locator('span.vmde-bare-url')).toHaveText(
    'https://cjk.example.com',
  )
  await expect(cjkParagraph).toContainText(
    '访问 https://cjk.example.com。下一句',
  )
})

test('the decoration pass is cheap on the large fixture', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  const frame = await openFile(evaluateInVSCode, workbox, freshCopy(LARGE))
  await settle(frame, 3000)
  // The fixture holds no bare URL (two `x.@y` table cells have a dotless domain), so the fast path
  // does all the work; the walk is measured through the selectionchange re-walk that every observer
  // shares, with the setting on against off (off only strips, a near-empty query).
  expect(await decorated(frame, '.vditor-ir')).toEqual([])
  const sample = () =>
    frame.locator('body').evaluate(async () => {
      const frames = () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        )
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        await frames()
        const t0 = performance.now()
        document.dispatchEvent(new Event('selectionchange'))
        times.push(performance.now() - t0)
      }
      return times.sort((a, b) => a - b)[2]
    })
  const on = await sample()
  await setSetting(evaluateInVSCode, false)
  await settle(frame, 2000)
  const off = await sample()
  test.info().annotations.push({
    type: 'bare-url-timing',
    description: `selectionchange re-walk median on the large fixture: setting on ${on.toFixed(1)} ms, off ${off.toFixed(1)} ms`,
  })
  console.log(
    `bare-url timing: on ${on.toFixed(1)} ms, off ${off.toFixed(1)} ms (large fixture, median of 5)`,
  )
  expect(on).toBeLessThan(2000)
  expect(await decorated(frame, '.vditor-ir')).toEqual([])
})
