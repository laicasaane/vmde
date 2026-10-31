import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'
import { selectEditorText } from './editor-selection'

// Task 646 (webview side): every plain `edit` carries the `revision` of the last host `update` the
// webview applied, and typing that has not reached the host yet is posted, with the OLD revision,
// before an incoming `update` replaces the DOM. The host then recognizes the edit as made from
// older text and refuses it with a warning instead of the typing vanishing silently (decisions D1
// and D2 in the task record). This runs the real webview entry (main.ts, as
// external-update-undo-base.spec.ts); the host's `update` is posted as a window message.

const DOC =
  'Alpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia juliet kilo lima.\n'
const DOC_UPDATED =
  'Alpha bravo charlie delta.\n\nEcho `foxtrot` golf hotel.\n\nIndia JULIET kilo lima.\n'
const NEEDLE = 'Alpha bravo charlie delta.'
const FIRST_REVISION = 3
const NEXT_REVISION = 4

async function open(page: Page) {
  const init = {
    command: 'update',
    type: 'init',
    content: DOC,
    revision: FIRST_REVISION,
    cdn: '/vditor',
    options: { showToolbar: true, defaultMode: 'ir' },
    theme: 'light',
    wiki: { enabled: false },
    e2e: true,
  }
  await page.addInitScript((message) => {
    const win = window as any
    win.__posted = []
    win.acquireVsCodeApi = () => ({
      postMessage: (posted: any) => {
        win.__posted.push(posted)
        if (posted?.command === 'ready') window.postMessage(message, '*')
      },
      getState: () => undefined,
      setState: () => undefined,
    })
  }, init)
  await page.goto('/shortcut-negative.html')
  await page.waitForFunction(
    () => {
      const win = window as any
      return (
        (win.__vmdeE2EReadiness?.editorEpoch ?? 0) > 0 &&
        win.vditor?.getCurrentMode?.() === 'ir'
      )
    },
    undefined,
    { timeout: 15_000 },
  )
  // Vditor's own first snapshot (after undoDelay), before any selection is placed.
  await page.waitForFunction(
    () => {
      const inner = (window as any).vditor.vditor
      return inner.undo[inner.currentMode].undoStack.length >= 1
    },
    undefined,
    { timeout: 15_000 },
  )
  await page.waitForTimeout(400)
}

// One character before the paragraph end: a caret at the very end of the block lands in the next one.
async function typeAtEndOfFirstParagraph(page: Page, key: string) {
  await page.keyboard.press('Shift')
  await page.evaluate(selectEditorText, [NEEDLE, NEEDLE.length - 1, 0] as const)
  await page.keyboard.press('Shift')
  await page.waitForTimeout(100)
  await page.keyboard.type(key)
}

const posts = (page: Page) =>
  page.evaluate(() => (window as any).__posted as any[])

test('(a) typing not yet posted is posted with the old revision before an update replaces the DOM', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })
  await typeAtEndOfFirstParagraph(page, 'K')
  // Inside the 250 ms edit debounce: the host's update arrives before the typing was posted.
  await page.evaluate(
    ([text, revision]) => {
      window.postMessage({ command: 'update', content: text, revision }, '*')
    },
    [DOC_UPDATED, NEXT_REVISION] as const,
  )
  await page.waitForFunction(
    () => (window as any).vditor.getValue().includes('JULIET'),
    undefined,
    { timeout: 10_000 },
  )
  const edits = (await posts(page)).filter(
    (m) => m.command === 'edit' && !m.exact,
  )
  const typed = edits.filter((m) => String(m.content).includes('deltaK.'))
  expect(
    typed.map((m) => m.revision),
    'the typed key must be posted with the revision the webview had applied',
  ).toEqual([FIRST_REVISION])
})

test('(b) every plain edit after an applied update carries that update’s revision', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })
  await typeAtEndOfFirstParagraph(page, 'K')
  await page.waitForFunction(
    () =>
      (window as any).__posted.some(
        (m: any) =>
          m.command === 'edit' && String(m.content).includes('deltaK.'),
      ),
    undefined,
    { timeout: 10_000 },
  )
  const firstEdits = (await posts(page)).filter(
    (m) => m.command === 'edit' && !m.exact,
  )
  expect(firstEdits.map((m) => m.revision)).toEqual(
    firstEdits.map(() => FIRST_REVISION),
  )
  expect(firstEdits.length).toBeGreaterThan(0)

  // An update the webview applies moves the revision; the next typing carries the new one.
  await page.evaluate(
    ([text, revision]) => {
      window.postMessage({ command: 'update', content: text, revision }, '*')
    },
    [DOC_UPDATED, NEXT_REVISION] as const,
  )
  await page.waitForFunction(
    () => (window as any).vditor.getValue().includes('JULIET'),
    undefined,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(500)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })
  await typeAtEndOfFirstParagraph(page, 'M')
  await page.waitForFunction(
    () =>
      (window as any).__posted.some(
        (m: any) =>
          m.command === 'edit' && String(m.content).includes('deltaM.'),
      ),
    undefined,
    { timeout: 10_000 },
  )
  const nextEdits = (await posts(page)).filter(
    (m) => m.command === 'edit' && !m.exact,
  )
  expect(nextEdits.map((m) => m.revision)).toEqual(
    nextEdits.map(() => NEXT_REVISION),
  )
})

test('(c) an update with the revision already applied does not publish pending typing', async ({
  page,
}) => {
  await open(page)
  await page.evaluate(() => {
    ;(window as any).__posted.length = 0
  })
  await typeAtEndOfFirstParagraph(page, 'K')
  // A repost of the same revision (after a rollback or a refused stale edit) shows host text the
  // webview already agrees with by revision: its pending typing is not flushed first.
  await page.evaluate(
    ([text, revision]) => {
      window.postMessage({ command: 'update', content: text, revision }, '*')
    },
    [DOC_UPDATED, FIRST_REVISION] as const,
  )
  await page.waitForFunction(
    () => (window as any).vditor.getValue().includes('JULIET'),
    undefined,
    { timeout: 10_000 },
  )
  await page.waitForTimeout(600)
  const typed = (await posts(page)).filter(
    (m) => m.command === 'edit' && String(m.content).includes('deltaK.'),
  )
  expect(typed).toEqual([])
})
