// Task 733 MEASUREMENT ONLY: how VS Code reports, undoes and normalizes a multi-range WorkspaceEdit
// on plain text documents (LF and CRLF). Feeds the host-side ranged write design.
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

test('task 733 delta host edit semantics @probe', async ({
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(120_000)
  const lines = Array.from(
    { length: 20 },
    (_, i) => `line ${String(i + 1).padStart(2, '0')} text`,
  )
  const lfFile = path.join(baseDir, 'delta-lf.txt')
  const crlfFile = path.join(baseDir, 'delta-crlf.txt')
  writeFileSync(lfFile, lines.join('\n') + '\n')
  writeFileSync(crlfFile, lines.join('\r\n') + '\r\n')

  const result = await evaluateInVSCode(
    async (vscode: typeof import('vscode'), files: string[]) => {
      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
      const out: Record<string, unknown> = {}
      for (const [label, file] of [
        ['LF', files[0]],
        ['CRLF', files[1]],
      ]) {
        await vscode.commands.executeCommand('workbench.action.closeAllEditors')
        const uri = vscode.Uri.file(file)
        const doc = await vscode.workspace.openTextDocument(uri)
        const editor = await vscode.window.showTextDocument(doc)
        const events: unknown[] = []
        const sub = vscode.workspace.onDidChangeTextDocument((e) => {
          if (e.document.uri.toString() !== uri.toString()) return
          events.push({
            version: e.document.version,
            reason: e.reason ?? 'undefined',
            changes: e.contentChanges.map((c) => ({
              start: [c.range.start.line, c.range.start.character],
              end: [c.range.end.line, c.range.end.character],
              rangeLength: c.rangeLength,
              rangeOffset: c.rangeOffset,
              text: JSON.stringify(c.text),
            })),
          })
        })
        const take = () => events.splice(0, events.length)
        const R = (l1: number, c1: number, l2: number, c2: number) =>
          new vscode.Range(l1, c1, l2, c2)
        const lone = (s: string) => /(^|[^\r])\n/.test(s)
        const startText = doc.getText()
        const rec: Record<string, unknown> = {
          eolBefore: doc.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
        }

        // Step 2: three ascending replaces in one WorkspaceEdit (1-based lines 2, 8, 15).
        {
          const we = new vscode.WorkspaceEdit()
          we.replace(uri, R(1, 0, 1, 4), 'LINE\nTWO') // replacement text holds an LF
          we.replace(
            uri,
            R(7, 0, 7, doc.lineAt(7).text.length),
            'eight replaced',
          )
          we.replace(uri, R(14, 8, 15, 4), '+joined+') // across the line break between lines 15 and 16
          const vBefore = doc.version
          const ok = await vscode.workspace.applyEdit(we)
          await wait(100)
          const ev = take()
          const text = doc.getText()
          rec.step2 = {
            ok,
            eventCount: ev.length,
            versionBefore: vBefore,
            versionAfter: doc.version,
            events: ev,
            eolAfter: doc.eol === vscode.EndOfLine.CRLF ? 'CRLF' : 'LF',
            loneLfInText: lone(text),
            lineCountAfter: doc.lineCount,
            firstLines: JSON.stringify(text.slice(0, 60)),
          }
        }

        // Step 3: undo until the text returns to the start.
        {
          await vscode.window.showTextDocument(doc, editor.viewColumn)
          const undos: unknown[] = []
          let count = 0
          while (doc.getText() !== startText && count < 5) {
            await vscode.commands.executeCommand('undo')
            count++
            await wait(100)
            undos.push({ version: doc.version, events: take() })
          }
          rec.step3 = {
            undoCount: count,
            restored: doc.getText() === startText,
            undos,
            isDirty: doc.isDirty,
          }
        }

        // Step 4: replacement equal to the current text of its range.
        {
          const we = new vscode.WorkspaceEdit()
          const range = R(2, 0, 2, doc.lineAt(2).text.length)
          we.replace(uri, range, doc.getText(range))
          const vBefore = doc.version
          const ok = await vscode.workspace.applyEdit(we)
          await wait(100)
          const ev = take()
          rec.step4 = {
            ok,
            eventFired: ev.length > 0,
            events: ev,
            versionBefore: vBefore,
            versionAfter: doc.version,
          }
        }

        // Step 5: two replaces given in descending position order.
        {
          const before = doc.getText()
          const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'
          const ls = before.split(eol)
          ls[9] = 'TEN' + ls[9].slice(4)
          ls[3] = 'FOUR' + ls[3].slice(4)
          const expected = ls.join(eol)
          const we = new vscode.WorkspaceEdit()
          we.replace(uri, R(9, 0, 9, 4), 'TEN')
          we.replace(uri, R(3, 0, 3, 4), 'FOUR')
          const vBefore = doc.version
          const ok = await vscode.workspace.applyEdit(we)
          await wait(100)
          const ev = take()
          rec.step5 = {
            ok,
            correct: doc.getText() === expected,
            eventCount: ev.length,
            versionBefore: vBefore,
            versionAfter: doc.version,
            events: ev,
          }
        }
        sub.dispose()
        // Leave the files unchanged on disk; revert in memory.
        await vscode.commands.executeCommand('workbench.action.files.revert')
        out[label] = rec
      }
      out.vscodeVersion = vscode.version
      return out
    },
    [lfFile, crlfFile],
  )
  const json = JSON.stringify(result)
  console.log(`DELTA-HOST ${json}`)
  expect((result as any).LF.step2.eventCount).toBeGreaterThan(0)
  expect((result as any).CRLF.step2.eventCount).toBeGreaterThan(0)
})
