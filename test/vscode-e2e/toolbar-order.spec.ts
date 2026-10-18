import { mkdirSync, writeFileSync } from 'node:fs'
import type { Locator } from '@playwright/test'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'
import path from 'node:path'

type WikiSettingsSnapshot = {
  enabled?: boolean
  root?: string
  globalValue?: boolean
  workspaceValue?: boolean
  workspaceFolderValue?: boolean
  workspaceFolder: string
}

// Task 642: one ordered sequence (wiki on); `|` marks a group boundary. The flow pass distributes
// it into rows by width, so there is no fixed row split. Task 631's collapse toggle is a trailing
// control of row one with no separator.
const OWNER_SEQUENCE = [
  'undo',
  'redo',
  '|',
  'headings',
  '|',
  'bold',
  'italic',
  'underline',
  'strike',
  'inline-code',
  '|',
  'subscript',
  'superscript',
  '|',
  'link',
  '|',
  'list',
  'ordered-list',
  'check',
  '|',
  'outdent',
  'indent',
  '|',
  'quote',
  'callout',
  'details',
  'code',
  'math',
  'table',
  'line',
  '|',
  'upload',
  'emoji',
  '|',
  'insert-before',
  'insert-after',
  '|',
  'outline',
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'preview',
  'edit-mode',
  'more',
]
const TAIL = ['preview', 'edit-mode', 'more']
const TOGGLE = 'collapse-toolbar'
// Source mode: Vditor hides these five controls.
const SV_HIDDEN = [
  'outdent',
  'indent',
  'outline',
  'insert-before',
  'insert-after',
]

const withoutControls = (
  sequence: readonly string[],
  hidden: readonly string[],
) => {
  const kept: string[] = []
  for (const name of sequence) {
    if (hidden.includes(name)) continue
    // One rule stays between consecutive visible groups; none leads or doubles.
    if (name === '|' && (kept.length === 0 || kept.at(-1) === '|')) continue
    kept.push(name)
  }
  if (kept.at(-1) === '|') kept.pop()
  return kept
}
const sequenceFor = (wikiEnabled: boolean, source = false) => {
  let sequence: readonly string[] = OWNER_SEQUENCE
  if (!wikiEnabled)
    sequence = [
      ...sequence.slice(0, sequence.indexOf('navigate-back')),
      ...sequence.slice(sequence.indexOf('edit-in-vscode')),
    ]
  return source ? withoutControls(sequence, SV_HIDDEN) : sequence
}
const controlsOf = (sequence: readonly string[]) =>
  sequence.filter((name) => name !== '|')
// Group number of each control: the count of rules before it.
const groupsOf = (sequence: readonly string[]) => {
  const groups = new Map<string, number>()
  let group = 0
  for (const name of sequence) {
    if (name === '|') group++
    else groups.set(name, group)
  }
  return groups
}

interface Layout {
  rows: string[][]
  more: string[]
}

/** The visible tokens of each row (a hidden row reads empty) and the controls held by More. */
const readLayout = (toolbar: Locator): Promise<Layout> =>
  toolbar.evaluate((element) => {
    const token = (child: Element) =>
      child.classList.contains('vditor-toolbar__divider')
        ? '|'
        : (child
            .querySelector(':scope > [data-type]')
            ?.getAttribute('data-type') ?? '')
    const rows = Array.from(
      element.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
    ).map((row) =>
      getComputedStyle(row).display === 'none'
        ? []
        : Array.from(row.children)
            .filter((child) => getComputedStyle(child).display !== 'none')
            .map(token),
    )
    const more = Array.from(
      element.querySelectorAll<HTMLElement>(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
      ),
    ).map((button) => button.getAttribute('data-type') ?? '')
    return { rows, more }
  })

/** The flow contract for any width: every control once, a body prefix in the rows and the rest in
 *  More in sequence order, the tail last in the last row, and a rule only between two placed
 *  controls of different groups (A1, A2, A3). */
const expectFlowContract = (
  layout: Layout,
  sequence: readonly string[],
  label = '',
) => {
  const controls = controlsOf(sequence)
  const groups = groupsOf(sequence)
  const rowControls = layout.rows.map((row) =>
    row.filter((name) => name !== '|' && name !== TOGGLE),
  )
  const placed = rowControls.flat()
  expect(
    [...placed, ...layout.more].sort(),
    `${label} every control once`,
  ).toEqual([...controls].sort())
  const body = controls.filter((name) => !TAIL.includes(name))
  const placedBody = placed.filter((name) => !TAIL.includes(name))
  expect(placedBody, `${label} placed body is a prefix`).toEqual(
    body.slice(0, placedBody.length),
  )
  expect(layout.more, `${label} More holds the rest in order`).toEqual(
    body.slice(placedBody.length),
  )
  const used = rowControls.filter((row) => row.length > 0)
  expect(used.at(-1)?.slice(-3), `${label} tail ends the last row`).toEqual(
    TAIL,
  )
  for (const row of layout.rows) {
    const tokens = row.filter((name) => name !== TOGGLE)
    if (tokens.length === 0) continue
    expect(tokens[0], `${label} row starts with a control`).not.toBe('|')
    expect(tokens.at(-1), `${label} row ends with a control`).not.toBe('|')
    tokens.forEach((name, index) => {
      if (name === '|') {
        expect(
          groups.get(tokens[index - 1]),
          `${label} rule between groups`,
        ).not.toBe(groups.get(tokens[index + 1]))
      } else if (index > 0 && tokens[index - 1] !== '|') {
        expect(groups.get(tokens[index - 1]), `${label} missing rule`).toBe(
          groups.get(name),
        )
      }
    })
  }
}

interface Sizes {
  widths: Record<string, number>
  separator: number
}

/** Control and rule widths, read from the one-row layout so the fit is checked against
 *  measurements and not against the planner. */
const readSizes = (toolbar: Locator): Promise<Sizes> =>
  toolbar.evaluate((element) => {
    const widths: Record<string, number> = {}
    for (const wrapper of element.querySelectorAll<HTMLElement>(
      '.vmde-toolbar-row > .vditor-toolbar__item',
    )) {
      const name = wrapper
        .querySelector(':scope > [data-type]')
        ?.getAttribute('data-type')
      if (name) widths[name] = Math.ceil(wrapper.getBoundingClientRect().width)
    }
    const divider = element.querySelector<HTMLElement>(
      '.vmde-toolbar-row > .vditor-toolbar__divider',
    ) as HTMLElement
    const style = getComputedStyle(divider)
    const separator = Math.ceil(
      divider.getBoundingClientRect().width +
        Number.parseFloat(style.marginLeft) +
        Number.parseFloat(style.marginRight),
    )
    return { widths, separator }
  })

const rowWidthOf = (row: readonly string[], sizes: Sizes) =>
  row.reduce(
    (sum, token) =>
      sum +
      (token === '|'
        ? sizes.separator
        : token === TOGGLE
          ? 0
          : sizes.widths[token]),
    0,
  )

/** Every placed row fits its capacity (unless the tail alone is wider), and a first row that has
 *  a second row after it is maximal: the unit that starts row two would not also fit in row one. */
const expectRowsFit = (
  layout: Layout,
  sizes: Sizes,
  groups: Map<string, number>,
  capacity: number,
  label: string,
) => {
  for (const row of layout.rows) {
    const content = row.filter((token) => token !== TOGGLE)
    if (content.length > 3)
      expect(
        rowWidthOf(content, sizes),
        `${label} row fits`,
      ).toBeLessThanOrEqual(capacity)
  }
  if (layout.rows[1].length === 0) return
  const first = layout.rows[0].filter((token) => token !== TOGGLE)
  const next = layout.rows[1][0]
  const last = first.filter((token) => token !== '|').at(-1) as string
  const joiner = groups.get(last) === groups.get(next) ? 0 : sizes.separator
  // The tail moves as one unit, so when row two starts with it the whole tail is the next unit.
  const unit = TAIL.includes(next)
    ? TAIL.reduce((sum, name) => sum + sizes.widths[name], 0)
    : sizes.widths[next]
  expect(
    rowWidthOf(first, sizes) + joiner + unit,
    `${label} row one is maximal`,
  ).toBeGreaterThan(capacity)
}

/** Row one's width without the toggle, the room the planner fills. */
const readCapacity = (toolbar: Locator) =>
  toolbar.evaluate((element) => {
    const row = element.querySelector(
      '.vmde-toolbar-row[data-vmde-toolbar-row="1"]',
    ) as HTMLElement
    const toggle = element.querySelector('[data-type="collapse-toolbar"]')
      ?.parentElement as HTMLElement
    return Math.floor(
      row.getBoundingClientRect().width - toggle.getBoundingClientRect().width,
    )
  })

const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/

test('real VS Code toolbar flows one ordered sequence at every width and the Math icon follows all themes (642 A1, A2, A3, A5)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'task571-toolbar-order.md')
  writeFileSync(
    file,
    '# Task 571 toolbar order\n\nDisposable toolbar fixture.\n',
  )

  const setTheme = (name: string) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('theme.content', 'auto', vscode.ConfigurationTarget.Global)
        await vscode.workspace
          .getConfiguration('workbench')
          .update('colorTheme', args[0], vscode.ConfigurationTarget.Global)
      },
      [name] as [string],
    )
  const setWiki = (enabled: boolean, documentPath: string) =>
    evaluateInVSCode(
      async (
        vscode: typeof import('vscode'),
        args: [string, string, string],
      ) => {
        const documentUri = vscode.Uri.file(args[0])
        if (!vscode.workspace.getWorkspaceFolder(documentUri)) {
          const start = vscode.workspace.workspaceFolders?.length ?? 0
          const added = vscode.workspace.updateWorkspaceFolders(start, 0, {
            uri: vscode.Uri.file(args[1]),
            name: 'Task571',
          })
          if (!added)
            throw new Error('Could not add the toolbar fixture workspace')
        }
        const folder = vscode.workspace.getWorkspaceFolder(documentUri)
        if (!folder) throw new Error('Toolbar fixture has no workspace folder')

        const config = vscode.workspace.getConfiguration('vmde', documentUri)
        await config.update(
          'wiki.enabled',
          args[2] === 'true',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
        await config.update(
          'wiki.root',
          '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
        const readback = vscode.workspace.getConfiguration('vmde', documentUri)
        const inspected = readback.inspect<boolean>('wiki.enabled')
        return {
          enabled: readback.get<boolean>('wiki.enabled'),
          root: readback.get<string>('wiki.root'),
          globalValue: inspected?.globalValue,
          workspaceValue: inspected?.workspaceValue,
          workspaceFolderValue: inspected?.workspaceFolderValue,
          workspaceFolder: folder.uri.fsPath,
        }
      },
      [documentPath, path.dirname(documentPath), String(enabled)] as [
        string,
        string,
        string,
      ],
    )

  let frame = wf(workbox)
  try {
    await setTheme('Default Light Modern')
    const enabledWiki = (await setWiki(true, file)) as WikiSettingsSnapshot
    console.log('TASK571_WIKI_ENABLED_SETTING', JSON.stringify(enabledWiki))
    expect(enabledWiki).toMatchObject({
      enabled: true,
      root: '',
      workspaceFolderValue: true,
      workspaceFolder: path.dirname(file),
    })
    frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeSidebar')
        await vscode.commands.executeCommand(
          'workbench.action.closeAuxiliaryBar',
        )
      },
      [file] as [string],
    )
    await workbox.setViewportSize({ width: 1400, height: 900 })

    const toolbar = () => frame.locator('.vditor-toolbar')
    const readControls = () =>
      toolbar().evaluate((element) =>
        Array.from(
          element.querySelectorAll<HTMLElement>(
            ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type], .vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
          ),
        )
          .map((button) => button.getAttribute('data-type') ?? '')
          .sort(),
      )
    const sequence = sequenceFor(true)
    const expectedEnabledControls = [...controlsOf(sequence), TOGGLE].sort()

    await expect(toolbar()).toBeVisible({ timeout: 60_000 })
    // A1, A2: wide, the whole sequence is one row with the toggle last and row two not shown.
    await expect
      .poll(() => readLayout(toolbar()))
      .toEqual({ rows: [[...sequence, TOGGLE], []], more: [] })
    expect(await readControls()).toEqual(expectedEnabledControls)
    // A1: Preview sits directly beside Edit Mode, before it.
    expect(sequence.indexOf('preview') + 1).toBe(sequence.indexOf('edit-mode'))

    const mathInRow = () =>
      toolbar().locator(
        '.vmde-toolbar-row[data-vmde-toolbar-row="1"] > .vditor-toolbar__item > [data-type="math"]',
      )
    await expect(mathInRow()).toBeVisible()
    const mathIcon = () => mathInRow().locator(':scope > svg')
    await expect(mathIcon()).toHaveAttribute('width', '16')
    await expect(mathIcon()).toHaveAttribute('height', '16')
    await expect(mathIcon().locator('path')).toHaveAttribute(
      'fill',
      'currentColor',
    )

    const themes = [
      {
        name: 'Default Light Modern',
        bodyClass: /vscode-light/,
        fileName: 'light',
      },
      {
        name: 'Default Dark Modern',
        bodyClass: /vscode-dark/,
        fileName: 'dark',
      },
      {
        name: 'Default High Contrast',
        bodyClass: /vscode-high-contrast/,
        fileName: 'high-contrast',
      },
    ]
    const iconColors: string[] = []
    for (const theme of themes) {
      await setTheme(theme.name)
      await expect(frame.locator('body')).toHaveClass(theme.bodyClass, {
        timeout: 30_000,
      })
      const colors = await mathIcon()
        .locator('path')
        .evaluate((pathElement) => {
          const pathStyle = getComputedStyle(pathElement)
          const button = pathElement.closest(
            '[data-type="math"]',
          ) as HTMLElement | null
          if (!button)
            throw new Error('Math button missing around its icon path')
          return {
            color: getComputedStyle(button).color,
            fill: pathStyle.fill,
            fillAttribute: pathElement.getAttribute('fill'),
          }
        })
      expect(colors.fillAttribute).toBe('currentColor')
      expect(colors.fill).toBe(colors.color)
      expect(colors.color).not.toBe('rgba(0, 0, 0, 0)')
      iconColors.push(colors.color)
      await toolbar().screenshot({
        path: `/tmp/vmde-task571-toolbar-${theme.fileName}.png`,
      })
    }
    expect(new Set(iconColors).size).toBeGreaterThan(1)

    await setTheme('Default Dark Modern')
    await expect(frame.locator('body')).toHaveClass(/vscode-dark/)

    // A2, A3: at each width the rows hold the longest prefix of the sequence that fits, row two
    // starts with the next control, and the rest is in More (Emoji and the others are not pinned).
    // Window widths: the webview is about the window width minus the 48 px activity bar.
    const sizes = await readSizes(toolbar())
    const groups = groupsOf(sequence)
    const layouts = new Map<number, string>()
    const checkWidth = async (width: number) => {
      await workbox.setViewportSize({ width, height: 900 })
      // Wait for the flow to settle: two reads 300 ms apart agree.
      let previous = ''
      await expect
        .poll(
          async () => {
            const next = JSON.stringify(await readLayout(toolbar()))
            const stable = next === previous
            previous = next
            await frame
              .locator('body')
              .evaluate(
                () => new Promise((resolve) => setTimeout(resolve, 300)),
              )
            return stable
          },
          { message: `layout settles at ${width}` },
        )
        .toBe(true)
      const layout = await readLayout(toolbar())
      expectFlowContract(layout, sequence, `w${width}`)
      expectRowsFit(
        layout,
        sizes,
        groups,
        await readCapacity(toolbar()),
        `w${width}`,
      )
      expect(await readControls(), `w${width} inventory`).toEqual(
        expectedEnabledControls,
      )
      const key = JSON.stringify(layout)
      // A5: the same width gives the same layout whichever way it was reached.
      if (layouts.has(width))
        expect(key, `width ${width} is stable after resizing`).toBe(
          layouts.get(width),
        )
      else layouts.set(width, key)
      return layout
    }
    const wide = await checkWidth(1400)
    expect(wide.more).toEqual([])
    expect(wide.rows[1]).toEqual([])
    const two = await checkWidth(900)
    // Two rows: row two is shown and starts with a control that row one did not hold.
    expect(two.rows[1].length).toBeGreaterThan(0)
    expect(
      two.rows[0].filter((token) => token !== TOGGLE).length,
    ).toBeGreaterThan(0)
    await checkWidth(700)
    const narrow500 = await checkWidth(500)
    const narrow380 = await checkWidth(380)
    // Emoji is not pinned: it has moved into More at the narrow width.
    expect(narrow380.more).toContain('emoji')
    expect(narrow500.more.length).toBeGreaterThan(0)
    expect(narrow380.more.length).toBeGreaterThanOrEqual(narrow500.more.length)
    console.log(
      'TASK642_ORDER_FLOW',
      JSON.stringify([...layouts].map(([w, l]) => [w, JSON.parse(l)])),
    )
    // A5: wider, narrower and wider again, without a reload, gives the earlier layouts.
    await checkWidth(1400)
    await checkWidth(500)
    await checkWidth(900)
    await checkWidth(1400)
    // Row one's first control is Undo at every width, and the toggle stays in row one.
    for (const key of layouts.values()) {
      const layout = JSON.parse(key) as Layout
      expect(layout.rows[0][0]).toBe('undo')
      expect(layout.rows[0].at(-1)).toBe(TOGGLE)
    }

    // Edge case: Source mode hides five controls; the flow keeps exactly one rule between visible
    // groups (no leading, trailing or doubled rule) at one and two rows, then IR restores the full
    // sequence.
    await toolbar().locator('[data-type="edit-mode"]').click()
    await toolbar().locator('button[data-mode="sv"]').click()
    await expect(frame.locator('.vditor-sv')).toBeVisible({ timeout: 20_000 })
    const svSequence = sequenceFor(true, true)
    await expect
      .poll(() => readLayout(toolbar()))
      .toEqual({ rows: [[...svSequence, TOGGLE], []], more: [] })
    await workbox.setViewportSize({ width: 700, height: 900 })
    await expect
      .poll(async () => (await readLayout(toolbar())).rows[1].length)
      .toBeGreaterThan(0)
    expectFlowContract(await readLayout(toolbar()), svSequence, 'sv w700')
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await expect
      .poll(() => readLayout(toolbar()))
      .toEqual({ rows: [[...svSequence, TOGGLE], []], more: [] })
    await toolbar().locator('[data-type="edit-mode"]').click()
    await toolbar().locator('button[data-mode="ir"]').click()
    await expect(frame.locator('.vditor-ir')).toBeVisible({ timeout: 20_000 })
    await expect
      .poll(() => readLayout(toolbar()))
      .toEqual({ rows: [[...sequence, TOGGLE], []], more: [] })
    // The webview saves the edit mode 500 ms after a panel click (toolbar-actions.ts). Reopening
    // sooner would restore Source mode, so let the save land before the editor is closed.
    await settle(frame, 800)

    const disabledWiki = (await setWiki(false, file)) as WikiSettingsSnapshot
    console.log('TASK571_WIKI_DISABLED_SETTING', JSON.stringify(disabledWiki))
    expect(disabledWiki).toMatchObject({
      enabled: false,
      root: '',
      workspaceFolderValue: false,
      workspaceFolder: path.dirname(file),
    })
    frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await workbox.setViewportSize({ width: 1400, height: 900 })
    // A1: with wiki off the same sequence minus the two wiki controls and their rule.
    const disabledSequence = sequenceFor(false)
    expect(controlsOf(disabledSequence)).not.toContain('wiki-pages')
    await expect
      .poll(() => readLayout(toolbar()))
      .toEqual({ rows: [[...disabledSequence, TOGGLE], []], more: [] })
    expect(await readControls()).toEqual(
      [...controlsOf(disabledSequence), TOGGLE].sort(),
    )
    await expect(
      toolbar().locator(
        '[data-type="navigate-back"], [data-type="wiki-pages"]',
      ),
    ).toHaveCount(0)
    await expect(mathInRow()).toBeVisible()
    const disabledSizes = await readSizes(toolbar())
    for (const width of [900, 500]) {
      await workbox.setViewportSize({ width, height: 900 })
      await expect
        .poll(async () => {
          const layout = await readLayout(toolbar())
          return layout.rows[1].length + layout.more.length
        })
        .toBeGreaterThan(0)
      let previous = ''
      await expect
        .poll(async () => {
          const next = JSON.stringify(await readLayout(toolbar()))
          const stable = next === previous
          previous = next
          await frame
            .locator('body')
            .evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)))
          return stable
        })
        .toBe(true)
      const layout = await readLayout(toolbar())
      expectFlowContract(layout, disabledSequence, `wiki off w${width}`)
      expectRowsFit(
        layout,
        disabledSizes,
        groupsOf(disabledSequence),
        await readCapacity(toolbar()),
        `wiki off w${width}`,
      )
    }
  } finally {
    await setWiki(true, file)
    await setTheme('Default Dark Modern')
  }
})

test('More supports real keyboard activation and Escape through focused X11 input', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.setTimeout(120_000)

  const file = path.join(baseDir, 'task571-xtest-toolbar.md')
  writeFileSync(file, 'Task 571 XTest toolbar focus.\n')
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string, string]) => {
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
      await vscode.commands.executeCommand('workbench.view.explorer')
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'Task 571 XTest editor readiness' },
  )
  // Narrow enough that the webview (about window width minus the activity bar) overflows.
  await workbox.setViewportSize({ width: 500, height: 900 })

  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  const panel = toolbar.locator('.vmde-toolbar-more > .vditor-hint')
  await expect(
    toolbar.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
    ),
  ).not.toHaveCount(0)

  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  expect(xtest.client.xid).toMatch(/^0x[\da-f]+$/iu)
  console.log('TASK571_XTEST_CLIENT', JSON.stringify(xtest.client))

  await frame.locator('body').evaluate(() => {
    const diagnostics = { keys: [] as unknown[], focus: [] as unknown[] }
    ;(window as any).__task571InputDiagnostics = diagnostics
    document.addEventListener(
      'keydown',
      (event) => {
        const target = event.target as HTMLElement | null
        diagnostics.keys.push({
          key: event.key,
          trusted: event.isTrusted,
          targetTag: target?.tagName ?? '',
          targetType: target?.dataset.type ?? '',
          targetClass: target?.className ?? '',
        })
      },
      true,
    )
    document.addEventListener(
      'focusin',
      (event) => {
        const target = event.target as HTMLElement | null
        diagnostics.focus.push({
          event: 'in',
          tag: target?.tagName ?? '',
          type: target?.dataset.type ?? '',
          className: target?.className ?? '',
        })
      },
      true,
    )
    document.addEventListener(
      'focusout',
      (event) => {
        const target = event.target as HTMLElement | null
        diagnostics.focus.push({
          event: 'out',
          tag: target?.tagName ?? '',
          type: target?.dataset.type ?? '',
          className: target?.className ?? '',
        })
      },
      true,
    )
  })

  await frame.locator('.vditor-ir p').first().click()
  await xtest.key('Home')
  await xtest.key('Escape')
  await xtest.key('Tab')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const toolbar = document.querySelector('.vditor-toolbar')
        const active = document.activeElement as HTMLElement | null
        return Boolean(toolbar?.contains(active) && active?.dataset.type)
      }),
    )
    .toBe(true)

  // Walk with Right until More has focus. A count computed up front was wrong when the flow was
  // still placing controls after the resize (the walk stopped on Callout), so read the focus after
  // every key; the toolbar has fewer than 60 controls.
  const focusedType = () =>
    frame
      .locator('body')
      .evaluate(
        () => (document.activeElement as HTMLElement | null)?.dataset.type,
      )
  for (let step = 0; step < 60 && (await focusedType()) !== 'more'; step++)
    await xtest.key('Right')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (document.activeElement as HTMLElement | null)?.dataset.type,
        ),
    )
    .toBe('more')
  await xtest.key('Return')
  await expect(panel).toBeVisible()
  await xtest.key('Tab')
  const readMenuState = () =>
    frame.locator('body').evaluate(() => {
      const toolbar = document.querySelector('.vditor-toolbar')
      const button = toolbar?.querySelector<HTMLElement>(
        '.vmde-toolbar-more > [data-type="more"]',
      )
      const panelElement = toolbar?.querySelector<HTMLElement>(
        '.vmde-toolbar-more > .vditor-hint',
      )
      const active = document.activeElement as HTMLElement | null
      const items = panelElement
        ? Array.from(
            panelElement.querySelectorAll<HTMLElement>(
              ':scope > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
            ),
          )
        : []
      const diagnostics = (window as any).__task571InputDiagnostics
      return {
        activeTag: active?.tagName ?? '',
        activeType: active?.dataset.type ?? '',
        activeClass: active?.className ?? '',
        activeInToolbar: Boolean(toolbar?.contains(active)),
        activeInMore: Boolean(panelElement?.contains(active)),
        activeInEditor: Boolean(active?.closest('.vditor-ir')),
        menuTypes: items.map((item) => item.dataset.type ?? ''),
        menuIndex: items.indexOf(active as HTMLElement),
        expanded: button?.getAttribute('aria-expanded') ?? '',
        panelDisplay: panelElement
          ? getComputedStyle(panelElement).display
          : 'missing',
        keydownCount: diagnostics?.keys.length ?? 0,
        keydowns: diagnostics?.keys.slice(-8) ?? [],
        focus: diagnostics?.focus.slice(-10) ?? [],
      }
    })
  const beforeDown = await readMenuState()
  console.log('TASK571_XTEST_BEFORE_DOWN', JSON.stringify(beforeDown))
  await xtest.key('Down')
  const afterDown = await readMenuState()
  console.log('TASK571_XTEST_AFTER_DOWN', JSON.stringify(afterDown))

  expect(afterDown.keydownCount).toBeGreaterThan(beforeDown.keydownCount)
  expect(afterDown.keydowns.at(-1)).toMatchObject({
    key: 'ArrowDown',
    trusted: true,
    targetType: beforeDown.menuTypes[0],
  })
  expect(afterDown.activeInMore).toBe(true)
  expect(afterDown.menuIndex).toBeGreaterThanOrEqual(0)
  if (beforeDown.menuTypes.length === 1)
    expect(afterDown.activeType).toBe(beforeDown.activeType)
  else expect(afterDown.activeType).not.toBe(beforeDown.activeType)
  await xtest.key('Escape')
  await expect(panel).not.toBeVisible()
  const afterEscape = await readMenuState()
  console.log('TASK571_XTEST_AFTER_ESCAPE', JSON.stringify(afterEscape))
  expect(afterEscape.activeInEditor).toBe(true)
})

// Task 580 CP3-2 (Policy 6) — tooltips and accessible labels show the action name only. An
// extension cannot read a user's remapped keys, so a shown key could be wrong. This scans every
// label the webview renders (aria-label, which the CSS tooltip shows; placeholder; title) plus the
// text of the toolbar's dropdown rows (Headings, edit mode, More), in IR with the table panel open
// and in WYSIWYG with the table, code-language and heading popovers open. Task 579's Find widget
// labels are the one exception.
test('no tooltip, label or dropdown row outside Find names a key', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'task580-names-only.md')
  writeFileSync(
    file,
    '# Names only\n\nParagraph.\n\n| A | B |\n| --- | --- |\n| one | two |\n\n```js\nconst x = 1\n```\n',
  )
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  const ready = await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    { message: 'names-only editor readiness' },
  )

  // Every label outside Find as `kind="value"`, then the ones that name a key.
  const scan = () =>
    frame.locator('body').evaluate(() => {
      const KEY_HINT = /Ctrl|Cmd|Meta\+|Option\+|Alt\+|Shift\+|[⌘⇧⌥⌃]/
      const attributes = [
        'aria-label',
        'placeholder',
        'title',
        'data-vmde-tip',
        'data-vmde-row-tip',
        'aria-description',
      ]
      const labelled = Array.from(
        document.querySelectorAll(
          '[aria-label], [placeholder], [title], [data-vmde-tip], [data-vmde-row-tip], [aria-description]',
        ),
      ).filter((element) => !element.closest('.vmde-find-replace'))
      const labels = labelled.flatMap((element) =>
        attributes
          .filter((name) => element.hasAttribute(name))
          .map((name) => `${name}="${element.getAttribute(name)}"`),
      )
      const rows = Array.from(
        document.querySelectorAll('.vditor-toolbar .vditor-hint button'),
        (row) => `row="${(row.textContent ?? '').trim()}"`,
      )
      const all = [...labels, ...rows]
      return {
        labels: all.length,
        found: all.filter((label) => KEY_HINT.test(label)),
      }
    })

  // IR: the toolbar, its dropdown rows, and the table panel.
  await frame.locator('.vditor-ir td').first().click()
  await expect(frame.locator('#fix-table-ir-wrapper button')).toHaveCount(13)
  const ir = await scan()
  expect(ir.labels).toBeGreaterThan(60)
  expect(ir.found).toEqual([])
  await expect(
    frame.locator('.vditor-toolbar button[data-tag="h1"]'),
  ).toHaveText(/^\s*Heading 1\s*$/)
  await expect(
    frame.locator('.vditor-toolbar button[data-mode="wysiwyg"]'),
  ).toHaveText(/^\s*WYSIWYG\s*$/)

  // WYSIWYG: Vditor's own popovers.
  await frame.locator('body').evaluate(() => {
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
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await waitForE2EReadiness(
    frame,
    (state) => state.modeEpoch > ready.modeEpoch && state.mode === 'wysiwyg',
    { message: 'names-only editor reported WYSIWYG' },
  )
  // Vditor's own WYSIWYG popover (`vditor.wysiwyg.popover`).
  const readPopover = () =>
    frame.locator('body').evaluate(() => {
      const element = (
        window as unknown as {
          vditor: { vditor: { wysiwyg: { popover: HTMLElement } } }
        }
      ).vditor.vditor.wysiwyg.popover
      return {
        labels: Array.from(element.querySelectorAll('[aria-label]'), (node) =>
          node.getAttribute('aria-label'),
        ),
        placeholder:
          element.querySelector('input')?.getAttribute('placeholder') ?? '',
      }
    })
  const popoverLabels = async () => (await readPopover()).labels

  await frame.locator('.vditor-wysiwyg td').first().click()
  await expect.poll(popoverLabels).toContain('Insert 1 above')
  const table = await scan()
  expect(table.found).toEqual([])
  expect(await popoverLabels()).toEqual(
    expect.arrayContaining(['Left', 'Delete Row', 'Up', 'Remove']),
  )

  await frame.locator('.vditor-wysiwyg h1').click()
  await expect.poll(popoverLabels).toContain('ID')
  expect((await scan()).found).toEqual([])

  await frame
    .locator('.vditor-wysiwyg [data-type="code-block"]')
    .first()
    .click()
  await expect
    .poll(async () => (await readPopover()).placeholder)
    .toBe('Language')
  expect((await scan()).found).toEqual([])
})

// Task 642 A10, A11: every top-level button, every More row (authored or moved) and the toggle has a
// non-empty description with no key; every More row shows a visible label beside its icon, in both
// toolbar states. The painted description comes from the button's `::after`.
test('every control, More row and the toggle is described without a key, and every More row has a visible label (642 A10, A11)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'task642-tips-labels.md')
  writeFileSync(file, '# Task 642 tips\n\nDisposable tooltip fixture.\n')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file] as [string],
  )
  const toolbar = frame.locator('.vditor-toolbar')
  const toggle = toolbar.locator(`[data-type="${TOGGLE}"]`)
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  const direct =
    '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type]'

  const checkState = async (collapsed: boolean) => {
    const label = collapsed ? 'collapsed' : 'expanded'
    await workbox.setViewportSize({ width: 500, height: 900 })
    await expect
      .poll(async () => (await readLayout(toolbar)).more.length, {
        message: label,
      })
      .toBeGreaterThan(0)
    const tips = await frame.locator(direct).evaluateAll((buttons) =>
      buttons.map((button) => ({
        name: button.getAttribute('data-type'),
        tip: button.getAttribute('data-vmde-tip'),
        description: button.getAttribute('aria-description'),
        label: button.getAttribute('aria-label'),
      })),
    )
    expect(tips.length, `${label} direct buttons`).toBeGreaterThan(15)
    for (const entry of tips) {
      expect(entry.tip, `${label} ${entry.name} tip`).toBeTruthy()
      expect(entry.tip, `${label} ${entry.name} tip`).not.toMatch(KEY_HINT)
      expect(entry.description, `${label} ${entry.name} description`).toBe(
        entry.tip,
      )
      expect(entry.label, `${label} ${entry.name} name`).toBeTruthy()
    }
    // The toggle's description follows its state.
    expect(tips.find((entry) => entry.name === TOGGLE)?.tip).toBe(
      collapsed
        ? 'Expand the toolbar to full-size buttons'
        : 'Collapse the toolbar to one row of small buttons',
    )
    // Hover paints the description (not the name) in the real webview.
    await frame.locator('body').hover({ position: { x: 5, y: 400 } })
    await toolbar.locator('[data-type="undo"]').hover()
    await expect
      .poll(() =>
        toolbar
          .locator('[data-type="undo"]')
          .evaluate((button) => getComputedStyle(button, '::after').content),
      )
      .toBe('"Undo the last change"')

    // Every More row: icon, visible label, no key in its description; a row has no native title and
    // carries its description for the VMDE hover box.
    await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
    const panel = toolbar.locator('.vmde-toolbar-more > .vditor-hint')
    await expect(panel).toBeVisible()
    const rows = await panel.locator(':scope > *').evaluateAll((items) =>
      items
        .filter((item) => !item.classList.contains('vditor-toolbar__divider'))
        .map((item) => {
          const button = item.querySelector(
            ':scope > [data-type]',
          ) as HTMLElement
          const authoredLabel = button.querySelector('.vmde-menu-label')
          const box = button.getBoundingClientRect()
          const icon = button.querySelector('svg')?.getBoundingClientRect()
          return {
            name: button.getAttribute('data-type') ?? '',
            moved: item.classList.contains('vditor-toolbar__item'),
            hasIcon: Boolean(icon && icon.width > 0),
            iconLeftOfLabel: Boolean(icon) && icon!.right <= box.right,
            visible: box.width > 0 && box.height > 0,
            itemHidden: getComputedStyle(item).display === 'none',
            box: `${box.width}x${box.height}`,
            label: authoredLabel?.textContent?.trim() ?? '',
            generated: getComputedStyle(button, '::after').content,
            ariaLabel: button.getAttribute('aria-label') ?? '',
            hasTitle: button.hasAttribute('title'),
            rowTip: button.getAttribute('data-vmde-row-tip') ?? '',
            description: button.getAttribute('aria-description') ?? '',
          }
        }),
    )
    const names = rows.map((row) => row.name)
    for (const authored of [
      'both',
      'settings',
      'insert-anchor',
      'info',
      'about',
    ])
      expect(names, `${label} authored row`).toContain(authored)
    expect(
      rows.filter((row) => row.moved).length,
      `${label} moved rows`,
    ).toBeGreaterThan(5)
    // Vditor hides the Split View row (`both`) itself outside Source mode; it is the only
    // row that may be absent from the panel.
    expect(
      rows.filter((row) => row.itemHidden).map((row) => row.name),
      `${label} hidden rows`,
    ).toEqual(['both'])
    for (const row of rows.filter((entry) => !entry.itemHidden)) {
      expect(row.visible, `${label} ${row.name} visible ${row.box}`).toBe(true)
      expect(row.hasIcon, `${label} ${row.name} icon`).toBe(true)
      expect(row.hasTitle, `${label} ${row.name} native title`).toBe(false)
      expect(row.description, `${label} ${row.name} description`).toBeTruthy()
      expect(row.description, `${label} ${row.name} description`).not.toMatch(
        KEY_HINT,
      )
      expect(row.rowTip, `${label} ${row.name} hover text`).toBe(
        row.description,
      )
      if (row.moved)
        // A moved control's label is the generated content of its aria-label.
        expect(row.generated, `${label} ${row.name} label`).toBe(
          `"${row.ariaLabel}"`,
        )
      else {
        expect(row.label.length, `${label} ${row.name} label`).toBeGreaterThan(
          0,
        )
        expect(row.label, `${label} ${row.name} label`).not.toContain(
          'undefined',
        )
      }
    }
    const byName = Object.fromEntries(rows.map((row) => [row.name, row]))
    expect(byName.settings.label).toBe('Settings')
    expect(byName['insert-anchor'].label).toBe('Insert ID')
    await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
    await expect(panel).not.toBeVisible()
  }

  try {
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await checkState(false)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await checkState(true)
  } finally {
    if ((await toggle.getAttribute('aria-expanded')) === 'false')
      await toggle.click()
  }
})

// Task 642 A10: a More row's description is shown by VMDE's own hover box, not a native `title`
// (Chromium paints that in a window of its own, in a small system font CSS cannot style).
test('a More row shows the VMDE hover in the VS Code webview (642 A10)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const file = path.join(baseDir, 'task642-row-hover.md')
  writeFileSync(file, '# Task 642 row hover\n\nDisposable fixture.\n')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file] as [string],
  )
  await workbox.setViewportSize({ width: 500, height: 900 })
  const toolbar = frame.locator('.vditor-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  await expect
    .poll(async () => (await readLayout(toolbar)).more.length)
    .toBeGreaterThan(0)
  await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
  const row = toolbar
    .locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type]',
    )
    .first()
  await expect(row).toBeVisible()
  await expect(row, 'a row has no native title').not.toHaveAttribute(
    'title',
    /.*/,
  )
  const description = await row.getAttribute('aria-description')
  expect(description, 'the row has a description').toBeTruthy()

  const hover = frame.locator('body > .vmde-row-hover')
  await row.hover()
  await expect(hover).toBeVisible()
  await expect(hover).toHaveText(description ?? '')
  await expect(hover).toHaveAttribute('role', 'tooltip')
  // Beside the menu, never over its rows.
  const geometry = await frame.locator('body').evaluate(() => {
    const box = document
      .querySelector('body > .vmde-row-hover')!
      .getBoundingClientRect()
    const panel = document
      .querySelector('.vmde-toolbar-more > .vditor-hint')!
      .getBoundingClientRect()
    return {
      beside: box.left >= panel.right - 0.5 || box.right <= panel.left + 0.5,
      inside: box.left >= 0 && box.right <= window.innerWidth + 0.5,
    }
  })
  expect(geometry).toEqual({ beside: true, inside: true })
  // Escape hides it.
  await frame.locator('body').press('Escape')
  await expect(hover).toBeHidden()
})

// Task 642 A14: OS keys walk the toolbar in the visual order, in one row, two rows and the
// collapsed row. The toolbar states are restored afterwards.
test('OS arrow keys walk the toolbar in the visual order: one row, two rows, collapsed (642 A14)', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.setTimeout(240_000)
  const file = path.join(baseDir, 'task642-traversal.md')
  writeFileSync(file, '# Task 642 traversal\n\nDisposable fixture.\n')
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
    },
    [file] as [string],
  )
  const toolbar = frame.locator('.vditor-toolbar')
  const toggle = toolbar.locator(`[data-type="${TOGGLE}"]`)
  await expect(toolbar).toBeVisible({ timeout: 60_000 })
  const xtest = await createXtestInput(electronApp, workbox)
  const focusedType = () =>
    frame
      .locator('body')
      .evaluate(() => document.activeElement?.getAttribute('data-type'))
  const visualOrder = () =>
    frame
      .locator(
        '.vditor-toolbar > .vmde-toolbar-row > .vditor-toolbar__item > [data-type]',
      )
      .evaluateAll((buttons) =>
        buttons
          .filter((button) => getComputedStyle(button).display !== 'none')
          .map((button) => ({
            name: button.getAttribute('data-type') as string,
            left: button.getBoundingClientRect().left,
            top: button.getBoundingClientRect().top,
            row: Number(
              (button.closest('.vmde-toolbar-row') as HTMLElement).dataset
                .vmdeToolbarRow,
            ),
          }))
          .sort((a, b) => a.row - b.row || a.left - b.left),
      )
  const walk = async (label: string, firstStopIsUndo = false) => {
    const visual = await visualOrder()
    const expected = visual.map((entry) => entry.name)
    expect(new Set(expected).size, `${label} unique`).toBe(expected.length)
    // Each row reads left to right.
    for (let index = 1; index < visual.length; index++)
      if (visual[index].row === visual[index - 1].row)
        expect(
          visual[index].left,
          `${label} ${visual[index].name} follows`,
        ).toBeGreaterThan(visual[index - 1].left)
    await frame.locator('.vditor-ir p').first().click()
    await xtest.key('Home')
    await xtest.key('Escape')
    await xtest.key('Tab')
    // The toolbar remembers its last stop (roving tabindex), so only the first walk starts at Undo.
    await expect
      .poll(async () => (await focusedType()) !== null, {
        message: `${label} Tab reaches the toolbar`,
      })
      .toBe(true)
    if (firstStopIsUndo) expect(await focusedType()).toBe('undo')
    for (let guard = 0; (await focusedType()) !== 'undo'; guard++) {
      expect(guard, `${label} reaches Undo`).toBeLessThan(expected.length)
      await xtest.key('Right')
    }
    const walked = ['undo']
    for (let step = 1; step < expected.length; step++) {
      await xtest.key('Right')
      walked.push((await focusedType()) ?? '')
    }
    expect(walked, `${label} order`).toEqual(expected)
    await xtest.key('Right')
    await expect.poll(focusedType, { message: `${label} wraps` }).toBe('undo')
    await xtest.key('Left')
    await expect
      .poll(focusedType, { message: `${label} wraps back` })
      .toBe(expected.at(-1))
    return expected.length
  }

  try {
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect
      .poll(async () => (await readLayout(toolbar)).rows[1].length)
      .toBe(0)
    const oneRow = await walk('one row', true)
    await workbox.setViewportSize({ width: 700, height: 900 })
    await expect
      .poll(async () => (await readLayout(toolbar)).rows[1].length)
      .toBeGreaterThan(0)
    const twoRows = await walk('two rows')
    expect(twoRows).toBeGreaterThan(5)
    expect(oneRow).toBeGreaterThan(twoRows - 1)
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await walk('collapsed row')
  } finally {
    if ((await toggle.getAttribute('aria-expanded')) === 'false')
      await toggle.click()
  }
})

// Task 642 A13: the Wiki Pages control shows a 16 px "W" icon in the row and inside More, and a
// click from either place lists the wiki pages (the host's quick pick titled "Wiki Pages").
test('Wiki Pages shows its icon at 16 px in the row and in More and lists the pages from both (642 A13)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const dir = path.join(baseDir, 'task642-wiki')
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'task642-wiki-home.md')
  writeFileSync(file, '# Home\n\nSee [[Other Page]].\n')
  writeFileSync(path.join(dir, 'Other Page.md'), '# Other\n')
  const setWiki = (enabled: boolean) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string, string]) => {
        const documentUri = vscode.Uri.file(args[0])
        if (!vscode.workspace.getWorkspaceFolder(documentUri))
          vscode.workspace.updateWorkspaceFolders(
            vscode.workspace.workspaceFolders?.length ?? 0,
            0,
            { uri: vscode.Uri.file(args[1]), name: 'Task642Wiki' },
          )
        const config = vscode.workspace.getConfiguration('vmde', documentUri)
        await config.update(
          'wiki.enabled',
          args[1] !== '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
        await config.update(
          'wiki.root',
          '',
          vscode.ConfigurationTarget.WorkspaceFolder,
        )
      },
      [file, enabled ? dir : ''] as [string, string],
    )
  await setWiki(true)
  try {
    const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeSidebar')
        await vscode.commands.executeCommand(
          'workbench.action.closeAuxiliaryBar',
        )
      },
      [file] as [string],
    )
    // Task 661: the reopen returns while the instant-paint overlay (which holds its own toolbar
    // copy) is the only toolbar in the document, so wait for it to go and read the live toolbar.
    await expect(frame.locator('#vmde-prerender')).toHaveCount(0, {
      timeout: 60_000,
    })
    const toolbar = frame.locator('#app .vditor-toolbar')
    await workbox.setViewportSize({ width: 1400, height: 900 })
    await expect(toolbar).toBeVisible({ timeout: 60_000 })
    const inRow = toolbar.locator(
      ':scope > .vmde-toolbar-row > .vditor-toolbar__item > [data-type="wiki-pages"]',
    )
    const inMore = toolbar.locator(
      '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"] > [data-type="wiki-pages"]',
    )
    const quickPick = workbox.locator('.quick-input-widget')
    const expectList = async (where: string) => {
      await expect(quickPick, `${where} opens the list`).toBeVisible({
        timeout: 20_000,
      })
      await expect(
        quickPick.locator('.monaco-list-row').filter({ hasText: 'Other Page' }),
        `${where} lists Other Page`,
      ).toHaveCount(1)
      await expect(
        quickPick
          .locator('.monaco-list-row')
          .filter({ hasText: 'task642-wiki-home' }),
        `${where} lists the home page`,
      ).toHaveCount(1)
      await workbox.keyboard.press('Escape')
      await expect(quickPick).toBeHidden()
    }
    const iconBox = (locator: Locator) =>
      locator
        .locator(':scope > svg')
        .first()
        .evaluate((svg) => {
          const box = svg.getBoundingClientRect()
          return {
            w: box.width,
            h: box.height,
            letter: (svg.innerHTML.match(/<path/g) ?? []).length > 0,
            fill: svg.querySelector('path')?.getAttribute('stroke') ?? '',
          }
        })

    await expect(inRow).toBeVisible()
    // The viewport has just been resized and the editor reopened, so the flow may still be
    // placing controls (a control being moved reads a 0 px icon): wait for the one-row layout.
    await expect
      .poll(async () => {
        const layout = await readLayout(toolbar)
        return layout.rows[1].length + layout.more.length
      })
      .toBe(0)
    await expect.poll(async () => (await iconBox(inRow)).w).toBe(16)
    const rowIcon = await iconBox(inRow)
    expect(rowIcon.w).toBe(16)
    expect(rowIcon.h).toBe(16)
    expect(rowIcon.letter).toBe(true)
    const rowDrawing = await inRow.locator(':scope > svg').first().innerHTML()
    await inRow.click()
    await expectList('the row')

    await workbox.setViewportSize({ width: 380, height: 900 })
    await expect(inMore).toHaveCount(1)
    await toolbar.locator('.vmde-toolbar-more > [data-type="more"]').click()
    await expect(inMore).toBeVisible()
    await expect.poll(async () => (await iconBox(inMore)).w).toBe(16)
    const moreIcon = await iconBox(inMore)
    expect(moreIcon.w).toBe(16)
    expect(moreIcon.h).toBe(16)
    // The same drawing in the row and in More.
    expect(await inMore.locator(':scope > svg').first().innerHTML()).toBe(
      rowDrawing,
    )
    await inMore.click()
    await expectList('More')
  } finally {
    await setWiki(false)
  }
})
