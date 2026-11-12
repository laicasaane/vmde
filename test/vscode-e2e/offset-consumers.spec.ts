import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 006: the offset consumers (block-handle hover, diff markers, reveal in Source, host
// line reveal) read model units while the model is live, so none of them serializes the document.
// Counters and state names only; no document text is logged.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface ShadowStats {
  state: 'off' | 'live'
  units: number
  dirtyNow: number
}

const fixture = tableHeavyMarkdown(1)
// 0-based lines of `tableHeavyMarkdown(1)`: paragraph 2 is line 10, paragraph 3 line 14, `## Tables`
// list items 16-25 (item `n` at 15 + n), line 76, table A header 80, delimiter 81, body row `n` at 81 + n.
const PARAGRAPH_2_LINE = 10
const PARAGRAPH_3_LINE = 14
const LIST_ITEM_3_LINE = 18
const TABLE_A_ROW_3_LINE = 84
const ROOT = '.vditor-ir .vditor-reset'
const created: string[] = []

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
  for (const file of created.splice(0)) rmSync(file, { force: true })
})

async function openVmde(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<Frame> {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.extensions.getExtension('vscode.git')?.activate()
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
    { message: 'the offset-consumers editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  return frame
}

async function openFixture(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, fixture)
  created.push(file)
  return { frame: await openVmde(workbox, evaluateInVSCode, file), file }
}

/** A live model with no dirty unit is what lets the consumers read model units. */
async function waitForLiveModel(frame: Frame): Promise<void> {
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(() => {
          const stats = (
            window as unknown as { __vmdeModelShadowStats?: ShadowStats }
          ).__vmdeModelShadowStats
          return (
            stats?.state === 'live' && stats.units > 0 && stats.dirtyNow === 0
          )
        }),
      { timeout: 90_000, message: 'the model is live with no dirty unit' },
    )
    .toBe(true)
}

const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    ;(
      window as unknown as { __vmdeEditCounters: { reset(n: number): void } }
    ).__vmdeEditCounters.reset(length as number)
  }, fixture.length)

const readCounters = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const counters = (
      window as unknown as {
        __vmdeEditCounters: { luteDocument: number; fullGetValue: number }
      }
    ).__vmdeEditCounters
    return {
      luteDocument: counters.luteDocument,
      fullGetValue: counters.fullGetValue,
    }
  })

/** Click the end of the block whose text starts with `prefix`, then type `text`. */
async function typeAtEnd(frame: Frame, prefix: string, text: string) {
  const block = frame.locator(`${ROOT} > p`, { hasText: prefix }).first()
  await block.click()
  const page = frame.owner().page()
  await page.keyboard.press('End')
  await page.keyboard.type(text)
}

test.describe('offset consumers on model units', () => {
  test('hover right after typing shows the handle with no whole-document work', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame } = await openFixture(
      workbox,
      evaluateInVSCode,
      baseDir,
      'offset-consumers-hover.md',
    )
    await waitForLiveModel(frame)
    await resetCounters(frame)
    await typeAtEnd(frame, 'Third paragraph', 'ab')
    // Move the pointer over table A at once, while the typing may still be unpublished.
    const cell = frame.locator(`${ROOT} > table td`).nth(7)
    await cell.scrollIntoViewIfNeeded()
    await cell.hover()
    await expect(frame.locator('.vmde-block-handle')).toBeVisible()
    // The handle belongs to table A, not to the paragraph that was typed in: its top falls inside
    // the table's rectangle.
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const handle = document.querySelector('.vmde-block-handle')
          const table = document.querySelector(
            '.vditor-ir .vditor-reset > table',
          )
          if (!(handle && table)) return false
          const h = handle.getBoundingClientRect()
          const t = table.getBoundingClientRect()
          return h.top >= t.top - 2 && h.top <= t.bottom
        }),
      )
      .toBe(true)
    const counters = await readCounters(frame)
    console.log(
      `OFFSET-CONSUMERS ${JSON.stringify({ step: 'hover', counters })}`,
    )
    expect(counters.luteDocument, 'luteDocument').toBe(0)
    expect(counters.fullGetValue, 'fullGetValue').toBe(0)
  })

  test('a changed paragraph gets one diff marker beside its block with no getValue', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    // The repository lives in a subfolder of the workspace folder: the Git extension scans it
    // there, and no workspace-folder change (which restarts the extension host) is needed.
    const repo = path.join(baseDir, 'offset-consumers-repo')
    const note = path.join(repo, 'note.md')
    try {
      rmSync(repo, { recursive: true, force: true })
      mkdirSync(repo, { recursive: true })
      writeFileSync(note, fixture)
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo })
      git('init', '--quiet')
      git('config', 'user.name', 'Vmde E2E')
      git('config', 'user.email', 'vmde-e2e@example.invalid')
      git('add', 'note.md')
      git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'baseline')
      await expect
        .poll(
          () =>
            evaluateInVSCode(
              async (vscode: typeof import('vscode'), args: string[]) => {
                const api = await vscode.extensions
                  .getExtension('vscode.git')
                  ?.activate()
                const repositories = api?.getAPI?.(1)?.repositories ?? []
                return repositories.some(
                  (repository: { rootUri: { fsPath: string } }) =>
                    repository.rootUri.fsPath === args[0],
                )
              },
              [repo],
            ),
          {
            timeout: 30_000,
            message: 'the Git extension found the repository',
          },
        )
        .toBe(true)
      const frame = await openVmde(workbox, evaluateInVSCode, note)
      await waitForLiveModel(frame)
      await resetCounters(frame)
      await typeAtEnd(frame, 'Second paragraph', ' edited')
      await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.files.save')
      }, [] as string[])
      const readMarkers = () =>
        frame.locator('body').evaluate(() => {
          const root = document.querySelector('.vditor-ir .vditor-reset')
          const paragraph = Array.from(root?.children ?? []).find((block) =>
            (block.textContent ?? '').startsWith('Second paragraph'),
          ) as HTMLElement | undefined
          const bars = Array.from(
            document.querySelectorAll('.me-diff-marker'),
          ) as HTMLElement[]
          return {
            count: bars.length,
            aligned:
              bars.length === 1 && bars[0].offsetTop === paragraph?.offsetTop,
          }
        })
      await expect
        .poll(readMarkers, { timeout: 30_000 })
        .toEqual({ count: 1, aligned: true })
      const counters = await readCounters(frame)
      console.log(
        `OFFSET-CONSUMERS ${JSON.stringify({ step: 'diff', line: PARAGRAPH_2_LINE, counters })}`,
      )
      expect(counters.fullGetValue, 'fullGetValue').toBe(0)
    } finally {
      await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      }, [] as string[])
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('Reveal in Source puts the Source caret on the host line of the table row', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame } = await openFixture(
      workbox,
      evaluateInVSCode,
      baseDir,
      'offset-consumers-reveal.md',
    )
    await waitForLiveModel(frame)
    const row = frame.locator(`${ROOT} > table tbody tr`).nth(2)
    await row.scrollIntoViewIfNeeded()
    await row.locator('td').first().click()
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.openTextEditor')
    }, [] as string[])
    // Until the router uses the unit-based cursor line, this case passes through the existing path
    // (regression value only), so it asserts the line and no counter.
    await expect
      .poll(
        () =>
          evaluateInVSCode(
            async (vscode: typeof import('vscode')) =>
              vscode.window.activeTextEditor?.selection.active.line ?? -1,
            [] as string[],
          ),
        { timeout: 20_000 },
      )
      .toBe(TABLE_A_ROW_3_LINE)
  })

  // A host reveal-line for a table row (no Lute), a paragraph line and a list item line (one unit
  // serialized alone through the live Lute): the caret lands in the target block, the block is in
  // view, and no whole-document work is counted from just before the command.
  const revealCases = [
    {
      name: 'table row',
      line: TABLE_A_ROW_3_LINE,
      target: { selector: `${ROOT} > table tbody tr`, nth: 2 },
    },
    {
      name: 'paragraph',
      line: PARAGRAPH_3_LINE,
      target: { selector: `${ROOT} > p`, nth: 0, text: 'Third paragraph' },
    },
    {
      name: 'list item',
      line: LIST_ITEM_3_LINE,
      target: { selector: `${ROOT} > ul > li`, nth: 2 },
    },
  ]
  for (const { name, line, target } of revealCases) {
    test(`a host reveal-line puts the caret in the ${name} with no whole-document work`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(180_000)
      const { frame, file } = await openFixture(
        workbox,
        evaluateInVSCode,
        baseDir,
        'offset-consumers-reveal-line.md',
      )
      await waitForLiveModel(frame)
      await evaluateInVSCode(
        async (vscode: typeof import('vscode'), args: string[]) => {
          const at = Number(args[1])
          await vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.file(args[0]),
            { preview: false, selection: new vscode.Range(at, 0, at, 0) },
          )
        },
        [file, String(line)],
      )
      // Count from just before the command that posts the reveal.
      await resetCounters(frame)
      await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
        await vscode.commands.executeCommand('vmde.openEditor')
      }, [] as string[])
      await expect
        .poll(
          () =>
            frame.locator('body').evaluate((_body, want) => {
              const { selector, nth, text } = want as {
                selector: string
                nth: number
                text?: string
              }
              const found = Array.from(
                document.querySelectorAll(selector),
              ).filter((el) => !text || (el.textContent ?? '').startsWith(text))
              const block = found[nth] as HTMLElement | undefined
              const anchor = getSelection()?.anchorNode
              const rect = block?.getBoundingClientRect()
              return {
                caretInBlock: !!anchor && !!block?.contains(anchor),
                inView:
                  !!rect && rect.top >= 0 && rect.top < window.innerHeight,
              }
            }, target),
          { timeout: 20_000 },
        )
        .toEqual({ caretInBlock: true, inView: true })
      const counters = await readCounters(frame)
      console.log(
        `OFFSET-CONSUMERS ${JSON.stringify({ step: 'reveal-line', name, counters })}`,
      )
      expect(counters.fullGetValue, 'fullGetValue').toBe(0)
      expect(counters.luteDocument, 'luteDocument').toBe(0)
    })
  }
})
