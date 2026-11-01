// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { liveDocumentText } from './document-text'

const win = window as unknown as { __vmdePreviewSnapshot?: () => string }

afterEach(() => {
  delete win.__vmdePreviewSnapshot
})

describe('liveDocumentText', () => {
  it('is the editor value when an edit view holds the document', () => {
    win.__vmdePreviewSnapshot = () => 'snapshot'
    expect(liveDocumentText({ getValue: () => 'live' })).toBe('live')
  })

  it('falls back to the Preview snapshot when the edit view is empty', () => {
    win.__vmdePreviewSnapshot = () => 'held text'
    expect(liveDocumentText({ getValue: () => '' })).toBe('held text')
  })

  it('treats the bare newline of an empty edit view as empty', () => {
    win.__vmdePreviewSnapshot = () => 'held text'
    expect(liveDocumentText({ getValue: () => '\n' })).toBe('held text')
  })

  it('is empty when nothing holds the document', () => {
    expect(liveDocumentText({ getValue: () => '' })).toBe('')
    expect(liveDocumentText({})).toBe('')
  })
})
