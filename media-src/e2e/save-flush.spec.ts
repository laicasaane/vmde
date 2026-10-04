import { test, expect } from './coverage-fixture'

/**
 * E2e for the will-save flush (task 58; Task 580 CP2-12 moved it from a Ctrl/Cmd+S keydown watch
 * to the host's will-save request). A save fired right after typing must persist the just-typed
 * content. This is the strict case the harness surfaced: Vditor only calls its input hook after
 * its own ~800ms throttle, so when the save comes immediately NOTHING is pending yet — the flush
 * must still post the editor's live value (not save stale content waiting on Vditor's/our
 * debounce), and its reply must follow that edit.
 */
test('a will-save request right after typing posts the live content, then replies', async ({
  page,
}) => {
  await gotoFlush(page)
  await page.keyboard.type('ZZZ58')
  // Request the flush immediately — far inside Vditor's ~800ms input throttle, so nothing is
  // pending. The flush must still post the live value before the reply.
  await page.evaluate(() =>
    window.postMessage(
      { command: 'flush-for-save', requestId: 'save-flush-1' },
      '*',
    ),
  )
  await page.waitForFunction(() =>
    (window as any).__posted.some(
      (m: any) => m.command === 'flush-for-save-done',
    ),
  )
  const posted = await page.evaluate(() =>
    (window as any).__posted.map((m: any) => ({
      command: m.command,
      requestId: m.requestId,
      content: m.content,
    })),
  )
  const reply = posted.findIndex(
    (m: any) => m.command === 'flush-for-save-done',
  )
  expect(posted[reply].requestId).toBe('save-flush-1')
  const edits = posted.slice(0, reply).filter((m: any) => m.command === 'edit')
  expect(edits.length).toBeGreaterThan(0)
  expect(edits[edits.length - 1].content).toContain('ZZZ58')
})

// VS Code owns the Save key (and the user may remap it): the webview no longer reacts to a
// literal Ctrl+S, so pressing it inside the input throttle posts nothing by itself.
test('a Ctrl+S keydown alone no longer flushes', async ({ page }) => {
  await gotoFlush(page)
  await page.keyboard.type('KEY58')
  await page.keyboard.press('Control+s')
  const commands = await page.evaluate(() =>
    (window as any).__posted.map((m: any) => m.command),
  )
  expect(commands).toEqual([])
})

async function gotoFlush(page: any, query = '') {
  await page.addInitScript(() => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => (window as any).__posted.push(m),
      getState: () => undefined,
      setState: () => {
        /* vscode API stub: state persistence unused in this spec */
      },
    })
  })
  await page.goto(`/save-flush.html${query}`)
  await page.waitForFunction(() => (window as any).__ready === true)
  const box = await page.evaluate(() => {
    const el = (window as any).vditor.vditor.ir.element as HTMLElement
    const r = el.getBoundingClientRect()
    return { x: r.x + 8, y: r.y + 8 }
  })
  await page.mouse.click(box.x, box.y)
}

// The debounced (non-save) edit serialises + posts in onIdle. On a small doc no
// busy cursor is shown (it would flash); the edit just lands.
test('the debounced edit posts the typed content (small doc → no busy cursor)', async ({
  page,
}) => {
  await gotoFlush(page)
  await page.keyboard.type('DEB42')
  await page.waitForTimeout(1400) // Vditor input signal (~800ms) + debounce (250ms)
  const state = await page.evaluate(() => ({
    edits: (window as any).__posted.filter((m: any) => m.command === 'edit'),
    busyLog: (window as any).__busyLog,
  }))
  expect(state.edits.length).toBeGreaterThan(0)
  expect(state.edits[state.edits.length - 1].content).toContain('DEB42')
  expect(state.busyLog).toEqual([]) // small doc: no busy cursor
})

// On a large doc the slow serialize is wrapped: the busy cursor is set, a paint is
// yielded, then it's cleared — and the edit still lands (task 68 cursor-wait).
test('the debounced edit wraps the serialize in a busy cursor on a large doc', async ({
  page,
}) => {
  await gotoFlush(page, '?large=1')
  await page.keyboard.type('BIG7')
  await page.waitForTimeout(1400)
  const state = await page.evaluate(() => ({
    edits: (window as any).__posted.filter((m: any) => m.command === 'edit'),
    busyLog: (window as any).__busyLog,
    busyNow: document.body.classList.contains('vmde-busy'),
  }))
  expect(state.edits.length).toBeGreaterThan(0)
  expect(state.edits[state.edits.length - 1].content).toContain('BIG7')
  expect(state.busyLog).toEqual([true, false]) // set then cleared around serialize
  expect(state.busyNow).toBe(false) // cleared afterwards
})

// Perf C2: on large docs we widen Vditor's reserialise/undo idle window
// (undoDelay) so the multi-second full-doc serialise fires only after a real idle,
// not mid-edit. Here we set a wide window and assert the host edit is deferred past
// the active-typing moment, then still lands once idle.
test('a widened undoDelay defers the host edit out of the active-typing window', async ({
  page,
}) => {
  test.setTimeout(30000)
  await page.addInitScript(() => {
    ;(window as any).__posted = []
    ;(window as any).acquireVsCodeApi = () => ({
      postMessage: (m: any) => (window as any).__posted.push(m),
      getState: () => undefined,
      setState: () => {
        /* vscode API stub: state persistence unused in this spec */
      },
    })
  })
  await page.goto('/save-flush.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  // Simulate the large-doc tuning (undoDelay is read dynamically per input).
  await page.evaluate(() => {
    ;(window as any).vditor.vditor.options.undoDelay = 1500
  })

  const box = await page.evaluate(() => {
    const el = (window as any).vditor.vditor.ir.element as HTMLElement
    const r = el.getBoundingClientRect()
    return { x: r.x + 8, y: r.y + 8 }
  })
  await page.mouse.click(box.x, box.y)
  await page.keyboard.type('WIDE9')

  // Well within the widened window: no host edit yet (serialise deferred).
  await page.waitForTimeout(700)
  const editsEarly = await page.evaluate(
    () =>
      (window as any).__posted.filter((m: any) => m.command === 'edit').length,
  )
  expect(editsEarly).toBe(0)

  // After the window elapses, the edit lands.
  await page.waitForTimeout(1800)
  const state = await page.evaluate(() => ({
    edits: (window as any).__posted.filter((m: any) => m.command === 'edit'),
  }))
  expect(state.edits.length).toBeGreaterThan(0)
  expect(state.edits[state.edits.length - 1].content).toContain('WIDE9')
})
