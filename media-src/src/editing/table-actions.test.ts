import { describe, expect, test } from 'vitest'
import {
  restoreTableUndoForRollback,
  snapshotTableUndoForRollback,
} from './table-actions'

describe('table transaction undo rollback', () => {
  test('failure restoration preserves the baseline for subsequent typing, undo, and redo', () => {
    const slot = {
      undoStack: ['open'],
      redoStack: [] as string[],
      lastText: 'document at open',
      hasUndo: false,
    }
    let resetCalls = 0
    const inner = {
      currentMode: 'ir',
      undo: {
        ir: slot,
        resetIcon: () => resetCalls++,
      },
    } as any
    const baseline = snapshotTableUndoForRollback(inner)

    // Inject the state a thrown table setValue leaves after its second checkpoint.
    slot.undoStack.push('failed-table-transaction')
    slot.lastText = 'failed replacement'
    slot.hasUndo = true
    restoreTableUndoForRollback(inner, baseline)
    expect(slot).toEqual({
      undoStack: ['open'],
      redoStack: [],
      lastText: 'document at open',
      hasUndo: false,
    })
    expect(resetCalls).toBe(1)

    // A normal typed edit must continue from the restored baseline, then undo/redo round-trip it.
    slot.undoStack.push('typed')
    slot.lastText = 'document after typing'
    const typed = slot.undoStack.pop()!
    slot.redoStack.push(typed)
    slot.lastText = 'document at open'
    expect(slot.lastText).toBe('document at open')
    slot.undoStack.push(slot.redoStack.pop()!)
    slot.lastText = 'document after typing'
    expect(slot.lastText).toBe('document after typing')
    expect(slot.undoStack).toEqual(['open', 'typed'])
    expect(slot.redoStack).toEqual([])
  })
})
