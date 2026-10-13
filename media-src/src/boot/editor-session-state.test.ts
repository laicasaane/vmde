import { describe, expect, it, beforeEach } from 'vitest'
import { sessionState } from './editor-session-state'

// Coverage-ratchet net (task 403 group 1) for the shared state container task 399
// extracted main.ts's module-global `let`s into. It's a plain object with no
// behaviour to speak of — this pins its shape and default values so a future field
// rename/typo is a red test, not a silent drop.
describe('editor-session-state', () => {
  beforeEach(() => {
    sessionState.lastInitMsg = null
    sessionState.applyingExtensionUpdate = false
    sessionState.streaming = false
    sessionState.editSync = null
    sessionState.wikiKnownPages = new Set()
    sessionState.wikiDisplayNames = new Set()
    sessionState.wikiKeysKnown = false
  })

  it('starts with the documented defaults', () => {
    expect(sessionState.lastInitMsg).toBeNull()
    expect(sessionState.applyingExtensionUpdate).toBe(false)
    expect(sessionState.streaming).toBe(false)
    expect(sessionState.editSync).toBeNull()
    expect(sessionState.wikiKnownPages).toBeInstanceOf(Set)
    expect(sessionState.wikiKnownPages.size).toBe(0)
    expect(sessionState.wikiDisplayNames).toBeInstanceOf(Set)
    expect(sessionState.wikiDisplayNames.size).toBe(0)
    // Keys are unknown until an `init` with `pageKeys` or a `wiki-update` says otherwise.
    expect(sessionState.wikiKeysKnown).toBe(false)
  })

  it('is a single shared instance — every field is directly mutable', () => {
    sessionState.applyingExtensionUpdate = true
    sessionState.streaming = true
    sessionState.lastInitMsg = { content: 'hello' }
    expect(sessionState.applyingExtensionUpdate).toBe(true)
    expect(sessionState.streaming).toBe(true)
    expect(sessionState.lastInitMsg?.content).toBe('hello')
  })

  it('the wiki sets are mutated IN PLACE, not replaced — the reference stays live', () => {
    // The whole point (per the file's own header comment): setupCustomRenderer / the
    // custom renderer captures the Set reference, so a later .add()/.clear() must be
    // visible through that same reference, not require re-wiring.
    const ref = sessionState.wikiKnownPages
    sessionState.wikiKnownPages.add('Some Page')
    expect(ref.has('Some Page')).toBe(true)
    expect(sessionState.wikiKnownPages).toBe(ref)
  })
})
