import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { largeMixedMarkdown } from './large-mixed-markdown'
import {
  docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

const CUT_TOKEN = 'cut-range-alpha-0123456789-omega'
const LIST_TOKEN = 'list-backspace-ABCDE'
const CODE_TOKEN = 'code-backspace-ABCDE'
const TABLE_TOKEN = 'table-backspace-ABCDE'
const TABLE_WIDTH_ANCHOR = 'stable-width-anchor-0123456789'
const TABLE_VALUE_WIDTH = TABLE_WIDTH_ANCHOR.length
const TARGETS = `${[
  '',
  '## Input stability targets',
  '',
  `Keep before ${CUT_TOKEN} keep after.`,
  '',
  `- ${LIST_TOKEN}`,
  '',
  `Inline \`${CODE_TOKEN}\` tail.`,
  '',
  '',
  `| Stability | ${'Value'.padEnd(TABLE_VALUE_WIDTH)} |`,
  `| --------- | ${'-'.repeat(TABLE_VALUE_WIDTH)} |`,
  `| row       | ${TABLE_TOKEN.padEnd(TABLE_VALUE_WIDTH)} |`,
  `| anchor    | ${TABLE_WIDTH_ANCHOR} |`,
].join('\n')}\n`
const INITIAL = `${largeMixedMarkdown()}${TARGETS}`
const CONFIG_KEYS = [
  'editor.codeLineNumbers',
  'editor.headingColors',
  'editor.fontSize',
  'theme.code',
  'editor.fullWidth',
  'theme.content',
  'editor.wrapColumn',
  'diagram.mermaid.layout',
  'editor.modifierClickLinks',
  'editor.autoWrapDelay',
  'editor.autoWrap',
  'editor.defaultMode',
  'preview.reflowLineBreaks',
] as const

type VmdeFrame = ReturnType<typeof wf>

interface InputState {
  selectionWrites: number
  selectionWriteStacks: string[]
  expandedQueries: number
  blockTag: string
  blockText: string
  sourceOffset: number
  scrollTop: number
  focused: boolean
}

const currentValue = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(() => (window as any).vditor.getValue() as string)

async function installMechanismProbe(frame: VmdeFrame): Promise<void> {
  await frame.locator('body').evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const selection = getSelection()!
    const counts = {
      selectionWrites: 0,
      selectionWriteStacks: [] as string[],
      expandedQueries: 0,
    }
    const originalRemove = selection.removeAllRanges.bind(selection)
    const originalAdd = selection.addRange.bind(selection)
    selection.removeAllRanges = () => {
      counts.selectionWrites++
      counts.selectionWriteStacks.push(new Error('removeAllRanges').stack ?? '')
      originalRemove()
    }
    selection.addRange = (range) => {
      counts.selectionWrites++
      counts.selectionWriteStacks.push(new Error('addRange').stack ?? '')
      originalAdd(range)
    }
    const originalQuery = surface.querySelectorAll.bind(surface)
    surface.querySelectorAll = ((selector: string) => {
      if (selector === '.vditor-ir__node--expand') counts.expandedQueries++
      return originalQuery(selector)
    }) as typeof surface.querySelectorAll

    let cut = { collapsed: true, text: '' }
    document.addEventListener(
      'cut',
      () => {
        const live = getSelection()
        cut = {
          collapsed: live?.isCollapsed ?? true,
          text: live?.toString() ?? '',
        }
      },
      true,
    )
    ;(window as any).__task532 = {
      counts,
      reset: () => {
        counts.selectionWrites = 0
        counts.selectionWriteStacks = []
        counts.expandedQueries = 0
      },
      cut: () => ({ ...cut }),
    }
  })
}

async function selectExact(frame: VmdeFrame, token: string): Promise<void> {
  await frame.locator('body').evaluate((_body, needle) => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = (node.textContent ?? '').indexOf(needle as string)
      if (index < 0) continue
      node.parentElement
        ?.closest<HTMLElement>('[data-block]')
        ?.scrollIntoView({ block: 'center' })
      surface.focus({ preventScroll: true })
      const range = document.createRange()
      range.setStart(node, index)
      range.setEnd(node, index + (needle as string).length)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
      return
    }
    throw new Error(`selection token not found: ${needle}`)
  }, token)
}

async function placeAtEnd(
  frame: VmdeFrame,
  token: string,
  alreadyExpanded: boolean,
  tableCell: boolean,
): Promise<void> {
  await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page setup keeps table paint/focus and already-expanded inline-code on the same exact Range placement.
    (_body, args) => {
      const surface = document.querySelector<HTMLElement>('.vditor-ir')!
      const searchRoot = args.tableCell
        ? (Array.from(surface.querySelectorAll<HTMLElement>('td')).find(
            (cell) => cell.textContent?.includes(args.needle),
          ) ?? surface)
        : surface
      const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node.textContent ?? '').indexOf(args.needle)
        if (index < 0) continue
        const inline =
          node.parentElement?.closest<HTMLElement>('.vditor-ir__node')
        if (args.alreadyExpanded && inline) {
          inline.classList.add('vditor-ir__node--expand')
          inline.dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true }),
          )
        }
        node.parentElement
          ?.closest<HTMLElement>('[data-block]')
          ?.scrollIntoView({ block: 'center' })
        surface.focus({ preventScroll: true })
        const range = document.createRange()
        range.setStart(node, index + args.needle.length)
        range.collapse(true)
        // Task 698: the preceding Undo arms a caret intent (Vditor's patched addCaret) that the
        // caret authority re-asserts each frame; a raw addRange was overwritten 25 ms later. The
        // deliberate writer retires that intent first.
        if (!(window as any).__vmdeWriteSelection?.(range))
          throw new Error(
            'cut-backspace-stability: the deliberate caret write was refused',
          )
        if (args.tableCell && searchRoot !== surface) searchRoot.focus()
        document.dispatchEvent(new Event('selectionchange'))
        return
      }
      throw new Error(`caret token not found: ${args.needle}`)
    },
    { needle: token, alreadyExpanded, tableCell },
  )
}

const resetMechanism = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => (window as any).__task532.reset())

const waitForMarkerController = (frame: VmdeFrame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

const inputState = (frame: VmdeFrame) =>
  frame.locator('body').evaluate(() => {
    const surface = document.querySelector<HTMLElement>('.vditor-ir')!
    const selection = getSelection()!
    const anchor = selection.rangeCount ? selection.anchorNode : null
    const element =
      anchor?.nodeType === Node.ELEMENT_NODE
        ? (anchor as Element)
        : anchor?.parentElement
    const block = element?.closest<HTMLElement>('li, td, p, [data-block]')
    let sourceOffset = -1
    if (block && anchor && selection.rangeCount) {
      const range = document.createRange()
      range.selectNodeContents(block)
      range.setEnd(anchor, selection.anchorOffset)
      sourceOffset = range.toString().length
    }
    const counts = (window as any).__task532.counts as {
      selectionWrites: number
      selectionWriteStacks: string[]
      expandedQueries: number
    }
    return {
      ...counts,
      blockTag: block?.tagName ?? '',
      blockText: block?.textContent ?? '',
      sourceOffset,
      scrollTop: surface.scrollTop,
      focused: Boolean(anchor && surface.contains(anchor)),
    } satisfies InputState
  }) as Promise<InputState>

async function waitForCaretToken(
  frame: VmdeFrame,
  token: string,
  requireExpanded: boolean,
): Promise<void> {
  let last: Record<string, unknown> | null = null
  try {
    await expect
      .poll(async () => {
        last = await frame.locator('body').evaluate(
          (_body, args) => {
            const selection = getSelection()
            const anchor = selection?.rangeCount ? selection.anchorNode : null
            const text = anchor?.textContent ?? ''
            const node =
              anchor?.nodeType === Node.ELEMENT_NODE
                ? (anchor as Element)
                : anchor?.parentElement
            const inline = node?.closest<HTMLElement>('.vditor-ir__node')
            const ok =
              text.includes(args.token) &&
              (!args.requireExpanded ||
                (inline?.classList.contains('vditor-ir__node--expand') ??
                  false))
            return {
              ok,
              anchorText: text,
              parentTag: node?.tagName ?? '',
              parentClass: (node as HTMLElement | null)?.className ?? '',
              inlineClass: inline?.className ?? '',
              inlineType: inline?.getAttribute('data-type') ?? '',
              matchingCodeClasses: Array.from(
                document.querySelectorAll<HTMLElement>(
                  '.vditor-ir__node[data-type="code"]',
                ),
              )
                .filter((candidate) =>
                  candidate.textContent?.includes(args.token),
                )
                .map((candidate) => candidate.className),
            }
          },
          { token, requireExpanded },
        )
        return last.ok
      })
      .toBe(true)
  } catch (error) {
    throw new Error(
      `caret token ${token} did not settle; last=${JSON.stringify(last)}; ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode, keys: string[]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      for (const key of keys)
        await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    },
    CONFIG_KEYS as unknown as string[],
  )
})

test('non-collapsed cut and recurring Backspace stay exact in a generated large document', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(240_000)
  const file = path.join(baseDir, 'cut-backspace-stability.md')
  writeFileSync(file, INITIAL)
  await evaluateInVSCode(
    async (vscode, args: [string, string, string]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      const values: Array<[string, unknown]> = [
        ['editor.codeLineNumbers', true],
        ['editor.headingColors', true],
        ['editor.fontSize', '16'],
        ['theme.code', 'github-dark-dimmed'],
        ['editor.fullWidth', false],
        ['theme.content', 'material-dark'],
        ['editor.wrapColumn', 120],
        ['diagram.mermaid.layout', 'elk'],
        ['editor.modifierClickLinks', false],
        ['editor.autoWrapDelay', 500],
        ['editor.autoWrap', false],
        ['editor.defaultMode', 'ir'],
        ['preview.reflowLineBreaks', false],
      ]
      for (const [key, value] of values)
        await config.update(key, value, vscode.ConfigurationTarget.Global)
      await vscode.extensions.getExtension(args[1])?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[2],
      )
    },
    [file, ExtensionId, MarkdownEditorViewType] as [string, string, string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'cut/backspace generated fixture readiness' },
  )
  await expect
    .poll(() => frame.locator('.language-mermaid svg').count(), {
      timeout: 60_000,
    })
    .toBe(4)
  await expect
    .poll(() => currentValue(frame), { timeout: 30_000 })
    .toBe(INITIAL)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        return inner.undo?.ir?.undoStack?.length ?? 0
      }),
    )
    .toBeGreaterThan(0)
  await frame.locator('.vditor-ir').click({ position: { x: 24, y: 24 } })
  await installMechanismProbe(frame)

  await evaluateInVSCode(async (vscode) => {
    await vscode.env.clipboard.writeText('task-532-clipboard-sentinel')
  })
  await expect
    .poll(
      () =>
        evaluateInVSCode(async (vscode) =>
          vscode.env.clipboard.readText(),
        ) as Promise<string>,
    )
    .toBe('task-532-clipboard-sentinel')
  await selectExact(frame, CUT_TOKEN)
  await workbox.keyboard.press('Control+x')
  const afterCut = INITIAL.replace(CUT_TOKEN, '')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(afterCut)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => (window as any).__task532.cut()),
    )
    .toEqual({ collapsed: false, text: CUT_TOKEN })
  await expect
    .poll(
      () =>
        evaluateInVSCode(async (vscode) =>
          vscode.env.clipboard.readText(),
        ) as Promise<string>,
    )
    .toBe(CUT_TOKEN)
  await workbox.keyboard.press('Control+z')
  await expect.poll(() => docText(evaluateInVSCode, file)).toBe(INITIAL)
  await expect.poll(() => currentValue(frame)).toBe(INITIAL)

  let current = INITIAL
  for (const target of [
    {
      token: LIST_TOKEN,
      prefix: 'list-backspace-',
      expanded: false,
      table: false,
    },
    {
      token: CODE_TOKEN,
      prefix: 'code-backspace-',
      expanded: true,
      table: false,
    },
    {
      token: TABLE_TOKEN,
      prefix: 'table-backspace-',
      expanded: false,
      table: true,
    },
  ]) {
    let token = target.token
    if (target.table) {
      const cell = frame.locator('.vditor-ir td').filter({ hasText: token })
      await cell.scrollIntoViewIfNeeded()
      await cell.click()
    }
    await placeAtEnd(frame, token, target.expanded, target.table)
    await waitForCaretToken(frame, token, target.expanded)
    // The preceding cut/undo or prior target can still own Vditor's 800 ms undo checkpoint. Let
    // that legitimate addCaret selection cycle finish before resetting the per-Backspace probe;
    // otherwise machine timing decides whether this iteration observes two spin writes or those
    // same two writes plus the unrelated delayed checkpoint pair.
    await frame
      .locator('body')
      .evaluate(() => new Promise((resolve) => setTimeout(resolve, 900)))
    for (let index = 0; index < 3; index++) {
      await resetMechanism(frame)
      const before = await inputState(frame)
      const next = token.slice(0, -1)
      current = target.table
        ? current.replace(
            token.padEnd(TABLE_VALUE_WIDTH),
            next.padEnd(TABLE_VALUE_WIDTH),
          )
        : current.replace(token, next)
      await workbox.keyboard.press('Backspace')
      await expect.poll(() => currentValue(frame)).toBe(current)
      await waitForMarkerController(frame)
      const after = await inputState(frame)
      expect(after.expandedQueries).toBe(0)
      expect(
        after.selectionWrites,
        `${target.token} deletion ${index + 1}\n${after.selectionWriteStacks.join('\n')}`,
      ).toBe(2)
      expect(after.blockTag).toBe(before.blockTag)
      expect(after.blockText).toContain(target.prefix)
      expect(after.sourceOffset).toBe(before.sourceOffset - 1)
      expect(after.scrollTop).toBe(before.scrollTop)
      expect(after.focused).toBe(true)
      await expect.poll(() => docText(evaluateInVSCode, file)).toBe(current)
      token = next
    }
    await expect.poll(() => currentValue(frame)).toBe(current)
  }

  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.files.save')
  })
  await expect.poll(() => readFileSync(file, 'utf8')).toBe(current)
  await evaluateInVSCode(
    async (vscode, args: [string, string]) => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        args[1],
      )
    },
    [file, MarkdownEditorViewType] as [string, string],
  )
  await frame.locator('.vditor-ir').waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { message: 'cut/backspace save-reopen readiness' },
  )
  await expect
    .poll(() => currentValue(frame), { timeout: 30_000 })
    .toBe(current)
  await expect
    .poll(() =>
      frame
        .locator('.vditor-ir td')
        .filter({ hasText: TABLE_TOKEN.slice(0, -3) })
        .count(),
    )
    .toBe(1)
})
