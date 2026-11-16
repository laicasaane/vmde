import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  shippedSwitches,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

// Task 733 / 015-T2 (task 015 sections 6.2 D-1 to D-4 and 6.6): Source mode publishes by units. The
// saved bytes after typing in each place equal the document outside the edited block; a block the
// Source spin reformatted (renumbered list) keeps its host bytes after an edit elsewhere; a blank line
// typed and deleted restores the bytes; documents with a link reference definition or a footnote keep
// today's whole-text path. Fails until 015-I1 and 015-I2 land (Source model, patch V-S1).

type Frame = ReturnType<typeof wf>
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

async function openSource(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Evaluate,
  file: string,
  text: string,
): Promise<Frame> {
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
  const before = await waitForE2EReadiness(
    frame,
    (snapshot) => snapshot.routerReady && snapshot.editorEpoch > 0,
    { message: 'the editor installed its router' },
  )
  // The edit-mode buttons sit in a panel hidden until hover: dispatch the click on the button.
  await frame.locator('body').evaluate(() => {
    document
      .querySelector('.vditor-toolbar button[data-mode="sv"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  })
  await waitForE2EReadiness(
    frame,
    (snapshot) =>
      snapshot.modeEpoch > before.modeEpoch && snapshot.mode === 'sv',
    { message: 'the editor reported Source' },
  )
  return frame
}

/** Caret at the end of line `line` of the Source block whose text starts with `prefix`. */
async function caretInSource(
  frame: Frame,
  prefix: string,
  line: number,
): Promise<void> {
  await frame
    .locator('pre.vditor-sv')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(
    (_body, args) => {
      const [start, row] = args as [string, number]
      const root = document.querySelector<HTMLElement>('pre.vditor-sv')
      const block = Array.from(root?.children ?? []).find((el) =>
        el.textContent?.startsWith(start),
      )
      if (!root || !block) return false
      const text = block.textContent ?? ''
      let end = -1
      for (let i = 0; i <= row; i++) end = text.indexOf('\n', end + 1)
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      let seen = 0
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const length = node.textContent?.length ?? 0
        if (end >= 0 && seen + length >= end) {
          const range = document.createRange()
          range.setStart(node, end - seen)
          range.collapse(true)
          window.getSelection()?.removeAllRanges()
          window.getSelection()?.addRange(range)
          root.focus()
          return true
        }
        seen += length
      }
      return false
    },
    [prefix, line] as [string, number],
  )
  if (!placed) throw new Error('Source block not found')
}

const save = (evaluateInVSCode: Evaluate) =>
  evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  }, [])

/** The text before and after the block that starts with `prefix` (blocks are separated by one blank line). */
function outside(text: string, prefix: string): [string, string] {
  const start = text.indexOf(`\n\n${prefix}`) + 2
  const end = text.indexOf('\n\n', start)
  return [text.slice(0, start), end < 0 ? '' : text.slice(end)]
}

const FIXTURE = tableHeavyMarkdown(1)
const PLACES = [
  { name: 'paragraph', prefix: 'Second paragraph', line: 0 },
  { name: 'table', prefix: '| Name', line: 3 },
  { name: 'list item', prefix: '- list item', line: 2 },
  { name: 'code block', prefix: '```ts', line: 1 },
] as const

test.describe('Source units', () => {
  for (const place of PLACES) {
    test(`typing in the ${place.name} saves the bytes outside the block unchanged`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const file = path.join(baseDir, 'source-units.md')
      const frame = await openSource(workbox, evaluateInVSCode, file, FIXTURE)
      test.skip(
        !(await shippedSwitches(frame)).sourceUnits,
        'Source units ship off',
      )
      await caretInSource(frame, place.prefix, place.line)
      await workbox.keyboard.type('xy', { delay: 150 })
      await workbox.waitForTimeout(2000)
      await save(evaluateInVSCode)
      const saved = await docText(evaluateInVSCode, file)
      const [before, after] = outside(FIXTURE, place.prefix)
      expect(saved.startsWith(before)).toBe(true)
      expect(saved.endsWith(after)).toBe(true)
      expect(saved.length).toBeGreaterThan(FIXTURE.length)
    })
  }

  test('a block the spin renumbered keeps its host bytes after an edit elsewhere', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const file = path.join(baseDir, 'source-units-forms.md')
    const text = '3. x\n5. y\n\nlast paragraph\n'
    const frame = await openSource(workbox, evaluateInVSCode, file, text)
    await caretInSource(frame, 'last', 0)
    await workbox.keyboard.type('z', { delay: 150 })
    await workbox.waitForTimeout(2000)
    await save(evaluateInVSCode)
    expect(await docText(evaluateInVSCode, file)).toBe(
      '3. x\n5. y\n\nlast paragraphz\n',
    )
  })

  test('a blank line typed and deleted restores the bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    const file = path.join(baseDir, 'source-units-split.md')
    const text = 'first block\n\nsecond block\n'
    const frame = await openSource(workbox, evaluateInVSCode, file, text)
    await caretInSource(frame, 'first', 0)
    await workbox.keyboard.press('Enter', { delay: 150 })
    await workbox.keyboard.press('Enter', { delay: 150 })
    await workbox.keyboard.type('mid', { delay: 150 })
    await workbox.waitForTimeout(2000)
    await save(evaluateInVSCode)
    expect(await docText(evaluateInVSCode, file)).toBe(
      'first block\n\nmid\n\nsecond block\n',
    )
    for (let i = 0; i < 5; i++)
      await workbox.keyboard.press('Backspace', { delay: 150 })
    await workbox.waitForTimeout(2000)
    await save(evaluateInVSCode)
    expect(await docText(evaluateInVSCode, file)).toBe(text)
  })

  for (const shape of [
    {
      name: 'a link reference definition',
      text: 'see [r]\n\n[r]: http://example.test\n',
    },
    { name: 'a footnote', text: 'see [^1]\n\n[^1]: note\n' },
  ]) {
    test(`a document with ${shape.name} keeps the whole-text path`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
    }) => {
      const file = path.join(baseDir, 'source-units-defs.md')
      const frame = await openSource(
        workbox,
        evaluateInVSCode,
        file,
        shape.text,
      )
      await caretInSource(frame, 'see', 0)
      await frame.locator('body').evaluate(() =>
        (
          window as unknown as {
            __vmdeEditCounters?: { reset(n: number): void }
          }
        ).__vmdeEditCounters?.reset(0),
      )
      await workbox.keyboard.type('q', { delay: 150 })
      await workbox.waitForTimeout(2000)
      const legacy = await frame.locator('body').evaluate(
        () =>
          (
            window as unknown as {
              __vmdeEditCounters?: { legacyEditPosts: number }
            }
          ).__vmdeEditCounters?.legacyEditPosts ?? 0,
      )
      await save(evaluateInVSCode)
      const saved = await docText(evaluateInVSCode, file)
      expect(saved.startsWith('see')).toBe(true)
      expect(saved).toContain('q')
      expect(legacy).toBeGreaterThan(0)
    })
  }
})
