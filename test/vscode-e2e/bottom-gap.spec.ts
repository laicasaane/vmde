import { wf } from './webview-helpers'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// End-of-file breathing room: the document must not end FLUSH against the bottom in the Preview
// pane. The content theme zeroes the last block's bottom margin (`> *:last-child`), so Preview
// glued the last block to the edge while IR kept a gap (its real last child is the collapsed
// trailing paragraph). main.css restores the gap in Preview; this checks both panes end with a
// comparable gap in the real webview.

const FIXTURE = path.join(__dirname, 'fixtures', 'all-renderers.md')

// Visible gap below the last non-empty block when scrolled to the very bottom.
const GAP = `(sel => {
  const reset = document.querySelector(sel);
  if (!reset) return -1;
  reset.scrollTop = reset.scrollHeight;
  const kids = Array.from(reset.children).filter(el => el.getBoundingClientRect().height > 0.5);
  const last = kids[kids.length - 1];
  if (!last) return -1;
  return Math.round(reset.getBoundingClientRect().bottom - last.getBoundingClientRect().bottom);
})`

test('the document ends with a gap in BOTH IR and Preview (last block not glued)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await evaluateInVSCode(async (vscode, uri) => {
    await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
    await vscode.commands.executeCommand(
      'vscode.openWith',
      vscode.Uri.file(uri),
      'vmde.editor',
    )
  }, FIXTURE)

  const frame = wf(workbox)
  await expect(
    frame.locator('.vditor-ir__node[data-type="code-block"]').first(),
  ).toBeVisible({ timeout: 45_000 })
  const readGap = (selector: string) =>
    frame
      .locator('body')
      .evaluate(
        (_e, s) => new Function('sel', `return (${s.probe})(sel)`)(s.selector),
        { probe: GAP, selector },
      ) as Promise<number>
  await expect
    .poll(() => readGap('.vditor-ir .vditor-reset'))
    .toBeGreaterThan(10)
  const irGap = await readGap('.vditor-ir .vditor-reset')

  await frame.locator('body').evaluate(() => {
    const inst = (window as any).vditor
    const v = inst.vditor
    v.preview.element.style.display = 'block'
    v[inst.getCurrentMode()].element.parentElement.style.display = 'none'
    v.preview.render(v)
  })
  await expect(frame.locator('.vditor-preview code.hljs').first()).toBeVisible({
    timeout: 20_000,
  })
  await expect.poll(() => readGap('.vditor-preview .vditor-reset')).toBe(irGap)
  const pvGap = await readGap('.vditor-preview .vditor-reset')

  // The `18` floor here used to assume `1em ≈ 16px` (this spec was authored 2026-06-13, hours
  // before the vscode-2026 content themes were retargeted to VS Code's OWN metrics — 14px, not a
  // generic 16px root — and before the fixture grew a trailing HTML-block demo whose own
  // margin-bottom is a bare Vditor `1em`, not a blockquote's roomier box). Both changes were
  // deliberate (task 480 traced them); at today's real 14px webview font, `1em` is 14px on BOTH
  // panes (Vditor's `_ir.less` on IR, this file's `.vditor-preview .vditor-reset > :last-child`
  // rule on Preview) — so `10` is the floor that still catches the ~10px "glued" bug this spec
  // exists for, without asserting a pixel value tied to an em-to-px assumption that has already
  // drifted once.
  expect(irGap).toBeGreaterThan(10) // IR keeps the last block's rhythm + padding
  expect(pvGap).toBeGreaterThan(10) // Preview now does too (was ~10 = glued)
  // Both panes derive their gap from the literal SAME `1em` rule (see above), so on any one document
  // they must match exactly, not just both clear the floor.
  expect(pvGap).toBe(irGap)
})
