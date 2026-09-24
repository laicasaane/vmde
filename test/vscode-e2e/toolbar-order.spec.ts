import { writeFileSync } from 'node:fs'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  ExtensionId,
  MarkdownEditorViewType,
  reopenVmdeFixture,
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

const OWNER_ROW_ONE = [
  'headings',
  '|',
  'bold',
  'italic',
  'strike',
  'subscript',
  'superscript',
  'underline',
  '|',
  'link',
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
  'line',
  'code',
  'inline-code',
  '|',
  'emoji',
  '|',
  'math',
]
const OWNER_ROW_TWO = [
  'insert-before',
  'insert-after',
  '|',
  'upload',
  'table',
  '|',
  'undo',
  'redo',
  '|',
  'outline',
  'preview',
  '|',
  'navigate-back',
  'wiki-pages',
  '|',
  'edit-in-vscode',
  'edit-mode',
  'more',
]

test('real VS Code toolbar matches owner order and the Math icon follows all themes', async ({
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
    const readRows = () =>
      toolbar().evaluate((element) =>
        Array.from(
          element.querySelectorAll<HTMLElement>(':scope > .vmde-toolbar-row'),
        ).map((row) =>
          Array.from(row.children)
            .filter((child) => getComputedStyle(child).display !== 'none')
            .map((child) =>
              child.classList.contains('vditor-toolbar__divider')
                ? '|'
                : (child
                    .querySelector(':scope > [data-type]')
                    ?.getAttribute('data-type') ?? ''),
            ),
        ),
      )
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
    const expectedEnabledRows = [OWNER_ROW_ONE, OWNER_ROW_TWO]
    const expectedEnabledControls = expectedEnabledRows
      .flat()
      .filter((name) => name !== '|')
      .sort()

    await expect(toolbar()).toBeVisible({ timeout: 60_000 })
    await expect.poll(readRows).toEqual(expectedEnabledRows)
    expect(await readControls()).toEqual(expectedEnabledControls)

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

    await workbox.setViewportSize({ width: 700, height: 900 })
    await expect(
      toolbar().locator(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
      ),
    ).not.toHaveCount(0)
    const narrowRows = await readRows()
    expect(narrowRows).toHaveLength(2)
    for (const row of narrowRows) {
      expect(row[0]).not.toBe('|')
      expect(row[row.length - 1]).not.toBe('|')
      for (let index = 1; index < row.length; index++)
        expect(row[index - 1] === '|' && row[index] === '|').toBe(false)
    }
    expect(await readControls()).toEqual(expectedEnabledControls)

    await workbox.setViewportSize({ width: 1400, height: 900 })
    await expect(
      toolbar().locator(
        '.vmde-toolbar-more > .vditor-hint > .vditor-toolbar__item[data-vmde-overflow="true"]',
      ),
    ).toHaveCount(0)
    await expect.poll(readRows).toEqual(expectedEnabledRows)

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
    const disabledRowTwo = [
      ...OWNER_ROW_TWO.slice(0, OWNER_ROW_TWO.indexOf('navigate-back') - 1),
      ...OWNER_ROW_TWO.slice(OWNER_ROW_TWO.indexOf('edit-in-vscode') - 1),
    ]
    const expectedDisabledRows = [OWNER_ROW_ONE, disabledRowTwo]
    const expectedDisabledControls = expectedDisabledRows
      .flat()
      .filter((name) => name !== '|')
      .sort()
    await expect.poll(readRows).toEqual(expectedDisabledRows)
    expect(await readControls()).toEqual(expectedDisabledControls)
    await expect(
      toolbar().locator(
        '[data-type="navigate-back"], [data-type="wiki-pages"]',
      ),
    ).toHaveCount(0)
    await expect(mathInRow()).toBeVisible()
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
  await workbox.setViewportSize({ width: 700, height: 900 })

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

  const arrowsToMore = await frame.locator('body').evaluate(() => {
    const toolbar = document.querySelector('.vditor-toolbar')
    if (!toolbar) throw new Error('Toolbar missing during XTest navigation')
    const items = Array.from(
      toolbar.querySelectorAll<HTMLElement>(
        ':scope .vditor-toolbar__item > [data-type]',
      ),
    ).filter(
      (item) =>
        item.closest('.vditor-hint') === null &&
        getComputedStyle(item).display !== 'none',
    )
    const from = items.indexOf(document.activeElement as HTMLElement)
    const to = items.findIndex((item) => item.dataset.type === 'more')
    if (from < 0 || to < 0) throw new Error('More is not in the roving toolbar')
    return (to - from + items.length) % items.length
  })
  for (let index = 0; index < arrowsToMore; index++) await xtest.key('Right')
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
    targetType: 'headings',
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
