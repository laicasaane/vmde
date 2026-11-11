import { beforeEach, describe, expect, it } from 'vitest'
import { EndOfLine, Range, Uri, WorkspaceEdit, workspace } from 'vscode'
import { mock } from './vscode-mock'

// Task 733 — the fake TextDocument and workspace.applyEdit carry the range surface the delta writer
// relies on: getText(range), validateRange, offsetAt, settable eol, opt-in ranged applyEdit with one
// change event, and a queue for the next applyEdit result.

const LINES = ['alpha', 'beta', 'gamma']

describe.each([
  ['LF', '\n', EndOfLine.LF],
  ['CRLF', '\r\n', EndOfLine.CRLF],
])('fake document (%s)', (_label, eol, eolValue) => {
  beforeEach(() => mock.reset())

  const open = () => {
    const doc = mock.createTextDocument('/w/a.txt', LINES.join(eol))
    doc.eol = eolValue
    return doc
  }

  it('getText(range), validateRange and offsetAt agree with the text', () => {
    const doc = open()
    const text = LINES.join(eol)
    expect(doc.lineCount).toBe(3)
    expect(doc.lineAt(1).text).toBe('beta')
    expect(doc.getText(new Range(0, 2, 1, 2))).toBe(`pha${eol}be`)
    expect(doc.getText(new Range(2, 0, 2, 5))).toBe('gamma')
    expect(doc.offsetAt(new Range(1, 0, 1, 0).start)).toBe(5 + eol.length)
    expect(doc.offsetAt(new Range(2, 5, 2, 5).start)).toBe(text.length)
    // A position past the line end clamps to the line end; a line past the end clamps to the end.
    const clamped = doc.validateRange(new Range(0, 99, 7, 3))
    expect([clamped.start.line, clamped.start.character]).toEqual([0, 5])
    expect([clamped.end.line, clamped.end.character]).toEqual([2, 5])
    expect(doc.offsetAt(clamped.start)).toBe(5)
    expect(doc.positionAt(5 + eol.length).line).toBe(1)
    expect(doc.positionAt(text.length).character).toBe(5)
  })

  it('ranged applyEdit splices two ranges, bumps version once, fires one event', async () => {
    mock.setRangedApplyEdit(true)
    const doc = open()
    const events: any[] = []
    const sub = workspace.onDidChangeTextDocument((e: any) => events.push(e))
    const edit = new WorkspaceEdit()
    edit.replace(doc.uri, new Range(0, 0, 0, 1), 'A')
    edit.replace(doc.uri, new Range(2, 0, 2, 5), 'g\nG')
    const versionBefore = doc.version
    const ok = await workspace.applyEdit(edit)
    expect(ok).toBe(true)
    expect(doc.getText()).toBe(['Alpha', 'beta', 'g', 'G'].join(eol))
    expect(doc.version).toBe(versionBefore + 1)
    expect(events).toHaveLength(1)
    expect(events[0].document).toBe(doc)
    expect(events[0].contentChanges).toHaveLength(2)
    expect(events[0].contentChanges.map((c: any) => c.text)).toEqual([
      `g${eol}G`,
      'A',
    ])
    sub.dispose()
  })

  it('a queued false leaves the text and version unchanged', async () => {
    mock.setRangedApplyEdit(true)
    const doc = open()
    mock.queueApplyEditResult(false)
    const edit = new WorkspaceEdit()
    edit.replace(doc.uri, new Range(0, 0, 0, 1), 'A')
    const versionBefore = doc.version
    expect(await workspace.applyEdit(edit)).toBe(false)
    expect(doc.getText()).toBe(LINES.join(eol))
    expect(doc.version).toBe(versionBefore)
    expect(await workspace.applyEdit(edit)).toBe(true)
    expect(doc.getText().startsWith('Alpha')).toBe(true)
  })
})

describe('default applyEdit mode', () => {
  beforeEach(() => mock.reset())

  it('replaces the whole text and fires no event', async () => {
    const doc = mock.createTextDocument('/w/b.txt', 'old')
    let fired = 0
    const sub = workspace.onDidChangeTextDocument(() => fired++)
    const edit = new WorkspaceEdit()
    edit.replace(Uri.file('/w/b.txt'), new Range(0, 0, 0, 3), 'new text')
    expect(await workspace.applyEdit(edit)).toBe(true)
    expect(doc.getText()).toBe('new text')
    expect(fired).toBe(0)
    sub.dispose()
  })
})
