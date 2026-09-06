import { expect, test } from 'vscode-test-playwright'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

// Task 477, hypothesis 2 — the save-window collision, PROVEN BENIGN by direct real-VS-Code
// measurement.
//
// checkNoopOnWillSave's save-correction (applied via `event.waitUntil`, OUTSIDE the
// applyChain that serializes every other write) replaces the whole document with the baseline.
// The remaining theoretical hazard was: a debounced edit-sync tick whose own full-document
// WorkspaceEdit was built against the LONGER pre-correction document lands AFTER the
// correction shrank it — its range references positions that no longer exist, so applyEdit
// resolves `false` and the user sees a scary "document changed underneath" error for a
// collision WE caused.
//
// That mechanism was never reproduced. This spec settles whether it CAN fire, deterministically
// — no timing race, just the collision's two edits applied in order against one real document:
//   1. corrEdit  — the save-correction: (0,0)-(2,0) → "hello\n", shrinking "hello\n\n" to two lines
//   2. tickEdit  — the tick's stale edit, BUILT first against the three-line document, applied after
//
// Measured 2026-08-10: real VS Code does NOT reject the stale range. It CLAMPS it and applies
// the edit successfully (returns true). And because a full-document replace always starts at
// (0,0), clamping the end to the current document covers the WHOLE document — the result is the
// tick's full content, never a partial write. So the collision cannot produce the error, and it
// cannot truncate data. This is a net, not a probe: if a future VS Code ever changes applyEdit
// to reject stale ranges, the 477 error class returns and this spec fails loudly.
test('a stale full-document replace landing after a shrink resolves true (clamped), so the save-window collision cannot surface the writeback error', async ({
  evaluateInVSCode,
}) => {
  test.setTimeout(60_000)
  // The collision's precondition: a three-line "hello\n\n" document, opened in a real editor
  // (the probe runs against an opened document, not a background handle, to match the
  // writeback's own conditions).
  const tmp = path.join(tmpdir(), 'vmde-writeback-save-window-477.md')
  writeFileSync(tmp, 'hello\n\n')

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

  const result = (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const uri = vscode.Uri.file(args[0])
      const doc = await vscode.workspace.openTextDocument(uri)
      // Build the collision's precondition IN the editor: document must be the three-line
      // "hello\n\n" before the correction. Mirror the writeback's own documentRange — end at
      // the last line's END, so the whole fixture content is replaced.
      const preLast = doc.lineAt(Math.max(doc.lineCount - 1, 0))
      const preRange = new vscode.Range(
        0,
        0,
        preLast.range.end.line,
        preLast.range.end.character,
      )
      const preEdit = new vscode.WorkspaceEdit()
      preEdit.replace(uri, preRange, 'hello\n\n')
      const preApplied = await vscode.workspace.applyEdit(preEdit)
      const lineCount = doc.lineCount
      const preText = doc.getText()

      // The tick's edit, built FIRST against the three-line document — its range covers
      // line 2, which the correction below is about to delete.
      const tickEdit = new vscode.WorkspaceEdit()
      tickEdit.replace(uri, new vscode.Range(0, 0, 2, 0), 'world\n')

      // The save-correction lands first: whole document → baseline "hello\n" (2 lines).
      const corrEdit = new vscode.WorkspaceEdit()
      corrEdit.replace(uri, new vscode.Range(0, 0, 2, 0), 'hello\n')
      const corrApplied = await vscode.workspace.applyEdit(corrEdit)

      // Now the tick's stale-range edit lands against the shrunken document.
      const tickApplied = await vscode.workspace.applyEdit(tickEdit)

      const after = vscode.workspace.textDocuments
        .find((d) => d.uri.toString() === uri.toString())
        ?.getText()

      return { preApplied, lineCount, preText, corrApplied, tickApplied, after }
    },
    [tmp] as [string],
  )) as {
    preApplied: boolean
    lineCount: number
    preText: string
    corrApplied: boolean
    tickApplied: boolean
    after: string | undefined
  }

  rmSync(tmp, { force: true })

  // Precondition: the collision's document state really was three lines, and both edits were
  // accepted into the pipeline.
  expect(result.preApplied).toBe(true)
  expect(result.lineCount).toBe(3)
  expect(result.preText).toBe('hello\n\n')
  expect(result.corrApplied).toBe(true)

  // eslint-disable-next-line no-console
  console.log(
    `[477-H2] preText=${JSON.stringify(result.preText)} corrApplied=${result.corrApplied} tickApplied=${result.tickApplied} after=${JSON.stringify(result.after)}`,
  )

  // THE HEADLINE: the stale-range edit does NOT resolve false — VS Code clamps it.
  // If this ever flips to `false`, the 477 error class is back and the writeback needs a
  // defensive re-check (the error would be a lie whenever the document already holds toWrite).
  expect(result.tickApplied).toBe(true)

  // The data-safety half: the clamped replace covered the WHOLE document — the tick's content,
  // not a partial write. The collision cannot truncate.
  expect(result.after).toBe('world\n')
})
