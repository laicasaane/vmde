import { expect, test } from './coverage-fixture'
import { openRewrapHarness, placeRewrapCaret } from './rewrap-helpers'
import {
  LARGE_MIXED_TARGET,
  largeMixedMarkdown,
} from '../../test/vscode-e2e/large-mixed-markdown'

test('large IR typing performs no target or full-document acquisition before the delay', async ({
  page,
}) => {
  await page.goto('/rewrap.html?mode=ir&column=48&auto=1&delay=1200')
  await page.waitForFunction(() => (window as any).__ready === true)
  const markdown = largeMixedMarkdown()
  expect(markdown.split('\n').length).toBeGreaterThan(2000)
  await page.evaluate((value) => {
    const harness = (window as any).__rewrap
    harness.editor.setValue(value)
    harness.invalidateSnapshot()
    harness.warmSnapshot()
    harness.resetCounts()
  }, markdown)
  await placeRewrapCaret(page, LARGE_MIXED_TARGET, LARGE_MIXED_TARGET.length)

  await page.keyboard.type('abcdefghijkl')

  expect(
    await page.evaluate(() => (window as any).__rewrap.state()),
  ).toMatchObject({
    captures: 0,
    getValueCalls: 0,
    fullIrSerializes: 0,
    syncs: 0,
  })

  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs), {
      timeout: 15_000,
    })
    .toBe(1)
  expect(
    await page.evaluate(() => (window as any).__rewrap.state()),
  ).toMatchObject({
    captures: 1,
    getValueCalls: 0,
    // Task 606: the proof adds one full IR serialization after the delay (edit-sync's exact
    // derivation of the typed edit proves its bytes against a projection, and the source index
    // resolves its units once); the old path serialized once for the target alone.
    fullIrSerializes: 2,
  })
})

test('Unicode prose and fenced input defer to one settle spin while structural input stays live', async ({
  page,
}) => {
  await openRewrapHarness(page, 'ir')

  for (const text of ['ascii', 'ไทย', '中文', 'éà', '😀🚀']) {
    await page.evaluate(() => {
      const harness = (window as any).__rewrap
      harness.editor.setValue('TARGET\n')
      harness.resetCounts()
    })
    await placeRewrapCaret(page, 'TARGET', 'TARGET'.length)
    for (const point of [...text]) await page.keyboard.insertText(point)

    expect(
      (await page.evaluate(() => (window as any).__rewrap.state())).spins,
    ).toBe(0)
    await expect
      .poll(() => page.evaluate(() => (window as any).__rewrap.state().spins))
      .toBe(1)
    expect(
      await page.evaluate(() => (window as any).__rewrap.editor.getValue()),
    ).toContain(`TARGET${text}`)
  }

  await page.evaluate(() => {
    const harness = (window as any).__rewrap
    harness.editor.setValue('```txt\nFENCE_TARGET\n```\n')
    harness.resetCounts()
  })
  await placeRewrapCaret(page, 'FENCE_TARGET', 'FENCE_TARGET'.length)
  await page.keyboard.insertText('😀')
  expect(
    (await page.evaluate(() => (window as any).__rewrap.state())).spins,
  ).toBe(0)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().spins))
    .toBe(1)

  await page.evaluate(() => {
    const harness = (window as any).__rewrap
    harness.editor.setValue('TARGET\n')
    harness.resetCounts()
  })
  await placeRewrapCaret(page, 'TARGET', 'TARGET'.length)
  await page.keyboard.insertText('*')
  expect(
    (await page.evaluate(() => (window as any).__rewrap.state())).spins,
  ).toBeGreaterThan(0)

  await page.evaluate(() => {
    const harness = (window as any).__rewrap
    harness.editor.setValue('```txt\nFENCE_TARGET\n```\n')
    harness.resetCounts()
  })
  await placeRewrapCaret(page, 'FENCE_TARGET', 'FENCE_TARGET'.length)
  await page.keyboard.insertText('`')
  expect(
    (await page.evaluate(() => (window as any).__rewrap.state())).spins,
  ).toBeGreaterThan(0)
})

for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
  test(`auto-wrap fires after idle and owns a separate undo step in ${mode}`, async ({
    page,
  }) => {
    await openRewrapHarness(page, mode, true)
    await placeRewrapCaret(page, 'gamma', 5)

    await page.keyboard.type('z')
    if (mode === 'sv') {
      await page.evaluate(() => {
        const editor = (window as any).__rewrap.editor.vditor.sv.element
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').includes('backslash beta')) {
            ;(window as any).__svUntouchedTail = node
            return
          }
        }
        throw new Error('SV untouched tail node not found')
      })
    }
    const typedCanonical = await page.evaluate(() =>
      (window as any).__rewrap.editor.getValue(),
    )
    expect(typedCanonical).toContain('gammaz')
    const wrappedCanonical = typedCanonical.replace(
      'alpha beta gammaz delta epsilon',
      'alpha beta\ngammaz delta\nepsilon',
    )

    await expect
      .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs))
      .toBe(1)
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(wrappedCanonical)
    expect(wrappedCanonical).toContain('two-space alpha  \ntwo-space beta')
    expect(wrappedCanonical).toContain('backslash alpha\\\nbackslash beta')

    if (mode !== 'sv') {
      const identity = await page.evaluate(() => {
        const inner = (window as any).__rewrap.editor.vditor
        const editor = inner[inner.currentMode].element as HTMLElement
        return {
          soft: editor.querySelectorAll('[data-vmde-soft-break="1"]').length,
          hard: editor.querySelectorAll('[data-vmde-hard-break]').length,
          whiteSpace: getComputedStyle(editor.querySelector('p')!).whiteSpace,
        }
      })
      expect(identity.soft).toBe(0)
      expect(identity.hard).toBe(2)
      expect(identity.whiteSpace).toBe('normal')
    } else {
      expect(
        await page.evaluate(() => {
          const tail = (window as any).__svUntouchedTail as Node
          return tail.isConnected && tail === (window as any).__svUntouchedTail
        }),
      ).toBe(true)
    }

    await page.evaluate(() => {
      const inner = (window as any).__rewrap.editor.vditor
      inner.undo.undo(inner)
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(typedCanonical)

    const initial = await page.evaluate(() => (window as any).__rewrap.initial)
    await page.evaluate(() => {
      const inner = (window as any).__rewrap.editor.vditor
      inner.undo.undo(inner)
    })
    await expect
      .poll(() =>
        page.evaluate(() => (window as any).__rewrap.editor.getValue()),
      )
      .toBe(initial)
  })
}

test('auto-wrap respects quote and Markdown syntax boundaries', async ({
  page,
}) => {
  await openRewrapHarness(page, 'ir', true, false, 60)
  const markdown = [
    '> **Selected option:** A',
    '>',
    '> **Required `MonoView` members:**',
    '>',
    '> **Required `UIToolkitView` members:**',
    '>',
    '> **Lifecycle constraints:** **Notes:** Add to plan file instead of proposal',
    '',
  ].join('\n')
  const expected = [
    '> **Selected option:** A',
    '>',
    '> **Required `MonoView` members:**',
    '>',
    '> **Required `UIToolkitView` members:**',
    '>',
    '> **Lifecycle constraints:** **Notes:** Add to plan file',
    '> instead of proposalx',
    '',
  ].join('\n')
  await page.evaluate((value) => {
    ;(window as any).__rewrap.editor.setValue(value)
  }, markdown)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(markdown)
  await placeRewrapCaret(page, 'proposal', 'proposal'.length)

  await page.keyboard.type('x')

  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs))
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(expected)

  await openRewrapHarness(page, 'ir', true, false, 30)
  const composite = [
    'Plain sibling unchanged',
    '',
    '- list sibling unchanged',
    '',
    '- [ ]  task sibling unchanged',
    '',
    '1. ordered sibling unchanged',
    '',
    '>> nested sibling unchanged',
    '>>',
    '>',
    '> [!NOTE]',
    '> callout alpha beta gamma delta epsilon',
    '>',
    '> quoted sibling unchanged',
    '',
    '> ```js',
    '> const protected = "alpha beta gamma delta"',
    '> ```',
    '',
    '> $$',
    '> alpha beta gamma',
    '> $$',
    '',
    'A Setext Heading',
    '----------------',
    '',
  ].join('\n')
  const compositeExpected = composite.replace(
    '> callout alpha beta gamma delta epsilon',
    '> callout alpha beta gamma\n> delta epsilonx',
  )
  await page.evaluate((value) => {
    ;(window as any).__rewrap.editor.setValue(value)
  }, composite)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(composite)
  await placeRewrapCaret(page, 'epsilon', 'epsilon'.length)

  await page.keyboard.type('x')

  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs))
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(compositeExpected)

  await openRewrapHarness(page, 'ir', true, false, 14)
  const nestedQuote = [
    '> outer alpha beta',
    '>',
    '>> nested gamma delta',
    '>>',
    '>',
    '> tail epsilon',
    '',
  ].join('\n')
  const nestedQuoteExpected = [
    '> outer alpha',
    '> betax',
    '>',
    '>> nested gamma delta',
    '>>',
    '>',
    '> tail epsilon',
    '',
  ].join('\n')
  await page.evaluate((value) => {
    ;(window as any).__rewrap.editor.setValue(value)
  }, nestedQuote)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(nestedQuote)
  await placeRewrapCaret(page, 'beta', 'beta'.length)

  await page.keyboard.type('x')

  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.state().syncs))
    .toBe(1)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(nestedQuoteExpected)

  await openRewrapHarness(page, 'ir', true, false, 12)
  const protectedFence = '> ```\n>> alpha beta gamma delta\n> ```\n'
  const typedProtectedFence = protectedFence.replace('gamma', 'gammax')
  await page.evaluate((value) => {
    ;(window as any).__rewrap.editor.setValue(value)
  }, protectedFence)
  await expect
    .poll(() => page.evaluate(() => (window as any).__rewrap.editor.getValue()))
    .toBe(protectedFence)
  await placeRewrapCaret(page, 'gamma', 'gamma'.length)

  await page.keyboard.type('x')
  await page.waitForTimeout(650)

  expect(
    await page.evaluate(() => (window as any).__rewrap.state().syncs),
  ).toBe(0)
  expect(
    await page.evaluate(() => (window as any).__rewrap.editor.getValue()),
  ).toBe(typedProtectedFence)
})
