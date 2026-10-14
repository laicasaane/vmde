import { describe, expect, it } from 'vitest'
import {
  applySvSelectionEdit,
  ownsSvColumnOneBackspace,
  ownsSvEnterOverSelection,
  ownsSvSelectionEdit,
} from './sv-selection-edit'

const SRC = 'Alpha line\nBravo line\nCharlie line\n'
const BRAVO = SRC.indexOf('Bravo')

describe('applySvSelectionEdit on a three-line source', () => {
  it('deleting `Bravo` keeps the previous newline', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO, BRAVO + 5)).toBe(true)
    const r = applySvSelectionEdit(SRC, BRAVO, BRAVO + 5, '')
    expect(r.text).toBe('Alpha line\n line\nCharlie line\n')
    expect(r.caret).toBe(BRAVO)
  })

  it('deleting the line content leaves a blank line', () => {
    expect(applySvSelectionEdit(SRC, BRAVO, BRAVO + 10, '').text).toBe(
      'Alpha line\n\nCharlie line\n',
    )
  })

  it('deleting the whole line with its newline removes the line', () => {
    expect(applySvSelectionEdit(SRC, BRAVO, BRAVO + 11, '').text).toBe(
      'Alpha line\nCharlie line\n',
    )
  })

  it('typing over `Bravo` replaces it and puts the caret after the text', () => {
    const r = applySvSelectionEdit(SRC, BRAVO, BRAVO + 5, 'X')
    expect(r.text).toBe('Alpha line\nX line\nCharlie line\n')
    expect(r.caret).toBe(BRAVO + 1)
  })
})

describe('ownsSvSelectionEdit', () => {
  it('does not own the first line', () => {
    expect(ownsSvSelectionEdit(SRC, 0, 5)).toBe(false)
  })

  it('owns a line after a blank line', () => {
    expect(ownsSvSelectionEdit('a\n\nb', 3, 4)).toBe(true)
    expect(applySvSelectionEdit('a\n\nb', 3, 4, '').text).toBe('a\n\n')
  })

  it('owns a blank line selected from its start', () => {
    expect(ownsSvSelectionEdit('a\n\nb', 2, 3)).toBe(true)
  })

  it('owns a multi-line selection that starts at a line start', () => {
    const end = SRC.indexOf('Charlie') + 3
    expect(ownsSvSelectionEdit(SRC, BRAVO, end)).toBe(true)
    expect(applySvSelectionEdit(SRC, BRAVO, end, '').text).toBe(
      'Alpha line\nrlie line\n',
    )
  })

  it('owns a selection that ends at the document end', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO, SRC.length)).toBe(true)
    expect(applySvSelectionEdit(SRC, BRAVO, SRC.length, '').text).toBe(
      'Alpha line\n',
    )
  })

  it('does not own a mid-line start', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO + 1, BRAVO + 5)).toBe(false)
  })

  it('does not own a start at the end of the previous line content', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO - 1, BRAVO + 5)).toBe(false)
  })

  it('does not own a collapsed selection', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO, BRAVO)).toBe(false)
  })

  it('does not own a whole-document selection', () => {
    expect(ownsSvSelectionEdit(SRC, 0, SRC.length)).toBe(false)
  })

  it('does not own invalid ranges', () => {
    expect(ownsSvSelectionEdit(SRC, BRAVO + 5, BRAVO)).toBe(false)
    expect(ownsSvSelectionEdit(SRC, BRAVO, SRC.length + 1)).toBe(false)
    expect(ownsSvSelectionEdit(SRC, -1, 3)).toBe(false)
    expect(ownsSvSelectionEdit(SRC, 1.5, 4)).toBe(false)
  })
})

describe('ownsSvColumnOneBackspace (Task 629 b)', () => {
  it('owns a mid-line selection that starts at column 1 (ravo)', () => {
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 1, BRAVO + 5)).toBe(true)
    expect(applySvSelectionEdit(SRC, BRAVO + 1, BRAVO + 5, '').text).toBe(
      'Alpha line\nB line\nCharlie line\n',
    )
  })

  it('owns a cross-line selection that starts at column 1', () => {
    const end = SRC.indexOf('Charlie') + 4
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 1, end)).toBe(true)
    expect(applySvSelectionEdit(SRC, BRAVO + 1, end, '').text).toBe(
      'Alpha line\nBlie line\n',
    )
  })

  it('owns a selection from the end of a one-character line', () => {
    const text = 'a\nx\nfoo'
    expect(ownsSvColumnOneBackspace(text, 3, 5)).toBe(true)
    expect(applySvSelectionEdit(text, 3, 5, '').text).toBe('a\nxoo')
  })

  it('owns a selection after a blank line', () => {
    expect(ownsSvColumnOneBackspace('a\n\nbcd', 4, 6)).toBe(true)
  })

  it('does not own a collapsed caret at column 1', () => {
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 1, BRAVO + 1)).toBe(false)
  })

  it('does not own a selection that starts at column 0 (the line-start case owns it)', () => {
    expect(ownsSvColumnOneBackspace(SRC, BRAVO, BRAVO + 5)).toBe(false)
  })

  it('does not own a selection that starts at column 2 or later', () => {
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 2, BRAVO + 5)).toBe(false)
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 4, BRAVO + 8)).toBe(false)
  })

  it('does not own line 1 of the document (no previous line break)', () => {
    expect(ownsSvColumnOneBackspace(SRC, 1, 5)).toBe(false)
    expect(ownsSvColumnOneBackspace(SRC, 0, 5)).toBe(false)
  })

  it('does not own a start whose column-0 character is a line break', () => {
    expect(ownsSvColumnOneBackspace('a\n\nb', 2, 4)).toBe(false)
  })

  it('does not own invalid ranges', () => {
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 5, BRAVO + 1)).toBe(false)
    expect(ownsSvColumnOneBackspace(SRC, BRAVO + 1, SRC.length + 1)).toBe(false)
    expect(ownsSvColumnOneBackspace(SRC, -1, 3)).toBe(false)
    expect(ownsSvColumnOneBackspace(SRC, 12.5, 15)).toBe(false)
  })
})

describe('ownsSvEnterOverSelection (Task 629 a)', () => {
  it('owns a mid-line, a line-start, a line-1 and a cross-line selection', () => {
    expect(ownsSvEnterOverSelection(SRC, BRAVO + 1, BRAVO + 5)).toBe(true)
    expect(ownsSvEnterOverSelection(SRC, BRAVO, BRAVO + 5)).toBe(true)
    expect(ownsSvEnterOverSelection(SRC, 0, 5)).toBe(true)
    expect(
      ownsSvEnterOverSelection(SRC, BRAVO + 1, SRC.indexOf('Charlie') + 4),
    ).toBe(true)
  })

  it('does not own a collapsed caret', () => {
    expect(ownsSvEnterOverSelection(SRC, BRAVO, BRAVO)).toBe(false)
  })

  it('does not own invalid ranges', () => {
    expect(ownsSvEnterOverSelection(SRC, BRAVO + 5, BRAVO)).toBe(false)
    expect(ownsSvEnterOverSelection(SRC, BRAVO, SRC.length + 1)).toBe(false)
    expect(ownsSvEnterOverSelection(SRC, -1, 3)).toBe(false)
    expect(ownsSvEnterOverSelection(SRC, 1.5, 4)).toBe(false)
  })
})
