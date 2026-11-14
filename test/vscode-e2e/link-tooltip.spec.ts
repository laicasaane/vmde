// Task 731 — hovering a link or an image shows its target as written, in the real VS Code webview:
// IR, WYSIWYG, Split's preview pane and Preview. Task 732 — the text shows in the toolbar-style
// hover box (`body > .vmde-hover-tip`); only an element with its own native `title` (a wiki chip,
// a WYSIWYG titled link or image) shows that instead, and never both. The pointer is the real
// X pointer (xdotool over XTEST on the verified VS Code window), moved in steps from a plain heading
// onto each target, so the browser's own hover state picks the element.
//
// After hovering every target and after a save, the document text, the bytes on disk, the dirty
// flag, Vditor's Undo depth and the caret are unchanged: the tooltip never reaches the Markdown.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

type Evaluate = Parameters<typeof reopenVmdeFixture>[0]
type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type ElectronApp = Parameters<typeof createXtestInput>[0]
type Point = { x: number; y: number }
type Mode = 'ir' | 'wysiwyg' | 'sv'

const DOC = [
  '# Link tooltips',
  '',
  'Plain paragraph.',
  '',
  'Owner: [point 14](scoping-proposal.md#L674) end.',
  '',
  'Titled: [L-titled](b.md "Link Title") end.',
  '',
  'Ref: [L-ref][r1] end.',
  '',
  'Auto: <https://example.com/L-auto> end.',
  '',
  'Bare: https://example.com/L-bare end.',
  '',
  'Wiki: [[Page#Heading]] end.',
  '',
  'Image: ![Alt text](pic.svg "Image Title") end.',
  '',
  'Alt only: ![Only alt](alt.svg) end.',
  '',
  'Same: ![Same](same.svg "Same") end.',
  '',
  'Linked: [![Inner alt](inner.svg) L-caption](https://example.com/outer) end.',
  '',
  '[r1]: https://example.com/ref',
  '',
].join('\n')

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#4a8"/></svg>\n'

// A target is visible text (never an IR marker) or an image by its `src` as written.
type Target = { text: string } | { src: string }
type Expected = string | RegExp
// No tooltip there: the start of every glide, and where the caret goes in an edit mode, so that no
// Vditor popover (a WYSIWYG heading's, a link's) covers a target.
const PLAIN: Target = { text: 'Plain paragraph.' }

// Contract D1-D5. In WYSIWYG a link or image with a Markdown title keeps Lute's own `title`
// attribute, which the browser shows natively (the tooltip cannot go on an element Lute
// serializes, and a hover box beside it would double it; Task 732 D5).
const CASES: Array<[name: string, target: Target, rendered: Expected]> = [
  ['Owner example', { text: 'point 14' }, 'scoping-proposal.md#L674'],
  ['titled link', { text: 'L-titled' }, 'Link Title\nb.md'],
  ['reference link', { text: 'L-ref' }, 'https://example.com/ref'],
  [
    'autolink',
    { text: 'https://example.com/L-auto' },
    'https://example.com/L-auto',
  ],
  [
    'bare URL',
    { text: 'https://example.com/L-bare' },
    'https://example.com/L-bare',
  ],
  [
    'wiki link',
    { text: 'Page#Heading' },
    /^(Open|Missing) wiki page Page#Heading$/,
  ],
  ['image', { src: 'pic.svg' }, 'Image Title\nAlt text\npic.svg'],
  ['image, alt only', { src: 'alt.svg' }, 'Only alt\nalt.svg'],
  ['image, title = alt', { src: 'same.svg' }, 'Same\nsame.svg'],
  ['image inside a link', { src: 'inner.svg' }, 'Inner alt\ninner.svg'],
  ['link around an image', { text: 'L-caption' }, 'https://example.com/outer'],
]
// Wiki chips keep their own native title (Task 731 D7, Task 732 D5).
const NATIVE_ONLY = new Set(['wiki link'])
const WYSIWYG_OWN_TITLE: Record<string, string> = {
  'titled link': 'Link Title',
  image: 'Image Title',
  'image, title = alt': 'Same',
}

const PANES = {
  ir: '.vditor-ir > .vditor-reset',
  wysiwyg: '.vditor-wysiwyg > .vditor-reset',
  preview: '.vditor-preview > .vditor-reset',
} as const
type Pane = keyof typeof PANES

/** Real X pointer moves on the VS Code window; points are workbox page coordinates. */
async function realPointer(electronApp: ElectronApp, workbox: Page) {
  const xtest = await createXtestInput(electronApp, workbox)
  const nativeWindow = await electronApp.browserWindow(workbox)
  expect(await workbox.evaluate(() => window.devicePixelRatio)).toBe(1)
  let at: Point | null = null
  // No `--sync`: it never returns when the pointer already sits on the point.
  const jump = async (point: Point) => {
    await xtest.activateAndFocus()
    const bounds = await nativeWindow.evaluate((win) => win.getContentBounds())
    execFileSync(
      '/usr/bin/xdotool',
      [
        'mousemove',
        String(Math.round(bounds.x + point.x)),
        String(Math.round(bounds.y + point.y)),
      ],
      { timeout: 5000 },
    )
    at = point
  }
  const pause = (ms: number) =>
    new Promise((resolve) => setTimeout(resolve, ms))
  const pointer = {
    /** Glide to `point` in a few steps, the way a hand moves the pointer. */
    async move(point: Point, steps = 4) {
      const from = at ?? point
      for (let step = 1; step <= steps; step++) {
        await jump({
          x: from.x + ((point.x - from.x) * step) / steps,
          y: from.y + ((point.y - from.y) * step) / steps,
        })
        await pause(30)
      }
    },
    async click(point: Point) {
      await pointer.move(point)
      execFileSync('/usr/bin/xdotool', ['click', '1'], { timeout: 5000 })
      await pause(300)
    },
  }
  return pointer
}
type Pointer = Awaited<ReturnType<typeof realPointer>>

// Scroll the target to the middle of its pane, then give its centre in workbox page coordinates
// (the webview frame's origin plus the target's client point).
async function pointOf(
  frame: Frame,
  pane: Pane,
  target: Target,
): Promise<Point> {
  const locate = (scroll: boolean) =>
    frame.locator('body').evaluate(
      (_body, [selector, wanted, doScroll]) => {
        const root = document.querySelector(selector as string)
        const goal = wanted as { text?: string; src?: string }
        const visible = (value: string | null | undefined) =>
          value?.replace(/\u200b/g, '').trim()
        const inMarker = (element: Element | null) =>
          !!element?.closest('.vditor-ir__marker')
        // A visible text node with exactly `text` (IR markers are hidden at rest).
        const textNodeBox = (scope: Element, text: string) => {
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (visible(n.textContent) !== text || inMarker(n.parentElement))
              continue
            const range = document.createRange()
            range.selectNodeContents(n)
            const rect = range.getClientRects()[0]
            if (rect?.width)
              return { element: n.parentElement as Element, box: rect }
          }
          return null
        }
        // A decoration can split the text into several nodes: take the innermost element instead.
        const elementBox = (scope: Element, text: string) => {
          const element = Array.from(scope.querySelectorAll('*'))
            .reverse()
            .find(
              (e) =>
                visible(e.textContent) === text &&
                !inMarker(e) &&
                e.getClientRects()[0]?.width,
            )
          return element
            ? { element, box: element.getClientRects()[0] as DOMRect }
            : null
        }
        const textBox = (scope: Element, text: string) =>
          textNodeBox(scope, text) ?? elementBox(scope, text)
        const imageBox = (scope: Element, src: string) => {
          const element = scope.querySelector(`img[src="${src}"]`)
          return element
            ? { element, box: element.getBoundingClientRect() }
            : null
        }
        const found = !root
          ? null
          : goal.src
            ? imageBox(root, goal.src)
            : textBox(root, goal.text ?? '')
        if (!found) return { missing: root?.textContent?.slice(0, 600) ?? null }
        if (doScroll) found.element.scrollIntoView({ block: 'center' })
        const { box } = found
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      },
      [PANES[pane], target, scroll] as const,
    )
  const first = await locate(true)
  expect(first, `${JSON.stringify(target)} in ${pane}`).not.toHaveProperty(
    'missing',
  )
  await settle(frame, 150)
  const local = (await locate(false)) as Point
  const origin = await frame.locator('html').boundingBox()
  if (!origin) throw new Error('no webview frame box')
  return { x: origin.x + local.x, y: origin.y + local.y }
}

// What the real pointer shows: the toolbar-style hover box (Task 732) when it is visible, else the
// nearest native `title` from the deepest hovered element up. `hovered` names that element so a
// failure says where the pointer was; `native` lets a case prove the two never show together.
const hoveredTitle = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const hovered = Array.from(document.querySelectorAll(':hover')).pop()
    let native: string | null = null
    for (let at = hovered ?? null; at && native === null; at = at.parentElement)
      native = at.getAttribute('title') || null
    const box = Array.from(
      document.querySelectorAll<HTMLElement>('body > .vmde-hover-tip'),
    ).find((element) => !element.hidden)
    return {
      hovered: hovered
        ? `${hovered.tagName.toLowerCase()}.${hovered.className}`
        : null,
      box: box?.textContent ?? null,
      native,
      title: box?.textContent ?? native,
    }
  })

async function expectTooltip(
  frame: Frame,
  pointer: Pointer,
  pane: Pane,
  name: string,
  target: Target,
  expected: Expected,
): Promise<void> {
  // From a plain paragraph (no tooltip) onto the target.
  await pointer.move(await pointOf(frame, pane, PLAIN))
  await expect
    .poll(async () => (await hoveredTitle(frame)).title, {
      message: `${pane} ${name}: none on plain text`,
    })
    .toBe(null)
  await pointer.move(await pointOf(frame, pane, target))
  const read = async () => (await hoveredTitle(frame)).title ?? ''
  const message = `${pane} ${name}: ${JSON.stringify(await hoveredTitle(frame))}`
  if (expected instanceof RegExp)
    await expect.poll(read, { message }).toMatch(expected)
  else await expect.poll(read, { message }).toBe(expected)
  const shown = await hoveredTitle(frame)
  expect(
    shown.box !== null && shown.native !== null,
    `${pane} ${name}: box and native title together ${JSON.stringify(shown)}`,
  ).toBe(false)
  const own =
    NATIVE_ONLY.has(name) || (pane === 'wysiwyg' && name in WYSIWYG_OWN_TITLE)
  expect(
    shown.box === null,
    `${pane} ${name}: ${own ? 'native' : 'hover box'} expected ${JSON.stringify(shown)}`,
  ).toBe(own)
}

interface State {
  text: string
  disk: string
  dirty: boolean | null
  undo: number
  value: string
  caret: { text: string | null; offset: number }
}

async function state(
  frame: Frame,
  evaluate: Evaluate,
  file: string,
): Promise<State> {
  const page = await frame.locator('body').evaluate(() => {
    const vditor = (
      window as unknown as {
        vditor: {
          getValue(): string
          vditor: {
            currentMode: string
            undo: Record<string, { undoStack: unknown[] } | undefined>
          }
        }
      }
    ).vditor
    const inner = vditor.vditor
    const selection = getSelection()
    return {
      undo:
        ((globalThis as any).__vmdeUnitHistory?.holds(inner)
          ? (globalThis as any).__vmdeUnitHistory.depth(inner).undo
          : inner.undo[inner.currentMode]?.undoStack.length) ?? -1,
      value: vditor.getValue(),
      caret: {
        text: selection?.anchorNode?.textContent ?? null,
        offset: selection?.anchorOffset ?? -1,
      },
    }
  })
  const dirty = (await evaluate(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? null,
    [file] as [string],
  )) as boolean | null
  return {
    text: await docText(evaluate, file),
    disk: readFileSync(file, 'utf8'),
    dirty,
    ...page,
  }
}

async function save(evaluate: Evaluate): Promise<void> {
  await evaluate(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as unknown as [string],
  )
}

// Hover every case on `pane`, save with the pointer still on the last one, and prove nothing moved.
async function hoverAllAndSave(
  frame: Frame,
  pointer: Pointer,
  evaluate: Evaluate,
  file: string,
  pane: Pane,
  expectedFor: (name: string, rendered: Expected) => Expected,
): Promise<void> {
  if (pane !== 'preview') await pointer.click(await pointOf(frame, pane, PLAIN))
  const before = await state(frame, evaluate, file)
  expect(before).toMatchObject({ text: DOC, disk: DOC, dirty: false })
  for (const [name, target, rendered] of CASES)
    await expectTooltip(
      frame,
      pointer,
      pane,
      name,
      target,
      expectedFor(name, rendered),
    )
  expect(await state(frame, evaluate, file), `${pane} after hovering`).toEqual(
    before,
  )
  await save(evaluate)
  await settle(frame, 1000)
  expect(await state(frame, evaluate, file), `${pane} after a save`).toEqual(
    before,
  )
}

async function switchMode(frame: Frame, mode: Mode) {
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
  await waitForE2EReadiness(frame, (s) => s.routerReady && s.mode === mode, {
    message: `link-tooltip ${mode} readiness`,
  })
}

// Every decoration the cases read is in place: bare URL spans or anchors, wiki chips and images.
async function waitForDecorations(frame: Frame, pane: Pane): Promise<void> {
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate((_b, selector) => {
          const root = document.querySelector(selector as string)
          const images = Array.from(root?.querySelectorAll('img') ?? [])
          return (
            !!root?.querySelector('[data-bare-url="1"], a.vmde-bare-url') &&
            !!root.querySelector('[data-wiki-link="1"]') &&
            images.length === 4 &&
            images.every((image) => image.complete && image.naturalWidth > 0)
          )
        }, PANES[pane]),
      { timeout: 30_000, message: `${pane} decorations and images` },
    )
    .toBe(true)
}

function writeWorkspace(dir: string): string {
  for (const name of ['pic.svg', 'alt.svg', 'same.svg', 'inner.svg'])
    writeFileSync(path.join(dir, name), SVG)
  writeFileSync(path.join(dir, 'Page.md'), '# Page\n\n## Heading\n')
  const file = path.join(dir, 'link-tooltip.md')
  writeFileSync(file, DOC)
  return file
}

async function open(
  evaluate: Evaluate,
  workbox: Page,
  electronApp: ElectronApp,
  baseDir: string,
) {
  const file = writeWorkspace(baseDir)
  const frame = await reopenVmdeFixture(evaluate, workbox, file)
  await waitForE2EReadiness(
    frame,
    (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
    { message: 'link-tooltip IR readiness' },
  )
  await waitForInitialUndoSnapshot(frame)
  return { file, frame, pointer: await realPointer(electronApp, workbox) }
}

test('IR and WYSIWYG: every link and image shows its target; nothing changes', async ({
  workbox,
  evaluateInVSCode,
  electronApp,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { file, frame, pointer } = await open(
    evaluate,
    workbox,
    electronApp,
    baseDir,
  )
  await waitForDecorations(frame, 'ir')
  await hoverAllAndSave(frame, pointer, evaluate, file, 'ir', (_n, r) => r)

  await switchMode(frame, 'wysiwyg')
  await waitForDecorations(frame, 'wysiwyg')
  await hoverAllAndSave(
    frame,
    pointer,
    evaluate,
    file,
    'wysiwyg',
    (name, rendered) => WYSIWYG_OWN_TITLE[name] ?? rendered,
  )
})

test("Split's preview pane and Preview: every link and image shows its target; nothing changes", async ({
  workbox,
  evaluateInVSCode,
  electronApp,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const evaluate = evaluateInVSCode as Evaluate
  const { file, frame, pointer } = await open(
    evaluate,
    workbox,
    electronApp,
    baseDir,
  )

  await switchMode(frame, 'sv')
  await waitForDecorations(frame, 'preview')
  await hoverAllAndSave(frame, pointer, evaluate, file, 'preview', (_n, r) => r)

  await switchMode(frame, 'ir')
  const previewButton = frame
    .locator('.vditor-toolbar [data-type="preview"]')
    .first()
  await previewButton.click()
  await expect
    .poll(() =>
      previewButton.evaluate((el) =>
        el.classList.contains('vditor-menu--current'),
      ),
    )
    .toBe(true)
  await waitForDecorations(frame, 'preview')
  await hoverAllAndSave(frame, pointer, evaluate, file, 'preview', (_n, r) => r)
  await previewButton.click()
})
