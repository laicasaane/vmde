import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'

// Task 626 S2 - acceptance 3. In IR, Vditor disables Bold, Italic and Strike inside inline code
// and ignores a click on a disabled button. The word-expand click listener (installed in
// production by boot/finish-init.ts) must then leave the selection alone: a real pointer click
// keeps the caret offset and an empty selection, also after the restore timer would have fired,
// and the document source does not change. The control is an enabled Bold click in plain text,
// which still expands to the word (so the listener really is installed in this page).

const DOC = 'Alpha bravo charlie.\n\nEcho `foxtrot` golf.\n'

interface Probe {
  collapsed: boolean
  selected: string
  anchorText: string | null
  anchorOffset: number
  value: string
  disabled: boolean
}

async function open(page: Page) {
  await page.goto('/format-hotkey-gate.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  await page.evaluate(async (doc) => {
    const w = window as any
    w.vditor.setValue(doc)
    w.__gate.installWordExpand()
    await new Promise((resolve) => setTimeout(resolve, 50))
  }, DOC)
}

/** Place the caret, let Vditor's own highlight settle, return the button's centre. */
async function settle(
  page: Page,
  target: [string, number, number],
  name: string,
) {
  await page.evaluate(async (target) => {
    const gate = (window as any).__gate
    gate.place({ text: target })
    gate.poisonAndSchedule()
    const result = await gate.waitHighlight(2000)
    if (!result.ok) throw new Error('highlight did not settle')
  }, target)
  const box = await page.evaluate((name) => {
    const b = (window as any).vditor.vditor.toolbar.elements[name]
      .children[0] as HTMLElement
    const r = b.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, name)
  return box
}

function probe(page: Page, name: string): Promise<Probe> {
  return page.evaluate((name) => {
    const w = window as any
    const sel = getSelection()
    const b = w.vditor.vditor.toolbar.elements[name].children[0] as HTMLElement
    return {
      collapsed: !!sel?.isCollapsed,
      selected: sel?.toString() ?? '',
      anchorText: sel?.anchorNode?.textContent ?? null,
      anchorOffset: sel?.anchorOffset ?? -1,
      value: w.vditor.getValue() as string,
      disabled: b.classList.contains('vditor-menu--disabled'),
    }
  }, name)
}

const settleTimers = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        setTimeout(
          () => requestAnimationFrame(() => setTimeout(resolve, 100)),
          50,
        ),
      ),
  )

for (const name of ['bold', 'italic', 'strike'] as const) {
  test(`a click on the disabled ${name} button inside IR inline code keeps the caret`, async ({
    page,
  }) => {
    await open(page)
    const at = await settle(page, ['foxtrot', 3, 0], name)
    const before = await probe(page, name)
    expect(before.disabled, 'Vditor disabled the button here').toBe(true)
    expect(before.collapsed).toBe(true)
    await page.mouse.click(at.x, at.y)
    await settleTimers(page)
    const after = await probe(page, name)
    expect(after.collapsed, 'selection stays empty').toBe(true)
    expect(after.selected).toBe('')
    expect(after.anchorText).toBe(before.anchorText)
    expect(after.anchorOffset).toBe(before.anchorOffset)
    expect(after.value, 'source unchanged').toBe(before.value)
  })
}

test('control: an enabled bold click in plain text still expands to the word', async ({
  page,
}) => {
  await open(page)
  const at = await settle(page, ['bravo', 2, 0], 'bold')
  const before = await probe(page, 'bold')
  expect(before.disabled).toBe(false)
  await page.mouse.click(at.x, at.y)
  await settleTimers(page)
  const after = await probe(page, 'bold')
  expect(after.value).not.toBe(before.value)
  expect(after.value).toContain('**bravo**')
})
