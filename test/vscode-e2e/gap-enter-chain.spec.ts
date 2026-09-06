import { settle, wf } from './webview-helpers'
// Task 486: repeated Enter below a callout/code-block at EOF pinned the paragraph count at 1 —
// cleanupGapParagraphs (gap-paragraph.ts) mistook each freshly Enter-split blank paragraph for a
// stale navigation splice (its previousElementSibling is still the callout) and reclaimed it, and
// ensureTrailingParagraph (trailing-paragraph.ts) separately dropped the ORIGINAL trailing
// paragraph on the very first split (Chromium's native Enter doesn't copy `data-vmde-trailing`
// onto either half) without adding a replacement. Net effect: the caret never visually descended
// past the line right after the callout/code-block — "returns to the last line with text".
// Fix: cleanupGapParagraphs keeps a paragraph that reaches the caret through an unbroken chain of
// empty paragraphs (gapChainReachesCaret); ensureTrailingParagraph transfers the TRAILING_ATTR tag
// to the new last paragraph instead of deleting the old one when the gap is exactly a same-tick
// Enter split. Only reproduces in the real custom-editor pipeline (native Enter split + the live
// MutationObserver-driven cleanup), so it lives here, not the chromium harness.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const FIXTURE = path.join(__dirname, 'fixtures', 'gap-enter-chain.md')
const CODE_FIXTURE = path.join(__dirname, 'fixtures', 'gap-enter-chain-code.md')

// Each helper must re-derive the IR element INLINE — these run via Playwright `evaluate`, which
// serializes the function body (toString) into the page and does NOT carry module-scope closures,
// so a shared IR_ELEMENT() helper would be `undefined` inside the page.
const PARAGRAPH_COUNT = () => {
  const ir = (
    window as unknown as {
      vditor?: { vditor?: { ir?: { element?: HTMLElement } } }
    }
  ).vditor?.vditor?.ir?.element
  return ir?.querySelectorAll(':scope > p').length ?? -1
}

const CARET_IN_TRAILING = () => {
  const sel = window.getSelection()
  const n = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null
  const el = n
    ? ((n.nodeType === 3 ? n.parentElement : (n as Element)) as Element)
    : null
  return !!el?.hasAttribute?.('data-vmde-trailing')
}

// The caret's top-level block in the IR editor, as `data-type || tagName` — 'p' = a blank line
// below the code block, 'code-block' = snapped back inside the fence (the task 486 symptom).
// Code blocks get NO persistent trailing paragraph (endsWithBlock excludes them), so the code
// case asserts on this instead of CARET_IN_TRAILING.
const CARET_BLOCK = () => {
  const ir = (
    window as unknown as {
      vditor?: { vditor?: { ir?: { element?: HTMLElement } } }
    }
  ).vditor?.vditor?.ir?.element
  const sel = window.getSelection()
  const n = sel?.rangeCount ? sel.getRangeAt(0).startContainer : null
  if (!n || !ir) return 'NO-EDITOR'
  let el = n.nodeType === 3 ? n.parentElement : (n as Element)
  while (el?.parentElement && el.parentElement !== ir) el = el.parentElement
  if (!el || el.parentElement !== ir) return 'OUTSIDE'
  return el.getAttribute('data-type') || el.tagName.toLowerCase()
}

test('repeated Enter below a callout grows one new paragraph per keypress, caret follows', async ({
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
    frame.locator('.vditor-ir__node[data-callout="note"]').first(),
  ).toBeVisible({ timeout: 45_000 })
  await settle(frame, 500)

  // Place the caret in the maintained EOF trailing paragraph via REAL input: click the
  // callout's rendered body (expands + focuses the editable source, same as a real user),
  // End, then ArrowDown (setupTrailingNav's EOF-descent path, gap-paragraph.ts) until it
  // lands. A programmatic Range/addRange gets overridden by the caret authority's own
  // restore logic on a freshly-focused contenteditable, so this drives real keys instead.
  await frame
    .locator('.vditor-ir')
    .getByText('callout body text', { exact: true })
    .click()
  await workbox.keyboard.press('End')
  for (let i = 0; i < 4; i++) {
    if (await frame.locator('body').evaluate(CARET_IN_TRAILING)) break
    await workbox.keyboard.press('ArrowDown')
    await settle(frame, 200)
  }
  expect(await frame.locator('body').evaluate(CARET_IN_TRAILING)).toBe(true)

  const before = await frame.locator('body').evaluate(PARAGRAPH_COUNT)
  // The fixture's leading "above the callout" paragraph + the maintained EOF trailing paragraph.
  expect(before).toBe(2)

  for (let i = 1; i <= 4; i++) {
    await workbox.keyboard.press('Enter')
    // rAF-debounced cleanup — give it a frame to settle before measuring.
    await settle(frame, 120)
    const count = await frame.locator('body').evaluate(PARAGRAPH_COUNT)
    expect(count).toBe(before + i) // one MORE paragraph per keypress — never collapses back
    expect(await frame.locator('body').evaluate(CARET_IN_TRAILING)).toBe(true)
  }
})

// The same repeated-Enter-under-EOF when the document ends in a CODE BLOCK. Mechanism is the
// same cleanupGapParagraphs guard (gapChainReachesCaret keeps the blank-line chain the user is
// building, instead of reclaiming each fresh Enter-split as a stale navigation splice) — but the
// position "below" the code is a Vditor TRANSIENT splice (insertAfterBlock), not a maintained
// trailing paragraph, because endsWithBlock excludes code blocks. So the assertions differ:
// caret in a plain `<p>` that never snaps back INTO the fence, and one new paragraph per Enter.
test('repeated Enter below a code block at EOF grows one new paragraph per keypress, caret follows', async ({
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
  }, CODE_FIXTURE)

  const frame = wf(workbox)
  await expect(
    frame.locator('.vditor-ir__node[data-type="code-block"]').first(),
  ).toBeVisible({ timeout: 45_000 })
  await settle(frame, 500)

  // Real keys the whole way (a programmatic Range gets overridden by the caret authority on a
  // fresh focus): click the code block's PREVIEW — the render layer sits ON TOP of the editable
  // source, and Vditor's own click handler (ir/index.ts) selects the source beneath it, exactly
  // how a real user enters the block. End to its last line, then ArrowDown — Vditor's native
  // insertAfterBlock (ir/processKeydown.ts) splices a transient blank <p> below the closing
  // fence and parks the caret there. End again: end of the transient ZWSP, the same landing the
  // callout test reaches in the maintained trailing paragraph.
  await frame
    .locator('.vditor-ir__node[data-type="code-block"] .vditor-ir__preview')
    .first()
    .click()
  await workbox.keyboard.press('End')
  await workbox.keyboard.press('ArrowDown')
  await settle(frame, 250)
  await workbox.keyboard.press('End')
  await settle(frame, 200)

  expect(await frame.locator('body').evaluate(CARET_BLOCK)).toBe('p') // below the fence, not inside it

  const before = await frame.locator('body').evaluate(PARAGRAPH_COUNT)
  // "above the code block" + the transient below-fence paragraph (no persistent trailing p).
  expect(before).toBe(2)

  for (let i = 1; i <= 4; i++) {
    await workbox.keyboard.press('Enter')
    // rAF-debounced cleanup — give it a frame to settle before measuring.
    await settle(frame, 120)
    const count = await frame.locator('body').evaluate(PARAGRAPH_COUNT)
    expect(count).toBe(before + i) // one MORE paragraph per keypress — never collapses back
    expect(await frame.locator('body').evaluate(CARET_BLOCK)).toBe('p') // caret never snaps back into the code
  }
})
