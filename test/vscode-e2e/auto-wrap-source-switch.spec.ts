import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

const FIXTURE = path.join(__dirname, 'fixtures', 'auto-wrap.md')
const ORIGINAL = readFileSync(FIXTURE, 'utf8').replace('<2sp>', '  ')
const TYPED = ORIGINAL.replace('gamma', 'gammaz')
const WRAPPED = TYPED.replace(
  'alpha beta gammaz delta epsilon',
  'alpha beta\ngammaz delta\nepsilon',
)

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode) => {
    const config = vscode.workspace.getConfiguration('vmde')
    for (const key of [
      'editor.wrapColumn',
      'editor.autoWrap',
      'editor.autoWrapDelay',
      'editor.defaultMode',
      'preview.reflowLineBreaks',
    ]) {
      await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    }
  })
})

test('Task 686: the IR auto-wrap applies right after a Source pass', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  const docPath = path.join(baseDir, 'auto-wrap.md')
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
        'editor.autoWrap',
        true,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.autoWrapDelay',
        500,
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'editor.defaultMode',
        'ir',
        vscode.ConfigurationTarget.Global,
      )
      await config.update(
        'preview.reflowLineBreaks',
        false,
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
        if (!doc) throw new Error('auto-wrap document not open')
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

  async function waitForUndoReady() {
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const inner = (window as any).vditor.vditor
          return inner.undo[inner.currentMode].undoStack.length
        }),
      )
      .toBeGreaterThanOrEqual(1)
  }

  const undoActiveMode = () =>
    frame.locator('body').evaluate(() => {
      const inner = (window as any).vditor.vditor
      inner.undo.undo(inner)
    })

  async function placeCaret(mode: 'ir' | 'wysiwyg' | 'sv') {
    const selector = `.vditor-${mode}`
    await frame
      .locator(selector)
      .first()
      .click({ position: { x: 4, y: 4 } })
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page fixture operation resolves the mode surface, places a real caret, and manufactures measurable scroll overflow
    await frame.locator('body').evaluate((_body, surface) => {
      const editor = document.querySelector(surface) as HTMLElement | null
      if (!editor) throw new Error(`missing ${surface}`)
      editor.focus({ preventScroll: true })
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let target: Text | null = null
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if ((node.textContent ?? '').includes('gamma')) {
          target = node as Text
          break
        }
      }
      if (!target) throw new Error(`gamma not found in ${surface}`)
      const range = document.createRange()
      range.setStart(target, target.data.indexOf('gamma') + 5)
      range.collapse(true)
      const selection = window.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const wrapper = editor.parentElement as HTMLElement
      editor.style.minHeight = '2000px'
      wrapper.style.display = 'block'
      wrapper.style.height = '80px'
      wrapper.style.maxHeight = '80px'
      wrapper.style.overflowY = 'scroll'
      let candidate: HTMLElement | null = editor
      let scroller: HTMLElement | null = null
      while (candidate && candidate !== document.body) {
        const overflow = getComputedStyle(candidate).overflowY
        if (
          (overflow === 'auto' ||
            overflow === 'scroll' ||
            overflow === 'overlay') &&
          candidate.scrollHeight > candidate.clientHeight + 1
        ) {
          scroller = candidate
          break
        }
        candidate = candidate.parentElement
      }
      scroller ??=
        (document.scrollingElement as HTMLElement | null) ??
        document.documentElement
      scroller.scrollTop = 20
      if (scroller.scrollTop === 0)
        throw new Error('scroll fixture did not overflow')
      ;(window as any).__autoWrapScroll = { scroller, top: scroller.scrollTop }
    }, selector)
  }

  async function setAutoWrapConfig(
    enabled: boolean,
    delay: number,
    reflow: boolean,
    column = 48,
  ) {
    await evaluateInVSCode(
      async (vscode, args: [boolean, number, boolean, number]) => {
        const [autoWrap, autoWrapDelay, previewReflow, wrapColumn] = args
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update(
          'editor.autoWrap',
          autoWrap,
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'editor.autoWrapDelay',
          autoWrapDelay,
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'preview.reflowLineBreaks',
          previewReflow,
          vscode.ConfigurationTarget.Global,
        )
        await config.update(
          'editor.wrapColumn',
          wrapColumn,
          vscode.ConfigurationTarget.Global,
        )
      },
      [enabled, delay, reflow, column] as [boolean, number, boolean, number],
    )
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(() => (window as any).__vmdeReflowPreview === true),
      )
      .toBe(reflow)
  }

  // Task 686: after a Source pass, the first IR key can arrive before edit-sync holds exact
  // authority (the typing was published as a plain edit). The automatic wrap must still apply.
  // No reseed step: every repetition goes straight from the Source pass to the IR pass.
  await setAutoWrapConfig(true, 1000, false, 12)
  for (let rep = 0; rep < 10; rep++) {
    if ((await docText()) !== ORIGINAL) {
      await replaceDocument(ORIGINAL)
      await expect.poll(docText, { timeout: 20_000 }).toBe(ORIGINAL)
    }
    await switchMode('sv')
    await waitForUndoReady()
    await placeCaret('sv')
    await workbox.keyboard.type('z')
    await expect.poll(docText, { timeout: 20_000 }).toBe(WRAPPED)
    await undoActiveMode()
    await expect.poll(docText, { timeout: 20_000 }).toBe(TYPED)
    await undoActiveMode()
    await expect.poll(docText, { timeout: 20_000 }).toBe(ORIGINAL)

    await switchMode('ir')
    await waitForUndoReady()
    await placeCaret('ir')
    await workbox.keyboard.type('z')
    // A declined firing leaves the typed, unwrapped text (TYPED) on the host.
    await expect(
      async () => expect(await docText()).toBe(WRAPPED),
      `repetition ${rep}`,
    ).toPass({ timeout: 10_000 })
    await undoActiveMode()
    await expect.poll(docText, { timeout: 20_000 }).toBe(TYPED)
    await undoActiveMode()
    await expect.poll(docText, { timeout: 20_000 }).toBe(ORIGINAL)
  }
})
