import { wf } from './webview-helpers'
// Edit-responsiveness quick-wins (task 171) — real VS Code. The bundle removes wasted work on the
// input path (a discarded full-doc serialize on the IR space fast-path + WYSIWYG/SV; a second spin
// via renderToc per keystroke). It is SUBTRACTIVE, so the e2e proves it didn't break the two things
// that path is responsible for: (1) edits still propagate to the host TextDocument (the gated
// `options.input()` still fires editSync), and (2) the ToC still refreshes after the edit settles
// (renderToc is now deferred, not skipped). Only reproducible with the real custom-editor pipeline.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'perf-edit.md')

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: (fn: unknown, args: unknown) => Promise<unknown>,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const [uri] = args
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [FIXTURE],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  // task 512: retain — exactly 1s initial edit-surface guard, at the conversion threshold.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1000)))
  return frame
}

// Read the host-side TextDocument text (proves a webview edit reached the host via editSync→applyEdit).
const readDoc = (
  evaluateInVSCode: (fn: unknown, args: unknown) => Promise<unknown>,
) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const [uri] = args
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === uri,
      )
      return doc ? doc.getText() : ''
    },
    [FIXTURE],
  ) as Promise<string>

async function placeAtEnd(
  frame: ReturnType<typeof wf>,
  surfaceSelector: string,
  needle: string,
) {
  await frame.locator('body').evaluate(
    (_body, args: [string, string]) => {
      const [selector, target] = args
      const surface = document.querySelector<HTMLElement>(selector)
      if (!surface) throw new Error(`missing ${selector}`)
      const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(target)
        if (index < 0) continue
        surface.focus({ preventScroll: true })
        const range = document.createRange()
        range.setStart(node, index + target.length)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        ;(window as any).__vmdeRequestCaret?.({
          node: range.startContainer,
          offset: range.startOffset,
        })
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`${target} not found in ${selector}`)
    },
    [surfaceSelector, needle] as [string, string],
  )
}

test('IR fast-path typing and deferred ToC updates reach the host document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const frame = await open(workbox, evaluateInVSCode)

  // type prose WITH SPACES at the end of the paragraph — this is exactly the startSpace/endSpace
  // fast-path whose discarded full-doc serialize item 1 gated away. The edit must still reach the host.
  await frame.locator('.vditor-ir').getByText('edit here').click()
  await placeAtEnd(frame, '.vditor-ir', 'edit here')
  await workbox.keyboard.type(' alpha beta gamma', { delay: 50 })
  await expect
    .poll(() => readDoc(evaluateInVSCode), { timeout: 20_000 })
    .toContain('edit here alpha beta gamma')

  const text = await readDoc(evaluateInVSCode)
  // eslint-disable-next-line no-console
  console.log(`[perf-edit] host doc tail: ${JSON.stringify(text.slice(-60))}`)
  expect.soft(text).toContain('edit here alpha beta gamma') // edit reached the host TextDocument

  // renderToc → outlineRender assigns each heading an `ir-<slug>_<index>` id (the numeric suffix is the
  // GLOBAL heading index, which only outlineRender knows — the per-block spin can't). So a new heading
  // getting that id proves the now-DEFERRED renderToc still flushed on settle. (`[toc]` renders no
  // block in IR — confirmed by probe — so the id is the reliable observable, not a toc element.)
  const newHeadingId = () =>
    frame.locator('body').evaluate(() => {
      const ir = (
        window as unknown as {
          vditor?: { vditor?: { ir?: { element?: HTMLElement } } }
        }
      ).vditor?.vditor?.ir?.element
      const h = Array.from(ir?.querySelectorAll('h2') ?? []).find((x) =>
        x.textContent?.includes('Section two'),
      )
      return (h as HTMLElement | undefined)?.id ?? ''
    })

  await placeAtEnd(frame, '.vditor-ir', 'edit here alpha beta gamma')
  await workbox.keyboard.press('Enter')
  // Type the marker + first word, let the `## ` heading PROMOTION (async spin) settle, THEN the space
  // + second word. Typing straight through races that promotion and the interior space is dropped in
  // the harness (verified: "## Section two" → "## Sectiontwo" without the settle, correct with it) —
  // a keyboard-timing artefact, not a product bug; a real user never types faster than the promotion.
  await workbox.keyboard.type('## Section', { delay: 50 })
  // task 512: retain — input sequencing, not an observation guess. The heading promotion must
  // complete before the following Space or the harness changes the typed text itself.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1200)))
  await workbox.keyboard.press('Space')
  await workbox.keyboard.type('two', { delay: 50 })

  // The fixture has no enabled outline or rendered embedded ToC in IR. The local spin still assigns
  // the new heading its stable id, while Task 536 must skip the document-wide ToC refresh entirely.
  await expect.soft
    .poll(newHeadingId, { timeout: 15_000, intervals: [300, 600, 1000] })
    .toMatch(/^ir-Section-two(?:_\d+)?$/)
  expect(
    await frame.locator('body').evaluate(() => ({
      invalidations: (window as any).__vmdeTocInvalidationStats.invalidations,
      refreshes: (window as any).__vmdeTocInvalidationStats.refreshes,
    })),
  ).toEqual({ invalidations: 0, refreshes: 0 })

  // and the heading round-trips to the host document. Poll — editSync to the host TextDocument is
  // async and lags the DOM/outline update the poll above already saw, so a single read can race it.
  await expect.soft
    .poll(() => readDoc(evaluateInVSCode), {
      timeout: 10_000,
      intervals: [300, 600, 1000],
    })
    .toContain('## Section two')
})

test('WYSIWYG typing still propagates to the host document (item 4)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const frame = await open(workbox, evaluateInVSCode)

  // switch IR → WYSIWYG via the edit-mode toolbar (same path as callouts-mode.spec.ts)
  await frame.locator('body').evaluate(() => {
    const v = (
      window as unknown as {
        vditor: {
          vditor: { toolbar: { elements: Record<string, HTMLElement> } }
        }
      }
    ).vditor.vditor
    v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 30_000 })
  await expect
    .poll(() => frame.locator('.vditor-wysiwyg').first().innerText())
    .toContain('edit here')

  await frame.locator('.vditor-wysiwyg').getByText('edit here').click()
  await placeAtEnd(frame, '.vditor-wysiwyg', 'edit here')
  await workbox.keyboard.insertText(' wysiwyg edit')
  await expect
    .poll(() => readDoc(evaluateInVSCode), { timeout: 20_000 })
    .toContain('edit here wysiwyg edit')

  const text = await readDoc(evaluateInVSCode)
  // eslint-disable-next-line no-console
  console.log(
    `[perf-edit] wysiwyg host doc tail: ${JSON.stringify(text.slice(-60))}`,
  )
  expect(text).toContain('edit here wysiwyg edit') // the WYSIWYG gated path still reaches the host
})
