import { waitForE2EReadiness, wf } from './webview-helpers'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// NET/PROBE (task 190 P0) — switching edit modes must not corrupt or lose content (J16).
// Vditor serializes differently per mode (VditorIRDOM2Md / VditorDOM2Md / raw textContent),
// so an ir → wysiwyg → sv → ir round-trip re-parses the document three times. On the
// canonical torture fixture (normalized so there's nothing for Lute to "fix") the return to
// IR must reproduce the original serialization byte-for-byte, and every hop must keep the
// content intact. No coverage existed for the mode-switch journey before this.
const SRC = path.join(__dirname, 'fixtures', 'torture.md')
// Format-INDEPENDENT anchors: each serializer (ir/wysiwyg/sv) may pad a table row's pipes
// differently, so we check cell/prose/code CONTENT, not a literal `| Alpha | 1 |` row. The
// exact-bytes guarantee is the ir1 === ir0 assertion below, not these.
const ANCHORS = [
  'ALPHA',
  'BRAVO',
  'ZULU',
  'Alpha',
  'Beta',
  'const answer = 42',
  'First bullet',
  'Step one',
]

test('ir → wysiwyg → sv → ir preserves the document (round-trip is byte-stable)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  const tmp = path.join(tmpdir(), 'vmde-mode-roundtrip.md')
  writeFileSync(tmp, readFileSync(SRC, 'utf8'))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [tmp] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(frame, (snapshot) => snapshot.editorEpoch > 0, {
    message: 'the round-trip editor finished initialization',
  })

  const getValue = () =>
    frame
      .locator('body')
      .evaluate(() =>
        (
          window as unknown as { vditor: { getValue(): string } }
        ).vditor.getValue(),
      ) as Promise<string>

  const switchMode = async (mode: string) => {
    const before = await waitForE2EReadiness(frame, () => true)
    await frame.locator('body').evaluate((_b, m) => {
      const btn = document.querySelector(
        `.vditor-toolbar button[data-mode="${m}"]`,
      )
      if (!btn) throw new Error(`mode button not found: ${m}`)
      btn.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    }, mode)
    await waitForE2EReadiness(
      frame,
      (snapshot) =>
        snapshot.modeEpoch > before.modeEpoch && snapshot.mode === mode,
      { message: `the editor reported ${mode} mode` },
    )
  }

  const ir0 = await getValue()
  await switchMode('wysiwyg')
  const wy = await getValue()
  await switchMode('sv')
  const sv = await getValue()
  await switchMode('ir')
  const ir1 = await getValue()
  // eslint-disable-next-line no-console
  console.log(
    `[mode-roundtrip] len ir0=${ir0.length} wy=${wy.length} sv=${sv.length} ir1=${ir1.length} identical=${ir0 === ir1}`,
  )
  rmSync(tmp, { force: true })

  // Content survives every hop (no block dropped mid round-trip).
  for (const a of ANCHORS) {
    expect(wy.includes(a), `wysiwyg keeps: ${a}`).toBe(true)
    expect(sv.includes(a), `sv keeps: ${a}`).toBe(true)
    expect(ir1.includes(a), `back-in-ir keeps: ${a}`).toBe(true)
  }
  // The round-trip returns to the exact original IR serialization — the no-drift guarantee.
  expect(ir1, 'ir → wysiwyg → sv → ir is byte-stable').toBe(ir0)
})
