import { expect, test } from './coverage-fixture'
import { getValue, gotoMouseops, type Mode, setDoc } from './mouseops-helpers'

// NET (task 191 P0-15) — clicking a rendered task checkbox must flip the source marker
// `- [ ]` ↔ `- [x]` WITHOUT the getValue collapse the task-190 §5 probe saw from a
// SYNTHETIC input.click(). This uses a REAL Playwright locator click (a trusted event),
// the way a user toggles it — and the flip is clean. In the read-only Preview the checkbox
// is `disabled` and a click is inert.
//   NOTE: the "exactly one edit posted per toggle" leg is deferred to L3 (Probe-21). Like
//   the cut/paste paths, the checkbox handler mutates the DOM (getValue reflects it) but
//   does not reliably drive Vditor's options.input → schedule → post pipeline under a
//   harness-driven click; the toggle→save WIRE is proven in the real editor.

for (const mode of ['ir', 'wysiwyg'] as Mode[]) {
  test(`real click toggles the task marker cleanly, no getValue collapse (${mode})`, async ({
    page,
  }) => {
    await gotoMouseops(page, mode)
    await setDoc(page, '# Tasks\n\n- [ ] one\n- [x] two\n')

    const box = page.locator(`.vditor-${mode} input[type="checkbox"]`).first()
    await box.waitFor({ timeout: 10_000 })

    // Toggle the first (unchecked) box → it becomes checked in the source. Lute
    // serializes a checked task as `[X]` (uppercase), and IR pads the marker with two
    // spaces vs wysiwyg's one — so match case-insensitively with flexible whitespace.
    await box.click()
    await expect
      .poll(() => getValue(page), { timeout: 5_000, intervals: [50, 100, 200] })
      .toMatch(/- \[[xX]\]\s+one/)
    const afterCheck = await getValue(page)
    expect(afterCheck).toMatch(/- \[[xX]\]\s+one/)
    // …the rest of the document is intact (no collapse to just "# Tasks").
    expect(afterCheck).toContain('# Tasks')
    expect(afterCheck).toContain('two')

    // Toggle it back → unchecked again.
    await box.click()
    await expect
      .poll(() => getValue(page), { timeout: 5_000, intervals: [50, 100, 200] })
      .toMatch(/- \[ \]\s+one/)
    expect(await getValue(page)).toContain('# Tasks')
  })
}

test('in the read-only Preview the checkbox is disabled and clicking is inert', async ({
  page,
}) => {
  await gotoMouseops(page, 'ir')
  await setDoc(page, '# Tasks\n\n- [ ] alpha\n- [x] beta\n')
  const before = await getValue(page)

  // Enter the full Preview overlay (same mechanism the parity spec uses).
  await page.evaluate(() => {
    const inst = (window as any).vditor
    const v = inst.vditor
    v.preview.element.style.display = 'block'
    v[inst.getCurrentMode()].element.parentElement.style.display = 'none'
    v.preview.render(v)
  })
  const box = page.locator('.vditor-preview input[type="checkbox"]').first()
  await box.waitFor({ timeout: 10_000 })

  // Preview checkboxes are disabled…
  expect(await box.isDisabled()).toBe(true)
  // …so a forced click cannot change the document.
  await box.click({ force: true }).catch(() => {
    /* Playwright may throw for forcing a click on a disabled element — expected */
  })
  await page.waitForTimeout(200)
  expect(await getValue(page)).toBe(before)
})

test('interactive Preview click posts one source-owned request without browser errors', async ({
  page,
}) => {
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(message.text())
  })
  page.on('pageerror', (error) => browserErrors.push(error.message))

  await gotoMouseops(page, 'ir')
  await setDoc(page, '# Tasks\n\n- [ ] first\n')
  const source = await getValue(page)
  await page.evaluate(() => {
    const editor = (window as any).vditor
    const vditor = editor.vditor
    // Match finish-init order: install the revision-source callback and delegated handler
    // before the real patched Vditor Preview render commits its captured source.
    ;(window as any).__installPreviewTaskCheckboxes()
    vditor.preview.element.style.display = 'block'
    vditor[editor.getCurrentMode()].element.parentElement.style.display = 'none'
    vditor.preview.render(vditor)
  })

  const checkbox = page
    .locator('.vditor-preview input[type="checkbox"]')
    .first()
  await expect(checkbox).toBeEnabled()
  const randomUUIDType = await page.evaluate(
    () => typeof window.crypto?.randomUUID,
  )
  await checkbox.click()
  await page.waitForTimeout(50)

  const requests = await page.evaluate(() =>
    ((window as any).__posted as Array<Record<string, unknown>>).filter(
      (message) => message.command === 'toggle-preview-task-checkbox',
    ),
  )
  const evidence = {
    randomUUIDType,
    browserErrors,
    requestCount: requests.length,
    request: requests[0],
  }
  await test.info().attach('preview-checkbox-request-path.json', {
    body: Buffer.from(JSON.stringify(evidence, null, 2)),
    contentType: 'application/json',
  })

  expect(requests, JSON.stringify(evidence)).toHaveLength(1)
  expect(requests[0]).toMatchObject({
    command: 'toggle-preview-task-checkbox',
    source,
    startOffset: source.indexOf('[ ]'),
    endOffset: source.indexOf('[ ]') + 3,
    marker: '[ ]',
    checked: true,
  })
  expect(browserErrors, JSON.stringify(evidence)).toEqual([])
})
