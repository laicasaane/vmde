import { describe, expect, it } from 'vitest'
import { planPreviewTaskCheckboxEdit } from '../../src/session/preview-task-checkbox-edit'

describe('planPreviewTaskCheckboxEdit', () => {
  it('plans exactly one unchecked marker replacement against the captured source', () => {
    const before = '# List\n\n- [ ] task\n- [x] other\n'
    const startOffset = before.indexOf('[ ]')
    const plan = planPreviewTaskCheckboxEdit(before, {
      source: before,
      startOffset,
      endOffset: startOffset + 3,
      marker: '[ ]',
      checked: true,
    })

    expect(plan).toEqual({
      status: 'planned',
      startOffset,
      endOffset: startOffset + 3,
      replacement: '[x]',
      after: before.replace('[ ]', '[x]'),
    })
  })

  it('unchecks both lowercase and uppercase checked markers', () => {
    for (const marker of ['[x]', '[X]']) {
      const before = ['- ', marker, ' task\n'].join('')
      const startOffset = before.indexOf(marker)
      expect(
        planPreviewTaskCheckboxEdit(before, {
          source: before,
          startOffset,
          endOffset: startOffset + 3,
          marker,
          checked: false,
        }),
      ).toMatchObject({
        status: 'planned',
        replacement: '[ ]',
        after: '- [ ] task\n',
      })
    }
  })

  it('rejects stale source and a marker that no longer matches the captured span', () => {
    const captured = '- [ ] task'
    const request = {
      source: captured,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    }
    expect(planPreviewTaskCheckboxEdit('- [x] task', request)).toEqual({
      status: 'stale',
    })
    expect(
      planPreviewTaskCheckboxEdit(captured, { ...request, marker: '[x]' }),
    ).toEqual({ status: 'stale' })
  })

  it('rejects malformed ranges, marker literals, and non-toggle state requests', () => {
    const source = '- [ ] task'
    const valid = {
      source,
      startOffset: 2,
      endOffset: 5,
      marker: '[ ]',
      checked: true,
    }
    expect(
      planPreviewTaskCheckboxEdit(source, { ...valid, endOffset: 6 }),
    ).toEqual({ status: 'stale' })
    expect(
      planPreviewTaskCheckboxEdit(source, { ...valid, marker: '[a]' }),
    ).toEqual({ status: 'stale' })
    expect(
      planPreviewTaskCheckboxEdit(source, { ...valid, checked: false }),
    ).toEqual({ status: 'stale' })
  })
})
