// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countBudget, scaledFixture } from '../testing/budget-harness'
import * as selectionWrite from './selection-write'
import {
  setIntentRetirer,
  writeSelection,
  writeSelectionKeepingIntent,
} from './selection-write'

// Task 733 / 012-19, B-14 `selection-write` part (D-13 design sections 1.3, 11.3 and 12.2): M3 is
// "one flush per user operation". A marked write made after the operation's DOM writes is at most
// one layout-dependent flush, whichever form its target has. The guard constant of the V-3a build
// patch lives here (012-19-I); it is read through this interface so the file typechecks before it exists.

const guard = selectionWrite as unknown as {
  VDITOR_SINGLE_SELECTION_WRITE?: boolean
}

afterEach(() => {
  setIntentRetirer(() => undefined)
  window.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

function fixture() {
  const root = scaledFixture({
    tables: 1,
    rows: 4,
    listItems: 3,
    paragraphs: 2,
  })
  const cell = root.querySelector('tbody td') as HTMLElement
  return { root, cell, text: cell.firstChild as Text }
}

const caretAt = (node: Node, offset: number): Range => {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  return range
}

describe('VDITOR_SINGLE_SELECTION_WRITE (012-19)', () => {
  it('is exported and on by default', () => {
    expect(guard.VDITOR_SINGLE_SELECTION_WRITE).toBe(true)
  })
})

describe('B-14 selection-write: one flush per operation', () => {
  const writers = [
    ['writeSelection', writeSelection],
    ['writeSelectionKeepingIntent', writeSelectionKeepingIntent],
  ] as const

  for (const [name, write] of writers) {
    it(`${name} of a Range after a DOM write flushes at most once`, () => {
      const { root, cell, text } = fixture()
      const { result, counts } = countBudget(root, () => {
        // The operation's DOM write: a break after the caret, as a cell Enter inserts.
        cell.appendChild(document.createElement('br'))
        return write(caretAt(text, 1))
      })
      expect(result).toBe(true)
      expect(counts.flushes).toBeLessThanOrEqual(1)
      expect(counts.layoutReads).toBe(0)
    })

    it(`${name} of selection ends after a DOM write flushes at most once`, () => {
      const { root, cell, text } = fixture()
      const { result, counts } = countBudget(root, () => {
        text.data = `${text.data}x`
        return write({
          anchorNode: text,
          anchorOffset: text.length,
          focusNode: text,
          focusOffset: 0,
        })
      })
      expect(result).toBe(true)
      expect(counts.flushes).toBeLessThanOrEqual(1)
      expect(cell.contains(window.getSelection()?.anchorNode ?? null)).toBe(
        true,
      )
    })

    it(`${name} on clean layout makes no flush`, () => {
      const { root, text } = fixture()
      const { counts } = countBudget(root, () => write(caretAt(text, 0)))
      expect(counts.flushes).toBe(0)
    })
  }

  it('lands the selection where the target says', () => {
    const { text } = fixture()
    expect(writeSelection(caretAt(text, 2))).toBe(true)
    const selection = window.getSelection() as Selection
    expect(selection.anchorNode).toBe(text)
    expect(selection.anchorOffset).toBe(2)
    expect(selection.isCollapsed).toBe(true)
  })

  it('returns false for a stale endpoint and retires the intent only for a deliberate write', () => {
    const retire = vi.fn()
    setIntentRetirer(retire)
    const { text } = fixture()
    const stale = {
      anchorNode: text,
      anchorOffset: text.length + 5,
      focusNode: text,
      focusOffset: 0,
    }
    expect(writeSelectionKeepingIntent(stale)).toBe(false)
    expect(retire).not.toHaveBeenCalled()
    expect(writeSelection(stale)).toBe(false)
    expect(retire).toHaveBeenCalledTimes(1)
  })
})
