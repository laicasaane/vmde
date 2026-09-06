import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'rewrap.md')
const ORIGINAL = readFileSync(FIXTURE, 'utf8')
const WRAPPED = ORIGINAL.replace(
  'alpha beta gamma delta epsilon',
  'alpha beta\ngamma delta\nepsilon',
)

const DOCUMENT = [
  '---',
  'title: protected alpha beta gamma',
  '---',
  '',
  '# Heading',
  '',
  'first alpha beta gamma delta epsilon',
  '',
  'middle alpha beta target gamma delta epsilon',
  '',
  '> quote alpha beta gamma delta',
  '',
  '- list alpha beta gamma delta',
  '',
  'hard alpha  ',
  'hard beta gamma',
  '',
  '```js',
  'const protected = "alpha beta gamma delta"',
  '```',
  '',
  '| alpha | beta |',
  '| ----- | ---- |',
  '',
  '$$',
  'alpha beta gamma',
  '$$',
  '',
  'tail alpha beta gamma delta epsilon',
  '',
].join('\n')

const wrappedDocument = (markdown: string) =>
  markdown
    .replace(
      'first alpha beta gamma delta epsilon',
      'first alpha beta\ngamma delta\nepsilon',
    )
    .replace(
      'middle alpha beta target gamma delta epsilon',
      'middle alpha beta\ntarget gamma delta\nepsilon',
    )
    .replace(
      '> quote alpha beta gamma delta',
      '> quote alpha beta\n> gamma delta',
    )
    .replace(
      '- list alpha beta gamma delta',
      '- list alpha beta\n  gamma delta',
    )
    .replace(
      'tail alpha beta gamma delta epsilon',
      'tail alpha beta\ngamma delta\nepsilon',
    )

function caretMatchesRewrappedTarget(
  _body: HTMLElement,
  input: { currentMode: string; expectedCaretOffset: number },
): boolean {
  const inner = (window as any).vditor.vditor
  const editor = inner[inner.currentMode].element as HTMLElement
  const selection = window.getSelection()
  const anchor = selection?.anchorNode
  if (!selection || !anchor || selection.rangeCount === 0) return false
  const before = document.createRange()
  before.selectNodeContents(editor)
  before.setEnd(anchor, selection.anchorOffset)
  if (input.currentMode === 'sv') {
    return before.toString().length === input.expectedCaretOffset
  }
  const after = document.createRange()
  after.selectNodeContents(editor)
  after.setStart(anchor, selection.anchorOffset)
  return (
    /target ga$/u.test(before.toString()) &&
    /^mma delta/u.test(after.toString())
  )
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const state = globalThis as typeof globalThis & {
      __vmdeRewrapDocumentEvents?: { dispose(): void }
    }
    state.__vmdeRewrapDocumentEvents?.dispose()
    delete state.__vmdeRewrapDocumentEvents
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.wrapColumn',
      undefined,
      vscode.ConfigurationTarget.Global,
    )
    await config.update(
      'editor.defaultMode',
      undefined,
      vscode.ConfigurationTarget.Global,
    )
  })
})

test('Alt+Q rewraps once with caret, scroll, writeback, and undo preserved in all modes', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(300_000)
  const docPath = path.join(baseDir, 'rewrap.md')
  writeFileSync(docPath, ORIGINAL)
  await evaluateInVSCode(
    async (vscode, args: string[]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      await config.update(
        'editor.wrapColumn',
        12,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.defaultMode',
        'ir',
        vscode.ConfigurationTarget.Global,
      )
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })

  const docText = () =>
    evaluateInVSCode(
      async (vscode, args: string[]) =>
        vscode.workspace.textDocuments
          .find((doc) => doc.uri.fsPath === args[0])
          ?.getText() ?? '',
      [docPath] as [string],
    ) as Promise<string>

  const replaceDocument = (text: string) =>
    evaluateInVSCode(
      async (vscode, args: [string, string]) => {
        const [fsPath, next] = args
        const doc = vscode.workspace.textDocuments.find(
          (candidate) => candidate.uri.fsPath === fsPath,
        )
        if (!doc) throw new Error('rewrap document not open')
        const edit = new vscode.WorkspaceEdit()
        edit.replace(
          doc.uri,
          new vscode.Range(
            doc.positionAt(0),
            doc.positionAt(doc.getText().length),
          ),
          next,
        )
        await vscode.workspace.applyEdit(edit)
      },
      [docPath, text] as [string, string],
    )

  const currentValue = () =>
    frame
      .locator('body')
      .evaluate(() =>
        (
          window as unknown as { vditor: { getValue(): string } }
        ).vditor.getValue(),
      ) as Promise<string>

  async function switchMode(mode: 'ir' | 'wysiwyg' | 'sv') {
    await frame.locator('body').evaluate((_body, nextMode) => {
      const inner = (window as any).vditor.vditor
      if (inner.currentMode === nextMode) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      document
        .querySelector(`button[data-mode="${nextMode}"]`)
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    }, mode)
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => (window as any).vditor.vditor.currentMode),
      )
      .toBe(mode)
  }

  async function placeCaret(
    mode: 'ir' | 'wysiwyg' | 'sv',
    needle = 'gamma',
    offset = 2,
  ) {
    const selector = `.vditor-${mode}`
    await frame
      .locator(selector)
      .first()
      .click({ position: { x: 4, y: 4 } })
    await frame.locator('body').evaluate(
      (_body, input) => {
        const { surface, needle, offset } = input as {
          surface: string
          needle: string
          offset: number
        }
        const editor = document.querySelector(surface) as HTMLElement | null
        if (!editor) throw new Error(`missing ${surface}`)
        const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
        let target: Text | null = null
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if ((node.textContent ?? '').includes(needle)) {
            target = node as Text
            break
          }
        }
        if (!target) throw new Error(`${needle} not found in ${surface}`)
        const range = document.createRange()
        range.setStart(target, target.data.indexOf(needle) + offset)
        range.collapse(true)
        editor.focus()
        const selection = window.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
        document.dispatchEvent(new Event('selectionchange'))
        const scroller = editor.parentElement as HTMLElement
        scroller.style.height = '80px'
        scroller.style.overflow = 'auto'
        scroller.scrollTop = 20
        ;(window as any).__rewrapScroll = { scroller, top: scroller.scrollTop }
        ;(window as any).__vmdeCaptureRewrapSelectionForTest?.()
        return new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
      },
      { surface: selector, needle, offset },
    )
  }

  async function sourceCaretOffset(mode: 'ir' | 'wysiwyg' | 'sv') {
    return frame.locator('body').evaluate((_body, currentMode) => {
      const outer = (window as any).vditor
      if (currentMode !== 'sv') {
        const editor = outer.vditor[currentMode].element as HTMLElement
        const selection = window.getSelection()!
        const range = selection.getRangeAt(0).cloneRange()
        const marker = '\uE200REAL_REWRAP_CARET'
        const markerNode = document.createTextNode(marker)
        range.insertNode(markerNode)
        const html = editor.innerHTML
        const markdown =
          currentMode === 'ir'
            ? outer.vditor.lute.VditorIRDOM2Md(html)
            : outer.vditor.lute.VditorDOM2Md(html)
        markerNode.remove()
        editor.normalize()
        return markdown.indexOf(marker)
      }
      const editor = outer.vditor.sv.element as HTMLElement
      const selection = window.getSelection()!
      const caret = selection.getRangeAt(0)
      const before = caret.cloneRange()
      before.selectNodeContents(editor)
      before.setEnd(caret.startContainer, caret.startOffset)
      return before.toString().length
    }, mode)
  }

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    if ((await docText()) !== ORIGINAL) {
      await replaceDocument(ORIGINAL)
      await expect.poll(currentValue, { timeout: 20_000 }).toBe(ORIGINAL)
    }
    await switchMode(mode)
    await placeCaret(mode)
    const canonicalBefore = await currentValue()
    const canonicalWrapped = canonicalBefore.replace(
      'alpha beta gamma delta epsilon',
      'alpha beta\ngamma delta\nepsilon',
    )

    await workbox.keyboard.press('Alt+q')

    await expect.poll(docText, { timeout: 20_000 }).toBe(WRAPPED)
    expect(await currentValue()).toBe(canonicalWrapped)
    expect(await sourceCaretOffset(mode)).toBe(13)
    const scrollKept = await frame.locator('body').evaluate(() => {
      const saved = (window as any).__rewrapScroll
      return saved.scroller.scrollTop === saved.top
    })
    expect(scrollKept).toBe(true)

    await workbox.keyboard.press('Control+z')
    await expect.poll(docText, { timeout: 20_000 }).toBe(ORIGINAL)
  }

  await evaluateInVSCode(async (vscode) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.wrapColumn', 18, vscode.ConfigurationTarget.Global)
  })

  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    await replaceDocument(DOCUMENT)
    await expect.poll(docText, { timeout: 20_000 }).toBe(DOCUMENT)
    await expect
      .poll(currentValue, { timeout: 20_000 })
      .toContain('middle alpha beta target gamma delta epsilon')
    const canonicalDocument = await currentValue()
    if ((await docText()) !== canonicalDocument) {
      await replaceDocument(canonicalDocument)
      await expect.poll(docText, { timeout: 20_000 }).toBe(canonicalDocument)
      await expect
        .poll(currentValue, { timeout: 20_000 })
        .toBe(canonicalDocument)
    }
    const documentWrapped = wrappedDocument(canonicalDocument)
    await switchMode(mode)
    const renderedBeforeCommand = await currentValue()
    await evaluateInVSCode(
      async (vscode, args: string[]) => {
        const state = globalThis as typeof globalThis & {
          __vmdeRewrapDocumentEvents?: { dispose(): void }
          __vmdeRewrapDocumentValues?: string[]
        }
        state.__vmdeRewrapDocumentEvents?.dispose()
        state.__vmdeRewrapDocumentValues = []
        state.__vmdeRewrapDocumentEvents =
          vscode.workspace.onDidChangeTextDocument((event) => {
            if (event.document.uri.fsPath === args[0]) {
              state.__vmdeRewrapDocumentValues?.push(event.document.getText())
            }
          })
      },
      [docPath] as [string],
    )
    await placeCaret(
      mode,
      'middle alpha beta target gamma delta epsilon',
      'middle alpha beta target '.length + 2,
    )
    const hostValues = () =>
      evaluateInVSCode(
        async () =>
          (
            globalThis as typeof globalThis & {
              __vmdeRewrapDocumentValues?: string[]
            }
          ).__vmdeRewrapDocumentValues ?? [],
      ) as Promise<string[]>

    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vmde.rewrapDocument')
    })
    await expect.poll(docText, { timeout: 20_000 }).toBe(documentWrapped)
    const renderedValue = await currentValue()
    expect(renderedValue).toContain('first alpha beta\ngamma delta\nepsilon')
    expect(renderedValue).toContain(
      'middle alpha beta\ntarget gamma delta\nepsilon',
    )
    expect(renderedValue).toContain('> quote alpha beta')
    expect(renderedValue).toContain('- list alpha beta\n  gamma delta')
    expect(renderedValue).toContain('hard alpha  \nhard beta gamma')
    expect(renderedValue).toContain(
      '```js\nconst protected = "alpha beta gamma delta"\n```',
    )
    expect(renderedValue).toContain('| alpha | beta |\n| ----- | ---- |')
    expect(renderedValue).toContain('$$\nalpha beta gamma\n$$')
    const expectedCaretOffset =
      renderedValue.indexOf(
        'target gamma delta',
        renderedValue.indexOf('middle'),
      ) + 'target ga'.length
    await expect
      .poll(
        () =>
          frame.locator('body').evaluate(caretMatchesRewrappedTarget, {
            currentMode: mode,
            expectedCaretOffset,
          }),
        { message: `document rewrap caret in ${mode}` },
      )
      .toBe(true)
    const interaction = await frame.locator('body').evaluate(() => {
      const outer = (window as any).vditor
      const inner = outer.vditor
      const editor = inner[inner.currentMode].element as HTMLElement
      const saved = (window as any).__rewrapScroll
      return {
        mode: inner.currentMode,
        scrollKept: saved.scroller.scrollTop === saved.top,
        focused: editor.contains(document.activeElement),
        markerInMarkdown: outer.getValue().includes('VMDE_REWRAP'),
        markerInDom: editor.textContent?.includes('VMDE_REWRAP') ?? false,
      }
    })
    expect(interaction).toEqual({
      mode,
      scrollKept: true,
      focused: true,
      markerInMarkdown: false,
      markerInDom: false,
    })
    expect(await hostValues()).toEqual([documentWrapped])

    await evaluateInVSCode(async (vscode) => {
      await vscode.commands.executeCommand('vmde.rewrapDocument')
    })
    // Negative-observation wait: a no-op has no positive completion event to poll for.
    await frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
    expect(await hostValues()).toEqual([documentWrapped])
    await frame
      .locator(`.vditor-${mode}`)
      .first()
      .click({ position: { x: 4, y: 4 } })
    await workbox.keyboard.press('Control+z')
    await frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)))
    await expect
      .poll(currentValue, { timeout: 20_000 })
      .toBe(renderedBeforeCommand)
    await expect.poll(docText, { timeout: 20_000 }).toBe(canonicalDocument)
  }
})
