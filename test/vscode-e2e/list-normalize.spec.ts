import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

// Task 255 — "Fix list numbering" (vmde.fixListNumbering) / "Renormalize all lists"
// (vmde.renormalizeAllLists). This is the L3 leg: real VS Code commands, executed exactly as
// the palette would (`vscode.commands.executeCommand`), through the host → postMessage →
// message-router.ts wiring — proving that path end-to-end. The block-scoped Lute-spin mechanics
// themselves (execAfterRender/undo/caret restore) are covered by
// media-src/e2e/list-normalize.spec.ts (harness, cheaper, calls the webview functions directly).
//
// Staleness is injected the same way the harness spec does: a raw `<li>.remove()` (no Lute spin),
// NOT source text with wrong numbers — Vditor's own initial parse already renumbers on load, so a
// merely-mis-numbered fixture would already read back correct.
const FIXTURE = path.join(__dirname, 'fixtures', 'list-renumber.md')

const getValue = (frame: ReturnType<typeof wf>) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (
          window as unknown as { vditor?: { getValue?: () => string } }
        ).vditor?.getValue?.() ?? '',
    ) as Promise<string>

function removeListItem(frame: ReturnType<typeof wf>, needle: string) {
  return frame.locator('body').evaluate((_el, needle: string) => {
    const li = [
      ...document.querySelectorAll('.vditor-ir li, .vditor-wysiwyg li'),
    ].find((x) => (x.childNodes[0]?.textContent ?? '').includes(needle))
    if (!li) throw new Error(`removeListItem: ${needle} not found`)
    li.remove()
  }, needle)
}

async function caretAt(
  frame: ReturnType<typeof wf>,
  needle: string,
  offset: number,
  surface = '.vditor-ir',
) {
  await frame
    .locator(surface)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    (_el, args) => {
      const [n, off, sel] = args as [string, number, string]
      const root = document.querySelector(sel) as HTMLElement | null
      if (!root) throw new Error(`no ${sel}`)
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').includes(n)) continue
        const r = document.createRange()
        r.setStart(node as Text, Math.min(off, node.textContent?.length ?? 0))
        r.collapse(true)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
        ;(node.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`anchor ${n} not found in ${sel}`)
    },
    [needle, offset, surface] as [string, number, string],
  )
}

test('vmde.fixListNumbering / vmde.renormalizeAllLists renumber lists via the real VS Code command (IR + WYSIWYG)', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(150_000)
  const file = path.join(baseDir, 'list-renumber.md')
  writeFileSync(file, readFileSync(FIXTURE, 'utf8'))
  await evaluateInVSCode(
    async (vscode, args) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file((args as string[])[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
  let frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(() => frame.locator('.vditor-ir').first().innerText())
    .toContain('gamma')
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'list command-router readiness' },
  )

  // 1. Fix list numbering at the caret — first list only, nested sublist included.
  await removeListItem(frame, 'beta')
  await removeListItem(frame, 'nested-x')
  const stale = await getValue(frame)
  expect(stale, 'sanity: removal alone leaves stale numbering').toMatch(
    /3\.\s+gamma/,
  )

  await caretAt(frame, 'gamma', 2)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.fixListNumbering')
  })
  // task 512: retain — all three command handoff waits in this file are 500ms, below the
  // conversion threshold; the hard getValue assertions immediately follow them.
  await settle(frame, 500)

  const afterFix = await getValue(frame)
  expect(afterFix).toMatch(/1\.\s+alpha/)
  expect(afterFix).toMatch(/2\.\s+gamma/)
  expect(afterFix).toMatch(/3\.\s+delta/)
  expect(afterFix).toMatch(/1\.\s+nested-y/)
  // The second list (untouched by the caret-scoped command) keeps ITS pre-existing numbering.
  expect(afterFix).toMatch(/1\.\s+first/)
  expect(afterFix).toMatch(/2\.\s+second/)
  expect(afterFix).toMatch(/3\.\s+third/)

  // 2. Renormalize all lists — stale the SECOND list, then fix the whole document.
  await removeListItem(frame, 'first')
  const staleAll = await getValue(frame)
  expect(staleAll, 'sanity: removal leaves the second list stale').toMatch(
    /3\.\s+third/,
  )

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.renormalizeAllLists')
  })
  await settle(frame, 500)

  const afterAll = await getValue(frame)
  expect(afterAll).toMatch(/1\.\s+second/)
  expect(afterAll).toMatch(/2\.\s+third/)
  expect(
    afterAll,
    'the plain paragraph between the two lists is untouched',
  ).toContain(
    'This paragraph must survive `Renormalize all lists` byte-identical.',
  )
  expect(afterAll, 'headings are untouched').toContain(
    '## A plain paragraph between the two lists',
  )

  // 3. WYSIWYG uses the SAME functions (mode-branches on SpinVditorDOM vs SpinVditorIRDOM) — one
  // pass proves the branch, not a full re-run of every case above.
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
    .toContain('gamma')

  await removeListItem(frame, 'delta')
  const staleWysiwyg = await getValue(frame)
  expect(staleWysiwyg, 'sanity: removal leaves the first list stale').toMatch(
    /2\.\s+gamma/,
  )
  await caretAt(frame, 'gamma', 2, '.vditor-wysiwyg')
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.fixListNumbering')
  })
  await settle(frame, 500)

  const afterWysiwyg = await getValue(frame)
  expect(afterWysiwyg).toMatch(/1\.\s+alpha/)
  expect(afterWysiwyg).toMatch(/2\.\s+gamma/)
  expect(afterWysiwyg).not.toContain('delta')

  // Task 495: source mode receives the raw authored markers from the host, rather than the
  // normalized visual DOM above. This crosses palette focus, exact history, save, and reopen.
  const sourceBefore = [
    'before',
    '',
    '3. alpha',
    '4. beta',
    '   4. nested',
    '   9. nested stale',
    '5. gamma',
    '',
    'after',
    '',
  ].join('\n')
  const sourceAfter = sourceBefore.replace('9. nested stale', '5. nested stale')
  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document.querySelector<HTMLButtonElement>('button[data-mode="sv"]')?.click()
  })
  await waitForE2EReadiness(frame, (state) => state.mode === 'sv', {
    message: 'source list mode readiness',
  })
  await frame.locator('body').evaluate((_body, source) => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.textContent = source
    root.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: ' ',
      }),
    )
  }, sourceBefore)
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceBefore)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    const target = (root.textContent ?? '').indexOf('nested stale') + 3
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let remaining = target
    for (
      let node = walker.nextNode() as Text | null;
      node;
      node = walker.nextNode() as Text | null
    ) {
      if (remaining <= node.data.length) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        const selection = getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        root.focus()
        return
      }
      remaining -= node.data.length
    }
    throw new Error('source list caret target missing')
  })
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.fixListNumbering')
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceAfter)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceBefore)
  await frame.locator('body').evaluate(() => {
    const root = (window as any).vditor.vditor.sv.element as HTMLElement
    root.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'y',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceAfter)
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('vmde.renormalizeAllLists')
  })
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceAfter)
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === args[0],
      )
      if (!document || !(await document.save()))
        throw new Error('source list document did not save')
    },
    [file] as [string],
  )
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(sourceAfter)
  frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    '.vditor-ir',
  )
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(sourceAfter)
})
