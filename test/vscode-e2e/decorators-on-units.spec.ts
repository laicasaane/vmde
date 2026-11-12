import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

// Task 733 / 008: the inline decorators and whole-root observers work on the changed units and on
// the block the caret left, not on the whole document. Real webview: the feed root is the IR
// element nested inside `#app`, which the decorators observe, and the Preview pane is a separate
// root that never uses the feed. Counters and state only; no document text is logged.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface ShadowStats {
  state: 'off' | 'live'
  units: number
  dirtyNow: number
}

interface DecoratorPasses {
  full: number
  scoped: number
}

const dir = path.join(tmpdir(), `vmde-decorators-on-units-${process.pid}`)
mkdirSync(path.join(dir, 'src'), { recursive: true })
// The code reference resolves against the workspace, so the target file has to exist.
writeFileSync(
  path.join(dir, 'src', 'target.ts'),
  ['// line 1', 'export const two = 2', 'export const three = 3', ''].join(
    '\n',
  ),
)

const TABLES = 3
const ROWS = 50
const TAIL = 'Tail paragraph with several plain words to move through.'

function table(index: number): string {
  const rows: string[] = []
  for (let row = 1; row <= ROWS; row++)
    rows.push(
      `| Row ${index}.${row} | \`src/target.ts:2\` | https://example.com/t${index}r${row} | <sub>x</sub> |`,
    )
  return [
    '| Name | Ref | Url | Sub |',
    '| --- | --- | --- | --- |',
    ...rows,
  ].join('\n')
}

const fixture = `# Decorators on units\n\n${Array.from({ length: TABLES }, (_, i) => table(i + 1)).join('\n\n')}\n\n${TAIL}\n`
const file = path.join(dir, 'decorators.md')
writeFileSync(file, fixture)

test.use({ baseDir: dir })

const ROOT = '.vditor-ir .vditor-reset'
const CHIP = '[data-code-ref="1"]'
const URL_SPAN = '.vmde-bare-url'
const SUB = 'sub[data-vmde-html-subscript="1"]'

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
})

test.afterAll(() => {
  rmSync(dir, { recursive: true, force: true })
})

async function openFixture(
  workbox: Page,
  evaluateInVSCode: Evaluate,
): Promise<Frame> {
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
    { message: 'the decorators editor installed its router' },
  )
  await waitForInitialUndoSnapshot(frame)
  await waitForLiveModel(frame)
  // The host answers the code-reference resolution after the first pass.
  await expect
    .poll(() => decorationOf(frame, 0), {
      timeout: 60_000,
      message: 'the mount pass decorated table 1',
    })
    .toEqual({ chips: ROWS, urls: ROWS, subs: ROWS })
  return frame
}

/** A live model with no dirty unit is what makes the feed deliver unit changes. */
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

/** Decoration counts inside the `index`-th (0-based) top-level table of the IR root. */
function decorationOf(frame: Frame, index: number) {
  return frame.locator('body').evaluate(
    (_body, args) => {
      const [root, which, chip, url, sub] = args as [
        string,
        number,
        string,
        string,
        string,
      ]
      const tables = document.querySelectorAll(`${root} > table`)
      const target = tables[which]
      return {
        chips: target?.querySelectorAll(chip).length ?? -1,
        urls: target?.querySelectorAll(url).length ?? -1,
        subs: target?.querySelectorAll(sub).length ?? -1,
      }
    },
    [ROOT, index, CHIP, URL_SPAN, SUB] as [
      string,
      number,
      string,
      string,
      string,
    ],
  )
}

/** Zeroes the decorator pass counters and the edit counters before a drive. */
const resetCounters = (frame: Frame) =>
  frame.locator('body').evaluate((_body, length) => {
    const win = window as unknown as {
      __vmdeDecoratorPasses?: DecoratorPasses
      __vmdeEditCounters?: { reset(n: number): void }
    }
    win.__vmdeDecoratorPasses = { full: 0, scoped: 0 }
    win.__vmdeEditCounters?.reset(length as number)
  }, fixture.length)

const readPasses = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const win = window as unknown as {
      __vmdeDecoratorPasses?: DecoratorPasses
    }
    return win.__vmdeDecoratorPasses ?? { full: 0, scoped: 0 }
  })

const readRootQueryAll = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const win = window as unknown as {
      __vmdeEditCounters?: { rootQueryAll: number }
    }
    return win.__vmdeEditCounters?.rootQueryAll ?? 0
  })

const cellOf = (frame: Frame, tableIndex: number, row: number, col = 0) =>
  frame
    .locator(`${ROOT} > table`)
    .nth(tableIndex)
    .locator('tbody tr')
    .nth(row - 1)
    .locator('td')
    .nth(col)

const nextFrames = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

const tail = (frame: Frame) =>
  frame.locator(`${ROOT} > p`, { hasText: 'Tail paragraph' }).first()

test.describe('decorators on units', () => {
  test('typing in a cell keeps the row decorated and runs scoped passes in the nested feed root', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    const frame = await openFixture(workbox, evaluateInVSCode)
    // Production binding: the decorators observe `#app`, the feed describes the IR root inside it.
    expect(
      await frame
        .locator('body')
        .evaluate(
          (_body, root) =>
            document
              .querySelector('#app')
              ?.contains(document.querySelector(root as string)) === true &&
            document.querySelector('#app') !==
              document.querySelector(root as string),
          ROOT,
        ),
    ).toBe(true)

    await cellOf(frame, 1, 10).click()
    await resetCounters(frame)
    const page = frame.owner().page()
    await page.keyboard.press('End')
    await page.keyboard.type('ab')
    await expect
      .poll(async () => (await readPasses(frame)).scoped, {
        timeout: 30_000,
        message: 'typing in a cell ran at least one scoped decorator pass',
      })
      .toBeGreaterThan(0)
    // Recorded now, asserted at task 012.
    test.info().annotations.push({
      type: 'rootQueryAll',
      description: String(await readRootQueryAll(frame)),
    })
    test.info().annotations.push({
      type: 'decorator-passes',
      description: JSON.stringify(await readPasses(frame)),
    })

    // The caret leaves the table: the row is decorated as before.
    await tail(frame).click()
    await expect
      .poll(
        () =>
          frame.locator('body').evaluate(
            (_body, args) => {
              const [root, chip, url, sub] = args as string[]
              const row = document
                .querySelectorAll(`${root} > table`)[1]
                ?.querySelectorAll('tbody tr')[9]
              return {
                chips: row?.querySelectorAll(chip).length ?? -1,
                urls: row?.querySelectorAll(url).length ?? -1,
                subs: row?.querySelectorAll(sub).length ?? -1,
              }
            },
            [ROOT, CHIP, URL_SPAN, SUB],
          ),
        { timeout: 30_000, message: 'the typed row is decorated' },
      )
      .toEqual({ chips: 1, urls: 1, subs: 1 })
  })

  test('leaving a table decorates it and leaves the other tables untouched', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    const frame = await openFixture(workbox, evaluateInVSCode)
    // Keep the elements of table 2: they must be the same nodes after the drive.
    await frame.locator('body').evaluate((_body, root) => {
      const target = document.querySelectorAll(`${root as string} > table`)[1]
      ;(window as unknown as { __kept?: Element[] }).__kept = Array.from(
        target?.querySelectorAll(
          '[data-code-ref="1"], .vmde-bare-url, sub[data-vmde-html-subscript="1"]',
        ) ?? [],
      )
    }, ROOT)

    await cellOf(frame, 0, 3).click()
    const page = frame.owner().page()
    await page.keyboard.press('End')
    // New content that only the caret-leave pass can decorate (Q-30: nothing inside the caret table).
    await page.keyboard.type(' https://example.com/typed')
    await nextFrames(frame)
    const typed = cellOf(frame, 0, 3).locator('.vmde-bare-url')
    expect(await typed.count()).toBe(0)
    await tail(frame).click()
    await expect
      .poll(() => typed.count(), {
        timeout: 30_000,
        message: 'the typed URL is decorated once the caret left the table',
      })
      .toBe(1)
    // The decorator's chip gets its link semantics although no feed change follows its write.
    await expect(typed).toHaveAttribute('role', 'link')
    await expect(typed).toHaveAttribute('aria-label', /^Open link /)

    await expect
      .poll(() => decorationOf(frame, 0), {
        timeout: 30_000,
        message: 'table 1 is decorated after the caret left it',
      })
      .toEqual({ chips: ROWS, urls: ROWS + 1, subs: ROWS })
    expect(await decorationOf(frame, 1)).toEqual({
      chips: ROWS,
      urls: ROWS,
      subs: ROWS,
    })
    expect(
      await frame.locator('body').evaluate(() => {
        const kept = (window as unknown as { __kept?: Element[] }).__kept ?? []
        return kept.length > 0 && kept.every((el) => el.isConnected)
      }),
    ).toBe(true)
  })

  test('moving the caret inside one block runs no full decorator pass', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    const frame = await openFixture(workbox, evaluateInVSCode)
    await tail(frame).click()
    const page = frame.owner().page()
    await page.keyboard.press('End')
    // Let the click's own selection change settle before counting.
    await nextFrames(frame)
    await resetCounters(frame)
    for (let step = 0; step < 6; step++) await page.keyboard.press('ArrowLeft')
    for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowRight')
    // Two frames after the last key, so a coalesced pass would have run.
    await nextFrames(frame)
    const passes = await readPasses(frame)
    test.info().annotations.push({
      type: 'decorator-passes',
      description: JSON.stringify(passes),
    })
    expect(passes.full).toBe(0)
  })

  test('Preview keeps its own decorators', async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    const frame = await openFixture(workbox, evaluateInVSCode)
    await frame.locator('.vditor-toolbar [data-type="preview"]').first().click()
    await expect
      .poll(
        () =>
          frame.locator('body').evaluate(() => {
            const preview = document.querySelector('.vditor-preview')
            return (
              (preview?.querySelectorAll('a.vmde-bare-url').length ?? 0) > 0 &&
              (preview?.querySelectorAll('[data-code-ref="1"]').length ?? 0) > 0
            )
          }),
        {
          timeout: 60_000,
          message: 'Preview decorated its URLs and code references',
        },
      )
      .toBe(true)
  })
})
