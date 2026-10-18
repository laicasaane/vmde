import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { planBlockAction } from '../../src/shared/block-move'
import {
  moveMarkdownSection,
  scanSourceHeadings,
} from '../../src/shared/section-move'
import {
  rewrapMarkdownDocument,
  rewrapMarkdownRange,
} from '../../media-src/src/editing/rewrap-markdown'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  wf,
} from './webview-helpers'

const FRONT = '---\ntitle: matrix\n---\n\n'
const PROSE =
  'Alpha one two three four five six seven eight nine ten eleven twelve.'
const BODY = `# First\n\n${PROSE}\n\nMover paragraph.\n\n$$\nx^2\n$$\n\n# Second\n\nTail findme paragraph.\n`
const FEATURES = [
  'selection Rewrap',
  'auto-wrap',
  'Rewrap Document',
  'heading shift',
  'block handle',
  'Move Block',
  'Turn Into',
  'Details',
  'callout apply',
  'selection Link',
  'outline move',
  'Find Replace',
] as const

// One launch per mode; each feature resets the same host document and compares the body operation
// on exact bytes with and without the YAML prefix. Failed steps remain separate report entries.
for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: front matter preserves every body action and shifts exact offsets`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(600_000)
    const file = path.join(baseDir, `front-matter-matrix-${mode}.md`)
    writeFileSync(file, BODY)
    await evaluateInVSCode(
      async (vscode, args: [string, string]) => {
        const config = vscode.workspace.getConfiguration('vmde')
        for (const [key, value] of Object.entries({
          'editor.defaultMode': args[1],
          'editor.wrapColumn': 30,
          'editor.autoWrap': false,
          'editor.autoWrapDelay': 300,
        }))
          await config.update(key, value, vscode.ConfigurationTarget.Global)
        await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          'vmde.editor',
        )
      },
      [file, mode] as [string, string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === mode,
      { timeout: 60_000 },
    )
    await waitForInitialUndoSnapshot(frame)
    await frame.locator('body').evaluate(() => {
      ;(window as any).__matrixConfig = {
        autoWrap: false,
        column: 30,
        inputs: 0,
        trusted: false,
        inputType: '',
      }
      window.addEventListener('message', (event) => {
        if (event.data?.command !== 'config-changed') return
        Object.assign((window as any).__matrixConfig, {
          autoWrap: event.data.options.autoWrap,
          column: event.data.options.wrapColumn,
        })
      })
      document.addEventListener('input', (event) => {
        const inner = (window as any).vditor.vditor
        if (!inner[inner.currentMode].element.contains(event.target)) return
        Object.assign((window as any).__matrixConfig, {
          inputs: (window as any).__matrixConfig.inputs + 1,
          trusted: event.isTrusted,
          inputType: (event as InputEvent).inputType,
        })
      })
    })
    const input = await createXtestInput(electronApp, workbox)
    await input.activateAndFocus()
    const fill = async (
      locator: ReturnType<typeof frame.locator>,
      text: string,
    ) => {
      await locator.click()
      await input.key('ctrl+a')
      await input.type(text)
      await expect(locator).toHaveValue(text)
    }
    const host = () => docText(evaluateInVSCode, file)
    const command = (id: string) =>
      evaluateInVSCode(async (vscode, id: string) => {
        await vscode.commands.executeCommand(id)
      }, id)
    const auto = async (enabled: boolean) => {
      await evaluateInVSCode(async (vscode, enabled: boolean) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('editor.autoWrap', enabled, vscode.ConfigurationTarget.Global)
      }, enabled)
      // Configuration transport is asynchronous: acknowledge the delivered option before typing.
      await expect
        .poll(() =>
          frame
            .locator('body')
            .evaluate(() => (window as any).__matrixConfig.autoWrap),
        )
        .toBe(enabled)
    }
    const reset = async (source: string) => {
      await auto(false)
      await evaluateInVSCode(
        async (vscode, args: [string, string]) => {
          const doc = vscode.workspace.textDocuments.find(
            (doc) => doc.uri.fsPath === args[0],
          )!
          const edit = new vscode.WorkspaceEdit()
          edit.replace(
            doc.uri,
            new vscode.Range(
              doc.positionAt(0),
              doc.positionAt(doc.getText().length),
            ),
            args[1],
          )
          await vscode.workspace.applyEdit(edit)
        },
        [file, source] as [string, string],
      )
      await expect.poll(host).toBe(source)
      await expect
        .poll(
          () =>
            frame
              .locator('body')
              .evaluate(
                (_body, source) =>
                  (window as any).__vmdeE2EExactMarkdown?.() === source,
                source,
              ),
          { timeout: 20_000 },
        )
        .toBe(true)
      await expect(
        frame
          .locator(`.vditor-${mode} .vditor-reset > p`)
          .filter({ hasText: PROSE }),
      ).toBeVisible()
    }
    const select = async (needle: string, start: number, end = start) => {
      await frame
        .locator(
          `.vditor-${mode} .vditor-reset > p, .vditor-${mode} .vditor-reset > h1`,
        )
        .filter({ hasText: needle })
        .first()
        .click()
      return frame.locator('body').evaluate(
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one DOM task installs and acknowledges a retained caret or range before host commands move focus.
        async (_body, point) => {
          const inner = (window as any).vditor.vditor
          const root = inner[inner.currentMode].element as HTMLElement
          const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.parentElement?.closest('[data-render]')) continue
            const at = (node.textContent ?? '').indexOf(point.needle)
            if (at < 0) continue
            root.focus({ preventScroll: true })
            const range = document.createRange()
            range.setStart(node, at + point.start)
            range.setEnd(node, at + point.end)
            getSelection()!.removeAllRanges()
            getSelection()!.addRange(range)
            ;(window as any).__vmdeRequestCaret(
              point.start === point.end
                ? { node, offset: at + point.start }
                : {
                    anchor: { node, offset: at + point.start },
                    focus: { node, offset: at + point.end },
                  },
            )
            document.dispatchEvent(new Event('selectionchange'))
            await new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            )
            return (window as any).__vmdeCaptureRewrapSelectionForTest?.()
          }
          throw new Error('matrix text endpoint missing')
        },
        { needle, start, end },
      )
    }
    const failures: string[] = []
    const plainResults = new Map<string, string>()
    try {
      for (const feature of FEATURES) {
        for (const prefix of ['', FRONT]) {
          // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: all twelve independent feature branches share one reset and exact-prefix comparison to keep the acceptance matrix within two launches.
          await test.step(`${feature}, frontMatter=${Boolean(prefix)}`, async () => {
            let phase = 'reset'
            const source = prefix + BODY
            let expected = source
            try {
              await reset(source)
              phase = 'capture'
              const caret = source.indexOf('three') + 2
              const proof = await select('three', 2)
              expect(proof).toMatchObject({
                startOffset: caret,
                endOffset: caret,
                caretOffset: caret,
              })
              phase = 'apply'
              if (feature === 'selection Rewrap') {
                expected = rewrapMarkdownRange(
                  source,
                  caret,
                  caret,
                  caret,
                  30,
                ).markdown
                await command('vmde.rewrap')
              } else if (feature === 'auto-wrap') {
                await auto(true)
                await select('three', 5)
                await input.type('z')
                // Acknowledge delivery before checking automatic reflow. The source-only prefix
                // must survive both the typing writeback and the automatic exact transaction.
                await expect.poll(host).toContain('threez')
                const typed = source.replace('three', 'threez')
                expected = rewrapMarkdownRange(
                  typed,
                  typed.indexOf('threez') + 6,
                  typed.indexOf('threez') + 6,
                  typed.indexOf('threez') + 6,
                  30,
                ).markdown
              } else if (feature === 'Rewrap Document') {
                expected = rewrapMarkdownDocument(source, caret, 30).markdown
                await command('vmde.rewrapDocument')
              } else if (feature === 'heading shift') {
                await select('First', 2)
                expected = source.replace('# First', '## First')
                await command('vmde.demoteHeading')
              } else if (
                feature === 'block handle' ||
                feature === 'Move Block'
              ) {
                const action = {
                  kind: 'move' as const,
                  sourceStart: source.indexOf('Mover'),
                  targetStart: source.indexOf(PROSE),
                  placement: 'before' as const,
                }
                const plan = planBlockAction(source, action)
                expect(plan.status).toBe('ok')
                if (plan.status !== 'ok')
                  throw new Error('matrix move planner declined')
                expected = plan.markdown
                if (feature === 'Move Block') {
                  await select('Mover', 2)
                  await command('vmde.moveBlockUp')
                } else {
                  if (prefix) {
                    await frame
                      .locator(
                        `.vditor-${mode} [data-type="yaml-front-matter"][data-block]`,
                      )
                      .hover()
                    await expect(
                      frame.locator('.vmde-block-handle'),
                    ).toBeHidden()
                  }
                  await frame
                    .locator(`.vditor-${mode} .vditor-reset > p`)
                    .filter({ hasText: 'Mover' })
                    .hover()
                  await expect(
                    frame.locator('.vmde-block-handle'),
                  ).toBeVisible()
                  await frame.locator('body').evaluate(() => {
                    const inner = (window as any).vditor.vditor
                    const root = inner[inner.currentMode].element as HTMLElement
                    const target = Array.from(
                      root.querySelectorAll(':scope > p'),
                    ).find((p) => p.textContent?.includes('Alpha'))!
                    const handle = document.querySelector('.vmde-block-handle')!
                    const data = new DataTransfer()
                    handle.dispatchEvent(
                      new DragEvent('dragstart', {
                        bubbles: true,
                        dataTransfer: data,
                      }),
                    )
                    target.dispatchEvent(
                      new DragEvent('drop', {
                        bubbles: true,
                        cancelable: true,
                        clientY: target.getBoundingClientRect().top + 1,
                        dataTransfer: data,
                      }),
                    )
                  })
                }
              } else if (feature === 'Turn Into') {
                await command('vmde.turnInto')
                const picker = workbox
                  .locator('.quick-input-widget input')
                  .first()
                await expect(picker).toBeVisible()
                await fill(picker, 'Heading 2')
                await input.key('Return')
                await expect(picker).toBeHidden()
                expected = source.replace(PROSE, `## ${PROSE}`)
              } else if (feature === 'Details') {
                await select(PROSE, 0, PROSE.length)
                const button = frame.locator(
                  '.vditor-toolbar [data-type="details"]',
                )
                await expect(button).toBeEnabled()
                await button.click()
                expected = source.replace(
                  PROSE,
                  `<details>\n<summary>Details</summary>\n\n${PROSE}\n\n</details>`,
                )
              } else if (feature === 'callout apply') {
                // Exercise the existing toolbar handlers with the same stable control setup as
                // callout-authoring.spec.ts; pointer interception is covered by that separate spec.
                await frame
                  .locator('.vditor-toolbar [data-type="callout"]')
                  .dispatchEvent('click')
                const panel = frame.locator('.vmde-callout-toolbar-panel')
                await expect(panel).toBeVisible()
                await panel.evaluate((panel) => {
                  ;(panel.querySelector('select') as HTMLSelectElement).value =
                    'note'
                  ;(panel.querySelector('input') as HTMLInputElement).value =
                    'Matrix'
                  ;(
                    panel.querySelector(
                      '.vmde-callout__apply',
                    ) as HTMLButtonElement
                  ).click()
                })
                expected = source.replace(PROSE, `> [!NOTE] Matrix\n> ${PROSE}`)
              } else if (feature === 'selection Link') {
                await select('three', 0, 5)
                const button = frame.locator(
                  '.vmde-selection-bubble [data-action="link"]',
                )
                await expect(button).toBeVisible()
                await button.click()
                expected = source.replace('three', '[three]()')
              } else if (feature === 'outline move') {
                const headings = scanSourceHeadings(source)
                const plan = moveMarkdownSection(
                  source,
                  headings[1],
                  headings[0],
                  'before',
                )
                expect(plan.status).toBe('ok')
                if (plan.status !== 'ok')
                  throw new Error('matrix section planner declined')
                expected = plan.markdown
                await frame.locator('body').evaluate(() =>
                  (window as any).__vmdeRunOutlineSectionMoveByIndex({
                    sourceIndex: 1,
                    targetIndex: 0,
                    placement: 'before',
                    rowLabels: ['First', 'Second'],
                  }),
                )
              } else if (feature === 'Find Replace') {
                await input.key('ctrl+h')
                const widget = frame.locator('.vmde-find-replace')
                await expect(widget).toBeVisible()
                await fill(widget.locator('[data-find]'), 'findme')
                await fill(widget.locator('[data-replace]'), 'found')
                await widget.locator('[data-action="replace-all"]').click()
                expected = source.replace('findme', 'found')
                await widget.locator('[data-action="close"]').click()
              }
              phase = 'host result'
              await expect
                .poll(host, {
                  timeout: 15_000,
                  message: `${feature} preserves exact body bytes`,
                })
                .toBe(expected)
              const actual = await host()
              if (prefix)
                expect(actual).toBe(prefix + plainResults.get(feature))
              else plainResults.set(feature, actual)
              await auto(false)
              phase = 'save'
              await command('workbench.action.files.save')
              expect(readFileSync(file, 'utf8')).toBe(expected)
              // OS Undo is part of the prefix contract as well as each edit's exact host result.
              phase = 'undo'
              if (expected !== source) {
                await frame
                  .locator(`.vditor-${mode} .vditor-reset`)
                  .click({ position: { x: 4, y: 4 } })
                await input.key('ctrl+z')
                const undoSource =
                  feature === 'auto-wrap'
                    ? source.replace('three', 'threez')
                    : source
                await expect.poll(host, { timeout: 15_000 }).toBe(undoSource)
              }
            } catch (error) {
              const actual = await host()
              const config = await frame
                .locator('body')
                .evaluate(() => (window as any).__matrixConfig)
              failures.push(
                JSON.stringify({
                  feature,
                  frontMatter: Boolean(prefix),
                  phase,
                  hostLength: actual.length,
                  expectedLength: expected.length,
                  prefixPreserved: actual.startsWith(prefix),
                  expectedHost: actual === expected,
                  savedHost: readFileSync(file, 'utf8') === actual,
                  config,
                  error:
                    error instanceof Error
                      ? error.message.split('\n')[0]
                      : 'failed',
                }),
              )
              await input.key('Escape')
            }
          })
        }
      }
    } finally {
      await evaluateInVSCode(async (vscode) => {
        const config = vscode.workspace.getConfiguration('vmde')
        for (const key of [
          'editor.defaultMode',
          'editor.wrapColumn',
          'editor.autoWrap',
          'editor.autoWrapDelay',
        ])
          await config.update(key, undefined, vscode.ConfigurationTarget.Global)
      })
    }
    console.log(
      '[670] prefix matrix',
      JSON.stringify({
        mode,
        comparisons: plainResults.size,
        failures: failures.length,
      }),
    )
    expect(failures).toEqual([])
  })
}
