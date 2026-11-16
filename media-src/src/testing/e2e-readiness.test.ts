// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  beginE2EActivity,
  configureE2EReadiness,
  markEditorReady,
  markModeReady,
  markRouterReady,
  recordE2ESwitches,
  snapshotE2EReadiness,
} from './e2e-readiness'

describe('E2E readiness ledger', () => {
  afterEach(() => {
    configureE2EReadiness(false)
  })

  it('does not expose state while disabled', () => {
    configureE2EReadiness(false)
    markRouterReady()
    markEditorReady('ir')
    markModeReady('wysiwyg')
    const done = beginE2EActivity('cache-put')
    done()

    expect(snapshotE2EReadiness()).toBeNull()
    expect(
      (window as unknown as { __vmdeE2EReadiness?: unknown })
        .__vmdeE2EReadiness,
    ).toBeUndefined()
  })

  it('latches router installation that precedes E2E init enablement', () => {
    configureE2EReadiness(false)
    markRouterReady()
    configureE2EReadiness(true)

    expect(snapshotE2EReadiness()?.routerReady).toBe(true)
  })

  it('advances lifecycle epochs and completes one activity token once', () => {
    configureE2EReadiness(true)
    markRouterReady()
    markEditorReady('ir')
    markEditorReady('ir')
    markModeReady('wysiwyg')
    const done = beginE2EActivity('cache-put')

    expect(snapshotE2EReadiness()).toMatchObject({
      routerReady: true,
      editorEpoch: 2,
      modeEpoch: 1,
      mode: 'wysiwyg',
      pending: { 'cache-put': 1 },
      completed: {},
    })

    done()
    done()
    expect(snapshotE2EReadiness()).toMatchObject({
      pending: { 'cache-put': 0 },
      completed: { 'cache-put': 1 },
    })
  })

  it('returns defensive snapshots and removes stale global state on disable', () => {
    configureE2EReadiness(true)
    markEditorReady('ir')
    const snapshot = snapshotE2EReadiness()
    expect(snapshot).not.toBeNull()
    if (snapshot) snapshot.pending.render = 99

    expect(snapshotE2EReadiness()?.pending.render).toBeUndefined()
    configureE2EReadiness(false)
    expect(snapshotE2EReadiness()).toBeNull()
    expect(
      (window as unknown as { __vmdeE2EReadiness?: unknown })
        .__vmdeE2EReadiness,
    ).toBeUndefined()
  })
})

// Task 733 / 024: the shipped switches, recorded once per editor init so a real-VS-Code spec can
// skip the tests of a feature that ships off.
describe('E2E readiness switches', () => {
  const SWITCHES = {
    wysiwygUnits: false,
    sourceUnits: true,
    definitionUnits: false,
    singleSelectionWrite: true,
  }

  afterEach(() => {
    configureE2EReadiness(false)
  })

  it('leaves the switches absent until they are recorded', () => {
    configureE2EReadiness(true)

    const snapshot = snapshotE2EReadiness()
    expect(snapshot).not.toBeNull()
    expect(snapshot).not.toHaveProperty('switches')
  })

  it('records the switches in the ledger', () => {
    configureE2EReadiness(true)
    recordE2ESwitches(SWITCHES)

    expect(snapshotE2EReadiness()?.switches).toEqual(SWITCHES)
    expect(
      (window as unknown as { __vmdeE2EReadiness?: { switches?: unknown } })
        .__vmdeE2EReadiness?.switches,
    ).toEqual(SWITCHES)
  })

  it('copies the switches into the snapshot', () => {
    configureE2EReadiness(true)
    recordE2ESwitches(SWITCHES)
    const snapshot = snapshotE2EReadiness()
    if (snapshot?.switches) snapshot.switches.sourceUnits = false

    expect(snapshotE2EReadiness()?.switches).toEqual(SWITCHES)
  })

  it('is a no-op without a ledger', () => {
    configureE2EReadiness(false)
    recordE2ESwitches(SWITCHES)

    expect(snapshotE2EReadiness()).toBeNull()
    expect(
      (window as unknown as { __vmdeE2EReadiness?: unknown })
        .__vmdeE2EReadiness,
    ).toBeUndefined()
    configureE2EReadiness(true)
    expect(snapshotE2EReadiness()).not.toHaveProperty('switches')
  })
})
