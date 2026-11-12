import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 004: Undo and Redo of IR restore the changed units and reach the host as one
// `history-delta`. Each case reads the file text through the VS Code document. The counters come
// from `window.__vmdeEditCounters` (end-to-end runs only); `update` and `history-transition` are
// recorded by wrapping the webview's message channel.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  historyDeltaPosts: number
  deltaPosts: number
  legacyEditPosts: number
  rootClone: number
  rootInnerHtmlRead: number
}

const FIXTURE = tableHeavyMarkdown(1)
const PARAGRAPH = '.vditor-ir .vditor-reset > p'
const CELL = '.vditor-ir .vditor-reset > table td'
const THIRD = 'Third paragraph introduces the list below.'
const TASKS = '# Tasks\n\n- [ ] one\n- [ ] two\n\nTail paragraph.\n'

async function open(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the history-delta editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await recordMessages(frame)
  return { frame, file }
}

/** Counts the webview's `history-transition` posts and the host's `update` messages. */
const recordMessages = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __hdSeen?: { updates: number; transitions: number; logs: string[] }
      vscode: { postMessage(message: unknown): void }
    }
    if (w.__hdSeen) return
    const seen = { updates: 0, transitions: 0, logs: [] as string[] }
    w.__hdSeen = seen
    const api = w.vscode
    w.vscode = Object.freeze({
      ...api,
      postMessage: (message: { command?: string; text?: string }) => {
        if (message?.command === 'history-transition') seen.transitions += 1
        if (
          message?.command === 'log' &&
          /unit-history/.test(message.text ?? '')
        )
          seen.logs.push(message.text as string)
        return api.postMessage(message)
      },
    })
    window.addEventListener('message', (event) => {
      if ((event.data as { command?: string } | null)?.command === 'update')
        seen.updates += 1
    })
  })

const seen = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __hdSeen: { updates: number; transitions: number; logs: string[] }
        }
      ).__hdSeen,
  )

const resetSeen = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const s = (window as unknown as { __hdSeen: Record<string, number> })
      .__hdSeen
    s.updates = 0
    s.transitions = 0
  })

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(length as number)
  }, FIXTURE.length)

const counters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      historyDeltaPosts: c.historyDeltaPosts,
      deltaPosts: c.deltaPosts,
      legacyEditPosts: c.legacyEditPosts,
      rootClone: c.rootClone,
      rootInnerHtmlRead: c.rootInnerHtmlRead,
    }
  })

async function caretAtEnd(
  workbox: Page,
  frame: Frame,
  selector: string,
  nth: number,
) {
  const target = frame.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

async function type(workbox: Page, text: string, cadence = 150) {
  for (const ch of text) {
    await workbox.keyboard.press(ch)
    await workbox.waitForTimeout(cadence)
  }
}

const hostEdit = (
  evaluateInVSCode: Evaluate,
  file: string,
  find: string,
  replacement: string,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (!doc) throw new Error('document not open')
      const at = doc.getText().indexOf(args[1])
      if (at < 0) throw new Error('text not found')
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        doc.uri,
        new vscode.Range(
          doc.positionAt(at),
          doc.positionAt(at + args[1].length),
        ),
        args[2],
      )
      await vscode.workspace.applyEdit(edit)
    },
    [file, find, replacement],
  )

const docVersion = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.version ?? -1,
    [file],
  ) as Promise<number>

const hostText = (evaluateInVSCode: Evaluate, file: string, expected: string) =>
  expect
    .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
    .toBe(expected)

const changedLines = (a: string, b: string): number => {
  const left = a.split('\n')
  const right = b.split('\n')
  let count = Math.abs(left.length - right.length)
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) count += 1
  }
  return count
}

const undo = async (workbox: Page) => {
  await workbox.keyboard.press('Control+z')
  await workbox.waitForTimeout(600)
}
const redo = async (workbox: Page) => {
  await workbox.keyboard.press('Control+y')
  await workbox.waitForTimeout(600)
}

test.describe('history delta (task 004)', () => {
  test('paragraph Undo and Redo', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-paragraph.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await resetCounters(frame)
    await type(workbox, 'abc')
    await settle(frame, 1000)
    const typed = FIXTURE.replace(THIRD, `${THIRD}abc`)
    await hostText(evaluateInVSCode, file, typed)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, FIXTURE)
    await redo(workbox)
    await hostText(evaluateInVSCode, file, typed)
    const c = await counters(frame)
    expect(c.historyDeltaPosts).toBe(2)
    expect(c.rootClone).toBe(0)
    expect(c.rootInnerHtmlRead).toBe(0)
  })

  test('cell Undo', async ({ workbox, evaluateInVSCode, baseDir }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-cell.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, CELL, 7)
    await type(workbox, 'xy')
    await settle(frame, 1000)
    const typed = await docText(evaluateInVSCode, file)
    expect(typed).not.toBe(FIXTURE)
    expect(changedLines(FIXTURE, typed)).toBe(1)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, FIXTURE)
  })

  test('native coupling: a proven walk keeps the host stack in step', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-native.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await type(workbox, 'a')
    await settle(frame, 1000)
    await type(workbox, 'b')
    await settle(frame, 1000)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, FIXTURE.replace(THIRD, `${THIRD}a`))
    // The walk was proven, so VS Code's own Undo continues from the matching stack position.
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('undo')
    }, [])
    await hostText(evaluateInVSCode, file, FIXTURE)
  })

  // Not driven end to end: an external change reaches the webview as an `update` that rebuilds the
  // DOM and starts a fresh history (guarantee 22), so no entry survives to be declined. The forward
  // write of a declined walk is covered by the host unit tests (delta-writer, history-coupling).

  test('a refused precondition resynchronizes the webview', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-refused.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await type(workbox, 'a')
    await settle(frame, 1000)
    await resetSeen(frame)
    // The host changes the paragraph the webview typed in.
    await hostEdit(
      evaluateInVSCode,
      file,
      `${THIRD}a`,
      'Host text for the third paragraph.',
    )
    await settle(frame, 1500)
    expect((await seen(frame)).updates).toBe(1)
    await undo(workbox)
    const hostChange = FIXTURE.replace(
      THIRD,
      'Host text for the third paragraph.',
    )
    await hostText(evaluateInVSCode, file, hostChange)
    await expect(frame.locator(PARAGRAPH).nth(2)).toHaveText(
      'Host text for the third paragraph.',
    )
  })

  test('Source keeps the old engine', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-source.md',
      FIXTURE,
    )
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="sv"]').click()
    await waitForE2EReadiness(
      frame,
      (snapshot) =>
        snapshot.routerReady &&
        snapshot.editorEpoch > 0 &&
        snapshot.mode === 'sv',
      { timeout: 60_000, message: 'Source mode readiness' },
    )
    await recordMessages(frame)
    await resetCounters(frame)
    await frame.locator('.vditor-sv').first().click()
    await workbox.keyboard.press('Control+End')
    await type(workbox, 'x')
    await settle(frame, 1000)
    await undo(workbox)
    await settle(frame, 1000)
    const c = await counters(frame)
    expect(c.legacyEditPosts).toBeGreaterThanOrEqual(1)
    expect(c.historyDeltaPosts).toBe(0)
    expect((await seen(frame)).transitions).toBeGreaterThanOrEqual(1)
  })

  test('an exact action Undo: a task checkbox toggle', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-task.md',
      TASKS,
    )
    await resetCounters(frame)
    await frame.locator('.vditor-ir input[type="checkbox"]').first().click()
    await settle(frame, 1000)
    const toggled = await docText(evaluateInVSCode, file)
    expect(toggled).not.toBe(TASKS)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, TASKS)
    expect((await counters(frame)).historyDeltaPosts).toBe(1)
  })

  test('a second Undo after an external change leaves the host text alone (guarantee 22)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-external.md',
      FIXTURE,
    )
    await caretAtEnd(workbox, frame, PARAGRAPH, 2)
    await type(workbox, 'a')
    await settle(frame, 1000)
    await hostEdit(
      evaluateInVSCode,
      file,
      'Sixth paragraph introduces the tables.',
      'Sixth paragraph, changed by the host.',
    )
    await settle(frame, 1500)
    const hostChange = await docText(evaluateInVSCode, file)
    const version = await docVersion(evaluateInVSCode, file)
    await resetCounters(frame)
    await undo(workbox)
    await undo(workbox)
    await settle(frame, 1000)
    expect(await docText(evaluateInVSCode, file)).toBe(hostChange)
    expect(await docVersion(evaluateInVSCode, file)).toBe(version)
    expect((await counters(frame)).historyDeltaPosts).toBe(0)
  })

  // Review repair cases (task 004-R): paths where the unit engine must hand over or restore a structure.

  // The model is off for this document (a reference definition), so the old engine holds the history.
  test('a document the model declines keeps a working Undo (old engine takes over)', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text =
      '[toc]\n\n# Head\n\nSee [d].\n\n[d]: https://example.com\n\nTail paragraph.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-declined.md',
      text,
    )
    const tail = frame.locator(PARAGRAPH).filter({ hasText: 'Tail paragraph.' })
    await tail.click()
    await workbox.keyboard.press('End')
    await resetCounters(frame)
    await type(workbox, 'abc')
    await settle(frame, 1000)
    expect(await docText(evaluateInVSCode, file)).not.toBe(text)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
    expect((await counters(frame)).historyDeltaPosts).toBe(0)
  })

  // Enter in a list item turns the model off today (pairing-failed): the old engine then holds a freshly
  // reset history and the Enter cannot be undone until task 011 (list structure) lands.
  test('a list Enter and Undo', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    // Not test.fail: with the model off, whether the old engine's idle snapshot lands before the Enter
    // decides the outcome, so the case passes on some runs and fails on others.
    test.fixme(true, 'red until task 011: Enter in a list turns the model off')
    const text = '# List\n\n- alpha\n- beta\n- gamma\n\nTail.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-list-enter.md',
      text,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > ul > li', 1)
    await workbox.keyboard.press('Enter')
    await type(workbox, 'x')
    await settle(frame, 1000)
    expect(await docText(evaluateInVSCode, file)).not.toBe(text)
    await undo(workbox)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
  })

  // Enter in a table cell inserts a line break in the cell today, not a row (red until task 009).
  test('a table row insert and Undo', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.fail(true, 'red until task 009')
    const text = '| a | b |\n| - | - |\n| c | d |\n\nTail.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-row.md',
      text,
    )
    await caretAtEnd(workbox, frame, CELL, 1)
    await workbox.keyboard.press('Enter')
    await settle(frame, 1000)
    expect(await docText(evaluateInVSCode, file)).not.toBe(text)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
  })

  // A typing edit in a list item restores through the item window.
  test('typing in a list item and Undo', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const text = '# List\n\n- alpha\n- beta\n- gamma\n\nTail.\n'
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-list.md',
      text,
    )
    await caretAtEnd(workbox, frame, '.vditor-ir .vditor-reset > ul > li', 1)
    await resetCounters(frame)
    await type(workbox, 'xy')
    await settle(frame, 1000)
    expect(await docText(evaluateInVSCode, file)).toBe(
      text.replace('beta', 'betaxy'),
    )
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
    expect((await counters(frame)).historyDeltaPosts).toBe(1)
  })

  test('an edit next to an ECharts block and Undo leaves a non-empty chart', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const chart =
      '{"xAxis":{"type":"category","data":["a","b"]},"yAxis":{},"series":[{"type":"bar","data":[1,2]}]}'
    const text = `Before the chart.\n\n\`\`\`echarts\n${chart}\n\`\`\`\n\nAfter the chart.\n`
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-echarts.md',
      text,
    )
    const canvas = frame.locator('.vditor-ir__preview canvas').first()
    await expect(canvas).toBeVisible({ timeout: 30_000 })
    await caretAtEnd(workbox, frame, PARAGRAPH, 0)
    await type(workbox, 'xy')
    await settle(frame, 1000)
    await caretAtEnd(workbox, frame, PARAGRAPH, 1)
    await type(workbox, 'z')
    await settle(frame, 1000)
    await undo(workbox)
    await hostText(
      evaluateInVSCode,
      file,
      text.replace('Before the chart.', 'Before the chart.xy'),
    )
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
    const box = await frame
      .locator('.vditor-ir__preview canvas')
      .first()
      .boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(0)
    expect(box?.height ?? 0).toBeGreaterThan(0)
  })

  // Re-review N1: the restored ECharts block itself (not a neighbour) must render again.
  test('a changed ECharts source and Undo renders the chart again', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const chart =
      '{"xAxis":{"type":"category","data":["a","b"]},"yAxis":{},"series":[{"type":"bar","data":[1,2]}]}'
    const text = `Before the chart.\n\n\`\`\`echarts\n${chart}\n\`\`\`\n\nAfter the chart.\n`
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'hd-echarts-source.md',
      text,
    )
    await expect(
      frame.locator('.vditor-ir__preview canvas').first(),
    ).toBeVisible({ timeout: 30_000 })
    // The source is covered by the rendered preview: select inside it, expand the node and focus it.
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    const placed = await frame.locator('body').evaluate(() => {
      const code = document.querySelector(
        '.vditor-ir .vditor-reset > [data-type="code-block"] pre.vditor-ir__marker--pre > code',
      )
      const node = code?.closest('.vditor-ir__node')
      const source = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
      const textNode = code
        ? (document
            .createTreeWalker(code, NodeFilter.SHOW_TEXT)
            .nextNode() as Text | null)
        : null
      if (!code || !node || !source || !textNode) return false
      node.classList.add('vditor-ir__node--expand')
      const range = document.createRange()
      range.setStart(textNode, (textNode.textContent ?? '').length)
      range.collapse(true)
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      source.focus()
      return true
    })
    expect(placed).toBe(true)
    await workbox.keyboard.press('Space')
    await settle(frame, 1500)
    expect(await docText(evaluateInVSCode, file)).not.toBe(text)
    await undo(workbox)
    await hostText(evaluateInVSCode, file, text)
    await settle(frame, 1500)
    const box = await frame
      .locator('.vditor-ir__preview canvas')
      .first()
      .boundingBox()
    expect(box?.width ?? 0).toBeGreaterThan(0)
    expect(box?.height ?? 0).toBeGreaterThan(0)
  })
})
