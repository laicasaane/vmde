import { wf } from './webview-helpers'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// Task 413 — the big-doc freeze fix (`content-visibility: auto` on top-level blocks, main.css)
// was scoped to `.vditor-ir` only, while the `vmde-large-doc` class that gates it is set from
// document SIZE alone (vditor-init.ts), i.e. mode-independent. A ≥100 KB document in WYSIWYG got
// the class and no containment — the exact O(document) repaint the fix exists to kill, silently
// unfixed in one mode.
//
// This asserts the CONTAINMENT, not the freeze: the original symptom was a VS Code 1.123 /
// Chromium 148 whole-window stall that this environment does not reproduce, so timing it here
// would prove nothing. `getComputedStyle(...).contentVisibility` is the property the fix turns on,
// and it is exactly what was missing in WYSIWYG.
//
// The fixture is generated, not committed: 100 KB of markdown is not worth carrying in the repo,
// and CONTENT_VIS_MIN_CHARS (100_000) is the only thing that matters about it.
const BIG = `# Big doc\n\n${Array.from(
  { length: 1400 },
  (_, i) =>
    `Paragraph ${i} — filler prose that exists only to push this document over the 100,000-character content-visibility threshold.`,
).join('\n\n')}\n`

async function open(
  evaluateInVSCode: (fn: unknown, args: [string]) => Promise<unknown>,
  file: string,
) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [file] as [string],
  )
}

// The computed `content-visibility` of the first plain paragraph in `mode`'s pane, plus the class
// that gates it — reported together so a failure says WHICH half broke.
async function probe(frame: ReturnType<typeof wf>, mode: string) {
  return frame.locator('body').evaluate((_b, sel: string) => {
    const pre = document.querySelector(`${sel} > pre.vditor-reset`)
    const block = pre
      ? Array.from(pre.children).find(
          (el) => el.tagName === 'P' && (el.textContent ?? '').length > 20,
        )
      : null
    return {
      large: document.body.classList.contains('vmde-large-doc'),
      blocks: pre?.children.length ?? 0,
      cv: block
        ? getComputedStyle(block).contentVisibility
        : 'NO-PARAGRAPH-BLOCK',
      // A heading is deliberately EXCLUDED (its -29px gutter marker would be clipped by the
      // implied paint containment) — pinned so the exclusion cannot be lost by a selector edit.
      headingCv: pre?.querySelector('h1')
        ? getComputedStyle(pre.querySelector('h1') as Element).contentVisibility
        : 'NO-HEADING',
    }
  }, mode)
}

async function switchToWysiwyg(frame: ReturnType<typeof wf>) {
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
  await frame.locator('.vditor-wysiwyg').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(
      async () => {
        const current = await probe(frame, '.vditor-wysiwyg')
        return (
          current.large &&
          current.blocks > 100 &&
          current.cv === 'auto' &&
          current.headingCv === 'visible'
        )
      },
      { timeout: 60_000 },
    )
    .toBe(true)
}

test('a large doc gets content-visibility in BOTH IR and WYSIWYG (413)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(240_000)
  const tmp = path.join(tmpdir(), 'vmde-content-visibility-big.md')
  writeFileSync(tmp, BIG)
  expect(
    BIG.length,
    'the fixture clears CONTENT_VIS_MIN_CHARS',
  ).toBeGreaterThan(100_000)
  await open(evaluateInVSCode, tmp)
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 120_000 })
  await expect
    .poll(
      async () => {
        const current = await probe(frame, '.vditor-ir')
        return (
          current.large &&
          current.blocks > 100 &&
          current.cv === 'auto' &&
          current.headingCv === 'visible'
        )
      },
      { timeout: 120_000 },
    )
    .toBe(true)

  const ir = await probe(frame, '.vditor-ir')
  expect(ir.large, 'the large-doc class is on the body').toBe(true)
  expect(ir.blocks, 'the IR pane really built its blocks').toBeGreaterThan(100)
  // The pre-existing IR behaviour — asserted so this change cannot regress the mode it came from.
  expect(ir.cv, 'IR: a plain block is contained').toBe('auto')
  expect(
    ir.headingCv,
    'IR: the heading stays UNcontained (gutter marker)',
  ).toBe('visible')

  await switchToWysiwyg(frame)
  const wy = await probe(frame, '.vditor-wysiwyg')
  expect(wy.blocks, 'the WYSIWYG pane really built its blocks').toBeGreaterThan(
    100,
  )
  // The gap this task closes: identical containment in the other editing mode.
  expect(wy.cv, 'WYSIWYG: a plain block is contained').toBe('auto')
  expect(
    wy.headingCv,
    'WYSIWYG: the heading stays UNcontained (gutter marker)',
  ).toBe('visible')

  rmSync(tmp, { force: true })
})
