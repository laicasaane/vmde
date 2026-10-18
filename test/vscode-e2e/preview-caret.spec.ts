import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  docText,
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  type wf,
} from './webview-helpers'

// Task 652: the editor caret and selection come back after Preview is turned off, in IR, WYSIWYG
// and Split source (tasks/done/652-restore-caret-after-preview-off.md, Acceptance 1 to 3). Every toggle
// is a real click on the toolbar Preview button, so the focus and selection behaviour of VS Code's
// own webview pipeline is what is measured.

type Frame = ReturnType<typeof wf>
type Mode = 'ir' | 'wysiwyg' | 'sv'

const FIXTURE = [
  '# Fixture preview-caret.md',
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

const PREVIEW = '.vditor-toolbar [data-type="preview"]'

// Where a measurement goes when it is only a probe: the Task 652 record reads these lines.
const probe = (label: string, value: unknown) =>
  console.log(`[preview-caret-probe] ${label} ${JSON.stringify(value)}`)

// Select text in the active edit pane. `range` anchors in the heading and focuses in the first
// paragraph (a backward selection across a paragraph into a heading); otherwise a collapsed caret
// sits inside the first paragraph. The pane is focused first, as a user would have it.
const place = (frame: Frame, range: boolean) =>
  frame.locator('body').evaluate((_body, wantRange) => {
    const v = (window as any).vditor.vditor
    const editor = v[v.currentMode].element as HTMLElement
    editor.focus()
    // Focusing a pane that holds only its start caret can arm a live caret intent (focus-restore
    // re-asserts the last tracked caret) that would overwrite a selection written from script on its
    // next frame. A user's pointer or key press retires it first, so a key event stands in for it.
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }),
    )
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    const texts: Text[] = []
    for (let n = walker.nextNode(); n; n = walker.nextNode())
      if ((n as Text).data.length > 0) texts.push(n as Text)
    // Text nodes can be split differently after an edit and its undo, so a needle is searched
    // in the pane's concatenated text and mapped back to a node and offset (never to -1).
    const whole = texts.map((t) => t.data).join('')
    const at = (needle: string, shift: number) => {
      const found = whole.indexOf(needle)
      if (found < 0)
        throw new Error(
          `place: "${needle}" not found in the ${v.currentMode} pane text ${JSON.stringify(whole)}`,
        )
      let rest = found + shift
      for (const t of texts) {
        if (rest < t.data.length) return { node: t, offset: rest }
        rest -= t.data.length
      }
      throw new Error(`place: "${needle}" +${shift} is past the pane text`)
    }
    const sel = getSelection() as Selection
    if (!wantRange) {
      const caret = at('paragraph', 4)
      sel.setBaseAndExtent(caret.node, caret.offset, caret.node, caret.offset)
      return
    }
    const anchor = at('heading', 3)
    const focus = at('one', 0)
    sel.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }, range)

// The selection as character offsets in the edit pane, its text, collapsed state, where focus is
// and the scroll position of the pane's scroller.
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
    let scroller: HTMLElement | null = editor
    while (
      scroller &&
      !(
        scroller.scrollHeight > scroller.clientHeight &&
        /auto|scroll/.test(getComputedStyle(scroller).overflowY)
      )
    )
      scroller = scroller.parentElement
    return {
      anchor: offset(sel.anchorNode, sel.anchorOffset),
      focus: offset(sel.focusNode, sel.focusOffset),
      text: sel.toString(),
      collapsed: sel.isCollapsed,
      focusInEditor: editor.contains(document.activeElement),
      scrollTop: scroller?.scrollTop ?? 0,
    }
  })

// Measure, in the webview, whether the edit pane fires `focusout` while Preview is turned on and
// off (the Task 652 handoff's open question about the collapse) and what the selection and
// `activeElement` are after each step. Probe output only; nothing here asserts.
const watchFocusout = (frame: Frame) =>
  frame.locator('body').evaluate(() => {
    const w = window as any
    w.__pcFocusouts = []
    document.addEventListener(
      'focusout',
      (e) => {
        const v = w.vditor.vditor
        const editor = v[v.currentMode].element as HTMLElement
        const sel = getSelection()
        w.__pcFocusouts.push({
          fromEditor: e.target instanceof Node && editor.contains(e.target),
          anchorOffset: sel?.anchorOffset ?? null,
          collapsed: sel?.isCollapsed ?? null,
        })
      },
      true,
    )
  })
const readFocusouts = (frame: Frame) =>
  frame.locator('body').evaluate((): unknown => {
    const w = window as any
    const log = w.__pcFocusouts
    w.__pcFocusouts = []
    return log
  })

const previewOn = (frame: Frame, on: boolean) =>
  expect
    .poll(
      () =>
        frame
          .locator('body')
          .evaluate(
            () =>
              !!(
                window as any
              ).vditor.vditor.toolbar.elements.preview.children[0].classList.contains(
                'vditor-menu--current',
              ),
          ),
      { timeout: 60_000, intervals: [250] },
    )
    .toBe(on)

// One full cycle with real clicks. While Preview shows, a selection is made in the overlay (the
// edit pane is hidden), so the restore has to beat what the overlay left behind.
async function cycle(frame: Frame, label: string, selectInOverlay: boolean) {
  await watchFocusout(frame)
  await previewOn(frame, false)
  await frame.locator(PREVIEW).click()
  await previewOn(frame, true)
  probe(`${label} focusout after on`, await readFocusouts(frame))
  if (selectInOverlay)
    await frame.locator('body').evaluate(() => {
      const preview = (window as any).vditor.vditor.preview
        .element as HTMLElement
      const text = document
        .createTreeWalker(preview, NodeFilter.SHOW_TEXT)
        .nextNode() as Text
      getSelection()?.setBaseAndExtent(text, 0, text, Math.min(4, text.length))
    })
  await frame.locator(PREVIEW).click()
  await previewOn(frame, false)
  probe(`${label} focusout after off`, await readFocusouts(frame))
  // Let the caret authority's per-frame re-assert run: a stray write would land inside this wait.
  await settle(frame, 800)
}

test('Preview on and off returns the caret and selection in IR, WYSIWYG and Split source, changes no Markdown, and survives a live setting change', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(600_000)
  await workbox.setViewportSize({ width: 1400, height: 900 })
  const file = path.join(baseDir, 'preview-caret.md')
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(
    frame,
    (state) => state.routerReady && state.editorEpoch > 0,
    { message: 'preview-caret readiness' },
  )
  const dirty = async () =>
    (await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) =>
        !!vscode.workspace.textDocuments.find((d) => d.uri.fsPath === args[0])
          ?.isDirty,
      [file] as [string],
    )) as boolean
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
      { message: `preview-caret ${mode} readiness` },
    )
  }

  try {
    // 1. IR: a range from the heading back into the first paragraph.
    await place(frame, true)
    const irBefore = await selectionState(frame)
    expect(irBefore.collapsed).toBe(false)
    expect(irBefore.focusInEditor).toBe(true)
    await cycle(frame, 'ir', true)
    expect(await selectionState(frame)).toEqual(irBefore)

    // 2. Typing lands at the restored selection; Ctrl+Z leaves the text as it was.
    await workbox.keyboard.type('Q')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .toContain('Q')
    await workbox.keyboard.press('Control+Z')
    await expect
      .poll(() => docText(evaluateInVSCode, file), { timeout: 15_000 })
      .toBe(FIXTURE)

    // 3. A live setting change re-lays the editor out; the selection still holds.
    await place(frame, true)
    const beforeSetting = await selectionState(frame)
    await cycle(frame, 'ir-setting', false)
    await setIndent(true)
    await settle(frame, 1500)
    await setIndent(false)
    await settle(frame, 1500)
    expect(await selectionState(frame)).toEqual(beforeSetting)

    // 4. WYSIWYG: a collapsed caret.
    await switchMode('wysiwyg')
    await place(frame, false)
    const wysiwygBefore = await selectionState(frame)
    expect(wysiwygBefore.collapsed).toBe(true)
    await cycle(frame, 'wysiwyg', false)
    expect(await selectionState(frame)).toEqual(wysiwygBefore)

    // 5. Split source: a range in the source pane.
    await switchMode('sv')
    await place(frame, true)
    const svBefore = await selectionState(frame)
    expect(svBefore.collapsed).toBe(false)
    await cycle(frame, 'sv', false)
    expect(await selectionState(frame)).toEqual(svBefore)

    // 6. The cycles changed nothing on disk or in the dirty state.
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE)
    await expect.poll(dirty, { timeout: 15_000 }).toBe(false)
  } finally {
    await setIndent(false)
  }
})
