import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput, type XtestInput } from './helpers/xtest-input'
import { tableHeavyMarkdown } from './table-heavy-markdown'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 733 / 045: the first Source edit after a switch from IR. Vditor's Source handlers render the
// preview synchronously, before any document bubble listener, so the first preview read used to pair
// the edited rendering with the pre-edit bytes: the preview showed old text and Save could cancel the
// edit. The fix marks a Source input in the capture phase, signals every edit-driven Source render
// (`__vmdeSourceRenderEdit`) and proves a Source anchor by line-ending normalization only.
//
// Every test opens a fresh fixture in IR and switches to Source with the toolbar. Counters come from
// the e2e seed stats (`__vmdeIncrementalSeedStats`), present only while `__vmdeE2EReadiness` exists.
//
// The `@probe` cases measure the 50 ms ceiling (design section 6.2). They are excluded from the
// default run (`@probe`, VMDE_PROBES=1) and report a per-cell verdict: pass, fail or unverified.

type Frame = ReturnType<typeof wf>
type Page = import('@playwright/test').Page
type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>

interface Marks {
  all: number
  trusted: number
  anchorMode: string | null
}

const LF_TEXT = '# T\n\nalpha beta\n'
const CRLF_TEXT = '# T\r\n\r\nalpha beta\r\n'

const CONFIG_KEYS = [
  'editor.defaultMode',
  'editor.autoWrap',
  'editor.wrapColumn',
  'editor.autoWrapDelay',
] as const

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), keys: string[]) => {
      const config = vscode.workspace.getConfiguration('vmde')
      for (const key of keys)
        await config.update(key, undefined, vscode.ConfigurationTarget.Global)
    },
    [...CONFIG_KEYS],
  )
})

/** Writes `text` into the test's base directory, opens it in IR and waits for the router and Undo. */
async function open(
  workbox: Page,
  evaluateInVSCode: Evaluate,
  baseDir: string,
  name: string,
  text: string,
): Promise<{ frame: Frame; file: string }> {
  const file = path.join(baseDir, name)
  writeFileSync(file, text)
  // The default `remember` reopens a file in the last mode used: after a run that switched to
  // Source, the next open of the same session would start in Source. Every test starts in IR.
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    await vscode.workspace
      .getConfiguration('vmde')
      .update('editor.defaultMode', 'ir', vscode.ConfigurationTarget.Global)
  }, [])
  const frame = (await reopenVmdeFixture(
    evaluateInVSCode as never,
    workbox,
    file,
  )) as Frame
  await waitForE2EReadiness(
    frame,
    (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
    { message: 'the first-edit editor opened in IR' },
  )
  await waitForInitialUndoSnapshot(frame)
  return { frame, file }
}

/** Switches to Source through the toolbar (the edit-mode panel is hidden until hover). */
async function toolbarSource(frame: Frame, split: boolean): Promise<void> {
  const before = await waitForE2EReadiness(frame, (s) => s.editorEpoch > 0, {
    message: 'the editor finished initialization',
  })
  await frame.locator('body').evaluate(() => {
    document
      .querySelector('.vditor-toolbar button[data-mode="sv"]')
      ?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
  })
  await waitForE2EReadiness(
    frame,
    (s) => s.modeEpoch > before.modeEpoch && s.mode === 'sv',
    { message: 'the editor reported Source' },
  )
  // The `both` toolbar button toggles the preview pane; click it only when the pane is not as wanted.
  await frame.locator('body').evaluate((_body, wantPreview) => {
    const pane = document.querySelector<HTMLElement>('.vditor-preview')
    const shown = !!pane && getComputedStyle(pane).display !== 'none'
    if (shown === wantPreview) return
    document
      .querySelector('.vditor-toolbar [data-type="both"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, split)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const pane = document.querySelector<HTMLElement>('.vditor-preview')
        return !!pane && getComputedStyle(pane).display !== 'none'
      }),
    )
    .toBe(split)
}

/** Switches the mode with a VMDE command from the host: no webview keydown, so the auto-wrap stays. */
async function commandMode(
  frame: Frame,
  evaluateInVSCode: Evaluate,
  mode: 'ir' | 'sv',
): Promise<void> {
  const before = await waitForE2EReadiness(frame, (s) => s.editorEpoch > 0)
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.commands.executeCommand(args[0])
    },
    [
      mode === 'sv'
        ? 'vmde.switchToSplitView'
        : 'vmde.switchToInstantRendering',
    ],
  )
  await waitForE2EReadiness(
    frame,
    (s) => s.modeEpoch > before.modeEpoch && s.mode === mode,
    { message: `the editor reported ${mode}` },
  )
}

const readMarks = (frame: Frame): Promise<Marks> =>
  frame.locator('body').evaluate(() => {
    const stats = (
      window as unknown as {
        __vmdeIncrementalSeedStats?: {
          userInputMarks: number
          trustedInputMarks: number
          lastRememberedAnchorMode: string | null
        }
      }
    ).__vmdeIncrementalSeedStats
    return {
      all: stats?.userInputMarks ?? -1,
      trusted: stats?.trustedInputMarks ?? -1,
      anchorMode: stats?.lastRememberedAnchorMode ?? null,
    }
  })

/**
 * Places a collapsed caret in the Source text: before the first `needle` (`after` false) or after
 * it. The click gives the webview native focus for XTEST; the deliberate writer then sets the caret
 * (a raw addRange is overwritten by the caret authority's live intent, Task 698).
 */
async function sourceCaret(
  frame: Frame,
  needle: string,
  after = false,
): Promise<void> {
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page operation finds the text node, scrolls it into view and writes the caret through the deliberate writer or a raw range
    (_body, args) => {
      const [text, end] = args as [string, boolean]
      const root = document.querySelector<HTMLElement>('.vditor-sv')
      if (!root) return 'no Source root'
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = (node as Text).data.indexOf(text)
        if (index < 0) continue
        node.parentElement?.scrollIntoView({ block: 'center' })
        const range = document.createRange()
        range.setStart(node, index + (end ? text.length : 0))
        range.collapse(true)
        root.focus({ preventScroll: true })
        const writer = (
          window as unknown as { __vmdeWriteSelection?: (r: Range) => boolean }
        ).__vmdeWriteSelection
        if (writer) {
          if (!writer(range)) return 'the caret write was refused'
        } else {
          const selection = getSelection()
          selection?.removeAllRanges()
          selection?.addRange(range)
        }
        return 'ok'
      }
      return `${text} not found`
    },
    [needle, after],
  )
  expect(placed).toBe('ok')
}

/** Places the caret at the start of the Source root's text (offset 0). */
async function sourceCaretAtStart(frame: Frame): Promise<void> {
  await frame
    .locator('.vditor-sv')
    .first()
    .click({ position: { x: 4, y: 4 } })
  const placed = await frame.locator('body').evaluate(() => {
    const root = document.querySelector<HTMLElement>('.vditor-sv')
    if (!root) return false
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    const first = walker.nextNode()
    const range = document.createRange()
    if (first) range.setStart(first, 0)
    else range.setStart(root, 0)
    range.collapse(true)
    root.focus({ preventScroll: true })
    const writer = (
      window as unknown as { __vmdeWriteSelection?: (r: Range) => boolean }
    ).__vmdeWriteSelection
    if (writer) return writer(range)
    const selection = getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    return true
  })
  expect(placed).toBe(true)
}

/**
 * Registers a one-shot document bubble `input` listener. Registered after the editor is ready, it
 * runs after the installer's bubble listener, inside the key's dispatch, and stores the exact source
 * edit-sync then holds. Also wraps the preview snapshot to keep its first returned string.
 */
const armDispatchCapture = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __vmdeE2EExactMarkdown?: () => string | null
      __vmdePreviewSnapshot?: () => string
      __q045Dispatch?: {
        stored: boolean
        exact: string | null
        at: number
        firstPreview: string | null
        restore(): void
      }
    }
    const state = {
      stored: false,
      exact: null as string | null,
      at: 0,
      firstPreview: null as string | null,
      // Replaced below when the preview snapshot exists; nothing to restore otherwise.
      restore: () => undefined,
    }
    const onInput = () => {
      document.removeEventListener('input', onInput)
      state.stored = true
      state.exact = w.__vmdeE2EExactMarkdown?.() ?? null
      state.at = performance.now()
    }
    document.addEventListener('input', onInput)
    const snapshot = w.__vmdePreviewSnapshot
    if (snapshot) {
      // Only the returned string is kept: an exact read here could publish a delta.
      const wrapped = () => {
        const text = snapshot()
        state.firstPreview ??= text
        return text
      }
      w.__vmdePreviewSnapshot = wrapped
      state.restore = () => {
        if (w.__vmdePreviewSnapshot === wrapped)
          w.__vmdePreviewSnapshot = snapshot
      }
    }
    w.__q045Dispatch = state
  })

const readDispatchCapture = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const state = (
      window as unknown as {
        __q045Dispatch?: {
          stored: boolean
          exact: string | null
          firstPreview: string | null
          restore(): void
        }
      }
    ).__q045Dispatch
    state?.restore()
    return {
      stored: state?.stored ?? false,
      exact: state?.exact ?? null,
      firstPreview: state?.firstPreview ?? null,
    }
  })

/** Saves the active editor and waits until the document is clean; returns the host text. */
async function saveAndRead(
  evaluateInVSCode: Evaluate,
  file: string,
): Promise<string> {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [file],
  )
  await expect
    .poll(() => isDirty(evaluateInVSCode, file), { timeout: 20_000 })
    .toBe(false)
  return docText(evaluateInVSCode as never, file)
}

const isDirty = (evaluateInVSCode: Evaluate, file: string) =>
  evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? false,
    [file],
  ) as Promise<boolean>

const previewText = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () => document.querySelector('.vditor-preview')?.textContent ?? '',
    )

const sourceValue = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (
          window as unknown as { vditor?: { getValue(): string } }
        ).vditor?.getValue() ?? '',
    )

/**
 * The Source text as VMDE serializes it for the host. Vditor's `getValue()` in Source also returns
 * the editable newline span Vditor always appends (one more trailing `\n`); VMDE's Source
 * serializer removes that node (edit-sync `serializeSvForHost`). A memoized rendered read: it is
 * not the exact pair read.
 */
const sourceText = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (
          window as unknown as { __vmdeE2ESnapshotMarkdown?: () => string }
        ).__vmdeE2ESnapshotMarkdown?.() ?? '',
    )

async function xtestFor(
  electronApp: import('playwright-core').ElectronApplication,
  workbox: Page,
): Promise<XtestInput> {
  const xtest = await createXtestInput(electronApp, workbox)
  expect(xtest.client.visible).toBe(true)
  return xtest
}

test.describe('Task 733 / 045: first Source edit', () => {
  test('045 CRLF provable insertion is exact on the first key', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'q045-crlf-start.md',
      CRLF_TEXT,
    )
    await toolbarSource(frame, true)
    const xtest = await xtestFor(electronApp, workbox)
    await sourceCaretAtStart(frame)
    await armDispatchCapture(frame)
    const before = await readMarks(frame)
    await xtest.type('Z')
    await expect
      .poll(async () => (await readDispatchCapture(frame)).stored)
      .toBe(true)
    const captured = await readDispatchCapture(frame)
    const after = await readMarks(frame)
    expect(after.all - before.all).toBe(1)
    expect(after.trusted - before.trusted).toBe(1)
    expect(captured.exact).toBe(`Z${CRLF_TEXT}`)
    expect(await saveAndRead(evaluateInVSCode, file)).toBe(`Z${CRLF_TEXT}`)
    expect(await isDirty(evaluateInVSCode, file)).toBe(false)
  })

  test('045 CRLF interior first edit declines and the preview shows it', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'q045-crlf-interior.md',
      CRLF_TEXT,
    )
    await toolbarSource(frame, true)
    const xtest = await xtestFor(electronApp, workbox)
    await sourceCaret(frame, 'alpha')
    await armDispatchCapture(frame)
    const before = await readMarks(frame)
    await xtest.type('Z')
    await expect
      .poll(async () => (await readDispatchCapture(frame)).stored)
      .toBe(true)
    const captured = await readDispatchCapture(frame)
    const after = await readMarks(frame)
    expect(after.all - before.all).toBe(1)
    expect(after.trusted - before.trusted).toBe(1)
    expect(captured.exact).toBeNull()
    expect(captured.firstPreview ?? '').toContain('Zalpha')
    const saved = await saveAndRead(evaluateInVSCode, file)
    expect(saved).toBe('# T\r\n\r\nZalpha beta\r\n')
    expect(/(?<!\r)\n/.test(saved)).toBe(false)
  })

  test('045 a synthetic input counts as untrusted', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'q045-synthetic.md',
      LF_TEXT,
    )
    await toolbarSource(frame, true)
    await sourceCaret(frame, 'alpha')
    const before = await readMarks(frame)
    const dispatched = await frame.locator('body').evaluate(() => {
      const root = document.querySelector<HTMLElement>('.vditor-sv')
      const selection = getSelection()
      const node = selection?.anchorNode
      if (!root || !(node instanceof Text)) return false
      const offset = selection?.anchorOffset ?? 0
      node.insertData(offset, 'S')
      const range = document.createRange()
      range.setStart(node, offset + 1)
      range.collapse(true)
      selection?.removeAllRanges()
      selection?.addRange(range)
      const event = new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: 'S',
      })
      root.dispatchEvent(event)
      return !event.isTrusted
    })
    expect(dispatched).toBe(true)
    const after = await readMarks(frame)
    expect(after.all - before.all).toBe(1)
    // A production trust override (marking every input trusted) would make this 1.
    expect(after.trusted - before.trusted).toBe(0)
    expect(await saveAndRead(evaluateInVSCode, file)).toBe(
      '# T\n\nSalpha beta\n',
    )
  })

  test('045 Paste Plain signals the render without an input event', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'q045-paste.md',
      LF_TEXT,
    )
    await toolbarSource(frame, true)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.env.clipboard.writeText(args[0])
      },
      ['P'],
    )
    await sourceCaret(frame, 'alpha')
    await armRenderSignalCount(frame)
    const before = await readMarks(frame)
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.pastePlain')
    }, [])
    await expect
      .poll(() => previewText(frame), { timeout: 20_000 })
      .toContain('Palpha')
    const counts = await readRenderSignalCount(frame)
    const after = await readMarks(frame)
    expect(counts.hooks).toBeGreaterThanOrEqual(1)
    expect(counts.inputs).toBe(0)
    expect(after.all - before.all).toBe(0)
    expect(await saveAndRead(evaluateInVSCode, file)).toBe(
      '# T\n\nPalpha beta\n',
    )
  })

  test('045 toolbar List signals the render without an input event', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { frame, file } = await open(
      workbox,
      evaluateInVSCode,
      baseDir,
      'q045-list.md',
      LF_TEXT,
    )
    await toolbarSource(frame, true)
    await sourceCaret(frame, 'alpha b', true)
    await armRenderSignalCount(frame)
    await frame.locator('body').evaluate(() => {
      document
        .querySelector('.vditor-toolbar [data-type="list"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
    })
    await expect
      .poll(() => sourceValue(frame), { timeout: 20_000 })
      .toContain('* alpha beta')
    const counts = await readRenderSignalCount(frame)
    expect(counts.hooks).toBeGreaterThanOrEqual(1)
    expect(counts.inputs).toBe(0)
    expect(await saveAndRead(evaluateInVSCode, file)).toBe(
      '# T\n\n* alpha beta\n',
    )
  })

  test('045 task marker after an IR anchor is not paired with the opened bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(180_000)
    await taskMarkerCase(
      { workbox, evaluateInVSCode, baseDir, electronApp },
      { name: 'q045-task.md', opened: '- [x] task\n' },
    )
  })

  test('045 task marker after an IR anchor with the text model off is not paired with the opened bytes', async ({
    workbox,
    evaluateInVSCode,
    baseDir,
    electronApp,
  }) => {
    test.setTimeout(180_000)
    // The text model declines this document: a definition inside a container block (here a quote)
    // makes `scanModelBlocks` return no blocks (`holdsNestedDefinition`, bridge/definition-units.ts),
    // so the model stays off ('scan-declined', bridge/text-model.ts `layoutUnits`) and every exact read
    // goes through edit-sync's own whole-text pair, whatever the model state of the first case.
    await taskMarkerCase(
      { workbox, evaluateInVSCode, baseDir, electronApp },
      {
        name: 'q045-task-model-off.md',
        opened: '- [x] task\n\n> [r]: https://example.com\n',
      },
    )
  })

  for (const eol of ['LF', 'CRLF'] as const) {
    for (const action of ['key', 'paste'] as const) {
      test(`045 @probe first Source edit latency ${eol} ${action}`, async ({
        workbox,
        evaluateInVSCode,
        baseDir,
        electronApp,
      }) => {
        test.skip(!process.env.VMDE_PROBES, 'probe: VMDE_PROBES=1')
        test.setTimeout(600_000)
        const cell = `${eol.toLowerCase()}-${action}`
        const runs: Record<string, LatencySample> = {}
        for (const tagged of [true, false]) {
          runs[tagged ? 'tagged' : 'untagged'] = await latencyRun(
            { workbox, evaluateInVSCode, baseDir, electronApp },
            eol,
            action,
            cell,
            tagged,
          )
        }
        const verdict = latencyVerdict(runs.tagged)
        const report = {
          cell,
          verdict,
          presentationMs:
            runs.tagged.presentationTime === null || runs.tagged.start === null
              ? null
              : runs.tagged.presentationTime - runs.tagged.start,
          tagged: runs.tagged,
          untagged: runs.untagged,
          note: 'counters come from the untagged run; the tagged run adds an attribute mutation (instrumented cost). P does not partition the counters.',
        }
        console.log(`Q045-FIRST-EDIT ${JSON.stringify(report)}`)
        test.info().annotations.push({
          type: 'verdict',
          description: `${cell}: ${verdict.verdict} (${verdict.reasons.join('; ')})`,
        })
        expect(verdict.verdict, verdict.reasons.join('; ')).not.toBe('fail')
      })
    }
  }

  for (const kind of ['heading', 'yaml'] as const) {
    test(`045 @probe return-to-IR pending history flush ${kind}`, async ({
      workbox,
      evaluateInVSCode,
      baseDir,
      electronApp,
    }) => {
      test.skip(!process.env.VMDE_PROBES, 'probe: VMDE_PROBES=1')
      test.setTimeout(600_000)
      const sample = await flushRun(
        { workbox, evaluateInVSCode, baseDir, electronApp },
        kind,
      )
      const verdict = flushVerdict(kind, sample)
      console.log(
        `Q045-RETURN-FLUSH ${JSON.stringify({ kind, verdict, sample })}`,
      )
      test.info().annotations.push({
        type: 'verdict',
        description: `${kind}: ${verdict.verdict} (${verdict.reasons.join('; ')})`,
      })
      expect(verdict.verdict, verdict.reasons.join('; ')).not.toBe('fail')
    })
  }
})

/**
 * The text model's state (`__vmdeModelShadowStats.state`, 'live' when it serves the document).
 * Diagnostic: while the model owns the text, edit-sync answers exact reads from it
 * (`liveExactText`) and never anchors its whole-text pair.
 */
const modelShadowState = (frame: Frame): Promise<string> =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeModelShadowStats?: { state: string }
        }
      ).__vmdeModelShadowStats?.state ?? 'missing',
  )

/** The opt-in block-handle pair-read counter (finish-init `countedSnapshotPair`). */
const blockHandleReads = (frame: Frame): Promise<number> =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __vmdeBlockHandleCacheMetrics?: Record<string, number>
        }
      ).__vmdeBlockHandleCacheMetrics?.blockHandleSnapshotCalls ?? 0,
  )

/**
 * Task 733 / 045 (Q-299): the edited Source rendering of a task marker is never paired with the opened
 * bytes. Only that safety property is asserted. The remembered anchor mode, the text model state and
 * the block-handle pair reads before the key depend on read order and model eligibility in the real
 * webview (rounds i045-4 and i045-6: null and 'sv' with the model off), so they are reported, not
 * asserted.
 *
 * Why each check fails on 680ad4aa's defect, where the edited Source rendering is paired with the
 * opened bytes:
 * - Stored exact: on 680ad4aa a Source read proved a pair with the IR rule, which accepts anything
 *   without a visual projection (`renderedFromExact` returns true in Source; rev 13 `anchorProves`,
 *   bridge/edit-sync.ts), and recalled a remembered IR anchor against the edited Source text
 *   (`rememberedRendering` returned the IR string; rev 13 substitutes the Source projection). Either
 *   way the exact read inside the key's dispatch returns the pair's exact bytes, the opened
 *   `- [x] …`, so `captured.exact` equals `opened`.
 * - Published edit: with that pair owned, edit-sync treats the opened bytes as the exact source of
 *   the edited rendering. It then posts them as exact, or nothing when the rendering equals the
 *   host's, so no `edit` carries the edited Source text.
 * - Host text after Save: the edited task line is a whole-document semantic no-op of the opened one,
 *   so the host's will-save check restores the opened bytes on both products (Tasks 61 and 434). The
 *   check fixes that host contract and that the document ends clean; on its own it does not separate
 *   the defect. The published-edit check does.
 * - One trusted mark: it does not detect the pairing by itself. It proves the key reached edit-sync as
 *   exactly one trusted input, the precondition of the checks above (a synthetic or doubled mark
 *   would test another route). On 680ad4aa the mark ran in boot/main.ts's bubble listener, after
 *   Vditor's Source handler, and the e2e mark counters did not exist (`readMarks` gives -1, a delta
 *   of 0), so it fails there as well.
 */
async function taskMarkerCase(
  fixtures: ProbeFixtures,
  options: { name: string; opened: string },
): Promise<void> {
  const { workbox, evaluateInVSCode, baseDir, electronApp } = fixtures
  const { opened } = options
  const { frame, file } = await open(
    workbox,
    evaluateInVSCode,
    baseDir,
    options.name,
    opened,
  )
  await expect
    .poll(() =>
      frame.locator('body').evaluate(
        () =>
          (
            window as unknown as {
              __vmdeE2EExactMarkdown?: () => string | null
            }
          ).__vmdeE2EExactMarkdown?.() ?? null,
      ),
    )
    .toBe(opened)
  // No Source pair read before the key: the native-focus click lands on IR, before the switch, the
  // pointer then leaves the webview (the block handle reads the pair under the pointer), and the
  // Source caret is written without a pointer. The opt-in counter reports any block-handle read.
  await frame.locator('body').evaluate(() => {
    ;(
      window as unknown as {
        __vmdeBlockHandleCacheMetrics?: Record<string, number>
      }
    ).__vmdeBlockHandleCacheMetrics = {}
  })
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.mouse.move(1, 1)
  await toolbarSource(frame, false)
  // The contract's Source rendering of the opened task line: `- [x]` is shown as `- [X]`.
  const sourceBefore = await sourceText(frame)
  if (opened === '- [x] task\n') expect(sourceBefore).toBe('- [X] task\n')
  else expect(sourceBefore.startsWith('- [X] task\n')).toBe(true)
  // The key inserts one space after the task marker.
  const edited = sourceBefore.replace('- [X] task', '- [X]  task')
  const xtest = await xtestFor(electronApp, workbox)
  const placed = await frame.locator('body').evaluate(() => {
    const markers = document.querySelectorAll(
      '.vditor-sv [data-type="task-marker"]',
    )
    const marker = markers[markers.length - 1]
    const walker = marker
      ? document.createTreeWalker(marker, NodeFilter.SHOW_TEXT)
      : null
    let last: Text | null = null
    for (let node = walker?.nextNode(); node; node = walker?.nextNode())
      last = node as Text
    if (!last) return false
    const range = document.createRange()
    range.setStart(last, last.length)
    range.collapse(true)
    ;(document.querySelector('.vditor-sv') as HTMLElement).focus({
      preventScroll: true,
    })
    const writer = (
      window as unknown as { __vmdeWriteSelection?: (r: Range) => boolean }
    ).__vmdeWriteSelection
    if (writer) return writer(range)
    getSelection()?.removeAllRanges()
    getSelection()?.addRange(range)
    return true
  })
  expect(placed).toBe(true)
  await armDispatchCapture(frame)
  await armEditPostCapture(frame)
  const before = await readMarks(frame)
  const handleReadsBeforeKey = await blockHandleReads(frame)
  const modelBeforeKey = await modelShadowState(frame)
  await xtest.type(' ')
  await expect
    .poll(async () => (await readDispatchCapture(frame)).stored)
    .toBe(true)
  const captured = await readDispatchCapture(frame)
  const after = await readMarks(frame)
  expect(await sourceText(frame)).toBe(edited)
  // Reported, not asserted (Q-299).
  const detail = `remembered anchor mode: ${after.anchorMode}; text model before the key: ${modelBeforeKey}; block-handle pair reads before the key: ${handleReadsBeforeKey}`
  console.log(`[q045-task-marker] ${options.name}: ${detail}`)
  test
    .info()
    .annotations.push({ type: 'q045-task-marker', description: detail })
  // The trusted-mark check comes last: its counter does not exist before F2, so a baseline run
  // without F2 still shows the stored-exact, published-edit and Save results first.
  expect(
    captured.exact,
    `exact read in the key's dispatch (${detail})`,
  ).not.toBe(opened)
  // The typing leaves the webview as the edited Source text: the idle publication (or the Save
  // flush) posts it. A pair of the edited rendering with the opened bytes would post the opened
  // bytes as exact, or nothing (equivalent to the host).
  await expect
    .poll(() => editPosts(frame), { timeout: 10_000 })
    .not.toHaveLength(0)
  const posts = await editPosts(frame)
  expect(
    posts.map((post) => ({ command: post.command, content: post.content })),
    `whole-text edits posted after the key (${detail})`,
  ).toContainEqual({ command: 'edit', content: edited })
  expect(
    posts.some((post) => post.exact && post.content === opened),
    `an exact post of the opened bytes (${detail})`,
  ).toBe(false)
  // Save then restores the clean baseline: the edited text is a whole-document semantic no-op
  // against the opened bytes (Lute's IR round trip of both is `- [X]  task\n`), so the host's
  // will-save check writes the baseline bytes back verbatim (Tasks 61 and 434:
  // src/writeback/writeback-controller.ts `checkNoopOnWillSave` and `isNoop`,
  // src/markdown/minimal-diff-writeback.ts `isSemanticNoop`). The document is clean afterwards.
  expect(
    await saveAndRead(evaluateInVSCode, file),
    `host text after Save (${detail})`,
  ).toBe(opened)
  expect(after.trusted - before.trusted, `one trusted mark (${detail})`).toBe(1)
}

/** Records every `edit` and `edit-delta` the webview posts from now on (content and exact flag). */
const armEditPostCapture = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      vscode: {
        postMessage(message: Record<string, unknown>): unknown
        getState(): unknown
        setState(state: unknown): unknown
      }
      __q045EditPosts?: Array<{
        command: string
        content: string | null
        exact: boolean
      }>
    }
    const posts: NonNullable<typeof w.__q045EditPosts> = []
    const api = w.vscode
    w.vscode = {
      postMessage: (message) => {
        if (message.command === 'edit' || message.command === 'edit-delta')
          posts.push({
            command: message.command,
            content:
              typeof message.content === 'string' ? message.content : null,
            exact: message.exact === true,
          })
        return api.postMessage(message)
      },
      getState: () => api.getState(),
      setState: (value) => api.setState(value),
    }
    w.__q045EditPosts = posts
  })

const editPosts = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __q045EditPosts?: Array<{
            command: string
            content: string | null
            exact: boolean
          }>
        }
      ).__q045EditPosts ?? [],
  )

// ── render-signal counter (Paste Plain, toolbar List) ──

/** Wraps `__vmdeSourceRenderEdit` (count, call through) and counts capture `input` on the Source root. */
const armRenderSignalCount = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as unknown as {
      __vmdeSourceRenderEdit?: () => void
      __q045Signals?: { hooks: number; inputs: number }
    }
    const counts = { hooks: 0, inputs: 0 }
    const hook = w.__vmdeSourceRenderEdit
    w.__vmdeSourceRenderEdit = () => {
      counts.hooks++
      hook?.()
    }
    document
      .querySelector('.vditor-sv')
      ?.addEventListener('input', () => counts.inputs++, true)
    w.__q045Signals = counts
  })

const readRenderSignalCount = (frame: Frame) =>
  frame.locator('body').evaluate(
    () =>
      (
        window as unknown as {
          __q045Signals?: { hooks: number; inputs: number }
        }
      ).__q045Signals ?? { hooks: -1, inputs: -1 },
  )

// ── first-edit latency probe (design section 6.2) ──

interface ProbeFixtures {
  workbox: Page
  evaluateInVSCode: Evaluate
  baseDir: string
  electronApp: import('playwright-core').ElectronApplication
}

interface CounterSnapshot {
  at: number
  marks: number
  snapshotCalls: number
  snapshotMemoHits: number
  fullFallbacks: number
  previewLegacyRoutes: number
  previewModelRoutes: number
  getValue: number
  cloneNode: number
  edits: number
}

interface FrameEntry {
  startTime: number
  duration: number
  blockingDuration: number
  scriptMs: number
  scripts: Array<{
    invoker: string
    invokerType: string
    sourceFunctionName: string
    duration: number
  }>
}

interface LatencySample {
  tagged: boolean
  previewShown: boolean
  start: number | null
  matches: number
  matchText: string[][]
  elementEntries: number
  elementIsResolved: boolean
  elementConnected: boolean
  intersectionArea: number
  presentationTime: number | null
  renderTime: number | null
  eventEnd: number | null
  frames: FrameEntry[]
  longTasks: Array<{ startTime: number; duration: number }>
  counters: Partial<Record<'t0' | 't1' | 't2' | 't3', CounterSnapshot>>
}

/** One run of a latency cell on a fresh file: arm, edit, collect. */
async function latencyRun(
  fixtures: ProbeFixtures,
  eol: 'LF' | 'CRLF',
  action: 'key' | 'paste',
  cell: string,
  tagged: boolean,
): Promise<LatencySample> {
  const { workbox, evaluateInVSCode, baseDir, electronApp } = fixtures
  const lf = tableHeavyMarkdown(16).replace(
    '# Overview\n\n',
    '# Overview\n\nq045 target paragraph\n\n',
  )
  const text = eol === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf
  const { frame } = await open(
    workbox,
    evaluateInVSCode,
    baseDir,
    `q045-latency-${cell}-${tagged ? 'tagged' : 'untagged'}.md`,
    text,
  )
  await toolbarSource(frame, true)
  if (action === 'paste')
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.env.clipboard.writeText(args[0])
      },
      ['q045p'],
    )
  const xtest = action === 'key' ? await xtestFor(electronApp, workbox) : null
  await sourceCaret(frame, 'q045 target paragraph')
  await frame.locator('body').evaluate(armLatencyProbe, {
    action,
    marker: action === 'key' ? 'zq045' : 'q045p',
    identifier: `q045-${cell}`,
    tagged,
  })
  if (xtest) await xtest.type('z')
  else
    await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('vmde.pastePlain')
    }, [])
  // Negative-assertion wait: the frames, the idle post and the delayed preview of the 1.5 s window
  // must have been observed before the sample is collected.
  await workbox.waitForTimeout(2500)
  return frame.locator('body').evaluate(collectLatencyProbe)
}

/** Installed in the webview page; see design section 6.2. Test code only. */
function armLatencyProbe(
  _body: Element,
  options: {
    action: 'key' | 'paste'
    marker: string
    identifier: string
    tagged: boolean
  },
): void {
  type Stats = Record<string, number | undefined>
  const w = window as unknown as {
    __vmdeIncrementalSeedStats?: Stats
    __vmdePreviewRendered?: (...args: unknown[]) => unknown
    vditor: { getValue(): string }
    vscode: {
      postMessage(message: { command: string }): unknown
      getState(): unknown
      setState(state: unknown): unknown
    }
    __q045Latency?: unknown
  }
  const source = document.querySelector<HTMLElement>('.vditor-sv')
  if (!source) throw new Error('no Source root')
  let getValueCalls = 0
  let cloneCalls = 0
  let edits = 0
  const getValue = w.vditor.getValue
  w.vditor.getValue = function (this: unknown) {
    getValueCalls++
    return getValue.call(this)
  }
  const cloneNode = Node.prototype.cloneNode
  Node.prototype.cloneNode = function (this: Node, deep?: boolean) {
    if (this === source) cloneCalls++
    return cloneNode.call(this, deep)
  }
  const state = {
    options,
    previewShown: (() => {
      const pane = document.querySelector<HTMLElement>('.vditor-preview')
      return !!pane && getComputedStyle(pane).display !== 'none'
    })(),
    start: null as number | null,
    records: [] as MutationRecord[],
    resolved: null as Element | null,
    elementEntries: [] as PerformanceEntry[],
    eventEntries: [] as PerformanceEntry[],
    frames: [] as PerformanceEntry[],
    longTasks: [] as PerformanceEntry[],
    counters: {} as Record<string, unknown>,
    observers: [] as Array<{ disconnect(): void }>,
  }
  const snap = (label: string) => {
    if (state.counters[label]) return
    const stats = w.__vmdeIncrementalSeedStats ?? {}
    state.counters[label] = {
      at: performance.now(),
      marks: stats.userInputMarks ?? 0,
      snapshotCalls: stats.snapshotCalls ?? 0,
      snapshotMemoHits: stats.snapshotMemoHits ?? 0,
      fullFallbacks: stats.fullFallbacks ?? 0,
      previewLegacyRoutes: stats.previewLegacyRoutes ?? 0,
      previewModelRoutes: stats.previewModelRoutes ?? 0,
      getValue: getValueCalls,
      cloneNode: cloneCalls,
      edits,
    }
  }
  const directText = (element: Element): string[] =>
    Array.from(element.childNodes)
      .filter((child) => child.nodeType === Node.TEXT_NODE)
      .map((child) => (child as Text).data)
  const markerElements = (records: MutationRecord[]): Element[] => {
    const added = records
      .flatMap((record) => Array.from(record.addedNodes))
      .filter((node): node is Element => node instanceof Element)
      .flatMap((element) => [element, ...element.querySelectorAll('*')])
    return [...new Set(added)].filter((element) =>
      directText(element).join('').includes(options.marker),
    )
  }
  const mutations = new MutationObserver((records) => {
    state.records.push(...records)
    if (!options.tagged || state.resolved) return
    const found = markerElements(state.records)
    if (found.length !== 1) return
    // Set in the observer callback (a microtask), before the frame's rendering steps.
    state.resolved = found[0]
    found[0].setAttribute('elementtiming', options.identifier)
  })
  const begin = (timeStamp: number) => {
    if (state.start !== null) return
    state.start = timeStamp
    snap('t0')
    mutations.observe(source, {
      childList: true,
      subtree: true,
      characterData: true,
    })
  }
  if (options.action === 'key') {
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.isTrusted && event.key === 'z') begin(event.timeStamp)
      },
      true,
    )
    const onInput = () => {
      if (state.start === null) return
      document.removeEventListener('input', onInput)
      snap('t1')
    }
    document.addEventListener('input', onInput)
  } else {
    const matches = (event: MessageEvent) =>
      event.data?.command === 'paste-plain' && event.data?.text === 'q045p'
    window.addEventListener(
      'message',
      (event) => {
        if (matches(event)) begin(event.timeStamp)
      },
      true,
    )
    // Registered after the router's listener: runs after its `paste-plain` handler returns.
    window.addEventListener('message', (event) => {
      if (matches(event)) snap('t1')
    })
  }
  const api = w.vscode
  w.vscode = {
    postMessage: (message) => {
      if (
        state.start !== null &&
        (message.command === 'edit' || message.command === 'edit-delta')
      ) {
        snap('t2')
        edits++
      }
      return api.postMessage(message)
    },
    getState: () => api.getState(),
    setState: (value) => api.setState(value),
  }
  const rendered = w.__vmdePreviewRendered
  if (rendered)
    w.__vmdePreviewRendered = (...args: unknown[]) => {
      if (state.start !== null) snap('t3')
      return rendered(...args)
    }
  const observe = (
    init: PerformanceObserverInit & { durationThreshold?: number },
    sink: PerformanceEntry[],
  ) => {
    try {
      const observer = new PerformanceObserver((list) =>
        sink.push(...list.getEntries()),
      )
      observer.observe(init)
      state.observers.push(observer)
    } catch {
      // An entry type this webview does not support leaves the sink empty (reported).
    }
  }
  observe({ type: 'element', buffered: false }, state.elementEntries)
  observe(
    { type: 'event', durationThreshold: 16, buffered: true },
    state.eventEntries,
  )
  observe({ type: 'long-animation-frame', buffered: true }, state.frames)
  observe({ type: 'longtask', buffered: true }, state.longTasks)
  w.__q045Latency = { state, mutations, markerElements, directText }
}

/** Collects the armed probe's sample (plain data only). Test code only. */
function collectLatencyProbe(): LatencySample {
  const probe = (
    window as unknown as {
      __q045Latency: {
        state: {
          options: { tagged: boolean; identifier: string }
          previewShown: boolean
          start: number | null
          records: MutationRecord[]
          resolved: Element | null
          elementEntries: PerformanceEntry[]
          eventEntries: PerformanceEntry[]
          frames: PerformanceEntry[]
          longTasks: PerformanceEntry[]
          counters: Record<string, unknown>
          observers: Array<{ disconnect(): void }>
        }
        mutations: MutationObserver
        markerElements(records: MutationRecord[]): Element[]
        directText(element: Element): string[]
      }
    }
  ).__q045Latency
  const { state } = probe
  probe.mutations.disconnect()
  for (const observer of state.observers) observer.disconnect()
  const found = probe.markerElements(state.records)
  const start = state.start
  const elements = state.elementEntries.filter(
    (entry) =>
      (entry as unknown as { identifier: string }).identifier ===
      state.options.identifier,
  ) as unknown as Array<
    PerformanceEntry & {
      element: Element | null
      intersectionRect: DOMRectReadOnly
      renderTime: number
      presentationTime?: number
    }
  >
  const element = elements.length === 1 ? elements[0] : null
  const rect = element?.intersectionRect
  const area =
    rect &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < innerHeight &&
    rect.left < innerWidth
      ? rect.width * rect.height
      : 0
  const keydown = state.eventEntries.find(
    (entry) =>
      entry.name === 'keydown' &&
      start !== null &&
      Math.abs(entry.startTime - start) < 1 &&
      ((entry as unknown as { interactionId?: number }).interactionId ?? 0) > 0,
  )
  const windowEnd = start === null ? 0 : start + 1500
  const frames = state.frames
    .filter(
      (entry) =>
        start !== null &&
        entry.startTime + entry.duration >= start &&
        entry.startTime <= windowEnd,
    )
    .map((entry) => {
      const frame = entry as unknown as {
        blockingDuration?: number
        scripts?: Array<{
          invoker?: string
          invokerType?: string
          sourceFunctionName?: string
          duration: number
        }>
      }
      const scripts = (frame.scripts ?? []).map((script) => ({
        invoker: script.invoker ?? '',
        invokerType: script.invokerType ?? '',
        sourceFunctionName: script.sourceFunctionName ?? '',
        duration: script.duration,
      }))
      return {
        startTime: entry.startTime,
        duration: entry.duration,
        blockingDuration: frame.blockingDuration ?? 0,
        scriptMs: scripts.reduce((sum, script) => sum + script.duration, 0),
        scripts,
      }
    })
  return {
    tagged: state.options.tagged,
    previewShown: state.previewShown,
    start,
    matches: found.length,
    matchText: found.map((match) => probe.directText(match)),
    elementEntries: elements.length,
    elementIsResolved:
      element !== null &&
      element.element !== null &&
      element.element === state.resolved,
    elementConnected: element?.element?.isConnected ?? false,
    intersectionArea: area,
    presentationTime: element?.presentationTime ?? null,
    renderTime: element?.renderTime ?? null,
    eventEnd: keydown ? keydown.startTime + keydown.duration : null,
    frames,
    longTasks: state.longTasks
      .filter((entry) => start !== null && entry.startTime >= start - 50)
      .map((entry) => ({
        startTime: entry.startTime,
        duration: entry.duration,
      })),
    counters: state.counters as LatencySample['counters'],
  }
}

type FrameCategory =
  | 'edit'
  | 'timer'
  | 'message'
  | 'unattributed'
  | 'other-script'

/**
 * The work a Long Animation Frame entry is attributed to. A frame whose non-script time is 50 ms or
 * more (a short callback followed by long layout) is unattributed. The pending-edit timer and the
 * preview debounce timer are both timer callbacks; the minified bundle does not name them apart, so
 * both count as `timer` (idle publication or delayed preview), and both are verdict criteria.
 */
function frameCategory(frame: FrameEntry, editEnd: number): FrameCategory {
  if (frame.scripts.length === 0 || frame.duration - frame.scriptMs >= 50)
    return 'unattributed'
  const invokers = frame.scripts.map(
    (script) => `${script.invokerType} ${script.invoker}`,
  )
  if (
    frame.startTime <= editEnd &&
    invokers.some((invoker) =>
      /keydown|keypress|beforeinput|\binput\b|paste|message/i.test(invoker),
    )
  )
    return 'edit'
  if (
    invokers.some((invoker) =>
      /TimerHandler|setTimeout|FrameRequestCallback|user-callback/i.test(
        invoker,
      ),
    )
  )
    return 'timer'
  if (invokers.some((invoker) => /message/i.test(invoker))) return 'message'
  return 'other-script'
}

interface Verdict {
  verdict: 'pass' | 'fail' | 'unverified'
  reasons: string[]
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the section 6.2 verdict table (validity, boundary, frame attribution, Event Timing band) kept in one place so each rule reads beside the others
function latencyVerdict(sample: LatencySample): Verdict {
  const reasons: string[] = []
  const invalid: string[] = []
  if (sample.start === null) invalid.push('no matching delivery')
  if (sample.matches !== 1)
    invalid.push(`${sample.matches} marker elements resolved`)
  if (sample.elementEntries !== 1)
    invalid.push(`${sample.elementEntries} element-timing entries`)
  if (!sample.elementIsResolved)
    invalid.push('the entry is not the resolved element')
  if (!sample.elementConnected) invalid.push('the element is disconnected')
  if (sample.intersectionArea <= 0)
    invalid.push('no intersection area in the viewport')
  if (
    sample.presentationTime === null ||
    sample.start === null ||
    sample.presentationTime <= sample.start
  )
    invalid.push(
      `no presentation feedback (renderTime ${sample.renderTime ?? 'none'})`,
    )
  const start = sample.start ?? 0
  const presented = sample.presentationTime ?? start
  const latency = presented - start
  const editEnd = sample.presentationTime ?? start
  let attributedOver = false
  let unattributedOver = false
  for (const frame of sample.frames) {
    if (frame.duration < 50) continue
    const category = frameCategory(frame, editEnd)
    if (category === 'unattributed' || category === 'other-script') {
      unattributedOver = true
      reasons.push(
        `unattributed frame ${frame.duration.toFixed(1)} ms at ${(frame.startTime - start).toFixed(1)} ms`,
      )
    } else {
      attributedOver = true
      reasons.push(
        `${category} frame ${frame.duration.toFixed(1)} ms at ${(frame.startTime - start).toFixed(1)} ms`,
      )
    }
  }
  if (invalid.length > 0)
    return { verdict: 'unverified', reasons: [...invalid, ...reasons] }
  reasons.unshift(`P - start = ${latency.toFixed(1)} ms`)
  if (latency >= 50 || attributedOver) return { verdict: 'fail', reasons }
  // Event Timing durations are rounded to 8 ms: a gap over 4 ms plus one frame means the two
  // observers may not describe the same frame. It never decides the boundary.
  if (
    sample.eventEnd !== null &&
    Math.abs(sample.eventEnd - presented) > 4 + 16.7
  ) {
    reasons.push(
      `Event Timing end differs from P by ${(sample.eventEnd - presented).toFixed(1)} ms`,
    )
    return { verdict: 'unverified', reasons }
  }
  if (unattributedOver) return { verdict: 'unverified', reasons }
  return { verdict: 'pass', reasons }
}

// ── return-to-IR pending history flush probe (design section 6.2, review binding changes 1 and 2) ──

const HEADING_DOC = `##   alpha\n\n${Array.from(
  { length: 1200 },
  (_, i) =>
    `Stable paragraph ${i} with plain words held across the mode switch.`,
).join('\n\n')}\n`
const YAML_HEAD = '---\ntitle: doc\n---\n\n'

/**
 * The complete bytes the flush may post for each fixture (review binding change 1: the whole post,
 * never a prefix, which would accept the document without the user's `!`). Heading: the plain IR
 * serialization, which normalizes the heading's spaces (`## alpha!`, 81,700 code units). YAML
 * follows K17, the unchanged plain path (Q-297): its rebase keeps the front matter separator and the
 * heading's spelling (81,722 code units) when it anchors, and otherwise posts the live IR
 * serialization (81,719 code units, round i045-2). Both hold the user's `!`.
 */
const expectedFlushPosts = (kind: 'heading' | 'yaml'): string[] =>
  kind === 'heading'
    ? [HEADING_DOC.replace('##   alpha', '## alpha!')]
    : [
        `${YAML_HEAD}${HEADING_DOC}`.replace('##   alpha', '##   alpha!'),
        `---\ntitle: doc\n---\n${HEADING_DOC.replace('##   alpha', '## alpha!')}`,
      ]

interface LuteCall {
  kind: 'render' | 'serialize-projection' | 'serialize-other'
  startedAt: number
  ms: number
}

interface FlushSample {
  opened: number
  flush: { pending: boolean; startedAt: number; endedAt: number } | null
  update: { timeStamp: number; revision: number } | null
  posts: Array<{
    command: string
    at: number
    exact: boolean
    revision: number | null
    length: number
    matches: boolean
    head: string
    /** First code unit where the post differs from the expected bytes (-1: equal), with context. */
    diffAt: number
    got: string
    want: string
  }>
  lute: LuteCall[]
  frames: FrameEntry[]
  /**
   * The route to the flush: the trusted `!` input in Source, the in-page switch back to IR, and the
   * edits posted between the input and the flush (none: the typing is still unpublished at entry).
   */
  route: {
    typedAt: number | null
    switchedAt: number | null
    postsBeforeFlush: number
  }
  /**
   * Diagnostic: the one-span comparison of the last projection's serialization (the plain path's
   * `before`) with the last posted edit's content (its `rendered`): the common prefix and suffix
   * lengths and the differing spans (clipped). Two or more spans show why a rebase declined.
   */
  projectionSpan: {
    prefix: number
    suffix: number
    oldSpan: string
    newSpan: string
  } | null
  hostText: string
}

/** One return-to-IR cell on a fresh file. */
async function flushRun(
  fixtures: ProbeFixtures,
  kind: 'heading' | 'yaml',
): Promise<FlushSample> {
  const { workbox, evaluateInVSCode, baseDir, electronApp } = fixtures
  const opened = kind === 'yaml' ? `${YAML_HEAD}${HEADING_DOC}` : HEADING_DOC
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    const config = vscode.workspace.getConfiguration('vmde')
    const target = vscode.ConfigurationTarget.Global
    await config.update('editor.autoWrap', true, target)
    await config.update('editor.wrapColumn', 80, target)
    // The manifest's maximum: the wrap stays pending through the route below.
    await config.update('editor.autoWrapDelay', 5000, target)
  }, [])
  const { frame, file } = await open(
    workbox,
    evaluateInVSCode,
    baseDir,
    `q045-flush-${kind}.md`,
    opened,
  )
  // The IR anchor: edit-sync holds the opened bytes exactly.
  await expect
    .poll(
      () =>
        frame.locator('body').evaluate(
          () =>
            (
              window as unknown as {
                __vmdeE2EExactMarkdown?: () => string | null
              }
            ).__vmdeE2EExactMarkdown?.() ?? null,
        ),
      { timeout: 30_000 },
    )
    .toBe(opened)
  await frame.locator('body').evaluate(armFlushProbe, expectedFlushPosts(kind))
  await commandMode(frame, evaluateInVSCode, 'sv')
  const xtest = await xtestFor(electronApp, workbox)
  await sourceCaret(frame, 'alpha', true)
  await frame.locator('body').evaluate(armReturnSwitch)
  const before = await waitForE2EReadiness(frame, (s) => s.mode === 'sv')
  await xtest.type('!')
  await waitForE2EReadiness(
    frame,
    (s) => s.modeEpoch > before.modeEpoch && s.mode === 'ir',
    { message: 'the editor returned to IR after the typing' },
  )
  // A ranged host edit: the change listener sends an `update` with a newer revision, and
  // `applyHostUpdate` flushes the pending typing before it cancels the wrap.
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (!doc) throw new Error('flush document not open')
      const edit = new vscode.WorkspaceEdit()
      edit.insert(doc.uri, doc.positionAt(doc.getText().length), args[1])
      await vscode.workspace.applyEdit(edit)
    },
    [file, '\nprobe tail\n'],
  )
  await expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (
                window as unknown as { __q045Flush?: { flushed(): boolean } }
              ).__q045Flush?.flushed() ?? false,
          ),
      { timeout: 30_000 },
    )
    .toBe(true)
  // Negative-assertion wait: frames of the 500 ms window after the update must be observed.
  await workbox.waitForTimeout(1000)
  const sample = (await frame
    .locator('body')
    .evaluate(collectFlushProbe)) as Omit<FlushSample, 'hostText' | 'opened'>
  // At flush entry the typing must be pending (auto-wrap still pending in IR) and unpublished (no
  // edit posted since the input); otherwise the probe measured another route.
  expect(
    sample.route.typedAt,
    'the trusted `!` input was observed',
  ).not.toBeNull()
  expect(sample.route.switchedAt, 'the switch back to IR ran').not.toBeNull()
  expect(sample.flush?.pending, 'auto-wrap pending at flush entry').toBe(true)
  expect(
    sample.route.postsBeforeFlush,
    'edits posted between the typing and the flush',
  ).toBe(0)
  return {
    ...sample,
    opened: opened.length,
    hostText: (await docText(evaluateInVSCode as never, file)).slice(0, 40),
  }
}

/** Installed in the webview page before the route. Test code only. */
function armFlushProbe(_body: Element, accepted: string[]): void {
  type Lute = {
    Md2VditorIRDOM(markdown: string): string
    VditorIRDOM2Md(html: string): string
  }
  const w = window as unknown as {
    vditor: { vditor: { lute: Lute } }
    vscode: {
      postMessage(message: Record<string, unknown>): unknown
      getState(): unknown
      setState(state: unknown): unknown
    }
    __vmdeIncrementalSeedStats?: {
      historyFlush?: { pending: boolean; startedAt: number; endedAt: number }
    }
    __q045Flush?: unknown
  }
  const armedAt = performance.now()
  const state = {
    updates: [] as Array<{ timeStamp: number; revision: number }>,
    posts: [] as Array<Record<string, unknown>>,
    lute: [] as Array<{ kind: string; startedAt: number; ms: number }>,
    frames: [] as PerformanceEntry[],
    observer: null as PerformanceObserver | null,
    projectionOut: null as string | null,
    lastPost: null as string | null,
  }
  window.addEventListener(
    'message',
    (event) => {
      if (
        event.data?.command === 'update' &&
        typeof event.data.revision === 'number'
      )
        state.updates.push({
          timeStamp: event.timeStamp,
          revision: event.data.revision,
        })
    },
    true,
  )
  // The first code unit where a post differs from the nearest accepted bytes, with 20 units of context.
  const difference = (content: string) => {
    if (accepted.includes(content)) return { diffAt: -1, got: '', want: '' }
    let best = { at: -1, expected: '' }
    for (const expected of accepted) {
      let at = 0
      const limit = Math.min(content.length, expected.length)
      while (at < limit && content[at] === expected[at]) at++
      if (at > best.at) best = { at, expected }
    }
    const from = Math.max(0, best.at - 20)
    return {
      diffAt: best.at,
      got: content.slice(from, best.at + 20),
      want: best.expected.slice(from, best.at + 20),
    }
  }
  const api = w.vscode
  w.vscode = {
    postMessage: (message) => {
      if (message.command === 'edit' || message.command === 'edit-delta') {
        const content =
          typeof message.content === 'string' ? message.content : ''
        if (message.command === 'edit') state.lastPost = content
        state.posts.push({
          command: message.command,
          at: performance.now(),
          exact: message.exact === true,
          revision:
            typeof message.revision === 'number' ? message.revision : null,
          length: content.length,
          matches: accepted.includes(content),
          head: content.slice(0, 40),
          ...difference(content),
        })
      }
      return api.postMessage(message)
    },
    getState: () => api.getState(),
    setState: (value) => api.setState(value),
  }
  // Review binding change 2: the inherited projection is a render plus the serialization of exactly
  // its output; every other serialization is other work.
  const lute = w.vditor.vditor.lute
  const render = lute.Md2VditorIRDOM
  const serialize = lute.VditorIRDOM2Md
  let projected: string | undefined
  lute.Md2VditorIRDOM = function (this: Lute, markdown: string) {
    const startedAt = performance.now()
    const out = render.call(this, markdown)
    state.lute.push({
      kind: 'render',
      startedAt,
      ms: performance.now() - startedAt,
    })
    projected = out
    return out
  }
  lute.VditorIRDOM2Md = function (this: Lute, html: string) {
    const isProjection = projected !== undefined && html === projected
    const startedAt = performance.now()
    const out = serialize.call(this, html)
    state.lute.push({
      kind: isProjection ? 'serialize-projection' : 'serialize-other',
      startedAt,
      ms: performance.now() - startedAt,
    })
    if (isProjection) {
      projected = undefined
      state.projectionOut = out
    }
    return out
  }
  try {
    state.observer = new PerformanceObserver((list) =>
      state.frames.push(...list.getEntries()),
    )
    state.observer.observe({ type: 'long-animation-frame', buffered: true })
  } catch {
    // No Long Animation Frames: the frame criterion stays unverified (reported).
  }
  w.__q045Flush = {
    state,
    flushed: () =>
      (w.__vmdeIncrementalSeedStats?.historyFlush?.startedAt ?? -1) > armedAt,
  }
}

/**
 * Installed before the `!` key. Edit-sync publishes Source typing 250 ms after the input (the
 * pending-edit idle timer, edit-sync `createPendingEdit({ wait: 250 })`); only in IR with an
 * auto-wrap pending does that post wait for the wrap (vditor-init `deferTypingPost`). A host-issued
 * mode command after the key arrived later than 250 ms in round i045-3, so the typing was published
 * in Source and the flush found nothing pending. The switch back to IR therefore runs in the page,
 * one task after the trusted input: a click on the toolbar's IR mode button (the toolbar route; a
 * dispatched click has no pointerdown or keydown, which would cancel the wrap). Test code only.
 */
function armReturnSwitch(): void {
  const state = {
    typedAt: null as number | null,
    switchedAt: null as number | null,
  }
  const onInput = (event: Event) => {
    if (!event.isTrusted) return
    const source = document.querySelector('.vditor-sv')
    if (!source?.textContent?.includes('alpha!')) return
    document.removeEventListener('input', onInput)
    state.typedAt = performance.now()
    setTimeout(() => {
      document
        .querySelector('.vditor-toolbar button[data-mode="ir"]')
        ?.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true }),
        )
      state.switchedAt = performance.now()
    }, 0)
  }
  document.addEventListener('input', onInput)
  ;(window as unknown as { __q045Return?: typeof state }).__q045Return = state
}

/** Collects the flush probe's sample (plain data only). Test code only. */
function collectFlushProbe(): Omit<FlushSample, 'hostText' | 'opened'> {
  const w = window as unknown as {
    __vmdeIncrementalSeedStats?: {
      historyFlush?: { pending: boolean; startedAt: number; endedAt: number }
    }
    __q045Flush: {
      state: {
        updates: Array<{ timeStamp: number; revision: number }>
        posts: FlushSample['posts']
        lute: LuteCall[]
        frames: PerformanceEntry[]
        observer: PerformanceObserver | null
        projectionOut: string | null
        lastPost: string | null
      }
    }
  }
  const { state } = w.__q045Flush
  state.observer?.disconnect()
  const flush = w.__vmdeIncrementalSeedStats?.historyFlush ?? null
  // The update that triggered the flush: the latest one delivered before the flush started.
  const update =
    flush === null
      ? null
      : (state.updates
          .filter((candidate) => candidate.timeStamp <= flush.startedAt)
          .pop() ?? null)
  const from = update?.timeStamp ?? 0
  const frames = state.frames
    .filter(
      (entry) =>
        update !== null &&
        entry.startTime + entry.duration >= from &&
        entry.startTime <= from + 500,
    )
    .map((entry) => {
      const scripts = (
        (
          entry as unknown as {
            scripts?: Array<{
              invoker?: string
              invokerType?: string
              sourceFunctionName?: string
              duration: number
            }>
          }
        ).scripts ?? []
      ).map((script) => ({
        invoker: script.invoker ?? '',
        invokerType: script.invokerType ?? '',
        sourceFunctionName: script.sourceFunctionName ?? '',
        duration: script.duration,
      }))
      return {
        startTime: entry.startTime,
        duration: entry.duration,
        blockingDuration:
          (entry as unknown as { blockingDuration?: number })
            .blockingDuration ?? 0,
        scriptMs: scripts.reduce((sum, script) => sum + script.duration, 0),
        scripts,
      }
    })
  const before = state.projectionOut
  const rendered = state.lastPost
  let projectionSpan: FlushSample['projectionSpan'] = null
  if (before !== null && rendered !== null) {
    const limit = Math.min(before.length, rendered.length)
    let prefix = 0
    while (prefix < limit && before[prefix] === rendered[prefix]) prefix++
    let suffix = 0
    while (
      suffix < limit - prefix &&
      before[before.length - 1 - suffix] ===
        rendered[rendered.length - 1 - suffix]
    )
      suffix++
    projectionSpan = {
      prefix,
      suffix,
      oldSpan: before.slice(prefix, before.length - suffix).slice(0, 120),
      newSpan: rendered.slice(prefix, rendered.length - suffix).slice(0, 120),
    }
  }
  const route = (
    window as unknown as {
      __q045Return?: { typedAt: number | null; switchedAt: number | null }
    }
  ).__q045Return ?? { typedAt: null, switchedAt: null }
  const typedAt = route.typedAt
  return {
    flush,
    update,
    posts: state.posts,
    lute: state.lute,
    frames,
    route: {
      typedAt,
      switchedAt: route.switchedAt,
      postsBeforeFlush:
        typedAt === null || flush === null
          ? -1
          : state.posts.filter(
              (post) => post.at >= typedAt && post.at < flush.startedAt,
            ).length,
    },
    projectionSpan,
  }
}

/**
 * The verdict of a return-to-IR cell. Review binding change 1: exactly one plain `edit` inside the
 * flush, with complete accepted bytes and the outgoing (older) revision. Review binding change 2 and
 * Q-297: the full flush time is always reported, with two known limits attributed separately:
 * - K17, the plain path's YAML projection: one `Md2VditorIRDOM` render plus the serialization of
 *   exactly its output (YAML only; at most one, none after an incidental IR read);
 * - K18, the plain path's serialization in the flush: every other `VditorIRDOM2Md` call inside it
 *   (the cold per-block IR serializations and the whole-document ones, about 1,200 calls).
 * The 50 ms rule applies to the rest. A second projection, a heading projection, a wrong post, or
 * 50 ms or more outside K17 and K18 fails; the limits are named, never hidden.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the return-to-IR verdict table (route, complete post bytes, revision, projections, K17 and K18 attribution, frames) kept in one place
function flushVerdict(kind: 'heading' | 'yaml', sample: FlushSample): Verdict {
  const reasons: string[] = []
  const { flush, update } = sample
  if (!flush?.pending || !update)
    return {
      verdict: 'unverified',
      reasons: [
        `the route did not run (flush ${JSON.stringify(flush)}, update ${JSON.stringify(update)})`,
      ],
    }
  const within = (at: number) => at >= flush.startedAt && at <= flush.endedAt
  const posts = sample.posts.filter((post) => within(post.at))
  const plain = posts.filter((post) => post.command === 'edit')
  const deltas = posts.filter((post) => post.command === 'edit-delta')
  const lute = sample.lute.filter((call) => within(call.startedAt))
  const sum = (calls: LuteCall[]) =>
    calls.reduce((total, call) => total + call.ms, 0)
  const renders = lute.filter((call) => call.kind === 'render')
  const projection = lute.filter(
    (call) => call.kind === 'render' || call.kind === 'serialize-projection',
  )
  const serializations = lute.filter((call) => call.kind === 'serialize-other')
  const flushMs = flush.endedAt - flush.startedAt
  const maxRenders = kind === 'yaml' ? 1 : 0
  // Only the inherited projection is K17; an extra one is outside it.
  const k17Ms = renders.length <= maxRenders ? sum(projection) : 0
  const k18Ms = sum(serializations)
  const outsideMs = flushMs - k17Ms - k18Ms
  reasons.push(
    `flush ${flushMs.toFixed(1)} ms${flushMs >= 50 ? ` (overrun ${(flushMs - 50).toFixed(1)} ms)` : ''}`,
    `K17 projection ${sum(projection).toFixed(1)} ms in ${renders.length} render(s)${kind === 'yaml' ? ' (known limit)' : ''}`,
    `K18 plain-path serialization ${k18Ms.toFixed(1)} ms in ${serializations.length} call(s) (known limit)`,
    `outside K17 and K18 ${outsideMs.toFixed(1)} ms`,
  )
  let failed = false
  const post = plain[0]
  if (plain.length !== 1 || deltas.length !== 0) {
    failed = true
    reasons.push(
      `${plain.length} plain edits and ${deltas.length} deltas in the flush`,
    )
  } else if (!post.matches || post.exact) {
    failed = true
    reasons.push(
      `post does not match: exact ${post.exact}, ${post.length} code units, head ${JSON.stringify(post.head)}, accepted ${expectedFlushPosts(
        kind,
      )
        .map((text) => text.length)
        .join(
          ' or ',
        )}; first difference at ${post.diffAt}: got ${JSON.stringify(post.got)}, want ${JSON.stringify(post.want)}; projection against post ${JSON.stringify(sample.projectionSpan)}`,
    )
  } else if (post.revision === null || post.revision >= update.revision) {
    failed = true
    reasons.push(
      `post revision ${post.revision} is not older than the update's ${update.revision}`,
    )
  }
  if (renders.length > maxRenders) {
    failed = true
    reasons.push(
      `${renders.length} projections, at most ${maxRenders} expected (an extra projection is outside K17)`,
    )
  }
  if (outsideMs >= 50) failed = true
  let unattributed = false
  for (const frame of sample.frames) {
    if (frame.duration < 50) continue
    const category = frameCategory(frame, update.timeStamp + 500)
    const isMessage = category === 'edit' || category === 'message'
    // The frame that holds the flush also holds the K17 and K18 work; only the rest counts.
    const counted = isMessage ? frame.duration - k17Ms - k18Ms : frame.duration
    if (counted < 50) continue
    reasons.push(
      `${category} frame ${frame.duration.toFixed(1)} ms (${counted.toFixed(1)} ms outside K17 and K18)`,
    )
    if (isMessage) failed = true
    else unattributed = true
  }
  if (failed) return { verdict: 'fail', reasons }
  if (unattributed) return { verdict: 'unverified', reasons }
  return { verdict: 'pass', reasons }
}
