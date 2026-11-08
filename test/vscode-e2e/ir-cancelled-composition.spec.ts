// Task 711 — a cancelled IME composition must not reformat the document in IR or WYSIWYG.
//
// With an input method such as IBus, Ctrl+Shift+U followed by Escape cancels a composition: the
// input method sends an empty composition update, an input event and `compositionend` with empty
// data, and the editor text is unchanged. Vditor's IR and WYSIWYG `compositionend` listeners called
// `input()` anyway, which rebuilt the block and posted the whole-document serialization, so the
// large fixture (which does not round-trip byte for byte) became dirty and was rewritten in Lute's
// form (measured before the fix: IR 174517 to 181855 characters, first difference at 66).
//
// The XTEST environment runs no input method (Task 698), so these tests drive the composition
// through Chromium's own IME path with CDP `Input.imeSetComposition` (an empty text cancels it) and
// `Input.insertText` (commits it), into the focused webview. The cancelled composition must leave the
// host text exact and clean; a committed composition must still edit.
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import {
  reopenVmdeFixture,
  settle,
  waitForE2EReadiness,
  waitForInitialUndoSnapshot,
  type wf,
} from './webview-helpers'

const FIXTURE = readFileSync(
  path.join(__dirname, 'fixtures/large-observable-models-synthetic.md'),
  'utf8',
)
// A plain-prose word that occurs once; the caret goes after it, as in the measured IBus repro.
const NEEDLE = 'ldzwcwrn'
// Longer than Vditor's input debounce and undo delay, so a posted edit has reached the host.
const POST_WINDOW_MS = 2_500

type Evaluate = (fn: unknown, args: string[]) => Promise<unknown>
type Mode = 'ir' | 'wysiwyg'
type Page = import('@playwright/test').Page

async function hostState(evaluateInVSCode: Evaluate, file: string) {
  return (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return { text: doc?.getText() ?? '', dirty: doc?.isDirty === true }
    },
    [file] as [string],
  )) as { text: string; dirty: boolean }
}

async function openFixture(
  evaluateInVSCode: Evaluate,
  workbox: Page,
  baseDir: string,
  name: string,
  mode: Mode,
) {
  const file = path.join(baseDir, name)
  writeFileSync(file, FIXTURE)
  const frame = await reopenVmdeFixture(evaluateInVSCode, workbox, file)
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
    { timeout: 90_000, message: `${name} IR readiness` },
  )
  if (mode === 'wysiwyg') {
    await frame.locator('.vditor-toolbar [data-type="edit-mode"]').click()
    await frame.locator('button[data-mode="wysiwyg"]').click()
    await waitForE2EReadiness(frame, (state) => state.mode === 'wysiwyg', {
      timeout: 90_000,
      message: `${name} WYSIWYG readiness`,
    })
  }
  await waitForInitialUndoSnapshot(frame)
  await settle(frame, POST_WINDOW_MS)
  // Preconditions: opening (and the mode switch) left the host exact, and the fixture is not byte
  // stable under Lute's IR round trip, so a whole-document serialization would show in the host.
  expect(await hostState(evaluateInVSCode, file)).toEqual({
    text: FIXTURE,
    dirty: false,
  })
  const roundTrip = await frame.locator('body').evaluate((_body, md) => {
    const lute = (
      window as unknown as {
        vditor: {
          vditor: {
            lute: {
              Md2VditorIRDOM(md: string): string
              VditorIRDOM2Md(html: string): string
            }
          }
        }
      }
    ).vditor.vditor.lute
    return lute.VditorIRDOM2Md(lute.Md2VditorIRDOM(md))
  }, FIXTURE)
  expect(roundTrip).not.toBe(FIXTURE)
  return { file, frame }
}

/**
 * Focuses the mode's editable with a real click, puts the caret after NEEDLE and starts a native
 * composition of "u" there (as Ctrl+Shift+U does). `commit` empty cancels it with an empty
 * composition; otherwise the text is committed. Returns the composition events seen and whether
 * the caret block survived and the editor text changed.
 */
async function compose(
  workbox: Page,
  frame: ReturnType<typeof wf>,
  mode: Mode,
  commit: string,
) {
  const selector = `.vditor-${mode}`
  await frame
    .locator(selector)
    .first()
    .click({ position: { x: 8, y: 8 } })
  await frame.locator('body').evaluate(
    (_body, [selector, needle]) => {
      const editor = document.querySelector<HTMLElement>(selector)!
      const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
      let node: Text | null = null
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.textContent ?? '').includes(needle)) {
          node = n as Text
          break
        }
      }
      if (!node) throw new Error(`caret anchor not found in ${selector}`)
      const range = document.createRange()
      range.setStart(node, node.data.indexOf(needle) + needle.length)
      const selection = getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const probe = {
        before: editor.textContent,
        block: node.parentElement!.closest('[data-block="0"]'),
        events: [] as string[],
      }
      ;(window as unknown as { __task711: typeof probe }).__task711 = probe
      for (const type of ['compositionstart', 'compositionend'])
        document.addEventListener(
          type,
          (event) =>
            probe.events.push(`${type}:${(event as CompositionEvent).data}`),
          { capture: true, once: true },
        )
    },
    [selector, NEEDLE] as [string, string],
  )
  const cdp = await workbox.context().newCDPSession(workbox)
  try {
    await cdp.send('Input.imeSetComposition', {
      text: 'u',
      selectionStart: 1,
      selectionEnd: 1,
    })
    if (commit) await cdp.send('Input.insertText', { text: commit })
    else
      await cdp.send('Input.imeSetComposition', {
        text: '',
        selectionStart: 0,
        selectionEnd: 0,
      })
  } finally {
    await cdp.detach()
  }
  return frame.locator('body').evaluate((_body, selector) => {
    const editor = document.querySelector<HTMLElement>(selector)!
    const probe = (
      window as unknown as {
        __task711: { before: string; block: Element | null; events: string[] }
      }
    ).__task711
    return {
      events: probe.events,
      blockRebuilt: !probe.block?.isConnected,
      textChanged: editor.textContent !== probe.before,
    }
  }, selector)
}

async function revertAndClose(evaluateInVSCode: Evaluate, file: string) {
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const doc = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      if (doc?.isDirty)
        await vscode.commands.executeCommand('workbench.action.files.revert')
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
    },
    [file] as [string],
  )
}

function cancelledCompositionTest(mode: Mode) {
  test(`${mode}: a cancelled composition leaves the host text exact and clean`, async ({
    workbox,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(180_000)
    const { file, frame } = await openFixture(
      evaluateInVSCode as Evaluate,
      workbox,
      baseDir,
      `cancelled-${mode}.md`,
      mode,
    )
    try {
      const result = await compose(workbox, frame, mode, '')
      await settle(frame, POST_WINDOW_MS)
      const host = await hostState(evaluateInVSCode as Evaluate, file)
      expect({
        ...result,
        hostExact: host.text === FIXTURE,
        hostLength: host.text.length,
        dirty: host.dirty,
      }).toEqual({
        events: ['compositionstart:', 'compositionend:'],
        blockRebuilt: false,
        textChanged: false,
        hostExact: true,
        hostLength: FIXTURE.length,
        dirty: false,
      })
    } finally {
      await revertAndClose(evaluateInVSCode as Evaluate, file)
    }
  })
}

// IR first; WYSIWYG last, so its mode switch cannot leave a remembered mode for the IR tests.
cancelledCompositionTest('ir')

test('ir: a committed composition still edits the document', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(180_000)
  const { file, frame } = await openFixture(
    evaluateInVSCode as Evaluate,
    workbox,
    baseDir,
    'committed-ir.md',
    'ir',
  )
  try {
    const result = await compose(workbox, frame, 'ir', 'X')
    expect(result.events).toEqual(['compositionstart:', 'compositionend:X'])
    expect(result.textChanged).toBe(true)
    await expect
      .poll(
        async () => {
          const host = await hostState(evaluateInVSCode as Evaluate, file)
          return host.dirty && host.text.includes(`${NEEDLE}X `)
        },
        { timeout: 15_000 },
      )
      .toBe(true)
  } finally {
    await revertAndClose(evaluateInVSCode as Evaluate, file)
  }
})

cancelledCompositionTest('wysiwyg')
