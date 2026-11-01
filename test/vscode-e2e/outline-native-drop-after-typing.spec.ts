/**
 * Task 668 — a native outline tree drop while typing is still pending.
 *
 * The outline tree names the dragged and target headings by offsets in the host text. Typing inside
 * Vditor's edit debounce reaches the host only when the webview publishes it for the move, which can
 * shift those offsets before the webview resolves them. The contract: the drop either moves the
 * sections it named, on the text the host then holds, or it moves nothing.
 *
 * Both cases drive the native drop through the extension's test seam inside one host call, right
 * after real OS-level typing, and check as an instrument condition that the host still held the
 * text from before the typing at drop time. Only lengths, short hashes and changed intervals are
 * printed, never document text.
 */
import { createHash } from 'node:crypto'
import { expect, test } from 'vscode-test-playwright'
import {
  type Ctx,
  closeAll,
  disposeObservers,
  endSelectionGesture,
  evalFrame,
  hostText,
  makeKit,
  openDocument,
  QUIET_MS,
  select,
  spyMark,
  spySince,
} from './helpers/shortcut-xtest-kit'
import {
  moveMarkdownSection,
  scanSourceHeadings,
} from '../../src/shared/section-move'

const section = (name: string, body: string) => `# ${name}\n\n${body}\n\n`
const INTRO = 'introword\n\n'
const SECTION_A = section('A', 'a')
const SECTION_B = section('B', 'b')
const SECTION_C = section('C', 'c')
const SECTION_D = '# D\n\ndword\n'
const DOCUMENT = `${INTRO}${SECTION_A}${SECTION_B}${SECTION_C}${SECTION_D}`
// Eight characters are exactly one section (A, B and C are eight bytes each): typed above the
// headings they shift every heading offset onto the previous section's heading.
const TYPED = '12345678'
const CHARACTER_DELAY_MS = 20

const fingerprint = (text: string | null) =>
  text === null
    ? null
    : {
        length: text.length,
        sha: createHash('sha256').update(text).digest('hex').slice(0, 12),
      }

const insertAt = (text: string, token: string, offset: number) => {
  const at = text.indexOf(token) + offset
  return `${text.slice(0, at)}${TYPED}${text.slice(at)}`
}

const hostBecomes = (ctx: Ctx, predicate: (text: string) => boolean) =>
  expect
    .poll(async () => predicate((await hostText(ctx)) ?? ''), {
      timeout: 15_000,
    })
    .toBe(true)

async function waitForOutlineRows(ctx: Ctx) {
  await ctx.kit.host(async (vscode) => {
    const api = vscode.extensions.getExtension('Laicasaane.vmde')
      ?.exports as any
    if (!api?.outlineProvider || !api?.outlineDragAndDrop)
      throw new Error('outline test seam is unavailable')
    const deadline = Date.now() + 15_000
    while (api.outlineProvider.getChildren().length < 4) {
      if (Date.now() > deadline) throw new Error('outline tree never filled')
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }, [])
}

// Types into the editor, then drops section D before section B through the native tree in the same
// host call. The host text it reads right before the drop is the instrument condition.
async function typeThenDrop(ctx: Ctx, token: string) {
  await select(ctx, token, { collapsed: true, offset: 2 })
  await endSelectionGesture(ctx)
  // Host messages the webview receives from here on (the installed message spy of the editor).
  const mark = await spyMark(ctx.kit)
  await ctx.kit.xtest.type(TYPED, CHARACTER_DELAY_MS)
  const typedInEditor = await evalFrame(
    ctx.kit,
    (_body, needle: string) =>
      ((window as any).vditor.getValue() as string).includes(needle),
    TYPED,
  )
  const atDrop = await ctx.kit.host(
    async (vscode, [fsPath]: [string]) => {
      const api = vscode.extensions.getExtension('Laicasaane.vmde')
        ?.exports as any
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.fsPath === fsPath,
      )
      const rows = api.outlineProvider.getChildren()
      const [, sectionB, , sectionD] = rows
      const data = new vscode.DataTransfer()
      const cancel = new vscode.CancellationTokenSource().token
      await api.outlineDragAndDrop.handleDrag([sectionD], data, cancel)
      const text = document?.getText() ?? null
      await api.outlineDragAndDrop.handleDrop(sectionB, data, cancel)
      return text
    },
    [ctx.file],
  )
  return { typedInEditor, atDrop, mark }
}

const receivedCommands = async (ctx: Ctx, mark: number) =>
  (await spySince(ctx.kit, mark)).map((message) => message.command)

async function settledHostText(ctx: Ctx, changed: (text: string) => boolean) {
  await hostBecomes(ctx, changed)
  // The move, when there is one, arrives within the webview's publish and apply round trip.
  await ctx.kit.workbox.waitForTimeout(QUIET_MS)
  return (await hostText(ctx)) ?? ''
}

test.describe('Task 668 native outline drop while typing is pending (OS-level XTEST)', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test('ir: a native outline drop while typing is pending is refused when the typing moved the headings', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      '668-shifted',
    )
    const ctx = await openDocument(
      kit,
      'outline-drop-shifted-ir.md',
      DOCUMENT,
      'ir',
    )
    try {
      await waitForOutlineRows(ctx)
      const { typedInEditor, atDrop, mark } = await typeThenDrop(
        ctx,
        'introword',
      )
      // Instrument: the typing was in the editor and the host had not received it at drop time.
      expect(typedInEditor, 'typing never reached the editor').toBe(true)
      expect(atDrop, 'host changed before the drop').toBe(DOCUMENT)

      const typed = insertAt(DOCUMENT, 'introword', 2)
      const after = await settledHostText(ctx, (text) => text !== DOCUMENT)
      console.log(
        '[668 shifted]',
        JSON.stringify({
          typed: fingerprint(typed),
          after: fingerprint(after),
        }),
      )
      // The typing is published and nothing else moved: the stale offsets named other headings.
      expect(after).toBe(typed)
      // Not a silent no-op: the drop reached the webview, which pulled the typed text and then
      // refused, so the host never prepared a move.
      const received = await receivedCommands(ctx, mark)
      expect(received, 'the drop never reached the webview').toContain(
        'move-outline-section',
      )
      expect(received).not.toContain('prepare-outline-section-move')
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
  })

  test('ir: a native outline drop while typing is pending still moves when the headings did not move', async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const kit = await makeKit(
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
      '668-unshifted',
    )
    const ctx = await openDocument(
      kit,
      'outline-drop-unshifted-ir.md',
      DOCUMENT,
      'ir',
    )
    try {
      await waitForOutlineRows(ctx)
      const { typedInEditor, atDrop, mark } = await typeThenDrop(ctx, 'dword')
      expect(typedInEditor, 'typing never reached the editor').toBe(true)
      expect(atDrop, 'host changed before the drop').toBe(DOCUMENT)

      // The typing is inside section D, after every heading offset the drop names.
      const typed = insertAt(DOCUMENT, 'dword', 2)
      const headings = scanSourceHeadings(typed)
      const moved = moveMarkdownSection(
        typed,
        headings[3],
        headings[1],
        'before',
      )
      expect(moved.status).toBe('ok')
      const expected = moved.status === 'ok' ? moved.markdown : ''
      const after = await settledHostText(ctx, (text) => text !== DOCUMENT)
      console.log(
        '[668 unshifted]',
        JSON.stringify({
          expected: fingerprint(expected),
          after: fingerprint(after),
        }),
      )
      expect(after).toBe(expected)
      expect(await receivedCommands(ctx, mark)).toContain(
        'prepare-outline-section-move',
      )
    } finally {
      await disposeObservers(kit)
      await closeAll(kit, ctx.file)
    }
  })
})
