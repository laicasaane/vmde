import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const VIEWPORT_CLASS = 'vmde-outline-item--in-viewport'

type Frame = ReturnType<typeof wf>

async function projection(frame: Frame) {
  return frame.locator('body').evaluate((body, viewportClass) => {
    const v = (window as any).vditor.vditor
    const previewShown = v.preview.element.style.display === 'block'
    const surface = (
      previewShown ? v.preview.previewElement : v[v.currentMode].element
    ) as HTMLElement
    const root = (
      v.preview.element.contains(surface) ? surface.parentElement : surface
    ) as HTMLElement
    const rootRect = root.getBoundingClientRect()
    const headings = Array.from(
      surface.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'),
    )
    const surfaceEnd =
      surface === root
        ? rootRect.top + surface.scrollHeight - root.scrollTop
        : surface.getBoundingClientRect().top + surface.scrollHeight
    const expected = headings
      .filter((heading, index) => {
        const start = heading.getBoundingClientRect().top
        const end =
          headings[index + 1]?.getBoundingClientRect().top ?? surfaceEnd
        return end > rootRect.top + 4 && start < rootRect.bottom - 4
      })
      .map((heading) => heading.id)
    const actual = Array.from(
      body.querySelectorAll<HTMLElement>(
        `.vditor-outline li > span.${viewportClass}`,
      ),
    ).map((item) => item.dataset.targetId!)
    return {
      mode: v.currentMode as string,
      previewShown,
      rootRelation: root === surface ? 'surface' : 'preview-parent',
      rootClass: root.className as string,
      rootOverflowY: getComputedStyle(root).overflowY,
      rootClientHeight: root.clientHeight as number,
      rootScrollHeight: root.scrollHeight as number,
      expected,
      actual,
    }
  }, VIEWPORT_CLASS)
}

async function expectProjection(frame: Frame): Promise<void> {
  try {
    await expect
      .poll(async () => {
        const state = await projection(frame)
        return JSON.stringify(state.actual) === JSON.stringify(state.expected)
      })
      .toBe(true)
  } catch (error) {
    console.log(
      '[outline-viewport] projection mismatch',
      JSON.stringify(await projection(frame)),
    )
    throw error
  }
}

async function clickControl(frame: Frame, selector: string): Promise<void> {
  await frame.locator('body').evaluate((_body, controlSelector) => {
    document
      .querySelector<HTMLElement>(controlSelector)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, selector)
}

test('outline viewport projection follows real editor geometry across modes without mutating Markdown', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const fixture = path.join(__dirname, 'fixtures', 'outline-viewport.md')
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [fixture] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => !!(window as any).vditor?.vditor?.preview?.element),
    )
    .toBe(true)
  await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    v.options.outline.enable = true
    v.outline.toggle(v, true)
  })

  const initialMarkdown = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  const initialHostText = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments
        .find((document) => document.uri.fsPath === args[0])
        ?.getText(),
    [fixture] as [string],
  )

  await expectProjection(frame)
  const initial = await projection(frame)
  expect(initial.mode).toBe('ir')
  expect(initial.rootRelation).toBe('surface')
  expect(initial.rootOverflowY).toMatch(/auto|scroll/)
  expect(initial.rootScrollHeight).toBeGreaterThan(initial.rootClientHeight)
  expect(initial.actual).toEqual([])

  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop = root.querySelector<HTMLElement>('h1')!.offsetTop
  })
  await expectProjection(frame)

  const items = frame.locator('.vditor-outline li > span[data-target-id]')
  await expect.poll(() => items.first().getAttribute('role')).toBe('treeitem')
  await workbox.keyboard.press('Tab')
  await items.first().evaluate((item: HTMLElement) => item.focus())
  const focusState = await items.first().evaluate((item) => {
    const style = getComputedStyle(item)
    return {
      active: document.activeElement === item,
      outlineStyle: style.outlineStyle,
      viewport: item.classList.contains('vmde-outline-item--in-viewport'),
      ariaCurrent: item.hasAttribute('aria-current'),
      ariaSelected: item.hasAttribute('aria-selected'),
      tabbable: Array.from(
        document.querySelectorAll<HTMLElement>(
          '.vditor-outline li > span[data-target-id]',
        ),
      ).filter((row) => row.tabIndex === 0).length,
    }
  })
  expect(focusState).toMatchObject({
    active: true,
    outlineStyle: 'solid',
    viewport: true,
    ariaCurrent: false,
    ariaSelected: false,
    tabbable: 1,
  })
  await workbox.keyboard.press('ArrowDown')
  await expect
    .poll(() =>
      items.nth(1).evaluate((item) => item === document.activeElement),
    )
    .toBe(true)
  expect(await items.nth(1).getAttribute('tabindex')).toBe('0')
  expect(
    await items.nth(1).evaluate((item) => getComputedStyle(item).outlineStyle),
  ).toBe('solid')

  const longSection = await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    const root = v.ir.element as HTMLElement
    const headings = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')
    root.scrollTop = headings[3].offsetTop + 100
    return { owner: headings[3].id, next: headings[4].id }
  })
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const root = (window as any).vditor.vditor.ir.element as HTMLElement
        const owner = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[3]
        return (
          owner.getBoundingClientRect().bottom <
          root.getBoundingClientRect().top + 4
        )
      }),
    )
    .toBe(true)
  await expectProjection(frame)
  expect((await projection(frame)).actual).toContain(longSection.owner)

  await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    const root = v.ir.element as HTMLElement
    const next = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[4]
    const rootRect = root.getBoundingClientRect()
    root.scrollTop += next.getBoundingClientRect().top - (rootRect.top + 50)
  })
  await expectProjection(frame)
  expect((await projection(frame)).actual).toEqual([
    longSection.owner,
    longSection.next,
  ])

  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    const next = root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')[4]
    root.scrollTop +=
      next.getBoundingClientRect().top - (root.getBoundingClientRect().top - 1)
  })
  await expectProjection(frame)
  expect((await projection(frame)).actual).toEqual([longSection.next])

  const firstAction = items.first().locator('.vditor-outline__action')
  await firstAction.evaluate((action: HTMLElement) =>
    action.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  await expect(items.first()).toHaveAttribute('aria-expanded', 'false')
  await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    v.ir.element.scrollTop += 80
  })
  await expectProjection(frame)
  await expect(items.first()).toHaveAttribute('aria-expanded', 'false')
  await firstAction.evaluate((action: HTMLElement) =>
    action.dispatchEvent(new MouseEvent('click', { bubbles: true })),
  )
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(initialMarkdown)

  const finalSectionId = await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop = root.scrollHeight
    return Array.from(
      root.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6'),
    ).at(-1)!.id
  })
  await expectProjection(frame)
  expect((await projection(frame)).actual).toEqual([finalSectionId])

  await clickControl(frame, 'button[data-mode="wysiwyg"]')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.vditor.currentMode),
    )
    .toBe('wysiwyg')
  await expectProjection(frame)
  expect((await projection(frame)).rootRelation).toBe('surface')
  const wysiwygMarkdown = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  await frame.locator('body').evaluate(() => {
    ;(window as any).vditor.vditor.wysiwyg.element.scrollTop += 60
  })
  await expectProjection(frame)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(wysiwygMarkdown)

  await clickControl(frame, 'button[data-type="preview"]')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (window as any).vditor.vditor.preview.element.style.display,
        ),
    )
    .toBe('block')
  await expectProjection(frame)
  expect((await projection(frame)).rootRelation).toBe('preview-parent')
  const previewMarkdown = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  await frame.locator('body').evaluate(() => {
    ;(window as any).vditor.vditor.preview.element.scrollTop += 60
  })
  await expectProjection(frame)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(previewMarkdown)

  await clickControl(frame, 'button[data-type="preview"]')
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (window as any).vditor.vditor.preview.element.style.display,
        ),
    )
    .toBe('none')
  await clickControl(frame, 'button[data-mode="sv"]')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => ({
        mode: (window as any).vditor.vditor.currentMode,
        preview: (window as any).vditor.vditor.preview.element.style.display,
      })),
    )
    .toEqual({ mode: 'sv', preview: 'block' })
  // Vditor intentionally hides its outline on entry to SV. Reopen it explicitly so this leg tests
  // the controller's SV rendered-Preview path under its actual contract: while the outline is open.
  await frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    v.outline.toggle(v, true, false)
  })
  await expect(frame.locator('.vditor-outline')).toBeVisible()
  await expectProjection(frame)
  expect((await projection(frame)).rootRelation).toBe('preview-parent')
  const svMarkdown = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  await frame.locator('body').evaluate(() => {
    ;(window as any).vditor.vditor.preview.element.scrollTop += 60
  })
  await expectProjection(frame)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(svMarkdown)
  expect(
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) =>
        vscode.workspace.textDocuments
          .find((document) => document.uri.fsPath === args[0])
          ?.getText(),
      [fixture] as [string],
    ),
  ).toBe(initialHostText)

  await clickControl(frame, 'button[data-mode="ir"]')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => ({
        mode: (window as any).vditor.vditor.currentMode,
        preview: (window as any).vditor.vditor.preview.element.style.display,
      })),
    )
    .toEqual({ mode: 'ir', preview: 'none' })
  await items.first().evaluate((row: HTMLElement) => {
    row.dataset.preEdit = '1'
    const paragraph = document.querySelector<HTMLElement>(
      '.vditor-ir .vditor-reset > p',
    )!
    const range = document.createRange()
    range.selectNodeContents(paragraph)
    range.collapse(false)
    const selection = getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    ;(window as any).vditor.vditor.ir.element.focus()
  })
  await workbox.keyboard.type('x')
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).vditor.getValue()),
    )
    .not.toBe(initialMarkdown)
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => document.querySelector('[data-pre-edit]') === null),
    )
    .toBe(true)
  await expectProjection(frame)

  const afterEdit = await frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue())
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.ir.element as HTMLElement
    root.scrollTop += 120
  })
  await expectProjection(frame)
  expect(
    await frame
      .locator('body')
      .evaluate(() => (window as any).vditor.getValue()),
  ).toBe(afterEdit)
})
