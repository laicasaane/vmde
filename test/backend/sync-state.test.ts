import { beforeEach, describe, expect, it } from 'vitest'
import { normalizeContent, SyncState } from '../../src/writeback/sync-state'

// Task 405 — the three echo-suppression fields (lastSyncedContent, pendingWebviewContent,
// applyingWebviewEdit) used to be private EditorSession fields, with the SAME `\r\n`→`\n`
// compare duplicated inline at postUpdate(), the onDidChangeTextDocument listener, AND
// (separately) writeback-controller.ts's own `normalize`. Single-sourced here.
describe('normalizeContent', () => {
  it('collapses CRLF to LF', () => {
    expect(normalizeContent('a\r\nb\r\n')).toBe('a\nb\n')
  })

  it('is the identity for LF-only content', () => {
    expect(normalizeContent('a\nb\n')).toBe('a\nb\n')
  })
})

describe('SyncState', () => {
  let state: SyncState

  beforeEach(() => {
    state = new SyncState('initial content\n')
  })

  it('starts synced to the content the constructor was given', () => {
    expect(state.getLastSynced()).toBe('initial content\n')
    expect(state.isAlreadySynced('initial content\n')).toBe(true)
  })

  it('isAlreadySynced compares CRLF-normalized (postUpdate dedup)', () => {
    expect(state.isAlreadySynced('initial content\r\n')).toBe(true)
    expect(state.isAlreadySynced('changed\n')).toBe(false)
  })

  it('markSynced advances what counts as already-synced', () => {
    state.markSynced('new content\n')
    expect(state.isAlreadySynced('new content\n')).toBe(true)
    expect(state.isAlreadySynced('initial content\n')).toBe(false)
  })

  it('applyingWebviewEdit flag defaults false and is settable', () => {
    expect(state.isApplyingEdit()).toBe(false)
    state.setApplyingWebviewEdit(true)
    expect(state.isApplyingEdit()).toBe(true)
    state.setApplyingWebviewEdit(false)
    expect(state.isApplyingEdit()).toBe(false)
  })

  it('pendingWebviewContent defaults undefined and is settable/gettable', () => {
    expect(state.getPendingWebviewContent()).toBeUndefined()
    state.setPendingWebviewContent('written text\n')
    expect(state.getPendingWebviewContent()).toBe('written text\n')
    state.setPendingWebviewContent(undefined)
    expect(state.getPendingWebviewContent()).toBeUndefined()
  })

  describe('isEcho — the change-listener predicate', () => {
    it('is false with no pending write', () => {
      expect(state.isEcho('anything\n')).toBe(false)
    })

    it('is true when the document change matches the pending write (CRLF-normalized)', () => {
      state.setPendingWebviewContent('written text\n')
      expect(state.isEcho('written text\r\n')).toBe(true)
    })

    it('is false when the document change does not match the pending write', () => {
      state.setPendingWebviewContent('written text\n')
      expect(state.isEcho('something else\n')).toBe(false)
    })

    it('is PURE — does not clear pending or advance lastSynced as a side effect', () => {
      state.setPendingWebviewContent('written text\n')
      state.isEcho('written text\n')
      // Callers do the two writes themselves (mirrors the original inline change-listener
      // logic byte-for-byte) — the predicate alone must not mutate state.
      expect(state.getPendingWebviewContent()).toBe('written text\n')
      expect(state.isAlreadySynced('written text\n')).toBe(false)
    })
  })
})

// Task 733 — the delta epoch beside the external revision.
describe('SyncState epoch', () => {
  it('startEpoch increments and returns; getEpoch reads', () => {
    const state = new SyncState('')
    expect(state.getEpoch()).toBe(0)
    expect(state.startEpoch()).toBe(1)
    expect(state.startEpoch()).toBe(2)
    expect(state.getEpoch()).toBe(2)
  })

  it('hasPostedEpoch toggles with markPostedEpoch and startEpoch', () => {
    const state = new SyncState('')
    expect(state.hasPostedEpoch()).toBe(false)
    state.markPostedEpoch(state.getEpoch())
    expect(state.hasPostedEpoch()).toBe(true)
    state.startEpoch()
    expect(state.hasPostedEpoch()).toBe(false)
    state.markPostedEpoch(state.getEpoch())
    expect(state.hasPostedEpoch()).toBe(true)
  })

  it('the epoch does not touch the external revision', () => {
    const state = new SyncState('')
    state.startEpoch()
    expect(state.getExternalRevision()).toBe(0)
    state.noteExternalChange()
    expect(state.getEpoch()).toBe(1)
  })

  it('isEcho still normalizes CRLF against a predicted LF text', () => {
    const state = new SyncState('')
    state.setPendingWebviewContent('a\nb')
    expect(state.isEcho('a\r\nb')).toBe(true)
  })
})
