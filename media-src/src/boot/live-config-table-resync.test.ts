// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 660: a live change of the section-indent setting or step changes the room every indented table
// has, with no resize or DOM edit to tell the table normalizer, so applyBodyOptions asks it for one
// full re-sync, and only when the attribute or the step variable actually changed.
const resync = vi.hoisted(() => vi.fn())
vi.mock('../chrome/responsive-tables', () => ({
  resyncResponsiveTables: resync,
}))

import { applyBodyOptions } from './live-config'

describe('applyBodyOptions table re-sync (task 660)', () => {
  beforeEach(() => {
    document.body.removeAttribute('data-section-indent')
    document.body.style.removeProperty('--vmde-section-indent-step')
    resync.mockClear()
  })
  afterEach(() => resync.mockClear())

  it('asks for one re-sync when the setting is switched on, and none when nothing changes', () => {
    applyBodyOptions({ sectionIndent: true, sectionIndentSize: 24 })
    expect(resync).toHaveBeenCalledTimes(1)
    applyBodyOptions({ sectionIndent: true, sectionIndentSize: 24 })
    expect(resync).toHaveBeenCalledTimes(1)
  })

  it('asks again when only the step changes, and when the setting goes off', () => {
    applyBodyOptions({ sectionIndent: true, sectionIndentSize: 24 })
    resync.mockClear()
    applyBodyOptions({ sectionIndent: true, sectionIndentSize: 40 })
    expect(resync).toHaveBeenCalledTimes(1)
    applyBodyOptions({ sectionIndent: false, sectionIndentSize: 40 })
    expect(resync).toHaveBeenCalledTimes(2)
  })
})
