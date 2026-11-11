import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 004-D: the text model in shadow mode on the real webview. Each test types, deletes,
// pastes, edits a table row, undoes or saves in IR and checks, from `window.__vmdeModelShadowStats`
// (end-to-end runs only), that every whole-text publication the model predicted matched the bytes
// the host answered with (`mismatch` 0), that the model stayed live, and, after a save, that the
// rotating audit finds nothing. The stats hold counts and state names only, never document text.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface ShadowStats {
  state: 'off' | 'live'
  offReason: string | undefined
  units: number
  proven: number
  opaque: number
  dirtyNow: number
  compared: number
  equal: number
  expectedDifference: number
  mismatch: number
  fallbacks: Record<string, number>
  auditMismatch: number
}

const fixture = tableHeavyMarkdown(1)

// Caret places, as in the counter gates: the Nth element the click lands on, then End.
const PLACES = {
  paragraph: { selector: '.vditor-ir .vditor-reset > p', nth: 2 },
  'table cell': { selector: '.vditor-ir .vditor-reset > table td', nth: 7 },
  'list item': { selector: '.vditor-ir .vditor-reset > ul > li', nth: 2 },
  // The fenced block's editable source; its rendered preview covers it, so a click cannot reach it.
  'code block': {
    selector:
      '.vditor-ir .vditor-reset > [data-type="code-block"] pre.vditor-ir__marker--pre > code',
    nth: 0,
    programmatic: true,
  },
} as const
type PlaceName = keyof typeof PLACES

const created: string[] = []

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
  for (const file of created.splice(0)) rmSync(file, { force: true })
})

async function openDocument(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
): Promise<Frame> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  created.push(file)
  openedFile = file
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
    { message: 'the shadow-spec editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

const readStats = (frame: Frame): Promise<ShadowStats | null> =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeModelShadowStats?: ShadowStats })
          .__vmdeModelShadowStats ?? null,
    )

async function stats(frame: Frame): Promise<ShadowStats> {
  const value = await readStats(frame)
  if (!value) throw new Error('no __vmdeModelShadowStats (not an e2e run?)')
  return value
}

/** The model is live and the idle proof covered every unit of the tree. */
async function waitForLiveModel(frame: Frame): Promise<ShadowStats> {
  await expect
    .poll(
      async () => {
        const s = await readStats(frame)
        return (
          s !== null &&
          s.state === 'live' &&
          s.units > 0 &&
          s.proven + s.opaque === s.units
        )
      },
      { timeout: 90_000, message: 'the model is live and fully proven' },
    )
    .toBe(true)
  return stats(frame)
}

/** Numbers and state names only; printed before any assertion so a failing run still has them. */
async function logStats(frame: Frame, test: string, step: string) {
  const s = await stats(frame)
  console.log(
    `MODEL-SHADOW ${JSON.stringify({
      test,
      step,
      state: s.state,
      offReason: s.offReason ?? null,
      units: s.units,
      proven: s.proven,
      opaque: s.opaque,
      dirtyNow: s.dirtyNow,
      compared: s.compared,
      equal: s.equal,
      expectedDifference: s.expectedDifference,
      mismatch: s.mismatch,
      fallbacks: s.fallbacks,
      auditMismatch: s.auditMismatch,
    })}`,
  )
  return s
}

/** Length and FNV-1a hash (32 bits, UTF-16 code units) of a text: the same function as the page's digest. */
function digestOf(text: string): { length: number; hash: number } {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return { length: text.length, hash: hash >>> 0 }
}

/** The file the last `openDocument` call opened. */
let openedFile = ''

const modelDigest = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelTextDigest?: () => {
            length: number
            hash: number
          } | null
        }
      ).__vmdeModelTextDigest?.() ?? null,
  )

/**
 * Run `act`, then expect the model text to equal the VS Code document text (digests of the two,
 * the document normalized to `\n`), no mismatch and a live model. In live mode a typing step posts
 * deltas, which nothing answers and nothing compares, so the equality is the proof; a step that
 * falls back to a whole-text publication ends in the same equality.
 */
async function publishedStep(
  frame: Frame,
  evaluateInVSCode: Evaluate,
  test: string,
  act: () => Promise<void>,
) {
  await act()
  await expect
    .poll(
      async () => {
        const document = await docText(evaluateInVSCode, openedFile)
        const model = await modelDigest(frame)
        return JSON.stringify([
          model,
          digestOf(document.replace(/\r\n?/g, '\n')),
        ])
      },
      { timeout: 20_000, message: `${test}: the model equals the document` },
    )
    .toMatch(/^\[(\{.*\}),\1\]$/)
  const after = await logStats(frame, test, 'published')
  expect(after.mismatch, `${test}: mismatch`).toBe(0)
  expect(after.state, `${test}: state`).toBe('live')
  return after
}

async function placeCaretInCodeSource(
  frame: Frame,
  selector: string,
): Promise<void> {
  // The top window must hold keyboard focus before the page-side selection is set.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate((_body, sel) => {
    const code = document.querySelector(sel as string)
    const node = code?.closest('.vditor-ir__node')
    const source = node?.querySelector<HTMLElement>('.vditor-ir__marker--pre')
    if (!code || !node || !source) return false
    node.classList.add('vditor-ir__node--expand')
    const text = document
      .createTreeWalker(code, NodeFilter.SHOW_TEXT)
      .nextNode() as Text | null
    if (!text) return false
    const content = text.textContent ?? ''
    const newline = content.indexOf('\n')
    const range = document.createRange()
    range.setStart(text, newline < 0 ? content.length : newline)
    range.collapse(true)
    const selection = window.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    source.focus()
    return true
  }, selector)
  if (!placed) throw new Error('code block source not found')
}

async function placeCaret(workbox: Page, frame: Frame, name: PlaceName) {
  const place = PLACES[name]
  if ('programmatic' in place) {
    await placeCaretInCodeSource(frame, place.selector)
    return
  }
  const target = frame.locator(place.selector).nth(place.nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
  await workbox.keyboard.press('End')
}

async function typeLetters(workbox: Page, letters: string) {
  for (const ch of letters) {
    await workbox.keyboard.press(ch)
    await workbox.waitForTimeout(80)
  }
}

// The wrapper itself is a 0x0 box; the visible, hoverable part is its panel.
const PANEL = '#fix-table-ir-wrapper .vditor-panel'
const PANEL_BUTTON = '#fix-table-ir-wrapper'

test.describe('model shadow (task 733 / 004)', () => {
  test.setTimeout(240_000)

  for (const name of Object.keys(PLACES) as PlaceName[]) {
    test(`typing in a ${name} is predicted exactly`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const frame = await openDocument(
        workbox,
        evaluateInVSCode,
        baseDir,
        'model-shadow.md',
        fixture,
      )
      await waitForLiveModel(frame)
      await placeCaret(workbox, frame, name)
      await publishedStep(frame, evaluateInVSCode, `type in ${name}`, () =>
        typeLetters(workbox, 'abc'),
      )
    })
  }

  test('Backspace in a table cell', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow.md',
      fixture,
    )
    await waitForLiveModel(frame)
    await placeCaret(workbox, frame, 'table cell')
    await publishedStep(
      frame,
      evaluateInVSCode,
      'backspace in cell',
      async () => {
        await workbox.keyboard.press('Backspace')
      },
    )
  })

  for (const name of ['paragraph', 'table cell'] as const) {
    test(`Enter in a ${name}`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const frame = await openDocument(
        workbox,
        evaluateInVSCode,
        baseDir,
        'model-shadow.md',
        fixture,
      )
      await waitForLiveModel(frame)
      await placeCaret(workbox, frame, name)
      await publishedStep(
        frame,
        evaluateInVSCode,
        `enter in ${name}`,
        async () => {
          await workbox.keyboard.press('Enter')
          // An empty paragraph writes no Markdown bytes, so Enter alone publishes nothing to compare:
          // type into the new paragraph. A cell's Enter already changes the text.
          if (name === 'paragraph') await typeLetters(workbox, 'x')
        },
      )
    })
  }

  test('paste of two paragraphs', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow.md',
      fixture,
    )
    await waitForLiveModel(frame)
    await placeCaret(workbox, frame, 'paragraph')
    await publishedStep(
      frame,
      evaluateInVSCode,
      'paste two paragraphs',
      async () => {
        // A synthetic paste of constant text; the clipboard itself may refuse a write without a gesture.
        await frame.locator('body').evaluate(() => {
          const editor = document.querySelector('.vditor-ir .vditor-reset')
          if (!editor) throw new Error('no IR editor')
          const transfer = new DataTransfer()
          transfer.setData('text/plain', 'Pasted one.\n\nPasted two.')
          editor.dispatchEvent(
            new ClipboardEvent('paste', {
              clipboardData: transfer,
              bubbles: true,
              cancelable: true,
            }),
          )
        })
      },
    )
  })

  test('adding and deleting a table row with the panel rebuilds the model from the outcome', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow.md',
      fixture,
    )
    const start = await waitForLiveModel(frame)
    await placeCaret(workbox, frame, 'table cell')
    // The write goes through a block action: the host announces a new epoch and the model rebuilds
    // from the outcome; the prediction of that write is not compared, so wait for the rebuild.
    await frame.locator(PANEL).hover()
    await frame.locator(`${PANEL_BUTTON} [data-type="insertRowB"]`).click()
    await expect
      .poll(async () => (await stats(frame)).units, { timeout: 30_000 })
      .toBeGreaterThan(start.units)
    const added = await waitForLiveModel(frame)
    const afterAdd = await logStats(frame, 'row add', 'rebuilt')
    expect(afterAdd.mismatch, 'row add: mismatch').toBe(0)
    await placeCaret(workbox, frame, 'table cell')
    await frame.locator(PANEL).hover()
    await frame.locator(`${PANEL_BUTTON} [data-type="deleteRow"]`).click()
    await expect
      .poll(async () => (await stats(frame)).units, { timeout: 30_000 })
      .toBeLessThan(added.units)
    await waitForLiveModel(frame)
    const afterDelete = await logStats(frame, 'row delete', 'rebuilt')
    expect(afterDelete.mismatch, 'row delete: mismatch').toBe(0)
    expect(afterDelete.state).toBe('live')
  })

  test('Undo and Redo of typing keep the model live without a mismatch', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow.md',
      fixture,
    )
    await waitForLiveModel(frame)
    await placeCaret(workbox, frame, 'paragraph')
    const typed = await publishedStep(
      frame,
      evaluateInVSCode,
      'type before undo',
      () => typeLetters(workbox, 'abc'),
    )
    // The transition is posted as before (no sequence, no prediction), so `compared` does not grow
    // for it: give the host time, then read the state.
    await workbox.keyboard.press('Control+z')
    await workbox.waitForTimeout(1500)
    const undone = await logStats(frame, 'undo', 'after')
    expect(undone.mismatch, 'undo: mismatch').toBe(0)
    expect(undone.compared).toBeGreaterThanOrEqual(typed.compared)
    await workbox.keyboard.press('Control+y')
    await workbox.waitForTimeout(1500)
    const redone = await logStats(frame, 'redo', 'after')
    expect(redone.mismatch, 'redo: mismatch').toBe(0)
    expect(redone.state, 'redo: state').toBe('live')
  })

  test('save, then the rotating audit finds no mismatch', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow.md',
      fixture,
    )
    await waitForLiveModel(frame)
    await placeCaret(workbox, frame, 'paragraph')
    await publishedStep(frame, evaluateInVSCode, 'type before save', () =>
      typeLetters(workbox, 'abc'),
    )
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    }, [] as string[])
    await workbox.waitForTimeout(1500)
    const mismatches = await frame.locator('body').evaluate(() =>
      (
        window as unknown as {
          __vmdeModelShadowAudit(): Promise<number>
        }
      ).__vmdeModelShadowAudit(),
    )
    const after = await logStats(frame, 'save', 'audit')
    expect(mismatches, 'audit pass mismatches').toBe(0)
    expect(after.auditMismatch, 'auditMismatch').toBe(0)
    expect(after.mismatch, 'save: mismatch').toBe(0)
  })

  test('quiet writers leave no dirty unit', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    // A cell that holds a code reference (the file exists, so it becomes a chip) and a link.
    writeFileSync(path.join(baseDir, 'model-shadow-ref.md'), 'target\n')
    created.push(path.join(baseDir, 'model-shadow-ref.md'))
    const text = [
      '| Name | Both |',
      '| --- | --- |',
      '| one | `model-shadow-ref.md:1` and [the link](./model-shadow-ref.md) |',
      '| two | plain |',
      '',
    ].join('\n')
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow-quiet.md',
      text,
    )
    await waitForLiveModel(frame)
    await workbox.waitForTimeout(2000)
    const idle = await logStats(frame, 'quiet', 'idle 2 s')
    expect(idle.dirtyNow, 'dirtyNow 2 s after open, no input').toBe(0)
    await frame.locator('.vditor-ir table td').nth(1).click()
    await workbox.waitForTimeout(1000)
    const clicked = await logStats(frame, 'quiet', 'after click')
    expect(
      clicked.dirtyNow,
      'dirtyNow after a click into the cell',
    ).toBeLessThanOrEqual(1)
  })

  test('a document with two blank lines between blocks keeps them in the model and the document', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const frame = await openDocument(
      workbox,
      evaluateInVSCode,
      baseDir,
      'model-shadow-gaps.md',
      'First block.\n\n\nMiddle block.\n\n\nLast block.\n',
    )
    await waitForLiveModel(frame)
    const before = await stats(frame)
    const target = frame.locator('.vditor-ir .vditor-reset > p').nth(1)
    await target.click()
    await workbox.keyboard.press('End')
    await publishedStep(frame, evaluateInVSCode, 'blank-line document', () =>
      typeLetters(workbox, 'x'),
    )
    // Live mode posts a delta and compares nothing: the model keeps both blank lines (PD-8), which
    // the digest equality of the step proved against the document.
    const after = await stats(frame)
    expect(after.expectedDifference).toBe(before.expectedDifference)
    expect(after.mismatch, 'mismatch').toBe(0)
  })
})
