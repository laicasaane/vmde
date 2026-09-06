import { docText, ev, settle, wf } from './webview-helpers'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 393 — pasting plain text over a selection inserted the new text BEFORE the selection
// instead of replacing it, and ate the selection's last character.
//
// Measured in a real VS Code with an instrumented `document.execCommand`: VS Code's webview
// clipboard bridge answers Ctrl+V by calling `document.execCommand("paste")` from a host-message
// handler, so `insertHTML`'s own `execCommand("delete")` ran WITH execCommand already on the call
// stack — genuinely re-entrant, and Chromium silently REFUSES it there (confirmed by forcing it
// synchronous: `execCommand` returned `false`, the DOM was unchanged). The old fix deferred every
// `execCommand("delete")` into a `setTimeout` to dodge that recursion guard (originally built for
// the CUT path only, see task 387) — for paste that let the delete fire a macrotask later, against
// whatever the selection had already collapsed to: a stealth backspace, one character short.
//
// The fix (`patchInsertHtmlDelete` in esbuild-shared.mjs) replaces that `execCommand("delete")`
// with `range.deleteContents()` — a plain DOM mutation the recursion guard never touches.
//
// Asserted with EXACT equality, not `toContain` — a `toContain` check passes on the mangled
// result too (it contains every original line), which is how this survived unnoticed.

const writeClip = (
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  text: string,
) =>
  ev(
    evaluateInVSCode,
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.env.clipboard.writeText(args[0])
    },
    text,
  )

let bootCount = 0
const TEMP_DIR = path.join(__dirname, '..', '..', 'tmp', 'vscode-e2e')

async function waitForDocText(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  file: string,
  expected: string,
) {
  await expect
    .poll(() => docText(evaluateInVSCode, file), { timeout: 10_000 })
    .toBe(expected)
    .catch(() => {
      // Preserve the exact hard assertion below so a red run reports the document bytes.
    })
  return docText(evaluateInVSCode, file)
}

async function boot(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  workbox: import('@playwright/test').Page,
  name: string,
  body: string,
) {
  mkdirSync(TEMP_DIR, { recursive: true })
  const tmp = path.join(TEMP_DIR, `${process.pid}-${bootCount++}-${name}`)
  writeFileSync(tmp, body)
  await ev(evaluateInVSCode, async (vscode: typeof import('vscode')) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })
  await ev(
    evaluateInVSCode,
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    tmp,
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(() => frame.locator('.vditor-ir').first().innerText())
    .toContain('Read the paper today.')
  return { tmp, frame }
}

/** Selects the exact text `needle` (first occurrence) in the currently-visible editor root. */
async function selectText(
  frame: ReturnType<typeof wf>,
  rootSelector: string,
  needle: string,
) {
  await frame
    .locator(rootSelector)
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    (_el, args) => {
      const root = document.querySelector(args.rootSelector) as HTMLElement
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const i = (n.textContent ?? '').indexOf(args.needle)
        if (i < 0) continue
        const r = document.createRange()
        r.setStart(n as Text, i)
        r.setEnd(n as Text, i + args.needle.length)
        const s = window.getSelection()
        s?.removeAllRanges()
        s?.addRange(r)
        ;(n.parentElement as HTMLElement | null)?.focus()
        return
      }
      throw new Error(`${args.needle} not found`)
    },
    { rootSelector, needle },
  )
}

test('IR paste-over-selection cases replace exactly the selection', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(180_000)
  const plain = await boot(
    evaluateInVSCode,
    workbox,
    'vmde-paste-ir.md',
    'Read the paper today.\n',
  )
  await writeClip(evaluateInVSCode, 'WORDS')
  await selectText(plain.frame, '.vditor-ir', 'the paper')
  await workbox.keyboard.press('Control+v')
  expect
    .soft(
      await waitForDocText(evaluateInVSCode, plain.tmp, 'Read WORDS today.\n'),
    )
    .toBe('Read WORDS today.\n')
  rmSync(plain.tmp, { force: true })

  // Multi-block paste takes insertHTML's other branch; it must still remove the selection.
  const block = await boot(
    evaluateInVSCode,
    workbox,
    'vmde-paste-multiblock.md',
    'Read the paper today.\n',
  )
  await writeClip(evaluateInVSCode, 'para one\n\npara two')
  await selectText(block.frame, '.vditor-ir', 'the paper')
  await workbox.keyboard.press('Control+v')
  expect
    .soft(
      await waitForDocText(
        evaluateInVSCode,
        block.tmp,
        'Read  today.\n\npara one\n\npara two\n',
      ),
    )
    .toBe('Read  today.\n\npara one\n\npara two\n')
  rmSync(block.tmp, { force: true })

  // The next real input must not be swallowed after a paste replacement.
  const type = await boot(
    evaluateInVSCode,
    workbox,
    'vmde-paste-then-type.md',
    'Read the paper today.\n',
  )
  await writeClip(evaluateInVSCode, 'WORDS')
  await selectText(type.frame, '.vditor-ir', 'the paper')
  await workbox.keyboard.press('Control+v')
  await waitForDocText(evaluateInVSCode, type.tmp, 'Read WORDS today.\n')
  await workbox.keyboard.type('!')
  expect
    .soft(
      await waitForDocText(evaluateInVSCode, type.tmp, 'Read WORDS! today.\n'),
    )
    .toBe('Read WORDS! today.\n')
  rmSync(type.tmp, { force: true })
})

async function switchMode(
  frame: ReturnType<typeof wf>,
  mode: 'wysiwyg' | 'sv',
) {
  // task 512: retain — task 451 proved that clicking the mode control immediately after a
  // condition-based boot can be lost permanently even though the toolbar DOM already exists.
  await settle(frame, 1500)
  await frame.locator('body').evaluate((_el, targetMode) => {
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
      .querySelector(`button[data-mode="${targetMode}"]`)
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, mode)
  await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 30_000 })
  await expect
    .poll(() => frame.locator(`.vditor-${mode}`).first().innerText())
    .toContain('Read the paper today.')
}

for (const mode of ['wysiwyg', 'sv'] as const) {
  test(`${mode}: paste-over-selection replaces exactly the selection`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    const editor = await boot(
      evaluateInVSCode,
      workbox,
      `vmde-paste-${mode}.md`,
      'Read the paper today.\n',
    )
    await switchMode(editor.frame, mode)
    await writeClip(evaluateInVSCode, 'WORDS')
    await selectText(editor.frame, `.vditor-${mode}`, 'the paper')
    await workbox.keyboard.press('Control+v')
    expect(
      await waitForDocText(evaluateInVSCode, editor.tmp, 'Read WORDS today.\n'),
    ).toBe('Read WORDS today.\n')
    rmSync(editor.tmp, { force: true })
  })
}
