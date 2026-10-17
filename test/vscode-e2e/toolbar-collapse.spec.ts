import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import path from 'node:path'
import { _electron, type Page } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  ExtensionId,
  MarkdownEditorViewType,
  type docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 631: the toolbar collapse toggle (tasks/done/631-toolbar-collapse-toggle.md, Acceptance 1 to 6).
// Expected values come from the task contract: the toggle is the last control of row one, shows an
// up chevron while expanded and a down chevron while collapsed, and collapsing is presentation
// only (no document, dirty, Undo, caret, selection or scroll effect).

// Follow-up F2 (Owner, 2026-10-15): "collapsing state of toolbar must be remembered through VSCode
// sessions" and "Collapsing state must be remembered through files too. All files receive the same
// toolbar collapsing state." One user-level value kept by the host: every editor, restored or newly
// opened, of any file, opens in it; a toggle in one editor is followed by the other open editors.

type Mode = 'ir' | 'wysiwyg' | 'sv'
type Frame = ReturnType<typeof wf>
type HostEvaluator = Parameters<typeof docText>[0]

const PARAGRAPHS = Array.from(
  { length: 80 },
  (_, index) => `Paragraph ${index + 1} alpha beta gamma delta.`,
)
const FIXTURE = `# Collapse toolbar fixture\n\n${PARAGRAPHS.join('\n\n')}\n`

const toolbarOf = (frame: Frame) => frame.locator('.vditor-toolbar')
const toggleOf = (frame: Frame) =>
  toolbarOf(frame).locator('[data-type="collapse-toolbar"]')

const hostState = (evaluateInVSCode: HostEvaluator, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      return { text: document?.getText() ?? '', dirty: !!document?.isDirty }
    },
    [file] as [string],
  ) as Promise<{ text: string; dirty: boolean }>

// Everything Acceptance 3 names, read in the webview (value, Undo depth, selection, scroll).
const webviewState = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: Mode
          undo: Record<string, { undoStack: unknown[] }>
        }
      }
    }
    const inner = outer.vditor.vditor
    const selection = getSelection()
    const anchor = selection?.anchorNode
    const scrollers = [
      document.scrollingElement,
      ...[
        `.vditor-${inner.currentMode}`,
        `.vditor-${inner.currentMode} .vditor-reset`,
      ].map((selector) => document.querySelector(selector)),
    ]
    return {
      mode: inner.currentMode,
      value: outer.vditor.getValue(),
      undoDepth: inner.undo[inner.currentMode]?.undoStack.length ?? -1,
      selectionText: selection?.toString() ?? '',
      anchorData: anchor instanceof Text ? anchor.data : null,
      anchorOffset: selection?.anchorOffset ?? -1,
      focusOffset: selection?.focusOffset ?? -1,
      scrollTops: scrollers.map((element) => element?.scrollTop ?? -1),
    }
  })

// Scroll whichever scroll container of the active mode overflows, so scrollTop is non-zero.
const scrollDown = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const mode = (
      window as unknown as { vditor: { vditor: { currentMode: Mode } } }
    ).vditor.vditor.currentMode
    const candidates = [
      document.scrollingElement,
      document.querySelector(`.vditor-${mode}`),
      document.querySelector(`.vditor-${mode} .vditor-reset`),
    ]
    const scroller = candidates.find(
      (element) => element && element.scrollHeight > element.clientHeight + 50,
    )
    if (!scroller) throw new Error('no overflowing scroll container')
    scroller.scrollTop = 300
    return scroller.scrollTop
  })

// Chevron direction by geometry: a point on the left arm lies in the fill for the up chevron near
// the bottom of the box and for the down chevron near the top.
const chevronDirection = (frame: Frame) =>
  toggleOf(frame)
    .evaluate((button) => {
      const path = button.querySelector('svg path') as SVGGeometryElement | null
      if (!path) return 'missing'
      const point = (y: number) => {
        const svg = path.ownerSVGElement as SVGSVGElement
        const p = svg.createSVGPoint()
        p.x = 4
        p.y = y
        return path.isPointInFill(p)
      }
      if (point(10) && !point(6.2)) return 'up'
      if (point(6.2) && !point(10)) return 'down'
      return 'unknown'
    })
    .catch(() => 'detached') // the frame is replaced while a webview reloads; the poll retries

const expectExpanded = async (frame: Frame, expanded: boolean) => {
  const toggle = toggleOf(frame)
  await expect(toggle).toHaveAttribute('aria-expanded', String(expanded))
  await expect(toggle).toHaveAttribute(
    'aria-label',
    expanded ? 'Collapse toolbar' : 'Expand toolbar',
  )
  await expect
    .poll(() => chevronDirection(frame))
    .toBe(expanded ? 'up' : 'down')
  await expect(toolbarOf(frame)).toHaveClass(
    expanded ? /^(?!.*vmde-toolbar--collapsed)/ : /vmde-toolbar--collapsed/,
  )
}

const overflowSet = (frame: Frame) =>
  toolbarOf(frame).evaluate((toolbar) =>
    Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
      ),
    )
      .map((button) => button.getAttribute('data-type') ?? '')
      .sort(),
  )

// Task 642: the collapsed toolbar is one small row. Its layout follows the same flow as the
// expanded one: the longest prefix of the sequence that fits, then Preview, Edit Mode and More as
// the last three controls, and the rest in More.
const TAIL = ['preview', 'edit-mode', 'more']
const TOGGLE = 'collapse-toolbar'

interface Layout {
  rows: string[][]
  more: string[]
}

/** The visible tokens of each row (a hidden row reads empty) and the controls held by More. */
const readLayout = (frame: Frame): Promise<Layout> =>
  toolbarOf(frame).evaluate((toolbar) => {
    const token = (child: Element) =>
      child.classList.contains('vditor-toolbar__divider')
        ? '|'
        : (child
            .querySelector(':scope > [data-type]')
            ?.getAttribute('data-type') ?? '')
    const rows = Array.from(
      toolbar.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    ).map((row) =>
      getComputedStyle(row).display === 'none'
        ? []
        : Array.from(row.children)
            .filter((child) => getComputedStyle(child).display !== 'none')
            .map(token),
    )
    const more = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
      ),
    ).map((button) => button.getAttribute('data-type') ?? '')
    return { rows, more }
  })

/** The controls of a layout in sequence order, rules and the toggle left out. */
const controlsIn = (layout: Layout) => [
  ...layout.rows.flat().filter((name) => name !== '|' && name !== TOGGLE),
  ...layout.more,
]

/** Collapsed contract (A3): one row only, the toggle in it, the placed body a prefix of the
 *  sequence, the rest in More in order, Preview, Edit Mode and More the last three controls
 *  before the toggle, and no rule at a row edge or doubled. `controls` is the sequence read from
 *  the one-row expanded layout, so a wiki-off configuration needs no second table. */
const expectCollapsedFlow = (
  layout: Layout,
  controls: readonly string[],
  label: string,
) => {
  expect(layout.rows[1], `${label} row two is not used`).toEqual([])
  const row = layout.rows[0]
  expect(row.at(-1), `${label} toggle ends the row`).toBe(TOGGLE)
  const tokens = row.filter((name) => name !== TOGGLE)
  expect(tokens.slice(-3), `${label} the tail is last`).toEqual(TAIL)
  expect(tokens[0], `${label} starts with a control`).not.toBe('|')
  tokens.forEach((name, index) => {
    if (name === '|')
      expect(tokens[index + 1], `${label} no double rule`).not.toBe('|')
  })
  const body = controls.filter((name) => !TAIL.includes(name))
  const placedBody = tokens.filter(
    (name) => name !== '|' && !TAIL.includes(name),
  )
  expect(placedBody, `${label} placed body is a prefix`).toEqual(
    body.slice(0, placedBody.length),
  )
  expect(layout.more, `${label} More holds the rest in order`).toEqual(
    body.slice(placedBody.length),
  )
  expect([...controlsIn(layout)].sort(), `${label} every control once`).toEqual(
    [...controls].sort(),
  )
}

/** A4: every direct button of the row measures the toggle's size, icon included. */
const expectButtonsMatchToggle = async (
  frame: Frame,
  toggle: { w: number; h: number },
) => {
  const buttons = await toolbarOf(frame)
    .locator(':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type]')
    .evaluateAll((elements) =>
      elements
        .filter((button) => getComputedStyle(button).display !== 'none')
        .map((button) => {
          const box = button.getBoundingClientRect()
          const icon = button.querySelector('svg')?.getBoundingClientRect()
          return {
            w: box.width,
            h: box.height,
            iw: icon?.width ?? 0,
            ih: icon?.height ?? 0,
          }
        }),
    )
  expect(buttons.length).toBeGreaterThan(5)
  for (const button of buttons) {
    expect(Math.abs(button.w - toggle.w)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(button.h - toggle.h)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(button.iw - 11.2)).toBeLessThanOrEqual(0.5)
    expect(Math.abs(button.ih - 11.2)).toBeLessThanOrEqual(0.5)
  }
}

/** Selects the word "alpha" of paragraph 4 in the IR surface and returns after the selection holds. */
const selectAlpha = async (frame: Frame) => {
  await frame
    .locator('.vditor-ir p')
    .filter({ hasText: 'Paragraph 4 alpha' })
    .first()
    .click()
  await frame.locator('body').evaluate(() => {
    const paragraph = Array.from(
      document.querySelectorAll('.vditor-ir p'),
    ).find((element) => element.textContent?.includes('Paragraph 4 alpha'))
    const walker = document.createTreeWalker(
      paragraph as Node,
      NodeFilter.SHOW_TEXT,
    )
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = (node as Text).data.indexOf('alpha')
      if (at < 0) continue
      const range = document.createRange()
      range.setStart(node, at)
      range.setEnd(node, at + 'alpha'.length)
      getSelection()?.removeAllRanges()
      getSelection()?.addRange(range)
      return
    }
    throw new Error('no text node holds alpha')
  })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => getSelection()?.toString()),
    )
    .toBe('alpha')
}

/** The toggle's box and the gap between it and the nearest other control or rule. */
const toggleGeometry = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const button = document.querySelector(
      '.vditor-toolbar [data-type="collapse-toolbar"]',
    ) as HTMLElement
    const box = button.getBoundingClientRect()
    let nearest = 0
    for (const element of document.querySelectorAll<HTMLElement>(
      '.vmde-toolbar-row > .vditor-toolbar__item, .vmde-toolbar-row > .vditor-toolbar__divider',
    )) {
      if (element.contains(button)) continue
      if (getComputedStyle(element).display === 'none') continue
      nearest = Math.max(nearest, element.getBoundingClientRect().right)
    }
    return {
      x: box.x,
      y: box.y,
      w: box.width,
      h: box.height,
      gap: box.left - nearest,
    }
  })

const switchMode = async (frame: Frame, mode: Mode) => {
  await toolbarOf(frame).locator('[data-type="edit-mode"]').click()
  await toolbarOf(frame).locator(`button[data-mode="${mode}"]`).click()
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === mode,
    { message: `collapse spec ${mode} readiness` },
  )
}

test('collapse toggle: placement, click and OS keys, no document effect, menus, Find widget, overflow', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires the explicit XTEST runner',
  )
  test.setTimeout(300_000)
  const file = path.join(baseDir, 'toolbar-collapse.md')
  writeFileSync(file, FIXTURE)

  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file] as [string],
  )
  await workbox.setViewportSize({ width: 1400, height: 900 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'collapse spec IR readiness' },
  )
  await waitForInitialUndoSnapshot(frame)
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)

  // IR-only checks run first: switching to Source mode and back leaves the toolbar overflow
  // measured with Source-hidden controls (see the record), which is not a collapse effect.
  const irSurface = frame.locator('.vditor-ir .vditor-reset').first()

  // Acceptance 4: a narrow width puts items in More; an open menu closes on collapse and the
  // overflow set after expand equals the set before collapse.
  await workbox.setViewportSize({ width: 500, height: 900 })
  await expect.poll(() => overflowSet(frame)).not.toEqual([])
  // Wait until the resize has settled: two reads 500 ms apart agree.
  let overflowBefore = await overflowSet(frame)
  await expect
    .poll(async () => {
      await settle(frame, 500)
      const next = await overflowSet(frame)
      const stable = next.join() === overflowBefore.join()
      overflowBefore = next
      return stable
    })
    .toBe(true)
  const more = toolbarOf(frame).locator('[data-type="more"]')
  await more.click()
  await expect(more).toHaveAttribute('aria-expanded', 'true')
  await toggleOf(frame).click()
  await expectExpanded(frame, false)
  await expect(more).toHaveAttribute('aria-expanded', 'false')
  await toggleOf(frame).click()
  await expectExpanded(frame, true)
  await expect.poll(() => overflowSet(frame)).toEqual(overflowBefore)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  await expect.poll(() => overflowSet(frame)).toEqual([])

  // Edge case (open S2 item): the Find widget top follows the toolbar bottom after collapse.
  await irSurface
    .locator('p')
    .filter({ hasText: 'Paragraph 5 alpha' })
    .first()
    .click()
  await xtest.key('ctrl+f')
  const widget = frame.locator('.vmde-find-replace')
  await expect(widget).toBeVisible()
  const geometry = () =>
    frame.locator('body').evaluate(() => {
      const toolbar = document
        .querySelector('.vditor-toolbar')!
        .getBoundingClientRect()
      const find = document
        .querySelector('.vmde-find-replace')!
        .getBoundingClientRect()
      return { toolbarBottom: toolbar.bottom, findTop: find.top }
    })
  const expandedGeometry = await geometry()
  expect(expandedGeometry.findTop).toBeGreaterThanOrEqual(
    expandedGeometry.toolbarBottom - 1,
  )
  // Task 642 (supersedes the 70% sizes of follow-up F1): the toggle is 17.5 x 24 px in both
  // states, at the same place, and the collapsed strip is one 24 px row plus the 1 px border.
  const sizes = () =>
    frame.locator('body').evaluate(() => {
      const box = (element: Element | null) => {
        const rect = (element as HTMLElement).getBoundingClientRect()
        return { w: rect.width, h: rect.height }
      }
      const toggle = document.querySelector(
        '.vditor-toolbar [data-type="collapse-toolbar"]',
      ) as HTMLElement
      const toolbar = document.querySelector('.vditor-toolbar') as HTMLElement
      return {
        toggle: box(toggle),
        icon: box(toggle.querySelector('svg')),
        toolbar: box(toolbar),
        toggleCenter:
          toggle.getBoundingClientRect().top +
          toggle.getBoundingClientRect().height / 2 -
          toolbar.getBoundingClientRect().top,
      }
    })
  const near = (actual: number, expected: number, tolerance = 1) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
  const expandedSizes = await sizes()
  near(expandedSizes.toggle.w, 17.5, 0.5)
  near(expandedSizes.toggle.h, 24, 0.5)
  await toggleOf(frame).click()
  await expectExpanded(frame, false)
  const collapsedSizes = await sizes()
  near(collapsedSizes.toggle.w, 17.5, 0.5)
  near(collapsedSizes.toggle.h, 24, 0.5)
  near(collapsedSizes.icon.w, expandedSizes.icon.w, 0.5)
  near(collapsedSizes.toolbar.h, 25)
  near(collapsedSizes.toggleCenter, collapsedSizes.toolbar.h / 2)
  await expect
    .poll(async () => {
      const collapsed = await geometry()
      return (
        collapsed.toolbarBottom < expandedGeometry.toolbarBottom &&
        Math.abs(collapsed.findTop - collapsed.toolbarBottom) <= 1
      )
    })
    .toBe(true)
  await toggleOf(frame).click()
  await expectExpanded(frame, true)
  await expect
    .poll(async () => {
      const expanded = await geometry()
      return Math.abs(expanded.findTop - expanded.toolbarBottom) <= 1
    })
    .toBe(true)
  await xtest.key('Escape')
  await expect(widget).toBeHidden()

  for (const mode of ['ir', 'wysiwyg', 'sv'] as Mode[]) {
    if (mode !== 'ir') await switchMode(frame, mode)
    const surface = frame.locator(`.vditor-${mode}`).first()
    await expect(surface).toBeVisible()

    // Acceptance 1: last control of row one, up chevron while expanded.
    const rowOneLast = await toolbarOf(frame).evaluate((toolbar) => {
      const row = toolbar.querySelector<HTMLElement>(
        ':scope > .vmde-toolbar-row[data-vmde-toolbar-row="1"]',
      )
      const last = Array.from(row?.children ?? []).filter(
        (child) => getComputedStyle(child).display !== 'none',
      )
      return last[last.length - 1]
        ?.querySelector(':scope > [data-type]')
        ?.getAttribute('data-type')
    })
    expect(rowOneLast, `${mode} row one last control`).toBe('collapse-toolbar')
    await expectExpanded(frame, true)
    const modeControls = controlsIn(await readLayout(frame))

    // Caret and selection by OS input, then scroll, then the baseline.
    await surface.getByText('Paragraph 3 alpha').first().click()
    await xtest.key('Home')
    for (let index = 0; index < 4; index++) await xtest.key('Shift+Right')
    expect(await scrollDown(frame)).toBeGreaterThan(0)
    // Let Vditor's debounced undo checkpoint for the click and selection land first, so the
    // baseline holds only history that exists before the toggle is used.
    await settle(frame, 2000)
    const before = await webviewState(frame)
    const hostBefore = await hostState(evaluateInVSCode, file)
    expect(before.selectionText.length).toBeGreaterThan(0)
    expect(hostBefore.dirty).toBe(false)

    // Acceptance 2 and 3: click collapse then expand; nothing but the toolbar changes.
    await toggleOf(frame).click()
    await expectExpanded(frame, false)
    expectCollapsedFlow(
      await readLayout(frame),
      modeControls,
      `${mode} collapsed`,
    )
    expect(await webviewState(frame)).toEqual(before)
    expect(await hostState(evaluateInVSCode, file)).toEqual(hostBefore)
    await toggleOf(frame).click()
    await expectExpanded(frame, true)
    expect(await webviewState(frame)).toEqual(before)
    expect(await hostState(evaluateInVSCode, file)).toEqual(hostBefore)

    // Acceptance 2 (OS keyboard) and the Tab edge case: Escape then Tab reaches the toggle while
    // collapsed; Enter collapses/expands via the toggle and Space does too.
    await toggleOf(frame).click()
    await expectExpanded(frame, false)
    await surface.getByText('Paragraph 3 alpha').first().click()
    await xtest.key('Escape')
    await xtest.key('Tab')
    // Task 642: the collapsed row holds the controls too, so Tab lands on the roving stop and
    // Right reaches the toggle, the last control of the row.
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              document.activeElement?.closest('.vditor-toolbar') !== null &&
              document.activeElement?.hasAttribute('data-type'),
          ),
      )
      .toBe(true)
    for (let step = 0; step < 80; step++) {
      if (await toggleOf(frame).evaluate((el) => el === document.activeElement))
        break
      await xtest.key('Right')
    }
    await expect(toggleOf(frame)).toBeFocused()
    await xtest.key('Return')
    await expectExpanded(frame, true)
    await expect(toggleOf(frame)).toBeFocused()
    await xtest.key('space')
    await expectExpanded(frame, false)
    await xtest.key('Return')
    await expectExpanded(frame, true)
    const hostAfterKeys = await hostState(evaluateInVSCode, file)
    expect(hostAfterKeys).toEqual(hostBefore)
    expect((await webviewState(frame)).undoDepth).toBe(before.undoDepth)
  }

  expect((await hostState(evaluateInVSCode, file)).text).toBe(FIXTURE)
})

// The webview of the visible editor tab (a retained hidden tab keeps its own iframe).
const visibleFrame = (workbox: Page) =>
  workbox
    .frameLocator('iframe.webview:visible')
    .frameLocator('iframe[title="VMDE"], #active-frame')

// Shows a file in the VMDE editor without closing the others: opens a new tab, or focuses its tab.
const showFile = async (
  evaluateInVSCode: HostEvaluator,
  workbox: Page,
  file: string,
) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = visibleFrame(workbox)
  await expect(frame.locator('.vditor-ir').first()).toBeVisible({
    timeout: 60_000,
  })
  return frame
}

test('one collapse state for every editor and file: survives a webview reload, new editors and other files open in it, open editors follow', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const fileA = path.join(baseDir, 'toolbar-collapse-a.md')
  const fileB = path.join(baseDir, 'toolbar-collapse-b.md')
  writeFileSync(fileA, FIXTURE)
  writeFileSync(fileB, FIXTURE)
  let frame = await reopenVmdeFixture(evaluateInVSCode, workbox, fileA)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  await expectExpanded(frame, true)
  const expandedControls = controlsIn(await readLayout(frame))
  await toggleOf(frame).click()
  await expectExpanded(frame, false)

  // Acceptance 5 (reload): reload the webviews; the host sends the collapsed state again.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand(
        'workbench.action.webview.reloadWebviewAction',
      )
    },
    [fileA] as [string],
  )
  // The reload replaces the webview frame; resolve the visible one again and let the retrying
  // assertions below wait for the new document.
  frame = visibleFrame(workbox)
  await expect(frame.locator('.vditor-ir').first()).toBeVisible({
    timeout: 60_000,
  })
  await expectExpanded(frame, false)
  expectCollapsedFlow(
    await readLayout(frame),
    expandedControls,
    'collapsed after a webview reload',
  )
  expect(await hostState(evaluateInVSCode, fileA)).toEqual({
    text: FIXTURE,
    dirty: false,
  })

  // F2 (supersedes "a new editor opens expanded"): a new editor of the same file, closed then
  // opened again, opens collapsed.
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, fileA)
  await expectExpanded(frame, false)

  // Owner (2026-10-15): all files receive the same state. A different file opens collapsed.
  frame = await showFile(evaluateInVSCode, workbox, fileB)
  await expectExpanded(frame, false)

  // Expanding in the second editor is followed by the first (no click there).
  await toggleOf(frame).click()
  await expectExpanded(frame, true)
  frame = await showFile(evaluateInVSCode, workbox, fileA)
  await expectExpanded(frame, true)

  // And the other way round: collapsing in the first is followed by the second.
  await toggleOf(frame).click()
  await expectExpanded(frame, false)
  frame = await showFile(evaluateInVSCode, workbox, fileB)
  await expectExpanded(frame, false)

  // Presentation only: neither file changed or became dirty.
  for (const file of [fileA, fileB])
    expect(await hostState(evaluateInVSCode, file)).toEqual({
      text: FIXTURE,
      dirty: false,
    })
})

// Follow-up F2: the value outlives VS Code. The harness's own VS Code keeps workspace storage in
// memory (it is launched with --extensionTestsPath), so a restart cannot be modelled with its
// electronApp; this case launches the installed VS Code itself, twice, on the same user-data
// directory and workspace folder (the design of wiki-persistent-keys.spec.ts, Task 638). Without
// the harness channel there is no evaluateInVSCode: files open through Quick Open, as a user does,
// and the document is read from disk.
const RESTART_ONE = 'collapse-restart-one.md'
const RESTART_TWO = 'collapse-restart-two.md'

interface ToolbarProbe {
  // Painted frames in which any toolbar (the live one or the teaser's placeholder) was taller than
  // the collapsed strip, and all painted frames sampled.
  tallFrames: number
  frames: number
  // What the first few tall frames showed: the height, the class and whether the teaser was there.
  tall: string[]
  // `toolbarCollapsed` of the inlined init payload and of every init message.
  inits: unknown[]
}

// Runs at document start in every frame of the workbench page; only child frames (the webviews)
// record. A webview's content frame starts as `about:blank` and its document is replaced, so a 1 ms
// timer (it survives the replacement) arms a frame sampler on every new root element.
function toolbarProbeScript() {
  if (window.top === window) return
  const store: ToolbarProbe = { tallFrames: 0, frames: 0, tall: [], inits: [] }
  ;(window as unknown as { __toolbarProbe: ToolbarProbe }).__toolbarProbe =
    store
  let armedOn: Element | null = null
  const sample = (root: Element) => {
    if (root !== document.documentElement) return
    const toolbars = Array.from(document.querySelectorAll('.vditor-toolbar'))
    if (toolbars.length > 0) {
      store.frames++
      if (toolbars.some((bar) => bar.getBoundingClientRect().height > 30)) {
        store.tallFrames++
        if (store.tall.length < 5)
          store.tall.push(
            toolbars
              .map(
                (bar) =>
                  `${Math.round(bar.getBoundingClientRect().height)}px ${bar.className} teaser=${!!bar.closest('#vmde-prerender')} style=${bar.getAttribute('style')}`,
              )
              .join(' | '),
          )
      }
    }
    requestAnimationFrame(() => sample(root))
  }
  // The inlined init payload is read once per root, but only once its script tag has been parsed:
  // a tick before that finds nothing and must try again on the next tick or frame.
  let inlineReadOn: Element | null = null
  const readInline = (root: Element) => {
    if (inlineReadOn === root) return
    const inline = document.getElementById('vmark-init')?.textContent
    if (!inline) return
    try {
      store.inits.push(JSON.parse(inline).toolbarCollapsed)
      inlineReadOn = root
    } catch {
      /* not fully parsed yet; the next tick retries */
    }
  }
  setInterval(() => {
    const root = document.documentElement
    if (!root) return
    if (root !== armedOn) {
      armedOn = root
      window.addEventListener(
        'message',
        (event) => {
          const data = event.data as {
            command?: string
            type?: string
            toolbarCollapsed?: unknown
          } | null
          if (data?.command === 'update' && data.type === 'init')
            store.inits.push(data.toolbarCollapsed)
        },
        true,
      )
      document.addEventListener('DOMContentLoaded', () => readInline(root))
      requestAnimationFrame(() => sample(root))
    }
    readInline(root)
  }, 1)
}

const readToolbarProbe = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __toolbarProbe?: ToolbarProbe })
          .__toolbarProbe ?? null,
    )

// Keep what classifies a launch failure: the VS Code logs, the window and the process list.
async function attachLaunchFailure(workbox: Page, userDataDir: string) {
  const info = test.info()
  await info.attach('restart-screenshot', {
    body: await workbox.screenshot().catch(() => Buffer.from('')),
    contentType: 'image/png',
  })
  await info.attach('restart-processes', {
    body: await promisify(execFile)('ps', ['-eo', 'pid,etime,args'], {
      encoding: 'utf8',
    }).then(
      (result) => result.stdout,
      () => 'ps failed',
    ),
    contentType: 'text/plain',
  })
  const logsDir = path.join(userDataDir, 'logs')
  if (!existsSync(logsDir)) return
  for (const entry of readdirSync(logsDir, { recursive: true })) {
    const file = path.join(logsDir, String(entry))
    if (file.endsWith('.log'))
      await info.attach(`restart-log-${String(entry)}`, { path: file })
  }
}

test('the collapsed state is remembered after VS Code restarts, for the same and another file', async ({
  _vscodeInstall,
  extensionDevelopmentPath,
  baseDir,
}) => {
  test.setTimeout(300_000)
  for (const name of [RESTART_ONE, RESTART_TWO])
    writeFileSync(path.join(baseDir, name), FIXTURE)
  mkdirSync(path.join(baseDir, '.vscode'), { recursive: true })
  writeFileSync(
    path.join(baseDir, '.vscode', 'settings.json'),
    `${JSON.stringify({ 'workbench.editorAssociations': { '*.md': 'vmde.editor' } }, null, 2)}\n`,
  )
  // A profile of its own, kept across the two launches: the worker's shared profile also holds what
  // the earlier cases of this file left (collapsed state, saved mode) and the harness's VS Code may
  // still be shutting down on it, which made the first launch flaky (the extension did not load,
  // the editor opened as plain text, or the probe armed after the init message).
  const userDataDir = path.join(baseDir, 'restart-user-data')
  const launch = async (body: (workbox: Page) => Promise<void>) => {
    // The previous case's VS Code (the harness's) may still be shutting down; starting beside it
    // made the launch flaky. Wait, bounded, until no other main VS Code process of this install runs.
    const mainProcesses = async () =>
      (
        await promisify(execFile)('ps', ['-eo', 'pid,args'], {
          encoding: 'utf8',
        })
      ).stdout
        .split('\n')
        .filter(
          (line) =>
            line.includes(_vscodeInstall.installPath) &&
            !line.includes('--type='),
        ).length
    await expect.poll(mainProcesses, { timeout: 30_000 }).toBe(0)
    const env = { ...process.env }
    // Any VSCODE_* variable of the parent breaks custom webviews (as in the harness's own launch).
    for (const name of Object.keys(env))
      if (/^VSCODE_/i.test(name)) delete env[name]
    const app = await _electron.launch({
      executablePath: _vscodeInstall.installPath,
      env,
      args: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
        '--disable-updates',
        '--ozone-platform=x11',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        `--extensions-dir=${path.join(_vscodeInstall.cachePath, 'extensions')}`,
        `--user-data-dir=${userDataDir}`,
        `--extensionDevelopmentPath=${extensionDevelopmentPath as string}`,
        baseDir,
      ],
    })
    try {
      await app.context().addInitScript(toolbarProbeScript)
      const workbox = await app.firstWindow()
      await workbox.setViewportSize({ width: 1400, height: 900 })
      try {
        await body(workbox)
      } catch (error) {
        await attachLaunchFailure(workbox, userDataDir)
        throw error
      }
    } finally {
      // Closing the application writes the workspace and profile state.
      await app.close()
    }
  }
  const openByQuickOpen = async (workbox: Page, name: string) => {
    await workbox.locator('.monaco-workbench').waitFor({ timeout: 60_000 })
    // Keys typed before the quick-input box has focus are lost, so wait for its input to hold
    // focus (pressing Control+P again if it did not open) and fill it rather than typing blindly.
    const input = workbox.locator('.quick-input-widget input')
    let focused = false
    for (let attempt = 0; attempt < 3 && !focused; attempt++) {
      await workbox.keyboard.press('Control+P')
      focused = await expect(input)
        .toBeFocused({ timeout: 5_000 })
        .then(
          () => true,
          () => false,
        )
    }
    expect(focused, 'Quick Open took focus after up to three attempts').toBe(
      true,
    )
    await input.fill(name)
    // Enter before the file list is ready would pick nothing.
    await workbox
      .locator('.quick-input-list .monaco-list-row')
      .filter({ hasText: name })
      .first()
      .waitFor({ timeout: 30_000 })
    await workbox.keyboard.press('Enter')
    const frame = visibleFrame(workbox)
    await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.editorEpoch > 0,
    )
    return frame
  }

  await test.step('first launch: nothing stored, the editor opens expanded; collapsing it stores the value', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTART_ONE)
      await expectExpanded(frame, true)
      expect((await readToolbarProbe(frame))?.inits).toContain(false)
      await toggleOf(frame).click()
      await expectExpanded(frame, false)
    }))

  await test.step('second launch: the editor opens collapsed from its first painted frame, and so does another file; expanding restores the default for later runs', () =>
    launch(async (workbox) => {
      const frame = await openByQuickOpen(workbox, RESTART_ONE)
      await expectExpanded(frame, false)
      const probe = await readToolbarProbe(frame)
      // The sampler ran, the host handed the stored value over with the init, and no painted frame
      // showed a toolbar taller than the collapsed strip (no flash of the expanded toolbar).
      expect(probe?.frames, 'painted frames sampled').toBeGreaterThan(0)
      expect(probe?.inits).toContain(true)
      expect(probe?.inits).not.toContain(false)
      expect(probe?.tall, 'frames with an expanded toolbar').toEqual([])
      expect(probe?.tallFrames).toBe(0)

      // Owner: all files receive the same state.
      const other = await openByQuickOpen(workbox, RESTART_TWO)
      await expectExpanded(other, false)
      expect((await readToolbarProbe(other))?.inits).toContain(true)

      await toggleOf(other).click()
      await expectExpanded(other, true)
    }))
})

test('no collapse toggle when vmde.editor.toolbar is off', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'toolbar-collapse-off.md')
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await expect(toggleOf(frame)).toHaveCount(1)
  const setToolbar = (enabled: boolean) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.toolbar',
            args[0] === 'true',
            vscode.ConfigurationTarget.Global,
          )
      },
      [String(enabled)] as [string],
    )
  try {
    await setToolbar(false)
    // Acceptance 6: the toolbar is empty, so there is no toggle.
    await expect
      .poll(() =>
        toolbarOf(frame).evaluate((element) => element.childElementCount),
      )
      .toBe(0)
    await expect(toggleOf(frame)).toHaveCount(0)
  } finally {
    await setToolbar(true)
  }
  await expect(toggleOf(frame)).toHaveCount(1)
})

// Task 642: the collapsed row keeps the controls (A3), its buttons measure the toggle's size and
// run their actions (A4), the toggle keeps its box across collapse and expand (A7), and a measured
// gap separates it from the controls in both states (A8). Window widths: the webview is about the
// window width minus the 48 px activity bar.
test('collapsed row: prefix plus tail, button size and actions, toggle box and gap (642 A3, A4, A7, A8)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = path.join(baseDir, 'toolbar-collapse-flow.md')
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file] as [string],
  )
  await workbox.setViewportSize({ width: 1400, height: 900 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'collapse flow IR readiness' },
  )
  await expectExpanded(frame, true)
  const controls = controlsIn(await readLayout(frame))
  expect(controls.slice(-3)).toEqual(TAIL)

  // The layout of a state settles when two reads 300 ms apart agree.
  const settledLayout = async () => {
    let previous = ''
    await expect
      .poll(async () => {
        const next = JSON.stringify(await readLayout(frame))
        const stable = next === previous
        previous = next
        await settle(frame, 300)
        return stable
      })
      .toBe(true)
    return readLayout(frame)
  }
  const near = (actual: number, expected: number, tolerance: number) =>
    expect(Math.abs(actual - expected)).toBeLessThanOrEqual(tolerance)
  try {
    for (const width of [1400, 700, 500, 380]) {
      await workbox.setViewportSize({ width, height: 900 })
      await expectExpanded(frame, true)
      await settledLayout()
      const expanded = await toggleGeometry(frame)
      // A8 (expanded): the gap before the toggle.
      expect(expanded.gap, `expanded gap at ${width}`).toBeGreaterThanOrEqual(
        11.99,
      )

      await toggleOf(frame).click()
      await expectExpanded(frame, false)
      const layout = await settledLayout()
      // A3: the longest prefix that fits, Preview, Edit Mode and More last, the rest in More.
      expectCollapsedFlow(layout, controls, `collapsed at ${width}`)
      if (width === 1400) expect(layout.more).toEqual([])
      if (width <= 500) expect(layout.more.length).toBeGreaterThan(0)
      console.log(
        'TASK642_COLLAPSED_FLOW',
        JSON.stringify({ width, row: layout.rows[0], more: layout.more }),
      )
      const collapsed = await toggleGeometry(frame)
      // A8 (collapsed) and A7: the toggle keeps its box (x, y, w, h within 0.5 px).
      expect(collapsed.gap, `collapsed gap at ${width}`).toBeGreaterThanOrEqual(
        11.99,
      )
      for (const key of ['x', 'y', 'w', 'h'] as const)
        near(collapsed[key], expanded[key], 0.5)
      // A4: every collapsed button measures the toggle's size, icon included.
      await expectButtonsMatchToggle(frame, collapsed)
      const strip = await toolbarOf(frame).evaluate(
        (toolbar) => toolbar.getBoundingClientRect().height,
      )
      near(strip, 25, 1)

      await toggleOf(frame).click()
      await expectExpanded(frame, true)
      await settledLayout()
      const again = await toggleGeometry(frame)
      for (const key of ['x', 'y', 'w', 'h'] as const)
        near(again[key], expanded[key], 0.5)
    }

    // A4: a collapsed button runs its action. Select a word, Bold it from the collapsed row, then
    // Undo it from the collapsed row.
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await toggleOf(frame).click()
    await expectExpanded(frame, false)
    const value = () =>
      frame
        .locator('body')
        .evaluate(() =>
          (
            window as unknown as { vditor: { getValue(): string } }
          ).vditor.getValue(),
        )
    const original = await value()
    await selectAlpha(frame)
    await toolbarOf(frame).locator('[data-type="bold"]').click()
    await expect.poll(value).toContain('**alpha**')
    await toolbarOf(frame).locator('[data-type="undo"]').click()
    await expect.poll(value).toBe(original)

    // A3: a control that moved into More works from there, in the collapsed row. Narrow until one
    // of the formatting controls is in More.
    const MARKS: Record<string, string> = {
      strike: '~~alpha~~',
      'inline-code': '`alpha`',
      bold: '**alpha**',
    }
    let moved: string | undefined
    for (const width of [380, 300, 240]) {
      await workbox.setViewportSize({ width, height: 900 })
      const layout = await settledLayout()
      moved = Object.keys(MARKS).find((name) => layout.more.includes(name))
      if (moved) break
    }
    expect(moved, 'a formatting control moved into More').toBeTruthy()
    await selectAlpha(frame)
    await toolbarOf(frame)
      .locator('.vmde-toolbar-more > [data-type="more"]')
      .click()
    await toolbarOf(frame)
      .locator(
        `.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type="${moved}"]`,
      )
      .click()
    await expect.poll(value).toContain(MARKS[moved as string])
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await toolbarOf(frame).locator('[data-type="undo"]').click()
    await expect.poll(value).toBe(original)
  } finally {
    await workbox.setViewportSize({ width: 1400, height: 900 })
    if ((await toggleOf(frame).getAttribute('aria-expanded')) === 'false')
      await toggleOf(frame).click()
  }
})
