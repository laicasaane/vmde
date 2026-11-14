import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 733 / 010: exact actions and host updates applied by units in IR (shared rules 3.7, Q-25,
// Q-31). Every test reads the document through the VS Code document and checks bytes, element
// identity (through a marker attribute the spec sets) or posted message names; no layout, no timing.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Counters {
  fullGetValue: number
  deltaPosts: number
  historyDeltaPosts: number
  legacyEditPosts: number
}

const HEAVY = tableHeavyMarkdown(1)
const P1 =
  'First paragraph of the synthetic document, with a few words of plain text.'
const P2 =
  'Second paragraph, a little longer than the first one, still plain prose.'
const P3 = 'Third paragraph introduces the list below.'
const MOVED = HEAVY.replace(`${P1}\n\n${P2}`, `${P2}\n\n${P1}`)
// The model-off case runs in WYSIWYG, where the text model is off by design (shared rules 1.3). A
// reference-definition document keeps the model off too, but its definitions block has no unit kind,
// so the existing block-action route declines every move there as well (no projection proof): it
// cannot show today's route moving a block.
const MODEL_OFF = 'Alpha.\n\nBeta.\n\nGamma.\n'

async function open(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
  live = true,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  const frame = (await reopenVmdeFixture(
    evaluateInVSCode as never,
    workbox,
    file,
  )) as Frame
  await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the apply-text editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  if (live)
    await expect.poll(() => modelState(frame), { timeout: 30_000 }).toBe('live')
  else expect(await modelState(frame)).toBe('off')
  return { frame, file }
}

const modelState = (frame: Frame): Promise<string> =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelShadowStats?: { state: string }
        }
      ).__vmdeModelShadowStats?.state ?? 'missing',
  )

const resetCounters = (frame: Frame, length: number) =>
  frame.locator('body').evaluate((_body, size) => {
    ;(
      window as unknown as {
        __vmdeEditCounters: { reset(length: number): void }
      }
    ).__vmdeEditCounters.reset(size as number)
  }, length)

const readCounters = (frame: Frame): Promise<Counters> =>
  frame.locator('body').evaluate(() => {
    const c = (window as unknown as { __vmdeEditCounters: Counters })
      .__vmdeEditCounters
    return {
      fullGetValue: c.fullGetValue,
      deltaPosts: c.deltaPosts,
      historyDeltaPosts: c.historyDeltaPosts,
      legacyEditPosts: c.legacyEditPosts,
    }
  })

/**
 * Records the names of posted and received messages (names only: no document text, SR-5). With
 * `holdDeltas`, `edit-delta` posts are kept back until `releaseHeld()`.
 */
const recordMessages = (frame: Frame, holdDeltas = false) =>
  frame.locator('body').evaluate((_body, hold) => {
    const w = window as unknown as Record<string, any>
    const api = w.vscode
    const trace = { outbound: [] as string[], inbound: [] as string[] }
    const held: unknown[] = []
    w.__applyTrace = trace
    w.__releaseHeld = () => {
      for (const message of held.splice(0)) api.postMessage(message)
    }
    w.__heldCount = () => held.length
    w.vscode = {
      ...api,
      postMessage: (message: { command: string }) => {
        trace.outbound.push(message.command)
        if (hold && message.command === 'edit-delta') {
          held.push(message)
          return true
        }
        return api.postMessage(message)
      },
    }
    window.addEventListener('message', (event) => {
      const command = (event.data as { command?: unknown })?.command
      if (typeof command === 'string') trace.inbound.push(command)
    })
  }, holdDeltas)

const trace = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (window as unknown as Record<string, any>).__applyTrace as {
        outbound: string[]
        inbound: string[]
      },
  )

const runCommand = (evaluateInVSCode: Evaluate, command: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(args[0])
    },
    [command],
  )

/** Replaces the first occurrence of `from` in the host document through a `WorkspaceEdit`. */
const hostReplace = (
  evaluateInVSCode: Evaluate,
  file: string,
  from: string,
  to: string,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (!document) throw new Error('document not open')
      const at = document.getText().indexOf(args[1])
      if (at < 0) throw new Error('host text not found')
      const edit = new vscode.WorkspaceEdit()
      edit.replace(
        document.uri,
        new vscode.Range(
          document.positionAt(at),
          document.positionAt(at + args[1].length),
        ),
        args[2],
      )
      if (!(await vscode.workspace.applyEdit(edit)))
        throw new Error('host edit failed')
    },
    [file, from, to],
  )

/** Marks an element by its selector and index so a later check can prove it is the same element. */
const mark = (frame: Frame, selector: string, nth: number, name: string) =>
  frame.locator('body').evaluate(
    (_body, [sel, index, attribute]) => {
      const el = document.querySelectorAll(sel as string)[index as number]
      if (!el) throw new Error('element to mark not found')
      el.setAttribute(attribute as string, '')
    },
    [selector, nth, name] as const,
  )

const settle = (workbox: Page) => workbox.waitForTimeout(2000)

const PARAGRAPHS = '.vditor-ir .vditor-reset > p'

async function caretIn(frame: Frame, selector: string, nth: number) {
  const target = frame.locator(selector).nth(nth)
  await target.scrollIntoViewIfNeeded()
  await target.click()
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), _args: string[]) => {
      try {
        await vscode.commands.executeCommand('workbench.action.files.revert')
      } catch {
        // No active document to revert.
      }
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [''],
  )
})

test.describe('apply text by units (task 010)', () => {
  test('Move Block Down applies by units and posts one delta', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-move.md',
      HEAVY,
    )
    await caretIn(frame, PARAGRAPHS, 0)
    await recordMessages(frame)
    await resetCounters(frame, HEAVY.length)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.moveBlockDown')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(MOVED)
    await settle(workbox)
    const counters = await readCounters(frame)
    expect(counters.fullGetValue).toBe(0)
    expect(counters.deltaPosts).toBe(1)
    const seen = await trace(frame)
    expect(seen.inbound).not.toContain('block-action-outcome')
    expect(seen.outbound).toContain('cancel-block-action')
    expect(seen.outbound).not.toContain('apply-block-action')
  })

  test('Undo of the move restores the fixture with one history delta', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-move-undo.md',
      HEAVY,
    )
    await caretIn(frame, PARAGRAPHS, 0)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.moveBlockDown')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(MOVED)
    await settle(workbox)
    await resetCounters(frame, HEAVY.length)
    await workbox.keyboard.press('Control+z')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe(HEAVY)
    await settle(workbox)
    expect((await readCounters(frame)).historyDeltaPosts).toBe(1)
  })

  // Q-79 OQ-6: Insert Row Below is Vditor's own table chord, not an apply by units. This case is an
  // identity regression: the command keeps the elements of the table's other rows.
  test('Insert Row Below keeps the other rows of the table as the same elements', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-table-row.md',
      HEAVY,
    )
    const rows = '.vditor-ir .vditor-reset > table:first-of-type tbody > tr'
    const rowCount = await frame.locator(rows).count()
    await frame.locator('body').evaluate((_body, sel) => {
      for (const row of Array.from(document.querySelectorAll(sel as string)))
        row.setAttribute('data-spec-row', '')
    }, rows)
    await caretIn(frame, `${rows}:nth-child(3) td`, 0)
    const before = await docText(evaluateInVSCode as never, file)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.table.insertRowBelow')
    await expect
      .poll(
        async () =>
          (await docText(evaluateInVSCode as never, file)).split('\n').length,
      )
      .toBe(before.split('\n').length + 1)
    expect(await frame.locator(`${rows}[data-spec-row]`).count()).toBe(rowCount)
    expect(await frame.locator(rows).count()).toBe(rowCount + 1)
  })

  test('an external one-line change is shown by units and keeps the other paragraph', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-external.md',
      HEAVY,
    )
    await mark(frame, PARAGRAPHS, 0, 'data-spec-keep')
    await resetCounters(frame, HEAVY.length)
    await hostReplace(
      evaluateInVSCode as Evaluate,
      file,
      P2,
      'Second paragraph, changed outside.',
    )
    await expect
      .poll(() => frame.locator(PARAGRAPHS).nth(1).textContent())
      .toContain('changed outside')
    await settle(workbox)
    expect(
      await frame.locator(PARAGRAPHS).nth(0).getAttribute('data-spec-keep'),
    ).toBe('')
    expect((await readCounters(frame)).fullGetValue).toBe(0)
  })

  test('an external change while typing elsewhere keeps both changes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-external-typing.md',
      HEAVY,
    )
    // Count the error and warning dialogs the host shows from here on.
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), _args: string[]) => {
        const g = globalThis as unknown as Record<string, unknown>
        g.__applyDialogs = 0
        const count =
          <T extends (...a: any[]) => any>(original: T) =>
          (...args: Parameters<T>) => {
            g.__applyDialogs = (g.__applyDialogs as number) + 1
            return original(...args)
          }
        g.__applyRestore = {
          error: vscode.window.showErrorMessage,
          warning: vscode.window.showWarningMessage,
        }
        vscode.window.showErrorMessage = count(
          vscode.window.showErrorMessage.bind(vscode.window),
        ) as typeof vscode.window.showErrorMessage
        vscode.window.showWarningMessage = count(
          vscode.window.showWarningMessage.bind(vscode.window),
        ) as typeof vscode.window.showWarningMessage
      },
      [''],
    )
    try {
      await caretIn(frame, PARAGRAPHS, 2)
      await workbox.keyboard.press('End')
      await workbox.keyboard.press('x')
      // Before the typing's idle publication.
      await hostReplace(
        evaluateInVSCode as Evaluate,
        file,
        P1,
        'First paragraph, changed outside.',
      )
      await expect
        .poll(() => docText(evaluateInVSCode as never, file), {
          timeout: 15_000,
        })
        .toBe(
          HEAVY.replace(P1, 'First paragraph, changed outside.').replace(
            P3,
            `${P3}x`,
          ),
        )
      expect(
        await evaluateInVSCode(
          async () =>
            (globalThis as unknown as Record<string, unknown>).__applyDialogs,
          [''],
        ),
      ).toBe(0)
    } finally {
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), _args: string[]) => {
          const g = globalThis as unknown as Record<string, any>
          if (!g.__applyRestore) return
          vscode.window.showErrorMessage = g.__applyRestore.error
          vscode.window.showWarningMessage = g.__applyRestore.warning
        },
        [''],
      )
    }
  })

  test('a refused exact delta shows the host text after one update', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-refused.md',
      HEAVY,
    )
    await caretIn(frame, PARAGRAPHS, 0)
    await recordMessages(frame, true)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.moveBlockDown')
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() =>
            (
              (window as unknown as Record<string, any>)
                .__heldCount as () => number
            )(),
          ),
      )
      .toBe(1)
    // The host changes paragraph 1 on the chain between the prepare and the delta.
    const external = 'First paragraph, changed by the host.'
    await hostReplace(evaluateInVSCode as Evaluate, file, P1, external)
    await frame
      .locator('body')
      .evaluate(() =>
        (
          (window as unknown as Record<string, any>).__releaseHeld as () => void
        )(),
      )
    const hostText = HEAVY.replace(P1, external)
    await expect
      .poll(() => frame.locator(PARAGRAPHS).nth(0).textContent())
      .toContain('changed by the host')
    await settle(workbox)
    expect(await docText(evaluateInVSCode as never, file)).toBe(hostText)
    const seen = await trace(frame)
    expect(seen.inbound.filter((name) => name === 'update')).toHaveLength(1)
    expect(seen.outbound).not.toContain('apply-block-action')
    expect(await frame.locator(PARAGRAPHS).nth(1).textContent()).toContain(
      'Second paragraph',
    )
  })

  test('with the model off the existing apply-block-action route moves the block', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode as Evaluate,
      baseDir,
      'apply-model-off.md',
      MODEL_OFF,
    )
    // As table-operations.spec.ts: the toolbar's edit-mode menu, then the WYSIWYG entry.
    await frame.locator('body').evaluate(() => {
      const toolbar = (window as any).vditor.vditor.toolbar
      toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector('button[data-mode="wysiwyg"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
      timeout: 60_000,
      message: 'WYSIWYG mode did not become ready',
    })
    // The model object may stay live until a later publication; the posted `apply-block-action` below proves the existing route.
    await caretIn(frame, '.vditor-wysiwyg .vditor-reset > p', 0)
    await recordMessages(frame)
    await runCommand(evaluateInVSCode as Evaluate, 'vmde.moveBlockDown')
    await expect
      .poll(() => docText(evaluateInVSCode as never, file))
      .toBe('Beta.\n\nAlpha.\n\nGamma.\n')
    expect((await trace(frame)).outbound).toContain('apply-block-action')
  })
})
