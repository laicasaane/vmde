import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { createXtestInput } from './helpers/xtest-input'
import {
  docText,
  ev,
  ExtensionId,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
} from './webview-helpers'

// Task 608 S4 — real-VS-Code verification of the blockless IR caret routes. Navigation uses OS-level
// (XTEST) keys; the four toolbar actions are real mouse clicks. Expected values come from the task
// contract: a document whose first block is atomic (rule, TOC, code block, table) opens the
// boundary-0 gap on Ctrl+Home; Headings and Link refuse at a blockless caret; Code and Table insert one
// top-level block with one Undo step; the original bytes survive around it.
const HR_FIRST =
  '----\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'
const HR_LAST =
  'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n\n----\n'
const TOC_FIRST =
  '[toc]\n\n# Probe\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'
const CODE_FIRST = '```js\nalpha\nbeta\n```\n\nOmega\n'
const HEADING_FIRST =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'
const PARAGRAPHS = 'Alpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n'
const ALPHA = 'Alpha bravo charlie delta.'
// Past Vditor's delayed input and its history checkpoint (undoDelay, 800 ms by default): a refusal
// that still queued work would show as a changed value, a longer history or a dirty document.
const QUIET_MS = 1100

type Frame = Awaited<ReturnType<typeof reopenVmdeFixture>>
type HostEvaluator = Parameters<typeof docText>[0]
type Tool = 'headings' | 'link' | 'code' | 'table'

interface Probe {
  mode: string
  focused: boolean
  rangeCount: number
  hasIrRange: boolean
  collapsed: boolean
  isRoot: boolean
  startIsRoot: boolean
  rootOffset: number
  inEditor: boolean
  blockText: string | null
  blocks: string[]
  gaps: number
  rootText: number
  tocBlocks: number
  undo: number
  redo: number
  historySource: string
  value: string
  disabled: Record<string, boolean>
}

const probe = (frame: Frame): Promise<Probe> =>
  frame.locator('body').evaluate(() => {
    const outer = window as unknown as {
      vditor: {
        getValue(): string
        vditor: {
          currentMode: string
          ir: { range?: Range; element: HTMLElement }
          undo: Record<
            string,
            { undoStack: unknown[]; redoStack: unknown[]; lastText: string }
          >
          toolbar?: {
            elements?: Record<string, { children: HTMLCollection } | undefined>
          }
        }
      }
    }
    const inner = outer.vditor.vditor
    const root = inner.ir.element
    const selection = getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const anchor = selection?.anchorNode ?? null
    const element = anchor instanceof Element ? anchor : anchor?.parentElement
    const disabled: Record<string, boolean> = {}
    for (const name of ['headings', 'link', 'code', 'table'])
      disabled[name] =
        inner.toolbar?.elements?.[name]?.children[0]?.classList.contains(
          'vditor-menu--disabled',
        ) ?? false
    return {
      mode: inner.currentMode,
      focused: document.activeElement === root,
      rangeCount: selection?.rangeCount ?? 0,
      hasIrRange: !!inner.ir.range,
      collapsed: range?.collapsed ?? true,
      isRoot: anchor === root,
      startIsRoot: range?.startContainer === root,
      rootOffset: anchor === root ? (selection?.anchorOffset ?? -1) : -1,
      inEditor: !!anchor && root.contains(anchor),
      blockText: element?.closest('[data-block]')?.textContent ?? null,
      blocks: Array.from(root.children).map(
        (child) =>
          child.getAttribute('data-type') || child.tagName.toLowerCase(),
      ),
      gaps: root.querySelectorAll(':scope > [data-vmde-gap]').length,
      rootText: Array.from(root.childNodes).filter(
        (node) =>
          node.nodeType === Node.TEXT_NODE && (node as Text).data.trim() !== '',
      ).length,
      tocBlocks: root.querySelectorAll('.vditor-toc').length,
      undo: inner.undo.ir.undoStack.length,
      redo: inner.undo.ir.redoStack.length,
      // The last history checkpoint without its caret marker and expand classes: two checkpoints
      // that differ only in the caret hold the same source (undo-boundaries.ts withoutCaret).
      historySource: inner.undo.ir.lastText
        .replace(/<wbr>|<span class="vditor-wbr"><\/span>/g, '')
        .replace(/ vditor-ir__node--expand/g, ''),
      value: outer.vditor.getValue(),
      disabled,
    }
  })

const frames = (frame: Frame) =>
  frame
    .locator('body')
    .evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    )

const sleep = (frame: Frame, ms: number) =>
  frame
    .locator('body')
    .evaluate((_body, delay) => new Promise((r) => setTimeout(r, delay)), ms)

// Seeds a collapsed caret on the bare editable root, the state Task 600's guard protects.
const seedRoot = (frame: Frame, offset: number) =>
  frame.locator('body').evaluate((_body, at) => {
    const root = (
      window as unknown as {
        vditor: { vditor: { ir: { element: HTMLElement } } }
      }
    ).vditor.vditor.ir.element
    root.focus({ preventScroll: true })
    getSelection()?.collapse(root, at)
    document.dispatchEvent(new Event('selectionchange'))
  }, offset)

const isDirty = (evaluate: HostEvaluator, file: string) =>
  evaluate(
    async (vscode: typeof import('vscode'), args: string[]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? false,
    [file],
  ) as Promise<boolean>

function openSession(
  evaluate: HostEvaluator,
  workbox: Parameters<typeof reopenVmdeFixture>[1],
  baseDir: string,
  input: Awaited<ReturnType<typeof createXtestInput>>,
) {
  let previous: string | undefined
  let serial = 0
  const observations: Record<string, unknown>[] = []
  const api = {
    observations,
    note(label: string, data: Record<string, unknown>) {
      observations.push({ label, ...data })
    },
    async fresh(doc: string) {
      // Save only this test's previous disposable document so closeAllEditors cannot open a
      // dirty-file confirmation dialog between cases.
      if (previous)
        await evaluate(
          async (vscode: typeof import('vscode'), [file]: string[]) => {
            await vscode.workspace.textDocuments
              .find((item) => item.uri.fsPath === file)
              ?.save()
          },
          [previous],
        )
      const file = path.join(baseDir, `task608-${++serial}.md`)
      writeFileSync(file, doc)
      previous = file
      const frame = await reopenVmdeFixture(
        evaluate,
        workbox,
        file,
        60_000,
        '.vditor-ir',
      )
      await waitForE2EReadiness(
        frame,
        (s) => s.routerReady && s.editorEpoch > 0 && s.mode === 'ir',
        { message: 'Task 608 IR editor ready' },
      )
      // Vditor's opening Undo snapshot would otherwise land inside a case and look like an edit.
      await waitForInitialUndoSnapshot(frame)
      expect(await docText(evaluate, file)).toBe(doc)
      return { frame, file, doc }
    },
    async key(frame: Frame, key: string) {
      await input.key(key)
      await frames(frame)
    },
    async clickText(frame: Frame, text: string) {
      await frame
        .locator('.vditor-ir p')
        .filter({ hasText: text })
        .first()
        .click()
      await frames(frame)
    },
    async tool(frame: Frame, tool: Tool) {
      if (tool === 'headings') {
        await frame.locator('.vditor-toolbar [data-type="headings"]').click()
        await frame
          .locator(
            '.vditor-toolbar__item:has([data-type="headings"]) .vditor-hint button[data-tag="h2"]',
          )
          .click()
      } else {
        await frame.locator(`.vditor-toolbar [data-type="${tool}"]`).click()
      }
      await frames(frame)
      await sleep(frame, QUIET_MS)
    },
    async command(frame: Frame, command: string) {
      // A user chord starts with a keydown in the webview, which takes a fresh command selection
      // snapshot; a bare Shift keydown is the cheapest one that edits nothing.
      await input.key('Shift_L')
      await ev(
        evaluate,
        async (vscode: typeof import('vscode'), args: string[]) =>
          vscode.commands.executeCommand(args[0]),
        command,
      )
      await frames(frame)
      await sleep(frame, QUIET_MS)
    },
  }
  return api
}

test('N1 OS-level navigation around an atomic first block (rule, TOC, code block) and the HR-last end', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
  )
  test.setTimeout(420_000)
  const evaluate = evaluateInVSCode as HostEvaluator
  const input = await createXtestInput(electronApp, workbox)
  const run = openSession(evaluate, workbox, baseDir, input)
  try {
    // markdown.toc is off by default; the TOC-first cases need the block rendered.
    await evaluate(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update('markdown.toc', true, vscode.ConfigurationTarget.Global)
        await vscode.extensions.getExtension(args[0])?.activate()
      },
      [ExtensionId],
    )

    // Acceptance 2: Ctrl+Home on a document that begins with an atomic block leaves a usable caret
    // (in the boundary-0 gap paragraph, never on the bare root) and changes no Markdown.
    for (const [name, doc, first] of [
      ['HR-first', HR_FIRST, 'hr'],
      ['TOC-first', TOC_FIRST, 'toc-block'],
      // Edge case (design question 1): needsGap breadth — a code block first behaves the same.
      ['code-block-first', CODE_FIRST, 'code-block'],
    ] as const) {
      await test.step(`${name}: Ctrl+Home lands in the gap, then typing opens a new first paragraph`, async () => {
        const { frame, file } = await run.fresh(doc)
        if (first === 'toc-block')
          expect((await probe(frame)).tocBlocks, 'TOC rendered').toBe(1)
        await run.clickText(frame, first === 'code-block' ? 'Omega' : 'Echo')
        const before = await probe(frame)
        expect(before).toMatchObject({ focused: true, inEditor: true })
        await run.key(frame, 'ctrl+Home')
        const landed = await probe(frame)
        run.note(`${name} after Ctrl+Home`, { landed })
        expect(landed).toMatchObject({
          inEditor: true,
          isRoot: false,
          gaps: 1,
          rootText: 0,
        })
        expect(landed.blocks.slice(0, 2)).toEqual(['p', first])
        // Landing alone is not an edit: no host write, no dirty state, no history entry.
        await sleep(frame, QUIET_MS)
        expect(await docText(evaluate, file)).toBe(doc)
        expect(await isDirty(evaluate, file)).toBe(false)
        expect((await probe(frame)).undo).toBe(before.undo)
        await input.type('Z')
        await frames(frame)
        // The typed text is a new paragraph before the atomic block; the original bytes (including
        // the four-hyphen rule) survive untouched below it.
        await expect
          .poll(() => docText(evaluate, file), { message: `${name} typing` })
          .toBe(`Z\n\n${doc}`)
        const typed = await probe(frame)
        run.note(`${name} after typing`, { typed })
        expect(typed.blocks.slice(0, 2)).toEqual(['p', first])
        expect(typed.rootText).toBe(0)
      })
    }

    // Acceptance 2: ordinary navigation out of the gap. The gap is reclaimed and the caret lands in
    // an editable block; the Markdown is unchanged.
    for (const [name, doc, key, landed] of [
      ['HR-first', HR_FIRST, 'Right', ALPHA],
      ['TOC-first', TOC_FIRST, 'Right', '# Probe'],
      ['HR-first', HR_FIRST, 'Left', null],
    ] as const) {
      await test.step(`${name}: Ctrl+Home then ${key} leaves the gap without a root landing`, async () => {
        const { frame, file } = await run.fresh(doc)
        await run.clickText(frame, 'Echo')
        await run.key(frame, 'ctrl+Home')
        expect((await probe(frame)).gaps).toBe(1)
        await run.key(frame, key)
        await sleep(frame, QUIET_MS)
        const after = await probe(frame)
        run.note(`${name} ${key} out of the gap`, { after })
        expect(after).toMatchObject({ inEditor: true, isRoot: false })
        // Left at the very start of the document has nowhere to go: the caret stays usable (the gap
        // or the first block); Right moves to the block after the rule/TOC and reclaims the gap.
        if (landed !== null) {
          expect(after.gaps).toBe(0)
          expect(after.blockText).toBe(landed)
        }
        expect(await docText(evaluate, file)).toBe(doc)
        expect(await isDirty(evaluate, file)).toBe(false)
      })
    }

    // Acceptance 2: the other keyboard routes to a root landing around a rule.
    await test.step('HR-first: ArrowLeft at the start of the first paragraph does not land on the root', async () => {
      const { frame, file, doc } = await run.fresh(HR_FIRST)
      await run.clickText(frame, 'Alpha')
      await run.key(frame, 'Home')
      expect((await probe(frame)).blockText).toBe(ALPHA)
      await run.key(frame, 'Left')
      await sleep(frame, QUIET_MS)
      const after = await probe(frame)
      run.note('HR-first ArrowLeft before Alpha', { after })
      expect(after).toMatchObject({ inEditor: true, isRoot: false })
      expect(await docText(evaluate, file)).toBe(doc)
    })
    await test.step('HR-first: PageUp to the top does not land on the root', async () => {
      const { frame, file, doc } = await run.fresh(HR_FIRST)
      await run.clickText(frame, 'Echo')
      await run.key(frame, 'Prior')
      await sleep(frame, QUIET_MS)
      const after = await probe(frame)
      run.note('HR-first PageUp', { after })
      expect(after).toMatchObject({ inEditor: true, isRoot: false })
      expect(await docText(evaluate, file)).toBe(doc)
    })
    await test.step('HR-last: Ctrl+End does not land on the root', async () => {
      const { frame, file, doc } = await run.fresh(HR_LAST)
      await run.clickText(frame, 'Alpha')
      await run.key(frame, 'ctrl+End')
      await sleep(frame, QUIET_MS)
      const after = await probe(frame)
      run.note('HR-last Ctrl+End', { after })
      expect(after).toMatchObject({ inEditor: true, isRoot: false })
      expect(await docText(evaluate, file)).toBe(doc)
    })
  } finally {
    await evaluate(async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('markdown.toc', undefined, vscode.ConfigurationTarget.Global)
    }, [])
    await test.info().attach('task608-navigation', {
      body: JSON.stringify(run.observations, null, 2),
      contentType: 'application/json',
    })
  }
})

test('A1 Headings and Link refuse, Code and Table insert one block, at fresh-open, a seeded root caret and a root-start selection', async ({
  electronApp,
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'Requires isolated Xvfb + Openbox and VMDE_XTEST=1',
  )
  test.setTimeout(900_000)
  const evaluate = evaluateInVSCode as HostEvaluator
  const input = await createXtestInput(electronApp, workbox)
  const run = openSession(evaluate, workbox, baseDir, input)

  type Session = Awaited<ReturnType<typeof run.fresh>>

  // A refused action: no edit, no dirty state, no source-changing history entry, intact blocks.
  // `clicked` is false for the command route. A toolbar click takes an undo boundary before the
  // action runs (undo-boundaries.ts onClick). It adds no entry at a blockless range (Task 608 S4b),
  // but with no live range at all (fresh-open) the click focuses the editor and the boundary may
  // still record one caret-only checkpoint, so a click is held to "no entry that changes the
  // source" and the exact entry count is only pinned for the command, which makes no click.
  const expectRefused = async (
    { frame, file, doc }: Session,
    before: Probe,
    label: string,
    clicked = true,
  ) => {
    const after = await probe(frame)
    run.note(label, { before, after })
    expect.soft(await docText(evaluate, file), `${label}: host text`).toBe(doc)
    expect.soft(await isDirty(evaluate, file), `${label}: dirty`).toBe(false)
    expect.soft(after.value, `${label}: webview value`).toBe(before.value)
    expect
      .soft(after.historySource, `${label}: history source`)
      .toBe(before.historySource)
    expect.soft(after.redo, `${label}: redo entries`).toBe(before.redo)
    if (!clicked)
      expect.soft(after.undo, `${label}: undo entries`).toBe(before.undo)
  }

  // The block the in-block control inserts, taken from the gap route (a collapsed caret in an empty
  // top-level paragraph is the contract's in-block control). `block` is the inserted bytes.
  const controlBlock = async (tool: 'code' | 'table') => {
    const session = await run.fresh(HR_FIRST)
    await run.clickText(session.frame, 'Echo')
    await run.key(session.frame, 'ctrl+Home')
    expect((await probe(session.frame)).gaps).toBe(1)
    await run.tool(session.frame, tool)
    const host = await docText(evaluate, session.file)
    run.note(`control ${tool} (gap route)`, { host })
    expect(host.endsWith(HR_FIRST), `control ${tool} keeps the document`).toBe(
      true,
    )
    const block = host.slice(0, host.length - HR_FIRST.length)
    expect(block.length, `control ${tool} inserts a block`).toBeGreaterThan(0)
    expect((await probe(session.frame)).gaps, 'gap reclaimed').toBe(0)
    return { host, block }
  }

  // One Undo step restores the original document.
  const expectOneUndo = async (
    { frame, file, doc }: Session,
    before: Probe,
    label: string,
  ) => {
    const inserted = await probe(frame)
    expect(inserted.undo, `${label}: one history entry`).toBe(before.undo + 1)
    await run.key(frame, 'ctrl+z')
    await expect
      .poll(() => docText(evaluate, file), { message: `${label}: Undo` })
      .toBe(doc)
  }

  try {
    // ---- Controls: the same actions with an ordinary in-block caret. -------------------------
    await test.step('controls: in a block, Headings rewrites the block and Link inserts', async () => {
      for (const tool of ['headings', 'link'] as const) {
        const { frame, file } = await run.fresh(HR_FIRST)
        await run.clickText(frame, 'Alpha')
        const before = await probe(frame)
        expect(before).toMatchObject({ inEditor: true, isRoot: false })
        await run.tool(frame, tool)
        const host = await docText(evaluate, file)
        run.note(`control ${tool} (in block)`, { host })
        if (tool === 'headings')
          expect(host).toBe(HR_FIRST.replace(ALPHA, `## ${ALPHA}`))
        else expect(host).toContain('](')
      }
    })

    // ---- Fresh-open: no live range yet. -------------------------------------------------------
    // A heading-first document shows the predicted harm (the first heading's marker is rewritten);
    // a rule-first document is the subject case.
    await test.step('fresh-open: Headings, Format: Heading 2 and Link refuse', async () => {
      for (const doc of [HR_FIRST, HEADING_FIRST]) {
        for (const action of ['headings', 'chord', 'link'] as const) {
          const session = await run.fresh(doc)
          const before = await probe(session.frame)
          run.note(`fresh-open ${action} state`, { doc, before })
          if (action === 'chord')
            await run.command(session.frame, 'vmde.format.heading2')
          else await run.tool(session.frame, action)
          await expectRefused(
            session,
            before,
            `fresh-open ${action} (${doc.slice(0, 7).trim()})`,
            action !== 'chord',
          )
        }
      }
    })

    for (const tool of ['code', 'table'] as const) {
      await test.step(`fresh-open: ${tool} inserts one top-level block, one Undo`, async () => {
        const { host: control } = await controlBlock(tool)
        const session = await run.fresh(HR_FIRST)
        const before = await probe(session.frame)
        run.note(`fresh-open ${tool} state`, { before })
        await run.tool(session.frame, tool)
        const host = await docText(evaluate, session.file)
        run.note(`fresh-open ${tool}`, { host })
        expect(host).toBe(control)
        await expectOneUndo(session, before, `fresh-open ${tool}`)
      })
    }

    // ---- Seeded root caret at offset 0 (heading-first and rule-first documents). --------------
    await test.step('seeded root caret: Headings, Format: Heading 2 and Link refuse', async () => {
      for (const doc of [HEADING_FIRST, HR_FIRST]) {
        for (const action of ['headings', 'chord', 'link'] as const) {
          const session = await run.fresh(doc)
          await seedRoot(session.frame, 0)
          await frames(session.frame)
          await sleep(session.frame, QUIET_MS)
          const seeded = await probe(session.frame)
          expect(seeded, `${action}: root caret seeded`).toMatchObject({
            isRoot: true,
            rootOffset: 0,
            collapsed: true,
          })
          if (action === 'chord')
            await run.command(session.frame, 'vmde.format.heading2')
          else await run.tool(session.frame, action)
          await expectRefused(
            session,
            seeded,
            `seeded root ${action} (${doc.slice(0, 7).trim()})`,
            action !== 'chord',
          )
        }
      }
    })

    // ---- Seeded root caret: Code and Table at offset 0 and offset 1 of an HR-first document. --
    for (const tool of ['code', 'table'] as const) {
      await test.step(`seeded root caret: ${tool} inserts at offset 0 and 1, rule survives, one Undo`, async () => {
        const { host: control, block } = await controlBlock(tool)
        for (const offset of [0, 1] as const) {
          const session = await run.fresh(HR_FIRST)
          await seedRoot(session.frame, offset)
          await frames(session.frame)
          await sleep(session.frame, QUIET_MS)
          const seeded = await probe(session.frame)
          expect(seeded, `${tool}@${offset}: root caret seeded`).toMatchObject({
            isRoot: true,
            rootOffset: offset,
          })
          run.note(`seeded ${tool}@${offset} state`, {
            seeded,
          })
          await run.tool(session.frame, tool)
          const host = await docText(evaluate, session.file)
          const after = await probe(session.frame)
          run.note(`seeded ${tool}@${offset}`, { host, after })
          // The original blocks survive in order around exactly one new block; the four-hyphen rule
          // keeps its source bytes.
          const rule = '----\n\n'
          const expected =
            offset === 0
              ? control
              : `${rule}${block}${HR_FIRST.slice(rule.length)}`
          expect(host).toBe(expected)
          expect(host).toContain(rule)
          await expectOneUndo(session, seeded, `seeded ${tool}@${offset}`)
        }
      })
    }

    await test.step('seeded root caret: the code command inserts the same block as the toolbar', async () => {
      const { host: control } = await controlBlock('code')
      const session = await run.fresh(HR_FIRST)
      await seedRoot(session.frame, 0)
      await frames(session.frame)
      await sleep(session.frame, QUIET_MS)
      const seeded = await probe(session.frame)
      expect(seeded).toMatchObject({ isRoot: true, rootOffset: 0 })
      await run.command(session.frame, 'vmde.format.code')
      const host = await docText(evaluate, session.file)
      run.note('seeded code command', { host })
      expect(host).toBe(control)
      await expectOneUndo(session, seeded, 'seeded code command')
    })

    // Edge case: a Table between two paragraphs. Record the exact newline run and compare with the
    // in-block control (an empty paragraph made with Enter at the end of the first paragraph).
    await test.step('seeded root caret: Table between two paragraphs equals the in-block control', async () => {
      const controlSession = await run.fresh(PARAGRAPHS)
      await run.clickText(controlSession.frame, 'Alpha')
      await run.key(controlSession.frame, 'End')
      await run.key(controlSession.frame, 'Return')
      await run.tool(controlSession.frame, 'table')
      const control = await docText(evaluate, controlSession.file)
      run.note('table control between paragraphs', { control })

      const session = await run.fresh(PARAGRAPHS)
      await seedRoot(session.frame, 1)
      await frames(session.frame)
      await sleep(session.frame, QUIET_MS)
      const seeded = await probe(session.frame)
      expect(seeded).toMatchObject({ isRoot: true, rootOffset: 1 })
      await run.tool(session.frame, 'table')
      const host = await docText(evaluate, session.file)
      run.note('table between paragraphs', {
        host,
        newlineRuns: host.match(/\n+/g),
      })
      expect(host.startsWith(`${ALPHA}\n\n`)).toBe(true)
      expect(host.endsWith('Echo foxtrot golf hotel.\n')).toBe(true)
      expect(host).toBe(control)
      await expectOneUndo(session, seeded, 'table between paragraphs')
    })

    // ---- Selection from the document start: all four actions refuse. -------------------------
    for (const action of ['headings', 'link', 'code', 'table'] as const) {
      await test.step(`Ctrl+Shift+Home then ${action} refuses`, async () => {
        const session = await run.fresh(HR_FIRST)
        await run.clickText(session.frame, 'Echo')
        await run.key(session.frame, 'ctrl+shift+Home')
        await sleep(session.frame, QUIET_MS)
        const selected = await probe(session.frame)
        expect(selected, 'selection starts at the root').toMatchObject({
          collapsed: false,
          startIsRoot: true,
        })
        await run.tool(session.frame, action)
        await expectRefused(session, selected, `selection ${action}`)
      })
    }
  } finally {
    await test.info().attach('task608-actions', {
      body: JSON.stringify(run.observations, null, 2),
      contentType: 'application/json',
    })
  }
})
