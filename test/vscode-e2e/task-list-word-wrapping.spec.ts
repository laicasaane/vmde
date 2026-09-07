import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'task-list-word-wrapping.md')
const ORIGINAL = readFileSync(FIXTURE, 'utf8')

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.defaultMode',
      undefined,
      vscode.ConfigurationTarget.Global,
    )
    await config.update(
      'theme.content',
      undefined,
      vscode.ConfigurationTarget.Global,
    )
  })
})

test('task-list prose wraps at word boundaries in the real webview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const documentPath = path.join(baseDir, 'task-list-word-wrapping.md')
  writeFileSync(documentPath, ORIGINAL)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'editor.defaultMode',
        'ir',
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'theme.content',
        'github-dark',
        vscode.ConfigurationTarget.Global,
      )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [documentPath] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const words = [
    'uncheckedboundary',
    'checkedboundary',
    'nestedboundary',
    'bulletboundary',
    'paragraphboundary',
    'codeboundary',
    'linkboundary',
  ]
  const snapshot = await frame.locator('body').evaluate((_body, words) => {
    const fragmentsForWord = (word: string) => {
      const root = document.querySelector('.vditor-ir') as Node
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      const counts: number[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        for (const match of (node.textContent ?? '').matchAll(
          new RegExp(word, 'gu'),
        )) {
          const range = document.createRange()
          range.setStart(node, match.index)
          range.setEnd(node, match.index + word.length)
          counts.push(range.getClientRects().length)
        }
      }
      return counts
    }
    const fragmentCounts = (needles: string[]) => {
      return Object.fromEntries(
        needles.map((word) => [word, fragmentsForWord(word)]),
      ) as Record<string, number[]>
    }
    const task = document.querySelector(
      '.vditor-ir li.vditor-task',
    ) as HTMLElement | null
    const root = document.querySelector('.vditor-ir') as HTMLElement | null
    if (!task || !root) throw new Error('task-list editor DOM not found')
    const style = getComputedStyle(task)
    return {
      fragments: fragmentCounts(words),
      longTokenLines: fragmentCounts([
        'supercalifragilisticexpialidociousunbrokencontainmenttokensupercalifragilisticexpialidociousunbrokencontainmenttokensupercalifragilisticexpialidociousunbrokencontainmenttoken',
      ]),
      taskItems: document.querySelectorAll('.vditor-ir li.vditor-task').length,
      taskStyle: {
        wordBreak: style.wordBreak,
        overflowWrap: style.overflowWrap,
        whiteSpace: style.whiteSpace,
      },
      content: {
        width: Math.round(root.getBoundingClientRect().width),
        scrollWidth: root.scrollWidth,
        fontFamily: getComputedStyle(root).fontFamily,
        fontSize: getComputedStyle(root).fontSize,
        zoom: getComputedStyle(root).zoom,
      },
      theme: {
        bodyClass: document.body.className,
        vditorClass: document.querySelector('.vditor')?.className ?? '',
        stylesheets: Array.from(document.styleSheets).map(
          (sheet) => sheet.href,
        ),
      },
    }
  }, words)
  // eslint-disable-next-line no-console
  console.log(`[task-567] real-webview snapshot=${JSON.stringify(snapshot)}`)

  expect(
    snapshot.taskItems,
    'checked, unchecked, nested, and inline task items render',
  ).toBe(4)
  expect(
    snapshot.taskStyle.wordBreak,
    'the built Vditor task-list rule is active',
  ).toBe('break-word')
  expect(
    snapshot.content.scrollWidth,
    'the long token remains contained',
  ).toBeLessThanOrEqual(snapshot.content.width + 1)
  expect(
    snapshot.longTokenLines[Object.keys(snapshot.longTokenLines)[0]][0],
  ).toBeGreaterThan(1)
  for (const [word, counts] of Object.entries(snapshot.fragments)) {
    expect(counts.length, `${word} is rendered`).toBeGreaterThan(0)
    expect(
      counts.every((count) => count === 1),
      `${word} is never split mid-word`,
    ).toBe(true)
  }

  const value = () =>
    frame
      .locator('body')
      .evaluate(() =>
        (
          window as unknown as { vditor: { getValue(): string } }
        ).vditor.getValue(),
      ) as Promise<string>
  expect(await value(), 'opening preserves source bytes').toBe(ORIGINAL)
})
