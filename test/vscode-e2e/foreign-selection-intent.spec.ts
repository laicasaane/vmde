import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 664: a deliberate VMDE selection write retires a stale caret intent, while an unmarked write
// (the shape of Vditor's own undo and spin churn) is still overridden by the caret authority. The
// stale intent is armed through the window bridge `__vmdeRequestCaret`, the deliberate write goes
// through `__vmdeWriteSelection`, and a live setting change re-lays the editor out afterwards, as
// in the Task 649 observation (tasks/664-foreign-selection-retires-stale-caret-intent.md).

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'

const FIXTURE = [
  '# Fixture foreign-selection-intent.md',
  '',
  'Alpha paragraph one two three.',
  '',
  'Beta paragraph four five six.',
  '',
  '## Second heading',
  '',
  'Gamma paragraph seven eight nine.',
  '',
].join('\n')

type Write = 'marked' | 'unmarked'

// Arm a stale collapsed intent at text offset 10, then write a 9-character range inside "Beta
// paragraph" with the given kind of write. A key event first retires whatever intent focusing the
// pane armed, as a user's key press would.
const armAndWrite = (frame: Frame, write: Write) =>
  frame.locator('body').evaluate((_body, kind) => {
    const w = window as any
    const v = w.vditor.vditor
    const editor = v[v.currentMode].element as HTMLElement
    editor.focus()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
    )
    if (kind === 'marked' && typeof w.__vmdeWriteSelection !== 'function')
      throw new Error('window.__vmdeWriteSelection is not installed')
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if ((n as Text).data.length > 0) texts.push(n as Text)
    const whole = texts.map((t) => t.data).join('')
    const locate = (target: number) => {
      let rest = target
      for (const t of texts) {
        if (rest < t.data.length) return { node: t, offset: rest }
        rest -= t.data.length
      }
      throw new Error(`offset ${target} is past the pane text`)
    }
    const found = whole.indexOf('Beta paragraph')
    if (found < 0)
      throw new Error(`"Beta paragraph" not found in ${JSON.stringify(whole)}`)
    w.__vmdeRequestCaret({ textOffset: 10 })
    const start = locate(found + 5)
    const end = locate(found + 14)
    const range = document.createRange()
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)
    if (kind === 'marked') {
      w.__vmdeWriteSelection(range)
    } else {
      const sel = getSelection() as Selection
      sel.removeAllRanges()
      sel.addRange(range)
    }
  }, write)

// The selection as character offsets in the edit pane, plus its text and collapsed state.
const selectionState = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const v = (window as any).vditor.vditor
    const editor = v[v.currentMode].element as HTMLElement
    const sel = getSelection() as Selection
    const offset = (node: Node | null, o: number) => {
      if (!node || !editor.contains(node)) return null
      const r = document.createRange()
      r.selectNodeContents(editor)
      r.setEnd(node, o)
      return r.toString().length
    }
    return {
      anchor: offset(sel.anchorNode, sel.anchorOffset),
      focus: offset(sel.focusNode, sel.focusOffset),
      text: sel.toString(),
      collapsed: sel.isCollapsed,
    }
  })

async function open(
  workbox: import('@playwright/test').Page,
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  baseDir: string,
) {
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const file = path.join(baseDir, 'foreign-selection-intent.md')
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'foreign-selection-intent readiness' },
  )
  const setIndent = async (on: boolean) =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: [string]) => {
        await vscode.workspace
          .getConfiguration('vmde')
          .update(
            'editor.sectionIndent',
            args[0] === 'true' ? true : undefined,
            vscode.ConfigurationTarget.Global,
          )
      },
      [String(on)] as [string],
    )
  const switchMode = async (mode: Mode) => {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame
      .locator('.vditor-toolbar')
      .locator(`button[data-mode="${mode}"]`)
      .click()
    await waitForE2EReadiness(
      frame,
      (state) => state.routerReady && state.mode === mode,
      { message: `foreign-selection-intent ${mode} readiness` },
    )
  }
  return { frame, setIndent, switchMode }
}

const MODES: readonly Mode[] = ['ir', 'wysiwyg', 'sv']

// Acceptance 2: the marked write is not undone by the stale intent, in the frames after it or by
// the re-layout a live setting change causes.
test('a marked selection write survives a stale caret intent and a live setting change', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const { frame, setIndent, switchMode } = await open(
    workbox,
    evaluateInVSCode,
    baseDir,
  )
  try {
    for (const mode of MODES) {
      if (mode !== 'ir') await switchMode(mode)
      await armAndWrite(frame, 'marked')
      const written = await selectionState(frame)
      expect(written.collapsed, `${mode} written`).toBe(false)
      expect(written.text, `${mode} written`).toBe('paragraph')
      await settle(frame, 500)
      expect(await selectionState(frame), `${mode} after frames`).toEqual(
        written,
      )
      await setIndent(true)
      await settle(frame, 1500)
      await setIndent(false)
      await settle(frame, 1500)
      expect(await selectionState(frame), `${mode} after setting`).toEqual(
        written,
      )
    }
  } finally {
    await setIndent(false)
  }
})

// Acceptance 3: an unmarked write is what Vditor's undo and spin writes look like to the authority,
// so the live intent still overrides it.
test('an unmarked selection write is still overridden by a live caret intent', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  const { frame, switchMode } = await open(workbox, evaluateInVSCode, baseDir)
  for (const mode of MODES) {
    if (mode !== 'ir') await switchMode(mode)
    await armAndWrite(frame, 'unmarked')
    await settle(frame, 500)
    const after = await selectionState(frame)
    expect(after.collapsed, `${mode} overridden`).toBe(true)
    expect(after.anchor, `${mode} overridden`).toBe(10)
  }
})
