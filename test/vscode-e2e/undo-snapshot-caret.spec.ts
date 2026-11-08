import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

// Task 708: Vditor's 800 ms after-render snapshot (`Undo.addCaret(vditor, true)`) must not move a
// collapsed caret whose container is an Element: neither back into a closing marker after the
// marker-reveal ejection, nor from the editable root into the first block's text.
const FIXTURE = path.join(__dirname, 'fixtures', 'undo-snapshot-caret.md')
const INITIAL = readFileSync(FIXTURE, 'utf8')

type Frame = ReturnType<typeof wf>

async function openFixture(
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode'), args: [string]) => Promise<void>,
    args: [string],
  ) => Promise<unknown>,
  baseDir: string,
) {
  const docPath = path.join(baseDir, 'undo-snapshot-caret.md')
  writeFileSync(docPath, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
}

async function prepare(frame: Frame) {
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'undo-snapshot-caret fixture readiness' },
  )
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 20, y: 20 } })
}

/** Put the caret at the end of the typing line (`type here`) and type `x`, which arms the snapshot. */
async function typeAtEndOfTypingLine(
  frame: Frame,
  keyboard: {
    type(text: string): Promise<void>
    press(key: string): Promise<void>
  },
) {
  await frame.locator('body').evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').startsWith('type here')) continue
      surface.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, (node.textContent ?? '').length)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error('typing line not found')
  })
  await keyboard.type('x')
}

for (const sample of [
  {
    name: 'link',
    needle: 'snap-end-link',
    expected: 'tail [snap-end-link](https://example.com)l',
  },
  {
    name: 'code',
    needle: 'snap-end-code',
    expected: 'tail `snap-end-code`l',
  },
]) {
  test(`snapshot keeps the caret after a trailing ${sample.name} out of its closing marker`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    await openFixture(evaluateInVSCode as never, baseDir)
    const frame = wf(workbox)
    await prepare(frame)

    await typeAtEndOfTypingLine(frame, workbox.keyboard)
    // Within the 800 ms undoDelay: put the caret at the end of the target line's closing marker
    // and press End. (From the middle of an expanded code span, End stops at the end of the code
    // content, inside the span, so it never reaches the ejection this spec exercises.)
    await frame.locator('body').evaluate((_body, needle) => {
      const surface = document.querySelector<HTMLElement>('.vditor-ir')!
      const line = Array.from(surface.querySelectorAll('p')).find((p) =>
        (p.textContent ?? '').includes(needle),
      )
      if (!line) throw new Error(`${needle} not found`)
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT)
      let last: Node | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        last = node
      if (!last) throw new Error(`${needle} line has no text`)
      surface.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(last, (last.textContent ?? '').length)
      range.collapse(true)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    }, sample.needle)
    await workbox.keyboard.press('End')
    // Negative-assertion wait: it must outlast the 800 ms undoDelay so the snapshot has fired.
    await workbox.waitForTimeout(1200)

    const state = await frame.locator('body').evaluate(() => {
      const anchor = getSelection()?.anchorNode
      const host =
        anchor instanceof Element ? anchor : (anchor?.parentElement ?? null)
      return {
        inMarker: !!host?.closest('.vditor-ir__marker'),
        hostClass: host?.className ?? '',
      }
    })
    expect(state.inMarker, `caret host ${state.hostClass}`).toBe(false)
    await workbox.keyboard.type('l')
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() =>
            (
              window as unknown as { vditor: { getValue(): string } }
            ).vditor.getValue(),
          ),
      )
      .toContain(sample.expected)
  })
}

test('snapshot keeps a collapsed caret on the editable root', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  await openFixture(evaluateInVSCode as never, baseDir)
  const frame = wf(workbox)
  await prepare(frame)

  await typeAtEndOfTypingLine(frame, workbox.keyboard)
  const written = await frame.locator('body').evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const write = (window as any).__vmdeWriteSelection as (
      target: Range,
    ) => boolean
    const range = document.createRange()
    range.setStart(surface, 1)
    range.collapse(true)
    return write(range)
  })
  expect(written).toBe(true)
  // Negative-assertion wait: it must outlast the 800 ms undoDelay so the snapshot has fired.
  await workbox.waitForTimeout(1200)

  const anchor = await frame.locator('body').evaluate(() => {
    const selection = getSelection()!
    const surface = document.querySelector('.vditor-ir')!
    return {
      isRoot: selection.anchorNode === surface,
      offset: selection.anchorOffset,
    }
  })
  expect(anchor).toEqual({ isRoot: true, offset: 1 })
})
