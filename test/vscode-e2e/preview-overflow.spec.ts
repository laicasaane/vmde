/**
 * Task 713 — Preview content must stay within the viewport, for every construct the editor renders.
 *
 * Three test cases, one per incompatible document state:
 *   1. the task record's table sample in an UNTITLED document;
 *   2. the same sample in a SAVED file;
 *   3. the stress fixture `fixtures/preview-overflow.md` (every construct of the task scope) in a
 *      saved file.
 * Each test case opens the document once in IR, then for each entry mode (IR, WYSIWYG, SV) switches
 * to that mode through the edit-mode toolbar panel, toggles Preview on, measures, and toggles it off.
 *
 * Construct markers: in the stress fixture every construct follows a level-2 heading `C:<name>`.
 * The heading text survives every renderer and every mode (Preview and WYSIWYG render `<h2>`, IR
 * and SV keep the `## ` marker as text), so the measurement groups the top-level blocks of a
 * surface by the nearest preceding marker heading. Blocks before the first marker belong to the
 * construct `front-matter` (the front matter, the title, the table of contents).
 *
 * A construct fits when no visible element of its group has a right edge past the viewport width
 * (`document.documentElement.clientWidth`). An element inside a box that clips or scrolls
 * horizontally counts only up to that box's right edge: scrolling inside the construct's own box is
 * allowed, widening the page is not. Each test also requires `scrollWidth <= clientWidth` for the
 * page scroller and every scroll container around the Preview pane.
 *
 * Every failure is collected as `"<entry> <construct>: right edge <x> > viewport <w>"` and the list
 * is asserted empty at the end, so one run reports the whole matrix. The edit modes are measured
 * on the stress fixture for comparison only (logged, not asserted). The full measurement is logged
 * as `P713 <json>` lines for the task report.
 */
import { writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAllEditors,
  PREVIEW_BUTTON,
  setConfig,
} from './preview-mode-helpers'
import {
  ExtensionId,
  MarkdownEditorViewType,
  renderAllPreviewBlocks,
  reopenVmdeFixture,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'
import { ProductDisplayName } from '../../src/shared/product-identity'

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'
// The document opens in WYSIWYG; IR comes last, so IR is entered by a mode change as in the report.
const MODES: Mode[] = ['wysiwyg', 'sv', 'ir']
const STRESS = path.join(__dirname, 'fixtures', 'preview-overflow.md')
const PREVIEW_SURFACE = '.vditor-preview .vditor-reset'
const EDIT_SURFACE: Record<Mode, string> = {
  ir: '.vditor-ir pre.vditor-reset',
  wysiwyg: '.vditor-wysiwyg pre.vditor-reset',
  sv: 'pre.vditor-sv',
}

// The task record's sample, verbatim.
const TABLE_SAMPLE = `## Rename candidates

| Current | Meaning | Candidate |
|---|---|---|
| \`IServiceBootstrap\` | Module start-up contract | \`IInjectingBootstrap\` |
| \`DefaultServiceBootstrap\` | Default module start-up | \`DefaultInjectingBootstrap\` |
| \`DisableServiceBootstrapOverrideAttribute\` | Turns off bootstrap override | \`DisableInjectingBootstrapOverrideAttribute\` |
| \`ProjectServices\` | Project composition root | \`ProjectInjection\` / \`ProjectRoot\` |
| \`SceneServices\` | Scene composition root component | \`SceneProvider\` / \`SceneRoot\` |
| \`ProjectScopeServices\` | Project-scope provider | \`ProjectScopeProvider\` |
| \`SceneServiceRouter\` | Routes scenes to providers | \`SceneProviderRouter\` |
| \`IServiceScope\` | Struct scope identifier | \`IInjectingScope\` (optional) |
| \`FindServices\` | Resolves all matches | \`GetServices\` / \`ResolveAll\` |
| \`InstallDiscoveredServices\` | Runs discovered installers | \`InstallDiscovered\` |
| \`__ServiceCatalogs__\` | Generated catalog holder | \`__InjectingCatalogs__\` |

## Keep

| Name | Reason |
|---|---|
| \`IServiceProvider\` | Extends \`System.IServiceProvider\` (D3) |
| \`ServiceProvider\` | Runtime node (D2) |
| \`ServiceProviderBehaviour\` | Subtree component (D2) |
| \`GetService\` | BCL name |
| \`GetRequiredService\` | Microsoft DI name |
| \`GetOptionalService\` | Same family as \`GetRequiredService\` |
| \`TryGetService\` | Same family as \`GetService\` |
| \`IServiceInstaller\` | Installs services; \`IInstaller\` too generic |
| \`_services\` | Private field |
| \`IShopService\` | Sample user type |
| \`ShopService\` | Sample user type |
| \`IInventoryService\` | Sample user type |
| \`MatchmakingService\` | Sample user type |
| \`PlayerSaveService\` | Sample user type |
| \`VContainerServiceProvider\` | Implements \`IServiceProvider\` |
| \`ReflexServiceProvider\` | Implements \`IServiceProvider\` |
`

interface Offender {
  path: string
  right: number
  width: number
  style: Record<string, string>
}
interface ConstructResult {
  name: string
  right: number
  /** Rendered output in the group: svg, canvas and img elements (0 for a text construct). */
  media: number
  /** Widest element of the group, to show that the construct is wider than the viewport. */
  widest: number
  /** First characters of an error message in the group, when a renderer failed. */
  error: string
  offenders: Offender[]
}
interface ScrollBox {
  path: string
  scrollWidth: number
  clientWidth: number
  overflowX: string
}
interface TableInfo {
  right: number
  width: number
  inlineStyle: string
  style: Record<string, string>
  parent: { path: string; right: number; width: number; overflowX: string }
  cell: Record<string, string>
  code: Record<string, string> | null
  hints: number
}
interface Measurement {
  viewport: number
  blocks: number
  firstTexts: string[]
  page: { scrollWidth: number; clientWidth: number }
  surface: { path: string; left: number; right: number; width: number }
  scrollBoxes: ScrollBox[]
  constructs: ConstructResult[]
  tables: TableInfo[]
}

/**
 * Measure one surface in the webview. Runs inside the page, so it is self-contained. Scrolls each
 * construct into view before reading it: off-screen blocks may be skipped by content-visibility or
 * deferred renders.
 */
async function measureSurface(
  frame: Frame,
  surfaceSelector: string,
): Promise<Measurement> {
  const walk = await frame.locator('body').evaluate(async (_body, selector) => {
    const STYLE_KEYS = [
      'display',
      'position',
      'width',
      'min-width',
      'max-width',
      'table-layout',
      'overflow-x',
      'overflow-wrap',
      'word-break',
      'white-space',
    ]
    const pick = (el: Element) => {
      const cs = getComputedStyle(el)
      const out: Record<string, string> = {}
      for (const key of STYLE_KEYS) out[key] = cs.getPropertyValue(key)
      return out
    }
    const pathOf = (el: Element) => {
      const parts: string[] = []
      let node: Element | null = el
      while (node && parts.length < 5 && !node.matches(selector)) {
        const cls = [...node.classList].slice(0, 2).join('.')
        parts.unshift(node.tagName.toLowerCase() + (cls ? `.${cls}` : ''))
        node = node.parentElement
      }
      return parts.join(' > ')
    }
    const surfaces = [...document.querySelectorAll<HTMLElement>(selector)]
    const surface =
      surfaces.find((s) => s.getBoundingClientRect().width > 0) ?? surfaces[0]
    if (!surface) throw new Error(`no surface ${selector}`)
    const viewport = document.documentElement.clientWidth
    const clips = (el: Element) =>
      /auto|scroll|hidden|clip/.test(getComputedStyle(el).overflowX)

    // Group the top-level blocks by the nearest preceding `C:<name>` heading.
    const groups: { name: string; blocks: Element[] }[] = [
      { name: 'front-matter', blocks: [] },
    ]
    // SV holds the whole source in one block element of line spans: group those spans instead.
    const container =
      surface.children.length === 1 ? surface.children[0] : surface
    for (const child of container.children) {
      const text = (child.textContent ?? '').trim()
      const match = /^(?:#{2}\s*)?C:([\w-]+)$/.exec(text)
      if (match) groups.push({ name: match[1], blocks: [] })
      else groups[groups.length - 1].blocks.push(child)
    }
    const errorText = (text: string) => {
      const at = text.search(/error|failed/i)
      return at < 0 ? '' : text.slice(Math.max(0, at - 40), at + 120)
    }
    const frame2 = () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      )

    const constructs: ConstructResult[] = []
    for (const group of groups) {
      const first = group.blocks[0] as HTMLElement | undefined
      first?.scrollIntoView({ block: 'start' })
      await frame2()
      const offenders: Offender[] = []
      let worst = 0
      let widest = 0
      const visit = (el: Element, clipRight: number) => {
        const rect = el.getBoundingClientRect()
        if (rect.width > 0 || rect.height > 0) {
          const right = Math.min(rect.right, clipRight)
          worst = Math.max(worst, right)
          widest = Math.max(widest, el.scrollWidth, rect.width)
          if (right > viewport + 1)
            offenders.push({
              path: pathOf(el),
              right: Math.round(right),
              width: Math.round(rect.width),
              style: pick(el),
            })
        }
        const childClip = clips(el)
          ? Math.min(clipRight, rect.right)
          : clipRight
        for (const child of el.children) visit(child, childClip)
      }
      for (const block of group.blocks) visit(block, Number.POSITIVE_INFINITY)
      // Outermost offenders first: they name the element that widens the page.
      // innerText leaves out <style> text (a diagram's CSS names `.error` classes).
      const text = group.blocks
        .map((b) => (b as HTMLElement).innerText ?? '')
        .join(' ')
      constructs.push({
        name: group.name,
        right: Math.round(worst),
        media: group.blocks.reduce(
          (n, b) => n + b.querySelectorAll('svg, canvas, img').length,
          0,
        ),
        widest: Math.round(widest),
        error: errorText(text),
        offenders: offenders.slice(0, 4),
      })
    }
    surface.scrollIntoView({ block: 'start' })
    return {
      viewport,
      constructs,
      // Grouping diagnostics: how many top-level blocks the surface has, and the first few texts.
      blocks: surface.children.length,
      firstTexts: [...surface.children]
        .slice(0, 6)
        .map((c) => (c.textContent ?? '').slice(0, 40)),
    }
  }, surfaceSelector)
  return { ...(await measureBoxes(frame, surfaceSelector)), ...walk }
}

/** Page and scroll-container widths, and the table width details, of one surface. */
function measureBoxes(
  frame: Frame,
  surfaceSelector: string,
): Promise<
  Omit<Measurement, 'viewport' | 'constructs' | 'blocks' | 'firstTexts'>
> {
  return frame.locator('body').evaluate((_body, selector) => {
    const STYLE_KEYS = [
      'display',
      'width',
      'min-width',
      'max-width',
      'table-layout',
      'overflow-x',
      'overflow-wrap',
      'word-break',
      'white-space',
    ]
    const pick = (el: Element) => {
      const cs = getComputedStyle(el)
      const out: Record<string, string> = {}
      for (const key of STYLE_KEYS) out[key] = cs.getPropertyValue(key)
      return out
    }
    const short = (el: Element) =>
      `${el.tagName.toLowerCase()}.${[...el.classList].slice(0, 2).join('.')}`
    const surfaces = [...document.querySelectorAll<HTMLElement>(selector)]
    const surface = (surfaces.find(
      (s) => s.getBoundingClientRect().width > 0,
    ) ?? surfaces[0]) as HTMLElement
    const scrollBoxes: ScrollBox[] = []
    for (
      let el: HTMLElement | null = surface;
      el;
      el = el.parentElement as HTMLElement | null
    )
      scrollBoxes.push({
        path: short(el),
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
      })
    const tables: TableInfo[] = [...surface.querySelectorAll('table')].map(
      (table) => {
        const rect = table.getBoundingClientRect()
        const parent = table.parentElement as HTMLElement
        const prect = parent.getBoundingClientRect()
        const cell = table.querySelector('td') ?? table.querySelector('th')
        const code = table.querySelector('td code')
        return {
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          inlineStyle: table.getAttribute('style') ?? '',
          style: pick(table),
          parent: {
            path: short(parent),
            right: Math.round(prect.right),
            width: Math.round(prect.width),
            overflowX: getComputedStyle(parent).overflowX,
          },
          cell: cell ? pick(cell) : {},
          code: code ? pick(code) : null,
          hints: table.querySelectorAll('.vmde-wrap-hint').length,
        }
      },
    )
    const srect = surface.getBoundingClientRect()
    const scroller = document.scrollingElement as HTMLElement
    return {
      page: {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
      },
      surface: {
        path: `${surface.tagName.toLowerCase()}.${[...surface.classList].join('.')}`,
        left: Math.round(srect.left),
        right: Math.round(srect.right),
        width: Math.round(srect.width),
      },
      scrollBoxes,
      tables,
    }
  }, surfaceSelector)
}

/** Failures of one measurement, in the spec's report format. */
function failuresOf(entry: string, m: Measurement): string[] {
  const out = m.constructs
    .filter((c) => c.right > m.viewport + 1)
    .map(
      (c) =>
        `${entry} ${c.name}: right edge ${c.right} > viewport ${m.viewport}`,
    )
  if (m.page.scrollWidth > m.page.clientWidth + 1)
    out.push(
      `${entry} page: scrollWidth ${m.page.scrollWidth} > clientWidth ${m.page.clientWidth}`,
    )
  for (const box of m.scrollBoxes)
    if (box.scrollWidth > box.clientWidth + 1)
      out.push(
        `${entry} ${box.path}: scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth}`,
      )
  return out
}

const log = (label: string, data: unknown) =>
  console.log(`P713 ${JSON.stringify({ label, data })}`)

// Mode-switch click: the same panel path the user takes (see block-fidelity.spec.ts).
async function switchMode(frame: Frame, mode: Mode) {
  const current = await frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { vditor: { vditor: { currentMode: string } } })
          .vditor.vditor.currentMode,
    )
  if (current === mode) return
  await frame.locator('body').evaluate((_body, wanted) => {
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
      .querySelector(`button[data-mode="${wanted}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 30_000 })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(
        () =>
          (
            window as unknown as {
              vditor: { vditor: { currentMode: string } }
            }
          ).vditor.vditor.currentMode,
      ),
    )
    .toBe(mode)
}

// Geometry quiescence: wrap hints, table widths and diagram sizing settle asynchronously after a
// render, and a poll can stop on a transient plateau (a false pass). A fixed settle is the
// documented pattern for cross-engine geometry (vmde-testing skill, task 451).
const settle = (frame: Frame, ms: number) =>
  frame
    .locator('body')
    .evaluate((_b, d) => new Promise((r) => setTimeout(r, d)), ms)

/** Full Preview is on: the Preview pane spans the viewport (SV's side preview spans about half). */
async function previewShown(frame: Frame) {
  return frame.locator('body').evaluate(() => {
    const p = document.querySelector<HTMLElement>('.vditor-preview')
    return (
      !!p &&
      getComputedStyle(p).display !== 'none' &&
      p.getBoundingClientRect().width >
        document.documentElement.clientWidth * 0.8
    )
  })
}

/** Walk the entry modes: edit measurement (optional), Preview on, measure, Preview off. */
async function runMatrix(
  frame: Frame,
  label: string,
  measureEdit: boolean,
): Promise<string[]> {
  const failures: string[] = []
  for (const mode of MODES) {
    await frame.locator('body').evaluate(() => window.scrollTo(0, 0))
    await switchMode(frame, mode)
    await settle(frame, 2500)
    if (measureEdit) {
      const edit = await measureSurface(frame, EDIT_SURFACE[mode])
      log(`${label} edit ${mode}`, edit)
      const editFailures = failuresOf(`${label} edit ${mode}`, edit)
      log(`${label} edit ${mode} failures (not asserted)`, editFailures)
    }
    await frame.locator(PREVIEW_BUTTON).click()
    await expect.poll(() => previewShown(frame)).toBe(true)
    await renderAllPreviewBlocks(frame, PREVIEW_SURFACE)
    await settle(frame, 2500)
    const preview = await measureSurface(frame, PREVIEW_SURFACE)
    log(`${label} preview from ${mode}`, preview)
    failures.push(...failuresOf(`${label} ${mode}→preview`, preview))
    await frame.locator(PREVIEW_BUTTON).click()
    // SV keeps its side-by-side preview after Preview is turned off, so wait for the edit surface.
    await expect
      .poll(() =>
        frame
          .locator(EDIT_SURFACE[mode])
          .first()
          .evaluate((el) => el.getBoundingClientRect().width),
      )
      .toBeGreaterThan(0)
  }
  log(`${label} failures`, failures)
  return failures
}

// Workbench sizes. The table runs both: the webview is narrower than the workbench by the activity
// bar and side bar, and the Owner's window width is not known. The stress fixture runs the first.
// Measured: the webview is 648 px narrower than the workbench, so these give webview widths of
// about 1252, 802 and 452 px. Widest first: each later size also checks a Preview that is already
// showing when the window shrinks.
const TABLE_VIEWPORTS = [
  { width: 1900, height: 900 },
  { width: 1450, height: 900 },
  { width: 1100, height: 900 },
]
const STRESS_VIEWPORT = TABLE_VIEWPORTS[1]

async function runViewports(
  workbox: import('@playwright/test').Page,
  frame: Frame,
  label: string,
) {
  const failures: string[] = []
  for (const [index, size] of TABLE_VIEWPORTS.entries()) {
    if (index > 0) {
      // Shrink the window while Preview is showing (the edit mode is IR, the matrix's last).
      await frame.locator(PREVIEW_BUTTON).click()
      await expect.poll(() => previewShown(frame)).toBe(true)
      await renderAllPreviewBlocks(frame, PREVIEW_SURFACE)
      await settle(frame, 1500)
      await workbox.setViewportSize(size)
      await settle(frame, 2500)
      const resized = await measureSurface(frame, PREVIEW_SURFACE)
      const entry = `${label} ${size.width} preview-resized`
      log(entry, resized)
      failures.push(...failuresOf(entry, resized))
      await frame.locator(PREVIEW_BUTTON).click()
      await expect.poll(() => previewShown(frame)).toBe(false)
    } else await workbox.setViewportSize(size)
    failures.push(...(await runMatrix(frame, `${label} ${size.width}`, true)))
  }
  return failures
}

test.afterEach(async ({ evaluateInVSCode }) => {
  // An untitled document is dirty: revert it so closing never shows a save prompt.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    for (const doc of vscode.workspace.textDocuments.filter(
      (d) => d.isUntitled,
    )) {
      await vscode.window.showTextDocument(doc)
      await vscode.commands.executeCommand(
        'workbench.action.revertAndCloseActiveEditor',
      )
    }
  })
  await closeAllEditors(evaluateInVSCode)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', undefined)
  await setConfig(evaluateInVSCode, 'markdown.toc', undefined)
})

test('table sample in an untitled document stays within the viewport in Preview', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(300_000)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'wysiwyg')
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension(args[0])?.activate()
      const doc = await vscode.workspace.openTextDocument({
        language: 'markdown',
        content: args[2],
      })
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, args[1])
    },
    [ExtensionId, MarkdownEditorViewType, TABLE_SAMPLE],
  )
  const frame = workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`)
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 90_000 })
  await waitForInitialUndoSnapshot(frame)
  expect(await runViewports(workbox, frame, 'untitled-table')).toEqual([])
})

test('table sample in a saved file stays within the viewport in Preview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'preview-overflow-table.md')
  writeFileSync(file, TABLE_SAMPLE)
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'wysiwyg')
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    90_000,
    '.vditor-wysiwyg',
  )
  await waitForInitialUndoSnapshot(frame)
  expect(await runViewports(workbox, frame, 'saved-table')).toEqual([])
})

test('every construct of the stress fixture stays within the viewport in Preview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  const file = path.join(baseDir, 'preview-overflow.md')
  writeFileSync(file, readFileSync(STRESS, 'utf8'))
  await setConfig(evaluateInVSCode, 'editor.defaultMode', 'wysiwyg')
  await setConfig(evaluateInVSCode, 'markdown.toc', true)
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    90_000,
    '.vditor-wysiwyg',
  )
  await waitForInitialUndoSnapshot(frame)
  await workbox.setViewportSize(STRESS_VIEWPORT)
  expect(await runMatrix(frame, 'stress', true)).toEqual([])
})
