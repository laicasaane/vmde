import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { ProductDisplayName } from '../../src/shared/product-identity'
import { docText, reopenVmdeFixture, type wf } from './webview-helpers'

// Task 646 reproduction: an external disk change of a file open in VMDE, and the stray U+200B.
// Q1: does a clean document show the new disk text? Q2: can VMDE write older text back after
// such a reload (next key, Save, Undo, Redo, held update, hidden tab)? Q3: with unsaved edits,
// does an external change silently overwrite either side? Q4: does any path write U+200B into
// the host text or the saved file? Every test asserts the CORRECT behaviour, so a failing test
// is a confirmed cause. Each test collects `problems` and asserts them together, so one run
// shows every deviation of a case instead of stopping at the first.
const FIXTURE = path.join(__dirname, 'fixtures', 'external-disk-change.md')
const ZWSP = '​'
const MODES = ['ir', 'wysiwyg', 'sv'] as const
type Mode = (typeof MODES)[number]
const EDIT_SELECTOR: Record<Mode, string> = {
  ir: '.vditor-ir',
  wysiwyg: '.vditor-wysiwyg',
  sv: '.vditor-sv',
}
const TARGET = 'EDIT-TARGET line here.'
const KEY = 'K'
const DISK_MARK = 'CHANGED ON DISK'

const original = () => readFileSync(FIXTURE, 'utf8').replace('{{ZWSP}}', ZWSP)
const changedOnDisk = (text: string) =>
  text
    .replace(
      'ALPHA-ORIGINAL paragraph that the disk change rewrites.',
      `ALPHA ${DISK_MARK} by another process.\n\nDisk-only paragraph added by the external change.`,
    )
    .replace('last line\n', 'last line\nline added on disk\n')
// Every passage the external change touched (changed, added, added inside a fence).
const DISK_PASSAGES = [
  DISK_MARK,
  'Disk-only paragraph added by the external change.',
  'line added on disk',
]
const hasDiskChange = (text: string) =>
  DISK_PASSAGES.every((p) => text.includes(p))
const missingDiskPassages = (text: string) =>
  DISK_PASSAGES.filter((p) => !text.includes(p))
const withKey = (text: string) => text.replace(TARGET, `${TARGET}${KEY}`)
const count = (text: string, needle: string) => text.split(needle).length - 1
// First differing position with the surrounding text, for failure messages.
const firstDiff = (actual: string, expected: string) => {
  let i = 0
  while (i < actual.length && i < expected.length && actual[i] === expected[i])
    i++
  const cut = (t: string) =>
    JSON.stringify(t.slice(Math.max(i - 20, 0), i + 30))
  return `first diff at ${i}: actual ${cut(actual)} expected ${cut(expected)}`
}
// Split mode rewrites a thematic break `---` as `***` on any edit (Lute's Split renderers; a
// general Split normalization, see the Task 646 record, decision D6). Map that one spelling back
// for Split comparisons so this spec proves the external-change behaviour only.
const splitRuleSpelling = (text: string) => text.replace(/^\*\*\*$/gm, '---')
const eol = (text: string) => text.replace(/\r\n/g, '\n')

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode')) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          undefined,
          vscode.ConfigurationTarget.Global,
        )
    },
    [] as [],
  )
})

async function waitUntil(
  check: () => Promise<boolean> | boolean,
  timeout: number,
): Promise<boolean> {
  const end = Date.now() + timeout
  for (;;) {
    if (await check()) return true
    if (Date.now() > end) return false
    await new Promise((r) => setTimeout(r, 200))
  }
}

type Ev = Parameters<typeof docText>[0]

async function openInMode(
  evaluateInVSCode: Ev,
  workbox: Parameters<typeof wf>[0],
  mode: Mode,
  file: string,
  readyText = 'EDIT-TARGET',
) {
  await (evaluateInVSCode as any)(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update(
          'editor.defaultMode',
          args[0],
          vscode.ConfigurationTarget.Global,
        )
    },
    [mode] as [string],
  )
  const frame = await reopenVmdeFixture(
    evaluateInVSCode,
    workbox,
    file,
    60_000,
    EDIT_SELECTOR[mode],
  )
  await expect
    .poll(() => frame.locator(EDIT_SELECTOR[mode]).first().innerText())
    .toContain(readyText)
  // task 512: retain — rendered text is not initial-layout quiescence; the undo snapshot and the
  // caret sequencing finish after it.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 1500)))
  return frame
}

// Page-level focus first (workbox.keyboard targets the top window), then a DOM selection at the
// end of the deepest element that holds `marker`.
async function caretAtEndOf(
  frame: Awaited<ReturnType<typeof openInMode>>,
  mode: Mode,
  marker: string,
) {
  await frame
    .locator(EDIT_SELECTOR[mode])
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page selection routine with a fallback for the three modes' different DOM shapes.
    (_b, a) => {
      const [selector, text] = a as [string, string]
      const root = document.querySelector(selector) as HTMLElement
      // Prefer the single text node that holds the marker (Split keeps several blocks and newline
      // spans inside one container); fall back to the end of the deepest element that holds it.
      const walkAll = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      let end = 0
      for (let n = walkAll.nextNode(); n; n = walkAll.nextNode()) {
        const at = (n.textContent ?? '').indexOf(text)
        if (at >= 0) {
          node = n as Text
          end = at + text.length
          break
        }
      }
      let el: HTMLElement | undefined
      if (!node) {
        const hits = [
          ...root.querySelectorAll<HTMLElement>(
            'p, li, h1, h2, div[data-block]',
          ),
        ].filter((e) => (e.textContent ?? '').includes(text))
        el = hits[hits.length - 1]
        if (!el) throw new Error(`no element holds ${text}`)
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if ((n.textContent ?? '').replace(/[\n\u200B]/g, '').length)
            node = n as Text
        }
        if (!node) throw new Error('no text node')
        end = (node.textContent ?? '').replace(/\n+$/, '').length
      }
      const last = node
      el = el ?? (last.parentElement as HTMLElement)
      const r = document.createRange()
      r.setStart(last, end)
      r.collapse(true)
      const s = window.getSelection()
      s?.removeAllRanges()
      s?.addRange(r)
      ;(el.closest('[contenteditable="true"]') as HTMLElement | null)?.focus()
    },
    [EDIT_SELECTOR[mode], marker] as [string, string],
  )
}

const viewText = (frame: Awaited<ReturnType<typeof openInMode>>, mode: Mode) =>
  frame.locator(EDIT_SELECTOR[mode]).first().innerText()

async function saveActive(evaluateInVSCode: Ev) {
  await (evaluateInVSCode as any)(
    async (vscode: typeof import('vscode')) => {
      await vscode.commands.executeCommand('workbench.action.files.save')
    },
    [] as [],
  )
  // negative-assertion wait: nothing observable marks "the save finished writing" for a no-op save.
  await new Promise((r) => setTimeout(r, 1200))
}

// Type one key, then Save, Undo, Redo, Save, and record every deviation from
// "file = new disk text + the key".
async function keySaveUndoRedo(
  ctx: {
    evaluateInVSCode: Ev
    workbox: Parameters<typeof wf>[0]
    frame: Awaited<ReturnType<typeof openInMode>>
    mode: Mode
    file: string
    label: string
  },
  problems: string[],
) {
  const { evaluateInVSCode, workbox, frame, mode, file, label } = ctx
  const newText = changedOnDisk(original())
  const expected = withKey(newText)
  await caretAtEndOf(frame, mode, TARGET)
  await workbox.keyboard.type(KEY, { delay: 40 })
  const landed = await waitUntil(
    async () =>
      (await docText(evaluateInVSCode, file)).includes(`${TARGET}${KEY}`),
    10_000,
  )
  const norm = (t: string) => (mode === 'sv' ? splitRuleSpelling(t) : t)
  const hostAfterKey = norm(eol(await docText(evaluateInVSCode, file)))
  console.log(
    `[${label}] key landed=${landed} hostHasDiskMark=${hostAfterKey.includes(DISK_MARK)}`,
  )
  if (!hasDiskChange(hostAfterKey))
    problems.push(
      `host text lost external passages after the key (older text written back): ${missingDiskPassages(hostAfterKey).join(' | ')}`,
    )
  if (hostAfterKey !== expected)
    problems.push(
      `host after key differs from new disk text + key (len ${hostAfterKey.length} vs ${expected.length}; ${firstDiff(hostAfterKey, expected)})`,
    )
  await saveActive(evaluateInVSCode)
  const diskAfterSave = norm(eol(readFileSync(file, 'utf8')))
  if (diskAfterSave !== expected)
    problems.push(
      `disk after Save differs from new disk text + key (hasDiskMark=${diskAfterSave.includes(DISK_MARK)}, len ${diskAfterSave.length} vs ${expected.length}; ${firstDiff(diskAfterSave, expected)})`,
    )
  if (count(diskAfterSave, ZWSP) !== 1)
    problems.push(
      `disk after Save holds ${count(diskAfterSave, ZWSP)} U+200B (expected 1, the fixture's own)`,
    )
  if (count(hostAfterKey, ZWSP) !== 1)
    problems.push(
      `host holds ${count(hostAfterKey, ZWSP)} U+200B after the key (expected 1)`,
    )

  // Undo then Redo. Let the undo checkpoint record first (undoDelay 800 ms).
  await new Promise((r) => setTimeout(r, 1200))
  await caretAtEndOf(frame, mode, TARGET)
  await workbox.keyboard.press('Control+z')
  const undone = await waitUntil(
    async () =>
      !(await docText(evaluateInVSCode, file)).includes(`${TARGET}${KEY}`),
    10_000,
  )
  const hostAfterUndo = eol(await docText(evaluateInVSCode, file))
  console.log(
    `[${label}] undone=${undone} hostHasDiskMark=${hostAfterUndo.includes(DISK_MARK)}`,
  )
  if (!undone) problems.push('Undo did not remove the key from the host text')
  if (!hasDiskChange(hostAfterUndo))
    problems.push(
      `host text lost external passages after Undo: ${missingDiskPassages(hostAfterUndo).join(' | ')}`,
    )
  await workbox.keyboard.press('Control+y')
  const redone = await waitUntil(
    async () =>
      (await docText(evaluateInVSCode, file)).includes(`${TARGET}${KEY}`),
    10_000,
  )
  const hostAfterRedo = eol(await docText(evaluateInVSCode, file))
  console.log(
    `[${label}] redone=${redone} hostHasDiskMark=${hostAfterRedo.includes(DISK_MARK)}`,
  )
  if (!redone) problems.push('Redo did not restore the key in the host text')
  await saveActive(evaluateInVSCode)
  const diskAfterRedo = norm(eol(readFileSync(file, 'utf8')))
  if (diskAfterRedo !== expected)
    problems.push(
      `disk after Undo/Redo/Save differs from new disk text + key (hasDiskMark=${diskAfterRedo.includes(DISK_MARK)}, len ${diskAfterRedo.length} vs ${expected.length}; ${firstDiff(diskAfterRedo, expected)})`,
    )
  if (count(diskAfterRedo, ZWSP) !== 1)
    problems.push(
      `disk after Redo+Save holds ${count(diskAfterRedo, ZWSP)} U+200B (expected 1)`,
    )
}

for (const mode of MODES) {
  test(`C1 clean document, visible, ${mode}: external change is shown and survives key, Save, Undo, Redo (Q1, Q2, Q4)`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(180_000)
    const dir = mkdtempSync(path.join(tmpdir(), 'vmde-646-c1-'))
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, original())
    const problems: string[] = []
    try {
      const frame = await openInMode(evaluateInVSCode, workbox, mode, file)
      writeFileSync(file, changedOnDisk(original()))
      const reloaded = await waitUntil(
        async () => (await docText(evaluateInVSCode, file)).includes(DISK_MARK),
        20_000,
      )
      expect(
        reloaded,
        'HARNESS: VS Code never reloaded the document from disk',
      ).toBe(true)
      const shown = await waitUntil(
        async () => (await viewText(frame, mode)).includes(DISK_MARK),
        20_000,
      )
      console.log(`[C1 ${mode}] view shows the disk change: ${shown}`)
      if (!shown) problems.push('Q1: the view never showed the external change')
      await keySaveUndoRedo(
        { evaluateInVSCode, workbox, frame, mode, file, label: `C1 ${mode}` },
        problems,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })

  // The file lives in the harness workspace folder: VS Code watches a file outside the workspace
  // only while its editor is visible, so a hidden tab would never see the change (decision D7).
  test(`C2 clean document, tab hidden during the change, ${mode}: shown after the tab is shown again (Q1, Q2, Q4)`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const dir = path.join(baseDir, `c2-${mode}`)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'doc.md')
    const other = path.join(dir, 'other.txt')
    writeFileSync(file, original())
    writeFileSync(other, 'another editor keeps the VMDE tab hidden\n')
    const problems: string[] = []
    try {
      await openInMode(evaluateInVSCode, workbox, mode, file)
      await (evaluateInVSCode as any)(
        async (vscode: typeof import('vscode'), args: string[]) => {
          await vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.file(args[0]),
          )
        },
        [other] as [string],
      )
      writeFileSync(file, changedOnDisk(original()))
      // VS Code may defer the reload of a hidden editor's document until it is shown again, so
      // record whether it reloaded while hidden instead of requiring it.
      const reloadedHidden = await waitUntil(
        async () => (await docText(evaluateInVSCode, file)).includes(DISK_MARK),
        8_000,
      )
      console.log(`[C2 ${mode}] host reloaded while hidden: ${reloadedHidden}`)
      await (evaluateInVSCode as any)(
        async (vscode: typeof import('vscode'), args: string[]) => {
          await vscode.commands.executeCommand(
            'vscode.openWith',
            vscode.Uri.file(args[0]),
            'vmde.editor',
          )
        },
        [file] as [string],
      )
      const frame = workbox
        .frameLocator('iframe.webview:visible')
        .frameLocator(`iframe[title="${ProductDisplayName}"], #active-frame`)
      await frame
        .locator(EDIT_SELECTOR[mode])
        .first()
        .waitFor({ timeout: 30_000 })
      const reloaded = await waitUntil(
        async () => (await docText(evaluateInVSCode, file)).includes(DISK_MARK),
        20_000,
      )
      expect(
        reloaded,
        'HARNESS: VS Code never reloaded the document from disk, even after the tab was shown',
      ).toBe(true)
      const shown = await waitUntil(
        async () => (await viewText(frame, mode)).includes(DISK_MARK),
        20_000,
      )
      console.log(
        `[C2 ${mode}] view shows the disk change after re-show: ${shown}`,
      )
      if (!shown)
        problems.push('Q1: the re-shown view never showed the external change')
      await keySaveUndoRedo(
        { evaluateInVSCode, workbox, frame, mode, file, label: `C2 ${mode}` },
        problems,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })

  test(`C3 held update, ${mode}: a key typed before the webview applies the external change never writes older text back (Q2)`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(180_000)
    const dir = mkdtempSync(path.join(tmpdir(), 'vmde-646-c3-'))
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, original())
    const problems: string[] = []
    try {
      const frame = await openInMode(evaluateInVSCode, workbox, mode, file)
      // Hold host `update` messages in the webview, so the window between "the host has the new
      // text" and "the webview applied it" stays open while a key is typed. A capture-phase
      // listener could not stop the router's own listener, so the held message is hidden at the
      // source instead: while holding, reading `MessageEvent.data` of an update yields undefined,
      // which the router ignores. Release re-dispatches the saved messages.
      await frame.locator('body').evaluate(() => {
        const w = window as any
        w.__held = []
        w.__cmds = []
        w.__hold = true
        const descriptor = Object.getOwnPropertyDescriptor(
          MessageEvent.prototype,
          'data',
        ) as PropertyDescriptor
        Object.defineProperty(MessageEvent.prototype, 'data', {
          configurable: true,
          get() {
            const value = descriptor.get?.call(this)
            if (value?.command)
              w.__cmds.push(`${value.command}${w.__hold ? '' : '+'}`)
            if (
              w.__hold &&
              value?.command === 'update' &&
              value.type !== 'init'
            ) {
              if (!w.__held.includes(value)) w.__held.push(value)
              return undefined
            }
            return value
          },
        })
      })
      writeFileSync(file, changedOnDisk(original()))
      const reloaded = await waitUntil(
        async () => (await docText(evaluateInVSCode, file)).includes(DISK_MARK),
        20_000,
      )
      expect(
        reloaded,
        'HARNESS: VS Code never reloaded the document from disk',
      ).toBe(true)
      const held = await waitUntil(
        async () =>
          (await frame
            .locator('body')
            .evaluate(() => (window as any).__held.length)) >= 1,
        10_000,
      )
      console.log(`[C3 ${mode}] update held in the webview: ${held}`)
      if (!held)
        problems.push('host never posted an update for the external change')
      const staleBeforeKey = !(await viewText(frame, mode)).includes(DISK_MARK)
      console.log(
        `[C3 ${mode}] before key: cmds=${JSON.stringify(await frame.locator('body').evaluate(() => (window as any).__cmds))} viewStillOld=${staleBeforeKey}`,
      )
      if (!staleBeforeKey)
        problems.push(
          'SETUP: the hold failed, the view already shows the external change',
        )
      await caretAtEndOf(frame, mode, TARGET)
      await workbox.keyboard.type(KEY, { delay: 40 })
      // The stale key's edit posts after the 250 ms idle debounce; give it time to reach the host.
      await waitUntil(
        async () =>
          (await docText(evaluateInVSCode, file)).includes(`${TARGET}${KEY}`),
        3_000,
      )
      const hostStale = eol(await docText(evaluateInVSCode, file))
      console.log(
        `[C3 ${mode}] host after stale key: hasAllDiskPassages=${hasDiskChange(hostStale)} missing=${JSON.stringify(missingDiskPassages(hostStale))} hasKey=${hostStale.includes(`${TARGET}${KEY}`)}`,
      )
      console.log(
        `[C3 ${mode}] stale host head=${JSON.stringify(hostStale.slice(0, 160))} cmdsAfter=${JSON.stringify(await frame.locator('body').evaluate(() => (window as any).__cmds))} view head before release=${JSON.stringify((await viewText(frame, mode)).slice(0, 120))}`,
      )
      if (!hasDiskChange(hostStale))
        problems.push(
          `Q2: the stale key made VMDE write older text over the external change (host text); missing: ${missingDiskPassages(hostStale).join(' | ')}`,
        )
      await frame.locator('body').evaluate(() => {
        const w = window as any
        w.__hold = false
        for (const d of w.__held.splice(0))
          window.dispatchEvent(new MessageEvent('message', { data: d }))
      })
      const shown = await waitUntil(
        async () => (await viewText(frame, mode)).includes(DISK_MARK),
        10_000,
      )
      console.log(
        `[C3 ${mode}] view shows the disk change after release: ${shown}`,
      )
      if (!shown)
        problems.push(
          'the view did not show the external change after the held update was released',
        )
      await saveActive(evaluateInVSCode)
      const disk = eol(readFileSync(file, 'utf8'))
      if (!hasDiskChange(disk))
        problems.push(
          `Q2: disk lost external passages (older text saved): ${missingDiskPassages(disk).join(' | ')}`,
        )
      if (count(disk, ZWSP) !== 1)
        problems.push(`disk holds ${count(disk, ZWSP)} U+200B (expected 1)`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })

  test(`C4 unsaved edits, ${mode}: an external change never silently overwrites the disk or loses the edit (Q3)`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(180_000)
    const dir = mkdtempSync(path.join(tmpdir(), 'vmde-646-c4-'))
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, original())
    const problems: string[] = []
    try {
      const frame = await openInMode(evaluateInVSCode, workbox, mode, file)
      await caretAtEndOf(frame, mode, TARGET)
      await workbox.keyboard.type(KEY, { delay: 40 })
      const dirty = await waitUntil(
        async () =>
          (await (evaluateInVSCode as any)(
            async (vscode: typeof import('vscode'), args: string[]) =>
              vscode.workspace.textDocuments.find(
                (d) => d.uri.fsPath === args[0],
              )?.isDirty ?? false,
            [file] as [string],
          )) as boolean,
        10_000,
      )
      expect(dirty, 'setup: the typed key must make the document dirty').toBe(
        true,
      )
      const external = changedOnDisk(original())
      writeFileSync(file, external)
      // negative-assertion wait: a dirty document must not be reloaded, and VMDE must not react.
      await new Promise((r) => setTimeout(r, 3000))
      const host = eol(await docText(evaluateInVSCode, file))
      console.log(
        `[C4 ${mode}] host after external change: hasKey=${host.includes(`${TARGET}${KEY}`)} hasDiskMark=${host.includes(DISK_MARK)}`,
      )
      if (!host.includes(`${TARGET}${KEY}`))
        problems.push('Q3: the unsaved edit left the host text')
      if (host.includes(DISK_MARK))
        problems.push(
          'Q3: the host text silently took the external change while dirty',
        )
      if (!(await viewText(frame, mode)).includes(`${TARGET}${KEY}`))
        problems.push('Q3: the unsaved edit left the view')
      if (eol(readFileSync(file, 'utf8')) !== eol(external))
        problems.push('Q3: the disk changed without a Save')
      // Save through the document API with a bound: VS Code's conflict handling may raise its
      // own error UI instead of resolving.
      const saved = await (evaluateInVSCode as any)(
        async (vscode: typeof import('vscode'), args: string[]) => {
          const doc = vscode.workspace.textDocuments.find(
            (d) => d.uri.fsPath === args[0],
          )
          if (!doc) return 'no-document'
          return await Promise.race([
            doc.save().then(
              (v) => `resolved:${v}`,
              (e) => `rejected:${String(e)}`,
            ),
            new Promise((r) => setTimeout(() => r('timeout'), 10_000)),
          ])
        },
        [file] as [string],
      )
      const diskAfterSave = eol(readFileSync(file, 'utf8'))
      console.log(
        `[C4 ${mode}] save outcome=${String(saved)} diskIsExternal=${diskAfterSave === eol(external)} diskHasKey=${diskAfterSave.includes(`${TARGET}${KEY}`)}`,
      )
      if (diskAfterSave !== eol(external))
        problems.push(
          `Q3: Save replaced the external disk text without the conflict prompt (outcome ${String(saved)})`,
        )
      const hostAfter = eol(await docText(evaluateInVSCode, file))
      if (!hostAfter.includes(`${TARGET}${KEY}`))
        problems.push('Q3: the unsaved edit was lost after the Save attempt')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })

  test(`C5 U+200B sweep, ${mode}: Enter at the end, caret moves across gaps and a click below the last block write no U+200B (Q4)`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(180_000)
    const dir = mkdtempSync(path.join(tmpdir(), 'vmde-646-c5-'))
    const file = path.join(dir, 'doc.md')
    writeFileSync(file, original())
    const problems: string[] = []
    try {
      const frame = await openInMode(evaluateInVSCode, workbox, mode, file)
      await caretAtEndOf(frame, mode, 'Last paragraph of the fixture.')
      await workbox.keyboard.press('Control+End')
      await workbox.keyboard.press('Enter')
      await workbox.keyboard.press('Enter')
      await workbox.keyboard.press('Control+Home')
      for (let i = 0; i < 30; i++)
        await workbox.keyboard.press('ArrowDown', { delay: 20 })
      for (let i = 0; i < 30; i++)
        await workbox.keyboard.press('ArrowUp', { delay: 20 })
      const pane = frame.locator(EDIT_SELECTOR[mode]).first()
      const box = await pane.boundingBox()
      await pane.click({
        position: { x: 40, y: Math.max((box?.height ?? 20) - 8, 4) },
      })
      await workbox.keyboard.press('Enter')
      // negative-assertion wait: nothing observable marks "no further edit will be posted".
      await new Promise((r) => setTimeout(r, 1500))
      const host = await docText(evaluateInVSCode, file)
      await saveActive(evaluateInVSCode)
      const disk = readFileSync(file, 'utf8')
      console.log(
        `[C5 ${mode}] host U+200B=${count(host, ZWSP)} disk U+200B=${count(disk, ZWSP)} hostTail=${JSON.stringify(host.slice(-60))} diskTail=${JSON.stringify(disk.slice(-60))}`,
      )
      if (count(host, ZWSP) !== 1)
        problems.push(
          `Q4: host text holds ${count(host, ZWSP)} U+200B (expected 1, the fixture's own)`,
        )
      if (count(disk, ZWSP) !== 1)
        problems.push(
          `Q4: saved file holds ${count(disk, ZWSP)} U+200B (expected 1)`,
        )
      if (!disk.includes(`before${ZWSP}after`))
        problems.push("Q4: the fixture's own U+200B was removed")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })

  test(`C6 U+200B sweep at document ends, ${mode}: ArrowDown, Enter and Ctrl+Shift+Enter after a last fence, table or list, and a paste into the fence, write no U+200B (Q4)`, async ({
    workbox,
    evaluateInVSCode,
  }) => {
    test.setTimeout(240_000)
    const dir = mkdtempSync(path.join(tmpdir(), 'vmde-646-c6-'))
    const prefix = '# C6\n\nIntro paragraph.\n\n'
    const kinds = [
      {
        name: 'fence',
        marker: 'line two',
        last: '```text\nline one\n  line two\n```\n',
      },
      {
        name: 'table',
        marker: 'beta',
        last: '| a | b |\n| - | - |\n| alpha | beta |\n',
      },
      {
        name: 'list',
        marker: 'item three',
        last: '- item one\n- item two\n- item three\n',
      },
    ]
    const problems: string[] = []
    try {
      for (const kind of kinds) {
        const file = path.join(dir, `${kind.name}.md`)
        writeFileSync(file, `${prefix}${kind.last}`)
        const frame = await openInMode(
          evaluateInVSCode,
          workbox,
          mode,
          file,
          'Intro paragraph.',
        )
        await caretAtEndOf(frame, mode, kind.marker)
        if (kind.name === 'fence') {
          await (evaluateInVSCode as any)(
            async (vscode: typeof import('vscode')) => {
              await vscode.env.clipboard.writeText('pasted line')
            },
            [] as [],
          )
          await workbox.keyboard.press('Control+v')
          // negative-assertion wait: nothing observable marks "the paste finished rendering".
          await new Promise((r) => setTimeout(r, 800))
        }
        await workbox.keyboard.press('ArrowDown')
        await workbox.keyboard.press('Enter')
        await workbox.keyboard.press('Enter')
        await workbox.keyboard.press('Control+Shift+Enter')
        // negative-assertion wait: nothing observable marks "no further edit will be posted".
        await new Promise((r) => setTimeout(r, 1500))
        const host = await docText(evaluateInVSCode, file)
        await saveActive(evaluateInVSCode)
        const disk = readFileSync(file, 'utf8')
        console.log(
          `[C6 ${mode} ${kind.name}] host U+200B=${count(host, ZWSP)} disk U+200B=${count(disk, ZWSP)} hostTail=${JSON.stringify(host.slice(-70))} diskTail=${JSON.stringify(disk.slice(-70))}`,
        )
        if (count(host, ZWSP) !== 0)
          problems.push(
            `Q4 ${kind.name}: host text holds ${count(host, ZWSP)} U+200B`,
          )
        if (count(disk, ZWSP) !== 0)
          problems.push(
            `Q4 ${kind.name}: saved file holds ${count(disk, ZWSP)} U+200B`,
          )
        if (kind.name === 'fence' && !eol(disk).includes('\n  line two'))
          problems.push(
            "Q4 fence: the fence's indented line lost its two spaces",
          )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    expect(problems).toEqual([])
  })
}
