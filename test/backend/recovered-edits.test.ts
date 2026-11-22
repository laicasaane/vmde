// Task 733 / 036 (E2, fix design 3.6, Q-I (a)): the untitled "Recovered edits" document. Each write appends
// to the one document (opened, or still open from an earlier write), shows it pinned without focus, and
// keeps it Markdown; the text shows every entry's position, old text and new text.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as vscode from 'vscode'
import {
  insertRecoveredEdits,
  presentRecoveredEdits,
  formatRecoveredEdits,
  RECOVERED_EDITS_URI,
} from '../../src/session/recovered-edits'

/** An untitled document the way VS Code keeps it: open until closed, dirty once it holds text. */
function untitledDocument() {
  const document = {
    uri: vscode.Uri.parse(RECOVERED_EDITS_URI),
    text: '',
    languageId: 'plaintext',
    isUntitled: true,
    isClosed: false,
    get isDirty() {
      return this.text.length > 0
    },
    getText() {
      return this.text
    },
    positionAt(offset: number) {
      return new vscode.Position(0, offset)
    },
  }
  return document
}

describe('Recovered edits (036 E2)', () => {
  let document: ReturnType<typeof untitledDocument>
  beforeEach(() => {
    vi.restoreAllMocks()
    document = untitledDocument()
    vi.spyOn(vscode.workspace, 'openTextDocument').mockImplementation(
      (async () => document) as never,
    )
    vi.spyOn(vscode.workspace, 'applyEdit').mockImplementation((async (
      edit: vscode.WorkspaceEdit,
    ) => {
      for (const replacement of (
        edit as unknown as { replacements: { content: string }[] }
      ).replacements)
        document.text += replacement.content
      return true
    }) as never)
    ;(vscode.languages as Record<string, unknown>).setTextDocumentLanguage =
      vi.fn(async (doc: typeof document, language: string) => {
        doc.languageId = language
        return doc
      })
  })

  it('formats every entry with its position, old text and new text in fences that keep backticks', () => {
    const text = formatRecoveredEdits('notes.md', [
      {
        epoch: 2,
        replayOp: 3,
        changes: [
          {
            start: { line: 4, character: 1 },
            end: { line: 4, character: 3 },
            oldText: 'ab',
            text: 'a ```b``` c',
          },
        ],
      },
      { epoch: 2, replayOp: 4, content: 'whole\n' },
      { epoch: 2, replayOp: 5, changes: [null, { text: 7 }] },
    ])
    expect(text).toContain('# Recovered edits: notes.md')
    expect(text).toContain('## Edit 2.3')
    expect(text).toContain('At line 5, column 2, replaced:')
    expect(text).toContain('```text\nab\n```')
    expect(text).toContain('````text\na ```b``` c\n````')
    expect(text).toContain('## Edit 2.4: whole document')
    expect(text).toContain('```text\nwhole\n```')
    // Malformed changes are shown without their missing fields.
    expect(text).toContain('## Edit 2.5')
    expect(text).toContain('At unknown position, replaced:')
  })

  // 036 core C7 (R33.4): the insertion and the presentation are separate steps.
  it('opens the untitled document, appends, shows it pinned without focus and makes it Markdown', async () => {
    const show = vi
      .spyOn(vscode.window, 'showTextDocument')
      .mockResolvedValue({} as never)
    await insertRecoveredEdits('first\n')
    expect(show).not.toHaveBeenCalled()
    await presentRecoveredEdits()
    expect(vscode.workspace.openTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ scheme: 'untitled' }),
    )
    expect(document.text).toBe('first\n')
    expect(document.isDirty).toBe(true)
    expect(document.languageId).toBe('markdown')
    expect(show).toHaveBeenCalledWith(document, {
      preview: false,
      preserveFocus: true,
    })
  })

  it('a later write appends to the open document: every entry stays, none repeats', async () => {
    vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as never)
    await insertRecoveredEdits('first\n')
    await insertRecoveredEdits('second\n')
    expect(document.text).toBe('first\n\nsecond\n')
    expect(document.isClosed).toBe(false)
    expect(document.isDirty).toBe(true)
  })

  it('a refused edit of the document is reported to the caller', async () => {
    vi.spyOn(vscode.workspace, 'applyEdit').mockResolvedValue(false as never)
    await expect(insertRecoveredEdits('x')).rejects.toThrow(
      'recovered edits not applied',
    )
  })
})
