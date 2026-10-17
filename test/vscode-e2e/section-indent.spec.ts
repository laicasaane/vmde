import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  closeAll,
  evalFrame,
  hostState,
  makeKit,
  openDocument,
  select,
  UNDO_LOCK_MS,
} from './helpers/shortcut-xtest-kit'
import {
  docText,
  reopenVmdeFixture,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

// Task 649 — indent each section by its heading level. The setting pair `vmde.editor.sectionIndent`
// (boolean) and `vmde.editor.sectionIndentSize` (pixels per step) is changed through VS Code's
// configuration API on an already-open editor, and the offsets are MEASURED in the real webview:
// a top-level block sits at depth x step from the content edge in WYSIWYG, IR, Split's preview pane
// and Preview. Split's source pane is never indented. Turning the setting on, resizing and turning
// it off leave the host document bytes, the dirty flag and Vditor's Undo step count untouched, and
// one Ctrl+Z after typing in an indented document restores the text in one step.

// Round-trips exactly through every mode's serializer (no blank-line or marker normalisation).
const DOC = `SiIntro paragraph before the first heading.

# SiH1

SiP1 under the first heading.

## SiH2

SiP2 under the second heading.

### SiH3

SiP3 under the third heading.

#### SiH4

SiP4 under the fourth heading.

# SiNext

SiPNext back at the top.

### SiSkip

SiPSkip after a skipped level.
`

// Token to its expected depth: a heading's depth is its level - 1, other blocks take the depth of
// the preceding heading, and a same or higher heading ends a deeper section.
const EXPECTED: ReadonlyArray<readonly [string, number]> = [
  ['SiIntro', 0],
  ['SiH1', 0],
  ['SiP1', 0],
  ['SiH2', 1],
  ['SiP2', 1],
  ['SiH3', 2],
  ['SiP3', 2],
  ['SiH4', 3],
  ['SiP4', 3],
  ['SiNext', 0],
  ['SiPNext', 0],
  ['SiSkip', 2],
  ['SiPSkip', 2],
]
const TOKENS = EXPECTED.map(([token]) => token)
const expectedOffsets = (step: number) =>
  Object.fromEntries(EXPECTED.map(([token, depth]) => [token, depth * step]))

type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'
// The surface whose top-level children carry the indentation (Split: the right-hand preview pane).
const PANE: Record<Mode, string> = {
  ir: '.vditor-ir > .vditor-reset',
  wysiwyg: '.vditor-wysiwyg > .vditor-reset',
  sv: '.vditor-preview > .vditor-reset',
  preview: '.vditor-preview > .vditor-reset',
}
const READY: Record<Mode, string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
  sv: '.vditor-sv',
  // Preview opens the IR pane hidden under the overlay: attached, not visible.
  preview: '.vditor-ir',
}
// Split's preview pane is only about 165 px wide in the test window and one step is capped at 40%
// of the pane (about 66 px), so the deepest depth here (3) must stay below that: 3 x 20 = 60.
const STEP = 12
const STEP_2 = 20

type Evaluate = Parameters<typeof reopenVmdeFixture>[0]

// `null` clears the key (back to its default); an absent key leaves it alone. The evaluator cannot
// carry `null` across the process boundary, so the settings travel as one JSON string.
interface Settings {
  sectionIndent?: boolean | null
  sectionIndentSize?: number | null
  defaultMode?: string | null
}

async function applySettings(evaluate: Evaluate, settings: Settings) {
  await evaluate(
    async (vscode: typeof import('vscode'), args: [string]) => {
      const s = JSON.parse(args[0]) as Settings
      const global = vscode.ConfigurationTarget.Global
      const config = vscode.workspace.getConfiguration('vmde')
      const value = <T>(v: T | null) => (v === null ? undefined : v)
      if (s.defaultMode !== undefined)
        await config.update('editor.defaultMode', value(s.defaultMode), global)
      if (s.sectionIndent !== undefined)
        await config.update(
          'editor.sectionIndent',
          value(s.sectionIndent),
          global,
        )
      if (s.sectionIndentSize !== undefined)
        await config.update(
          'editor.sectionIndentSize',
          value(s.sectionIndentSize),
          global,
        )
    },
    [JSON.stringify(settings)],
  )
}

test.afterEach(async ({ evaluateInVSCode }) => {
  await applySettings(evaluateInVSCode as Evaluate, {
    sectionIndent: null,
    sectionIndentSize: null,
    defaultMode: null,
  })
})

type Frame = ReturnType<typeof wf>

const measure = (frame: Frame, mode: Mode, tokens: readonly string[]) =>
  frame.locator('body').evaluate(
    (_body, [pane, list]) => {
      const root = document.querySelector(pane) as HTMLElement | null
      if (!root) return null
      const style = getComputedStyle(root)
      const left =
        root.getBoundingClientRect().left +
        Number.parseFloat(style.paddingLeft) +
        Number.parseFloat(style.borderLeftWidth)
      const norm = (text: string) => text.replace(/[​\s]+/g, ' ')
      const out: Record<string, number | null> = {}
      for (const token of list) {
        const el = Array.from(root.children).find((child) =>
          norm(child.textContent ?? '').includes(token),
        )
        out[token] = el
          ? Math.round((el.getBoundingClientRect().left - left) * 100) / 100
          : null
      }
      return out
    },
    [PANE[mode], tokens] as const,
  )

// Left edge of the first source-pane text node that holds the token (Split only).
const sourceLeft = (frame: Frame, token: string) =>
  frame.locator('body').evaluate((_body, needle) => {
    const sv = document.querySelector('.vditor-sv')
    if (!sv) return null
    const walker = document.createTreeWalker(sv, NodeFilter.SHOW_TEXT)
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!(node.textContent ?? '').includes(needle)) continue
      const range = document.createRange()
      range.selectNodeContents(node)
      return Math.round(range.getBoundingClientRect().left * 100) / 100
    }
    return null
  }, token)

const marks = (frame: Frame) =>
  frame.locator('body').evaluate(() => ({
    all: document.querySelectorAll('[data-vmde-indent]').length,
    roots: document.querySelectorAll('[data-vmde-indent-root]').length,
    source: document.querySelectorAll(
      '.vditor-sv [data-vmde-indent], .vditor-sv[data-vmde-indent-root]',
    ).length,
    body: document.body.getAttribute('data-section-indent'),
    step: document.body.style.getPropertyValue('--vmde-section-indent-step'),
  }))

const undoDepth = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const inner = (
      window as unknown as {
        vditor?: {
          vditor?: {
            currentMode?: string
            undo?: Record<string, { undoStack?: unknown[] } | undefined>
          }
        }
      }
    ).vditor?.vditor
    const mode = inner?.currentMode
    return mode ? (inner?.undo?.[mode]?.undoStack?.length ?? -1) : -1
  })

const dirtyState = (evaluate: Evaluate, file: string) =>
  evaluate(
    async (vscode: typeof import('vscode'), args: [string]) =>
      vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
        ?.isDirty ?? null,
    [file],
  ) as Promise<boolean | null>

async function openIn(
  evaluate: Evaluate,
  workbox: import('@playwright/test').Page,
  file: string,
  mode: Mode,
): Promise<Frame> {
  await applySettings(evaluate, { defaultMode: mode })
  const frame = (await reopenVmdeFixture(
    evaluate,
    workbox,
    file,
    60_000,
    READY[mode],
    false,
  )) as Frame
  await frame
    .locator(READY[mode])
    .first()
    .waitFor({
      state: mode === 'preview' ? 'attached' : 'visible',
      timeout: 60_000,
    })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode !== null,
    { message: `Task 649 ${mode} readiness`, timeout: 60_000 },
  )
  // Preview and Split render their pane after the editor is ready.
  await expect
    .poll(() => measure(frame, mode, ['SiH4']).then((m) => m?.SiH4 ?? null), {
      message: `${mode} pane rendered`,
      timeout: 30_000,
    })
    .not.toBeNull()
  await waitForInitialUndoSnapshot(frame)
  return frame
}

test('section indentation: offsets, live size change, off restores the layout, nothing else changes', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(900_000)
  const evaluate = evaluateInVSCode as Evaluate
  const file = path.join(baseDir, 'section-indent.md')
  writeFileSync(file, DOC)

  for (const mode of ['wysiwyg', 'ir', 'sv', 'preview'] as const) {
    await applySettings(evaluate, {
      sectionIndent: false,
      sectionIndentSize: null,
    })
    const frame = await openIn(evaluate, workbox, file, mode)
    const label = (what: string) => `${mode}: ${what}`

    // Setting off (default): every block is at depth 0 and nothing is marked.
    const off = await measure(frame, mode, TOKENS)
    expect(off, label('off baseline')).toEqual(expectedOffsets(0))
    expect(await marks(frame), label('off marks')).toMatchObject({
      all: 0,
      roots: 0,
      body: '0',
    })
    const sourceBefore = mode === 'sv' ? await sourceLeft(frame, 'SiH3') : null
    const depthBefore = await undoDepth(frame)
    expect(depthBefore, label('undo stack read')).toBeGreaterThanOrEqual(1)

    // On, live: offsets are depth x step.
    await applySettings(evaluate, {
      sectionIndent: true,
      sectionIndentSize: STEP,
    })
    await expect
      .poll(() => measure(frame, mode, TOKENS), {
        message: label(`offsets = depth x ${STEP}`),
        timeout: 30_000,
      })
      .toEqual(expectedOffsets(STEP))
    const on = await marks(frame)
    expect(on.body, label('body flag')).toBe('1')
    expect(on.step, label('step variable')).toBe(`${STEP}px`)
    expect(on.all, label('marked blocks')).toBeGreaterThan(0)

    // Size change, live: every depth rescales (depth x 20).
    await applySettings(evaluate, { sectionIndentSize: STEP_2 })
    await expect
      .poll(() => measure(frame, mode, TOKENS), {
        message: label(`offsets = depth x ${STEP_2}`),
        timeout: 30_000,
      })
      .toEqual(expectedOffsets(STEP_2))
    expect((await marks(frame)).step, label('new step variable')).toBe(
      `${STEP_2}px`,
    )

    // Split's source pane is never indented, with the setting on.
    if (mode === 'sv') {
      expect((await marks(frame)).source, label('source pane marks')).toBe(0)
      expect(await sourceLeft(frame, 'SiH3'), label('source pane x')).toBe(
        sourceBefore,
      )
    }

    // Display only while on: host bytes, dirty flag and Undo step count.
    expect(await docText(evaluate, file), label('bytes while on')).toBe(DOC)
    expect(await dirtyState(evaluate, file), label('dirty while on')).toBe(
      false,
    )
    expect(await undoDepth(frame), label('undo steps while on')).toBe(
      depthBefore,
    )

    // Off, live: the layout is today's again and every mark is gone.
    await applySettings(evaluate, { sectionIndent: false })
    await expect
      .poll(() => measure(frame, mode, TOKENS), {
        message: label('offsets back to 0'),
        timeout: 30_000,
      })
      .toEqual(off)
    expect(await marks(frame), label('marks after off')).toMatchObject({
      all: 0,
      roots: 0,
      body: '0',
    })
    if (mode === 'sv')
      expect(await sourceLeft(frame, 'SiH3'), label('source x after off')).toBe(
        sourceBefore,
      )
    expect(await docText(evaluate, file), label('bytes after off')).toBe(DOC)
    expect(await dirtyState(evaluate, file), label('dirty after off')).toBe(
      false,
    )
    expect(await undoDepth(frame), label('undo steps after off')).toBe(
      depthBefore,
    )
  }
})

// One Ctrl+Z (OS-level XTEST key) after typing in an indented document removes the typed text in
// one step, host and view, and the indentation survives the Undo. Needs a window manager.
test.describe('section indentation with OS-level keys', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('ir: typing then one Ctrl+Z restores the text in one step, indentation intact', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const evaluate = evaluateInVSCode as Evaluate
    await applySettings(evaluate, {
      sectionIndent: true,
      sectionIndentSize: STEP,
    })
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      'Task 649 undo',
    )
    const ctx = await openDocument(kit, 'section-indent-undo.md', DOC, 'ir')
    try {
      const frame = kit.frame() as Frame
      await waitForInitialUndoSnapshot(frame)
      await expect
        .poll(() => measure(frame, 'ir', TOKENS), {
          message: 'indented before typing',
          timeout: 30_000,
        })
        .toEqual(expectedOffsets(STEP))
      const viewBefore = await evalFrame(
        kit,
        () => (window as any).vditor.getValue() as string,
        0,
      )
      const depthBefore = await undoDepth(frame)

      // Caret at the end of a paragraph under an indented heading; fast typing is one history entry.
      await select(ctx, 'SiP3', { collapsed: true, offset: 'SiP3'.length })
      await kit.xtest.type('QX', 30)
      await expect
        .poll(async () => (await hostState(ctx)).text ?? '', {
          message: 'host holds the typed text',
          timeout: 15_000,
        })
        .toContain('QX')
      expect(await dirtyState(evaluate, ctx.file)).toBe(true)
      // Vditor records the entry undoDelay (800 ms) after the last key.
      await kit.workbox.waitForTimeout(UNDO_LOCK_MS)
      expect(await undoDepth(frame), 'typing recorded one entry').toBe(
        depthBefore + 1,
      )
      await expect
        .poll(() => measure(frame, 'ir', TOKENS), {
          message: 'still indented after typing',
          timeout: 15_000,
        })
        .toEqual(expectedOffsets(STEP))

      await kit.xtest.key('ctrl+z')
      await expect
        .poll(async () => (await hostState(ctx)).text, {
          message: 'one Ctrl+Z restores the host text',
          timeout: 15_000,
        })
        .toBe(DOC)
      expect((await hostState(ctx)).dirty, 'clean after Undo').toBe(false)
      expect(
        await evalFrame(kit, () => (window as any).vditor.getValue(), 0),
        'view restored',
      ).toBe(viewBefore)
      await expect
        .poll(() => measure(frame, 'ir', TOKENS), {
          message: 'indented after Undo',
          timeout: 15_000,
        })
        .toEqual(expectedOffsets(STEP))
    } finally {
      await closeAll(kit, ctx.file).catch(() => undefined)
    }
  })
})
