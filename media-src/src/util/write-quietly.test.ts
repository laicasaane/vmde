// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { registerQuietObserver, writeQuietly } from './mutation-impact'

describe('writeQuietly (Task 655)', () => {
  const disposers: Array<() => void> = []
  afterEach(() => {
    for (const d of disposers.splice(0)) d()
    document.body.innerHTML = ''
  })

  function watch() {
    const root = document.createElement('div')
    document.body.appendChild(root)
    const handled: MutationRecord[][] = []
    const observer = new MutationObserver(() => undefined)
    observer.observe(root, { childList: true, subtree: true })
    disposers.push(
      registerQuietObserver(observer, (records) => handled.push(records)),
      () => observer.disconnect(),
    )
    return { root, observer, handled }
  }

  it("hands over queued records first and discards the write's own", () => {
    const { root, observer, handled } = watch()
    root.append(document.createElement('i')) // a genuine record, still queued
    writeQuietly(() => root.append(document.createElement('b')))
    expect(handled.flat()).toHaveLength(1)
    expect(observer.takeRecords()).toEqual([])
  })

  it("still discards the write's records when the write throws", () => {
    const { root, observer } = watch()
    expect(() =>
      writeQuietly(() => {
        root.append(document.createElement('b'))
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(observer.takeRecords()).toEqual([])
  })

  it("a nested call does not hand over the outer write's records as genuine", () => {
    const { root, handled } = watch()
    handled.length = 0
    writeQuietly(() => {
      root.append(document.createElement('b'))
      writeQuietly(() => root.append(document.createElement('u')))
    })
    expect(handled.flat()).toHaveLength(0)
  })
})
