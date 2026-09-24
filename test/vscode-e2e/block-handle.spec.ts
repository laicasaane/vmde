import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const ORIGINAL = 'alpha\n\n```ts\nconst x = 1\n```\n\nomega\n'
const MOVED = '```ts\nconst x = 1\n```\n\nalpha\n\nomega\n'
const MIXED =
  '# Heading\n\nbody\n\n- parent\n  - child\n- sibling\n\n> quote\n\n```js\nx()\n```\n\n| A | B |\n| --- | --- |\n| a | b |\n\n---\n'

test('real block handle moves a paragraph across a fence through one exact host transaction', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  let frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      timeout: 60_000,
      message: 'block handle editor readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
  const handle = frame.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(
      new DragEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
    fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  await workbox.keyboard.press('Control+y')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(MOVED)
  frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(frame, (state) => state.routerReady, {
    timeout: 60_000,
    message: 'reopened block handle editor readiness',
  })
  expect(readFileSync(file, 'utf8')).toBe(MOVED)
})

test.describe('Task 259 OS keyboard acceptance', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('physical Alt+Down and Alt+Up share exact move history', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const file = path.join(baseDir, 'block-handle-xtest.md')
    writeFileSync(file, ORIGINAL)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) => {
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
    await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === 'ir',
      {
        message: 'block handle XTEST readiness',
      },
    )
    const alpha = frame
      .locator('.vditor-ir .vditor-reset > p')
      .filter({ hasText: 'alpha' })
    await alpha.click()
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await xtest.key('alt+Down')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
    await alpha.click()
    await xtest.key('ctrl+z')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
    await alpha.click()
    await xtest.key('ctrl+y')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(MOVED)
    await alpha.click()
    await xtest.key('alt+Up')
    await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  })
})

test('handle Turn Into opens the shared native palette for the clicked block', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle-turn-into.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'block handle Turn Into readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
  await frame.locator('.vmde-block-handle').click()
  await frame
    .locator('.vmde-block-handle-menu [data-action="turnInto"]')
    .click()
  const picker = workbox.locator('.quick-input-widget input').first()
  await expect(picker).toBeVisible()
  await picker.fill('Heading 2')
  await picker.press('Enter')
  const changed = ORIGINAL.replace('alpha', '## alpha')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(changed)
})

test('handle Duplicate and Delete each make one guarded host edit and one undo step', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle-menu-actions.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'block handle menu action readiness',
    },
  )
  const alpha = frame
    .locator('.vditor-ir .vditor-reset > p')
    .filter({ hasText: 'alpha' })
  await alpha.hover()
  await frame.locator('.vmde-block-handle').click()
  await frame
    .locator('.vmde-block-handle-menu [data-action="duplicate"]')
    .click()
  const duplicated = ORIGINAL.replace('alpha\n\n', 'alpha\n\nalpha\n\n')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(duplicated)
  await alpha.first().click()
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  const omega = frame
    .locator('.vditor-ir .vditor-reset > p')
    .filter({ hasText: 'omega' })
  await omega.hover()
  await frame.locator('.vmde-block-handle').click()
  await frame.locator('.vmde-block-handle-menu [data-action="delete"]').click()
  const deleted = ORIGINAL.replace('\n\nomega\n', '\n')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(deleted)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(ORIGINAL)
})

test('mixed heading/list/quote/fence/table document exposes source-owned handles', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const mixed = MIXED
  const file = path.join(baseDir, 'block-handle-mixed.md')
  writeFileSync(file, mixed)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'mixed block handle readiness',
    },
  )
  const rendered = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  const dom = await frame
    .locator('body')
    .evaluate(() =>
      Array.from(
        document.querySelectorAll('.vditor-ir .vditor-reset > [data-block]'),
      ).map(
        (element) => `${element.tagName}:${element.getAttribute('data-type')}`,
      ),
    )
  const canonical = await frame.locator('body').evaluate((_body, source) => {
    const lute = (window as any).vditor.vditor.lute
    const dom = lute.Md2VditorIRDOM(source)
    const html = typeof dom === 'string' ? dom : dom.innerHTML
    const root = document.createElement('div')
    root.innerHTML = html
    return {
      projected: lute.VditorIRDOM2Md(html),
      tags: Array.from(root.querySelectorAll(':scope > [data-block]')).map(
        (e) => `${e.tagName}:${e.getAttribute('data-type')}`,
      ),
    }
  }, mixed)
  const tail = await frame
    .locator('body')
    .evaluate(
      () =>
        Array.from(
          document.querySelectorAll('.vditor-ir .vditor-reset > [data-block]'),
        ).at(-1)?.outerHTML,
    )
  expect(rendered).not.toBe(mixed)
  expect(canonical.projected).toBe(rendered)
  expect(tail).toContain('data-vmde-trailing')
  expect(dom.slice(0, -1)).toEqual(canonical.tags)
  const selectors = [
    '.vditor-ir .vditor-reset > h1',
    '.vditor-ir .vditor-reset > p',
    '.vditor-ir .vditor-reset > ul > li',
    '.vditor-ir .vditor-reset > blockquote',
    '.vditor-ir [data-type="code-block"]',
    '.vditor-ir .vditor-reset > table',
  ]
  for (const selector of selectors) {
    const target = frame.locator(selector).first()
    await expect(target).toBeVisible()
    if (selector.includes('> table')) {
      const interior = await target.evaluate((element) => {
        const table = element.getBoundingClientRect()
        const cell = element.querySelector('th,td')!.getBoundingClientRect()
        const x = cell.left + Math.min(20, cell.width / 3)
        const y = cell.top + cell.height / 2
        const resize = Array.from(
          document.querySelectorAll('.vmde-table-resize-handle'),
        ).map((handle) => handle.getBoundingClientRect())
        return {
          local: { x: x - table.left, y: y - table.top },
          blocked: resize.some(
            (rect) =>
              x >= rect.left &&
              x <= rect.right &&
              y >= rect.top &&
              y <= rect.bottom,
          ),
          tableLeft: table.left,
          cellLeft: cell.left,
          resizeXs: resize.map((rect) => [rect.left, rect.right]),
        }
      })
      expect(interior.blocked).toBe(false)
      await target.hover({ position: interior.local })
    } else await target.hover()
    await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  }
  expect(await docText(evaluateInVSCode, file)).toBe(mixed)
  await frame
    .locator('.vditor-ir .vditor-reset > p')
    .filter({ hasText: 'body' })
    .first()
    .hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  const moved = mixed
    .replace('body\n\n', '')
    .replace('```\n\n| A', '```\n\nbody\n\n| A')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(moved)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(mixed)
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            (_body, source) =>
              (window as any).__vmdeE2EExactMarkdown?.() === source,
            mixed,
          ),
      { timeout: 5000 },
    )
    .toBe(true)
  await frame.locator('.vditor-ir .vditor-reset > blockquote').hover()
  await frame.locator('.vmde-block-handle').click()
  await frame.locator('.vmde-block-handle-menu [data-action="delete"]').click()
  const deleted = mixed.replace('> quote\n\n', '')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(deleted)
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  expect(readFileSync(file, 'utf8')).toBe(deleted)
})

test('held block request declines after a real edit-mode switch', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle-stale-mode.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'stale block request readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const api = (window as any).vscode
    ;(window as any).__heldBlockRequest = null
    ;(window as any).__blockRequestMessages = []
    ;(window as any).__releaseBlockRequest = () =>
      api.postMessage((window as any).__heldBlockRequest)
    ;(window as any).vscode = {
      ...api,
      postMessage: (message: { command: string }) => {
        ;(window as any).__blockRequestMessages.push(message.command)
        if (message.command === 'request-block-action') {
          ;(window as any).__heldBlockRequest = message
          return true
        }
        return api.postMessage(message)
      },
    }
  })
  const dragState = await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    const beforeHidden = (handle as HTMLElement).hidden
    const startAccepted = handle.dispatchEvent(
      new DragEvent('dragstart', {
        bubbles: true,
        cancelable: true,
        dataTransfer: data,
      }),
    )
    const rect = fence.getBoundingClientRect()
    const dropAccepted = fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
    return {
      beforeHidden,
      afterHidden: (handle as HTMLElement).hidden,
      startAccepted,
      dropAccepted,
      mime: data.getData('application/x-vmde-block'),
      messages: (window as any).__blockRequestMessages,
    }
  })
  expect(dragState).toMatchObject({
    startAccepted: true,
    dropAccepted: false,
    mime: '0',
  })
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(() => Boolean((window as any).__heldBlockRequest)),
      { timeout: 3000 },
    )
    .toBe(true)
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'stale block request switched mode',
  })
  await frame
    .locator('body')
    .evaluate(() => (window as any).__releaseBlockRequest())
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() =>
          (window as any).__blockRequestMessages.includes(
            'cancel-block-action',
          ),
        ),
    )
    .toBe(true)
  expect(await docText(evaluateInVSCode, file)).toBe(ORIGINAL)
})

test('mixed WYSIWYG document retains source-owned block handles', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle-mixed-wysiwyg.md')
  writeFileSync(file, MIXED)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'mixed WYS source readiness',
    },
  )
  await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
  await frame.locator('button[data-mode="wysiwyg"]').click()
  await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
    message: 'mixed WYS mode readiness',
  })
  const dom = await frame
    .locator('body')
    .evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '.vditor-wysiwyg .vditor-reset > [data-block]',
        ),
      ).map(
        (element) => `${element.tagName}:${element.getAttribute('data-type')}`,
      ),
    )
  expect(dom).toEqual([
    'H1:null',
    'P:null',
    'UL:null',
    'BLOCKQUOTE:null',
    'DIV:code-block',
    'TABLE:null',
    'HR:null',
  ])
  const heading = frame.locator('.vditor-wysiwyg .vditor-reset > h1').first()
  await expect(heading).toBeVisible()
  await heading.hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  for (const selector of [
    '.vditor-wysiwyg .vditor-reset > p',
    '.vditor-wysiwyg .vditor-reset > ul > li',
    '.vditor-wysiwyg .vditor-reset > blockquote',
    '.vditor-wysiwyg [data-type="code-block"]',
  ]) {
    await frame.locator(selector).first().hover()
    await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  }
  await frame
    .locator('.vditor-wysiwyg .vditor-reset > table')
    .evaluate((element) =>
      element.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })),
    )
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  expect(await docText(evaluateInVSCode, file)).toBe(MIXED)
  await frame
    .locator('.vditor-wysiwyg .vditor-reset > p')
    .filter({ hasText: 'body' })
    .hover()
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = document.querySelector(
      '.vditor-wysiwyg .vditor-reset > blockquote',
    )!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  const moved = MIXED.replace('body\n\n', '').replace(
    '> quote\n\n',
    '> quote\n\nbody\n\n',
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(moved)
})

test('split editor keeps heading handle and table interior reachable', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const file = path.join(baseDir, 'block-handle-split.md')
  writeFileSync(file, MIXED)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
      await vscode.commands.executeCommand('workbench.action.closeSidebar')
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar')
      await vscode.commands.executeCommand('workbench.action.splitEditorRight')
    },
    [file] as [string],
  )
  const frame = workbox
    .locator('iframe.webview')
    .last()
    .contentFrame()
    .frameLocator('iframe[title="VMDE"], #active-frame')
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'split block handle readiness',
    },
  )
  const heading = frame.locator('.vditor-ir .vditor-reset > h1')
  await heading.hover()
  const handle = frame.locator('.vmde-block-handle')
  await expect(handle).toBeVisible()
  const gutter = await frame.locator('body').evaluate(() => {
    const block = document
      .querySelector('.vditor-ir .vditor-reset > h1')!
      .getBoundingClientRect()
    const handle = document
      .querySelector('.vmde-block-handle')!
      .getBoundingClientRect()
    return {
      blockLeft: block.left,
      blockRight: block.right,
      handleLeft: handle.left,
      handleRight: handle.right,
      viewport: window.innerWidth,
    }
  })
  expect(gutter.handleLeft).toBeGreaterThanOrEqual(0)
  expect(gutter.handleRight).toBeLessThanOrEqual(gutter.viewport)
  if (gutter.blockLeft >= 50)
    expect(gutter.handleRight).toBeLessThanOrEqual(gutter.blockLeft - 38)
  else expect(gutter.handleLeft).toBeGreaterThanOrEqual(gutter.blockRight - 12)
  const table = frame.locator('.vditor-ir .vditor-reset > table')
  const interior = await table.evaluate((element) => {
    const tableRect = element.getBoundingClientRect()
    const cell = element.querySelector('th,td')!.getBoundingClientRect()
    const x = cell.left + Math.min(20, cell.width / 3)
    const y = cell.top + cell.height / 2
    const handles = Array.from(
      document.querySelectorAll('.vmde-table-resize-handle'),
    ).map((node) => node.getBoundingClientRect())
    return {
      local: { x: x - tableRect.left, y: y - tableRect.top },
      blocked: handles.some(
        (rect) =>
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom,
      ),
    }
  })
  expect(interior.blocked).toBe(false)
  await table.hover({ position: interior.local })
  await expect(handle).toBeVisible()
  expect(await docText(evaluateInVSCode, file)).toBe(MIXED)
})

test('real heading handle moves its complete section and native Undo restores exact bytes', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const before =
    '# Alpha\n\nalpha body\n\n## Child\n\nchild body\n\n# Beta\n\nbeta body\n'
  const after =
    '# Beta\n\nbeta body\n\n# Alpha\n\nalpha body\n\n## Child\n\nchild body\n'
  const file = path.join(baseDir, 'block-handle-heading-section.md')
  writeFileSync(file, before)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'heading section handle readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > h1').first().hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const target = document.querySelectorAll('.vditor-ir .vditor-reset > h1')[1]
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = target.getBoundingClientRect()
    target.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(after)
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(before)
})

test('an external host edit invalidates a prepared block move without overwriting it', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const external = 'external replacement\n'
  const file = path.join(baseDir, 'block-handle-external-stale.md')
  writeFileSync(file, ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string]) => {
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
  await frame.locator('.vditor-ir').waitFor({ timeout: 90_000 })
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.mode === 'ir',
    {
      message: 'external stale block readiness',
    },
  )
  await frame.locator('.vditor-ir .vditor-reset > p').first().hover()
  await expect(frame.locator('.vmde-block-handle')).toBeVisible()
  await frame.locator('body').evaluate(() => {
    const api = (window as any).vscode
    ;(window as any).__heldBlockApply = null
    ;(window as any).__releaseBlockApply = () =>
      api.postMessage((window as any).__heldBlockApply)
    ;(window as any).vscode = {
      ...api,
      postMessage: (message: { command: string }) => {
        if (message.command === 'apply-block-action') {
          ;(window as any).__heldBlockApply = message
          return true
        }
        return api.postMessage(message)
      },
    }
  })
  await frame.locator('body').evaluate(() => {
    const handle = document.querySelector('.vmde-block-handle')!
    const fence = document.querySelector('.vditor-ir [data-type="code-block"]')!
    const data = new DataTransfer()
    handle.dispatchEvent(
      new DragEvent('dragstart', { bubbles: true, dataTransfer: data }),
    )
    const rect = fence.getBoundingClientRect()
    fence.dispatchEvent(
      new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: rect.bottom - 1,
        dataTransfer: data,
      }),
    )
  })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => Boolean((window as any).__heldBlockApply)),
    )
    .toBe(true)
  expect(await docText(evaluateInVSCode, file)).toBe(ORIGINAL)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: [string, string]) => {
      const uri = vscode.Uri.file(args[0])
      const document = await vscode.workspace.openTextDocument(uri)
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        uri,
        new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length),
        ),
        args[1],
      )
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error('external change failed')
    },
    [file, external] as [string, string],
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(external)
  await frame
    .locator('body')
    .evaluate(() => (window as any).__releaseBlockApply())
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .toBe(external)
  expect(await docText(evaluateInVSCode, file)).toBe(external)
})
