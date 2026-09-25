import path from 'node:path'
import { readFileSync } from 'node:fs'
import { expect, test } from './coverage-fixture'

const FIXTURE = path.join(
  __dirname,
  '../../test/vscode-e2e/fixtures/large-observable-models-synthetic.md',
)

function copiedText(source: string): string {
  let text = source.replace(/\u00a0/gu, ' ').replace(/\u200b/gu, '')
  if (text.endsWith('\n')) text = text.slice(0, -1)
  return text
}

test('code-copy text stays exact without layout reads in IR, WYSIWYG, and Preview', async ({
  page,
}) => {
  const markdown = readFileSync(FIXTURE, 'utf8')

  await page.addInitScript((input: string) => {
    const win = window as any
    win.__vmdeCodeCopyMarkdown = input
    const metrics = { innerTextReads: 0 }
    win.__vmdeCodeCopyMetrics = metrics

    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'innerText',
    )
    if (!descriptor?.get)
      throw new Error('HTMLElement.innerText getter missing')
    Object.defineProperty(HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        if (this.tagName === 'CODE') metrics.innerTextReads++
        return descriptor.get!.call(this)
      },
      set(value: string) {
        descriptor.set?.call(this, value)
      },
    })
  }, markdown)

  await page.goto('/code-copy-text.html')
  await page.waitForFunction(() => (window as any).__vmdeCodeCopyReady === true)
  await page.waitForFunction(
    () => document.querySelectorAll('.vditor-copy textarea').length > 0,
    undefined,
    { timeout: 20_000 },
  )

  const openPreview = async () => {
    await page.evaluate(() => (window as any).__vmdeToggleCodeCopyPreview())
    await page.waitForFunction(
      () => (window as any).__vmdePreviewVisible() === true,
    )
    await page.waitForFunction(
      () =>
        (window as any).vditor.vditor.preview.previewElement.querySelectorAll(
          'pre > code',
        ).length > 0,
      undefined,
      { timeout: 20_000 },
    )
    const counts = await page.evaluate(() => {
      const preview = (window as any).vditor.vditor.preview.previewElement
      return {
        codeBlocks: preview.querySelectorAll('pre > code').length,
        copyContainers: preview.querySelectorAll('.vditor-copy').length,
        copyButtons: preview.querySelectorAll(
          '.vditor-copy [data-vmde-copy-code]',
        ).length,
        inlineHandlers: preview.querySelectorAll('.vditor-copy [onclick]')
          .length,
      }
    })
    expect(counts.codeBlocks).toBe(36)
    expect(counts.copyContainers).toBe(36)
    expect(counts.copyButtons).toBe(36)
    expect(
      counts.copyButtons,
      ['Preview code-copy structure: ', JSON.stringify(counts)].join(''),
    ).toBeGreaterThan(0)
    expect(counts.copyButtons).toBe(counts.copyContainers)
    expect(counts.inlineHandlers).toBe(0)
  }
  const closePreview = async () => {
    await page.evaluate(() => (window as any).__vmdeToggleCodeCopyPreview())
    await page.waitForFunction(
      () => (window as any).__vmdePreviewVisible() === false,
    )
  }
  const copyPreviewCode = async () => {
    const copy = page
      .locator('.vditor-preview .vditor-copy [data-vmde-copy-code]')
      .first()
    const textarea = copy.locator('xpath=../textarea')
    const expected = (await textarea.inputValue())
      .split(String.fromCharCode(0x200b))
      .join('')
    await copy.locator('xpath=ancestor::pre[1]').hover()
    await expect(copy).toBeVisible()
    const before = await page.evaluate(() => ({
      value: (window as any).__vmdeCodeCopyValue() as string,
      sourceCodeCount: (window as any).__vmdeSourceCodeCount() as number,
    }))
    await copy.click()
    const stats = await page.evaluate((payload) => {
      const messages = (window as any).__vmdeCodeCopyMessages as string[]
      const message = messages.at(-1)
      const textarea = document
        .querySelector('.vditor-preview .vditor-copy [data-vmde-copy-code]')
        ?.parentElement?.querySelector('textarea')?.value
      let mismatch = -1
      if (message && textarea) {
        const limit = Math.min(message.length, textarea.length)
        for (let index = 0; index < limit; index++) {
          if (message[index] !== textarea[index]) {
            mismatch = index
            break
          }
        }
      }
      return {
        messageCount: messages.length,
        payloadLength: payload.length,
        messageLength: message?.length ?? -1,
        textareaLength: textarea?.length ?? -1,
        payloadMatchesTextarea: textarea === payload,
        messageMatchesTextarea: message === textarea,
        mismatch,
      }
    }, expected)
    expect(
      stats.messageMatchesTextarea,
      ['copy payload metrics: ', JSON.stringify(stats)].join(''),
    ).toBe(true)
    expect(stats.payloadMatchesTextarea).toBe(true)
    const after = await page.evaluate(() => ({
      value: (window as any).__vmdeCodeCopyValue() as string,
      sourceCodeCount: (window as any).__vmdeSourceCodeCount() as number,
    }))
    expect(after.value === before.value).toBe(true)
    expect(after.sourceCodeCount).toBe(before.sourceCodeCount)
  }

  expect(
    await page.evaluate(() => (window as any).__vmdeCodeCopyMode() as string),
  ).toBe('ir')
  const irSourceBlocks = await page.evaluate(
    () => (window as any).__vmdeSourceCodeCount() as number,
  )
  expect(irSourceBlocks).toBeGreaterThan(0)
  await openPreview()
  await copyPreviewCode()
  await closePreview()

  await page.evaluate(() => (window as any).__vmdeSwitchCodeCopyMode('wysiwyg'))
  await page.waitForFunction(
    () => (window as any).__vmdeCodeCopyMode() === 'wysiwyg',
  )
  const wysiwygSourceBlocks = await page.evaluate(
    () => (window as any).__vmdeSourceCodeCount() as number,
  )
  expect(wysiwygSourceBlocks).toBeGreaterThan(0)
  await openPreview()
  await copyPreviewCode()
  await closePreview()

  // Full Preview is also opened from WYSIWYG and keeps its source unchanged.
  await openPreview()
  await copyPreviewCode()

  const ordinaryText =
    '\tconst label = "A\u00a0B";\n\nconst markup = "<tag>&";\n'
  const highlightedLines = [
    '\tconst label = "C\u00a0D";',
    'const markup = "<tag>&";',
  ]
  const expectedOrdinary = copiedText(ordinaryText)
  const expectedHighlighted =
    '\tconst label = "C D";\n\nconst markup = "<tag>&";\n'
  const probeButtonCount = await page.evaluate(
    ({ ordinary, highlighted }) =>
      (window as any).__vmdeRenderCopyProbe(ordinary, highlighted),
    { ordinary: ordinaryText, highlighted: highlightedLines },
  )
  expect(probeButtonCount).toBe(2)

  const probeMatches = await page
    .locator('#code-copy-probe textarea')
    .evaluateAll((textareas) => {
      const values = textareas.map(
        (textarea) => (textarea as HTMLTextAreaElement).value,
      )
      return (
        values[0] === '\tconst label = "A B";\n\nconst markup = "<tag>&";' &&
        values[1] === '\tconst label = "C D";\n\nconst markup = "<tag>&";\n'
      )
    })
  expect(probeMatches).toBe(true)

  const probeBefore = await page.evaluate(() =>
    (window as any).__vmdeCodeCopyValue(),
  )
  for (const [index, expected] of [
    [0, expectedOrdinary],
    [1, expectedHighlighted],
  ] as const) {
    const copy = page
      .locator('#code-copy-probe .vditor-copy [data-vmde-copy-code]')
      .nth(index)
    await copy.locator('xpath=ancestor::pre[1]').hover()
    await copy.click()
    const matches = await page.evaluate((payload) => {
      const messages = (window as any).__vmdeCodeCopyMessages as string[]
      return messages.at(-1) === payload
    }, expected)
    expect(matches).toBe(true)
  }
  const probeAfter = await page.evaluate(() =>
    (window as any).__vmdeCodeCopyValue(),
  )
  expect(probeAfter === probeBefore).toBe(true)

  const innerTextReads = await page.evaluate(
    () => (window as any).__vmdeCodeCopyMetrics.innerTextReads as number,
  )
  expect(innerTextReads).toBe(0)
})
