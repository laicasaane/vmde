import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const SOURCE = [
  ...Array.from({ length: 18 }, (_, i) => `Before table ${i}.\n`),
  '| Left | Center | Right |\n| :--- | :---: | ---: |\n| one | two | three |\n| four | five | six |\n',
  ...Array.from({ length: 30 }, (_, i) => `After table ${i}.\n`),
].join('\n')
const PANEL = '#fix-table-ir-wrapper .vditor-panel'

async function centerTable(frame: ReturnType<typeof wf>) {
  await frame
    .locator('.vditor-ir td')
    .first()
    .evaluate(async (cell) => {
      const root = cell.closest<HTMLElement>('.vditor-reset')!
      root.scrollTop +=
        cell.getBoundingClientRect().top -
        root.getBoundingClientRect().top -
        root.clientHeight * 0.7
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )
    })
  await frame.locator('.vditor-ir td').first().click()
  await expect(frame.locator(PANEL)).toBeVisible()
}

async function measurePanel(frame: ReturnType<typeof wf>) {
  return frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const wrapper = document.querySelector<HTMLElement>(
      '#fix-table-ir-wrapper',
    )!
    const panel = wrapper.firstElementChild!.getBoundingClientRect()
    const cell = root.querySelector('td')!.getBoundingClientRect()
    const clip = wrapper.parentElement!.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    return {
      scrollTop: root.scrollTop,
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight,
      rootTop: rootRect.top,
      panelTop: panel.top,
      cellTop: cell.top,
      offsetLeft: panel.left - cell.left,
      offsetTop: panel.top - cell.top,
      outsideRoot: !root.contains(wrapper),
      siblingClip: wrapper.parentElement!.parentElement === root.parentElement,
      panelHit: !!document
        .elementFromPoint(
          panel.left + panel.width / 2,
          panel.top + panel.height / 2,
        )
        ?.closest('#fix-table-ir-wrapper'),
      clipError: Math.max(
        Math.abs(clip.left - rootRect.left),
        Math.abs(clip.top - rootRect.top),
        Math.abs(clip.right - rootRect.right),
        Math.abs(clip.bottom - rootRect.bottom),
      ),
    }
  })
}

test('IR sibling table panel follows scroll and survives mode changes, XTEST history, save and reopen', async ({
  workbox,
  electronApp,
  evaluateInVSCode,
  baseDir,
}, testInfo) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'table-panel-lifecycle.md')
  writeFileSync(file, SOURCE)
  await evaluateInVSCode(async (vscode) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', true)
  })
  await evaluateInVSCode(
    async (vscode, [uri]: [string]) => {
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  const frame = wf(workbox)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'table panel IR readiness',
    },
  )
  const input = await createXtestInput(electronApp, workbox)
  expect(input.client.visible).toBe(true)
  await input.activateAndFocus()
  const { display, xid, pid } = input.client
  console.log('[table-panel XTEST]', JSON.stringify({ display, xid, pid }))
  const hostText = () => docText(evaluateInVSCode as never, file)
  await centerTable(frame)
  const originalPanel = await frame
    .locator('#fix-table-ir-wrapper')
    .elementHandle()
  const rendered = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  const before = await measurePanel(frame)
  expect(before.clientHeight).toBeGreaterThan(400)
  expect(
    before.scrollHeight - before.scrollTop - before.clientHeight,
  ).toBeGreaterThan(200)
  expect(before.outsideRoot).toBe(true)
  expect(before.siblingClip).toBe(true)
  expect(before.clipError).toBeLessThan(1)
  expect(before.panelHit).toBe(true)
  await frame.locator('.vditor-ir > .vditor-reset').evaluate(async (root) => {
    root.scrollTop += 200
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
  })
  const after = await measurePanel(frame)
  console.log('[table-panel scroll]', JSON.stringify({ before, after }))
  await testInfo.attach('table-panel-scroll.json', {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: 'application/json',
  })
  expect(after.scrollTop - before.scrollTop).toBe(200)
  expect(after.panelTop - before.panelTop).toBeCloseTo(-200, 1)
  expect(after.cellTop - before.cellTop).toBeCloseTo(-200, 1)
  expect(after.rootTop).toBe(before.rootTop)
  expect(after.offsetLeft).toBeCloseTo(before.offsetLeft, 1)
  expect(after.offsetTop).toBeCloseTo(before.offsetTop, 1)
  expect(after.panelHit).toBe(true)
  expect(
    await frame
      .locator('body')
      .evaluate(
        (_body, value) => (window as any).vditor.getValue() === value,
        rendered,
      ),
  ).toBe(true)

  const clipped = await frame.locator('body').evaluate(async () => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const panel = document.querySelector('#fix-table-ir-wrapper .vditor-panel')!
    const rootTop = root.getBoundingClientRect().top
    // Keep the test point inside the webview viewport but above the pane's clip
    // edge, proving the scrolled panel cannot intercept the toolbar there.
    root.scrollTop += panel.getBoundingClientRect().bottom - rootTop + 10
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    )
    const rect = panel.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + rect.height / 2
    return {
      aboveRoot: rect.bottom < rootTop,
      pointInViewport: x >= 0 && x < innerWidth && y >= 0 && y < innerHeight,
      panelHit: !!document
        .elementFromPoint(x, y)
        ?.closest('#fix-table-ir-wrapper'),
    }
  })
  console.log('[table-panel clip]', JSON.stringify(clipped))
  expect(clipped).toEqual({
    aboveRoot: true,
    pointInViewport: true,
    panelHit: false,
  })

  await frame.locator('.vditor-ir p').last().click()
  await expect(frame.locator(PANEL)).toBeHidden()
  for (const mode of ['wysiwyg', 'ir']) {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator(`button[data-mode="${mode}"]`).click()
    await waitForE2EReadiness(frame, (state) => state.mode === mode, {
      message: `table panel ${mode} readiness`,
    })
  }
  await centerTable(frame)
  expect(
    await originalPanel!.evaluate(
      (panel) => panel === document.getElementById('fix-table-ir-wrapper'),
    ),
  ).toBe(true)
  await expect(frame.locator('#fix-table-ir-wrapper')).toHaveCount(1)
  expect(await hostText()).toBe(SOURCE)
  const dirty = await evaluateInVSCode(
    async (vscode, [uri]: [string]) =>
      vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri)
        ?.isDirty,
    [file] as [string],
  )
  expect(dirty).toBe(false)
  expect(readFileSync(file, 'utf8')).toBe(SOURCE)

  // Actual OS keys arm the rectangle; the real panel pointerdown must retain it
  // so insertion adds two columns. Undo/Redo then rebuild IR content under the
  // retained sibling wrapper, whose action handlers must still work afterwards.
  await input.key('shift+Right')
  await expect(frame.locator('.vditor-ir .vmde-cell-selected')).toHaveCount(2)
  await frame.locator(PANEL).hover()
  await frame
    .locator('#fix-table-ir-wrapper [data-type="insertColumnR"]')
    .click()
  const columns = () => frame.locator('.vditor-ir th').count()
  await expect.poll(columns).toBe(5)
  await expect.poll(async () => (await hostText()) !== SOURCE).toBe(true)
  const inserted = await hostText()
  await input.key('ctrl+z')
  await expect.poll(columns).toBe(3)
  await expect.poll(hostText).toBe(SOURCE)
  await input.key('ctrl+y')
  await expect.poll(columns).toBe(5)
  await expect.poll(hostText).toBe(inserted)
  expect(
    await originalPanel!.evaluate(
      (panel) => panel === document.getElementById('fix-table-ir-wrapper'),
    ),
  ).toBe(true)
  await frame.locator('.vditor-ir td').nth(4).click()
  await frame.locator(PANEL).hover()
  await frame
    .locator('#fix-table-ir-wrapper [data-type="moveColumnLeft"]')
    .click()
  await expect.poll(async () => (await hostText()) !== inserted).toBe(true)
  await input.key('ctrl+z')
  await expect.poll(hostText).toBe(inserted)
  await expect.poll(columns).toBe(5)
  // Task 578 owns panel operation after history and byte fidelity through save/
  // reopen. The extra pre-move caret/DOM checkpoint is a pre-existing history
  // defect (Task 578 relays 10/11); its separate recorded evidence retains the
  // failed two-action Undo-chain observation. Save this known exact edit state.
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect
    .poll(() => readFileSync(file).equals(Buffer.from(inserted, 'utf8')))
    .toBe(true)
  const savedBytes = readFileSync(file)
  await originalPanel!.dispose()

  const reopened = await reopenVmdeFixture(
    evaluateInVSCode as never,
    workbox,
    file,
  )
  await waitForE2EReadiness(
    reopened,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 90_000,
      message: 'reopened table panel readiness',
    },
  )
  await expect.poll(hostText).toBe(inserted)
  await expect(reopened.locator('.vditor-ir th')).toHaveCount(5)
  await centerTable(reopened)
  await expect(reopened.locator('#fix-table-ir-wrapper')).toHaveCount(1)
  const reopenedGeometry = await measurePanel(reopened)
  expect(reopenedGeometry.outsideRoot).toBe(true)
  expect(reopenedGeometry.siblingClip).toBe(true)
  expect(reopenedGeometry.clipError).toBeLessThan(1)
  expect(reopenedGeometry.panelHit).toBe(true)
  expect(await hostText()).toBe(inserted)
  const reopenedDirty = await evaluateInVSCode(
    async (vscode, [uri]: [string]) =>
      vscode.workspace.textDocuments.find((doc) => doc.uri.fsPath === uri)
        ?.isDirty,
    [file] as [string],
  )
  expect(reopenedDirty).toBe(false)
  expect(readFileSync(file).equals(savedBytes)).toBe(true)
  const completed = {
    before,
    after,
    clipped,
    reopenedGeometry,
    savedBytes: savedBytes.length,
    savedSha256: createHash('sha256').update(savedBytes).digest('hex'),
    reopenedSourceExact: true,
    reopenedDiskExact: true,
    reopenedDirty,
  }
  const evidence = testInfo.outputPath('table-panel-lifecycle.json')
  writeFileSync(evidence, JSON.stringify(completed, null, 2))
  await testInfo.attach('table-panel-lifecycle.json', {
    path: evidence,
    contentType: 'application/json',
  })
  console.log('[table-panel completed]', JSON.stringify(completed))
})
