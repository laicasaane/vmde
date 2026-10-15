// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWrapHints,
  createWrapHintSpan,
  insertWrapHint,
  installWrapHintRecordFilter,
  isOwnHintRecord,
  stripWrapHints,
  withoutOwnHintRecords,
} from './wrap-hint-mark'

// Task 640 S2b. The hint is view state: the proof that a DOM write is ours must pass every record of
// the engine's own writes and never a real edit, including a real edit of a node the engine created
// (S1 probe 2: the proof is a registry of what the writer created, with the data it left).

const HINT = '<span class="vmde-wrap-hint" data-render="1"></span>'

function mount(html: string): HTMLElement {
  document.body.innerHTML = `<p>${html}</p>`
  return document.querySelector('code') as HTMLElement
}

/** Records of `run` (the microtask observer batch). */
async function recordsOf(
  root: Node,
  run: () => void,
): Promise<MutationRecord[]> {
  const observer = new MutationObserver(() => undefined)
  observer.observe(root, {
    childList: true,
    characterData: true,
    subtree: true,
  })
  run()
  const records = observer.takeRecords()
  observer.disconnect()
  return records
}

afterEach(() => {
  document.body.replaceChildren()
})

describe('hint span shape', () => {
  it('serializes as the exact span form the strip and the scrubs match', () => {
    const code = mount('<code>aaaa/bbbb</code>')
    insertWrapHint(code.firstChild as Text, 5)
    expect(code.innerHTML).toBe(`aaaa/${HINT}bbbb`)
    expect(code.textContent).toBe('aaaa/bbbb')
  })

  it('has no contenteditable attribute (Task 640 S1 probe 1: it would cost an arrow press)', () => {
    expect(createWrapHintSpan(document).attributes).toHaveLength(2)
    expect(createWrapHintSpan(document).hasAttribute('contenteditable')).toBe(
      false,
    )
  })
})

describe('stripWrapHints', () => {
  it('removes every hint and returns the same string when there is none', () => {
    const plain = '<p data-block="0"><code>a/b</code></p>'
    expect(stripWrapHints(plain)).toBe(plain)
    expect(stripWrapHints(`<code>a/${HINT}b/${HINT}c</code>`)).toBe(
      '<code>a/b/c</code>',
    )
  })

  it('removes a hint whose attributes were reordered or extended', () => {
    expect(
      stripWrapHints(
        '<code>a<span class="vmde-wrap-hint" data-render="1" data-x="y"></span>b</code>',
      ),
    ).toBe('<code>ab</code>')
  })

  it('does not touch another span', () => {
    const other = '<code>a<span class="hljs-keyword"></span>b</code>'
    expect(stripWrapHints(other)).toBe(other)
  })
})

describe('own-write proof', () => {
  it('recognises the split and the hint insert of insertWrapHint as hint writes', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    const records = await recordsOf(document.body, () => {
      insertWrapHint(code.firstChild as Text, 10)
      insertWrapHint(code.firstChild as Text, 5)
    })
    expect(records.length).toBeGreaterThan(0)
    expect(records.every(isOwnHintRecord)).toBe(true)
    expect(withoutOwnHintRecords(records)).toEqual([])
  })

  it('recognises the removal and merge of clearWrapHints as hint writes', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    insertWrapHint(code.firstChild as Text, 10)
    insertWrapHint(code.firstChild as Text, 5)
    const records = await recordsOf(document.body, () => {
      expect(clearWrapHints(code)).toBe(true)
    })
    expect(code.childNodes).toHaveLength(1)
    expect(code.textContent).toBe('aaaa/bbbb/cccc')
    expect(records.length).toBeGreaterThan(0)
    expect(withoutOwnHintRecords(records)).toEqual([])
  })

  it('still counts a real edit next to a hint write in the same batch', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code><span id="x">z</span>')
    const edit = document.getElementById('x')?.firstChild as Text
    const records = await recordsOf(document.body, () => {
      insertWrapHint(code.firstChild as Text, 5)
      edit.appendData('!')
    })
    const real = withoutOwnHintRecords(records)
    expect(real).toHaveLength(1)
    expect(real[0].target).toBe(edit)
  })

  it('counts a user edit of the head or the tail Text node the engine left', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    insertWrapHint(code.firstChild as Text, 5)
    const [head, , tail] = Array.from(code.childNodes) as Text[]
    const records = await recordsOf(document.body, () => {
      head.appendData('X')
      tail.insertData(0, 'Y')
    })
    expect(withoutOwnHintRecords(records)).toHaveLength(2)
  })

  it('counts the removal of a Text node whose data a user changed', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    insertWrapHint(code.firstChild as Text, 5)
    const tail = code.lastChild as Text
    tail.data = 'edited'
    const records = await recordsOf(document.body, () => {
      tail.remove()
    })
    expect(withoutOwnHintRecords(records)).toHaveLength(1)
  })

  it('does not trust a hint span it did not create (a restored snapshot is a real change)', async () => {
    const code = mount('<code>aaaa/bbbb</code>')
    const records = await recordsOf(document.body, () => {
      code.insertAdjacentHTML('beforeend', HINT)
    })
    expect(withoutOwnHintRecords(records)).toHaveLength(1)
  })

  it('counts the removal of a hint by anyone but the engine (a Preview morph, an Undo restore)', async () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    insertWrapHint(code.firstChild as Text, 5)
    const span = code.querySelector('.vmde-wrap-hint') as HTMLElement
    const records = await recordsOf(document.body, () => {
      span.remove()
    })
    expect(withoutOwnHintRecords(records)).toHaveLength(1)
  })

  it('counts attribute records and unrelated nodes', async () => {
    const code = mount('<code>aaaa/bbbb</code>')
    const observer = new MutationObserver(() => undefined)
    observer.observe(document.body, {
      attributes: true,
      childList: true,
      subtree: true,
    })
    code.setAttribute('data-x', '1')
    code.append(document.createElement('em'))
    const records = observer.takeRecords()
    expect(withoutOwnHintRecords(records)).toHaveLength(2)
  })
})

describe('insert and clear keep the caret', () => {
  // jsdom's Node.normalize does not move live ranges (Chromium does, per the DOM spec), so the
  // clear half of this contract is asserted in the Chromium spec (wrap-hints.spec.ts).
  it('keeps a collapsed caret on the same character through insert', () => {
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    const text = code.firstChild as Text
    const selection = window.getSelection()
    selection?.collapse(text, 7)
    const offsetOfCaret = (): number => {
      const range = document.createRange()
      range.setStart(code, 0)
      range.setEnd(selection!.anchorNode as Node, selection!.anchorOffset)
      return range.toString().length
    }
    expect(offsetOfCaret()).toBe(7)
    insertWrapHint(code.firstChild as Text, 10)
    insertWrapHint(code.firstChild as Text, 5)
    expect(offsetOfCaret()).toBe(7)
  })

  it('clearWrapHints reports nothing to do on a clean element', () => {
    const code = mount('<code>aaaa/bbbb</code>')
    expect(clearWrapHints(code)).toBe(false)
  })
})

// Task 640 S2b perf: the profile on a path-dense document showed ~60 observers waking per hint
// write batch (several walk the whole document), so observers are made blind to the engine's
// own records at their source.
describe('installWrapHintRecordFilter', () => {
  let uninstall: (() => void) | undefined
  afterEach(() => {
    uninstall?.()
    uninstall = undefined
  })

  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

  it('does not call an observer for a batch that holds only hint writes', async () => {
    uninstall = installWrapHintRecordFilter()
    const code = mount('<code>aaaa/bbbb/cccc</code>')
    const seen: MutationRecord[][] = []
    const observer = new MutationObserver((records) => seen.push(records))
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    insertWrapHint(code.firstChild as Text, 5)
    clearWrapHints(code)
    await flush()
    expect(seen).toEqual([])
    observer.disconnect()
  })

  it('hands an observer only the real records of a mixed batch, and filters takeRecords', async () => {
    uninstall = installWrapHintRecordFilter()
    const code = mount('<code>aaaa/bbbb/cccc</code><span id="x">z</span>')
    const edit = document.getElementById('x')?.firstChild as Text
    const seen: MutationRecord[][] = []
    const observer = new MutationObserver((records) => seen.push(records))
    observer.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    insertWrapHint(code.firstChild as Text, 5)
    edit.appendData('!')
    await flush()
    expect(seen).toHaveLength(1)
    expect(seen[0]).toHaveLength(1)
    expect(seen[0][0].target).toBe(edit)

    insertWrapHint(code.lastChild as Text, 3)
    expect(observer.takeRecords()).toEqual([])
    edit.appendData('?')
    expect(observer.takeRecords()).toHaveLength(1)
    observer.disconnect()
  })

  it('is idempotent and restores the native observer when uninstalled', () => {
    const Native = window.MutationObserver
    uninstall = installWrapHintRecordFilter()
    expect(installWrapHintRecordFilter()).toBe(uninstall)
    expect(window.MutationObserver).not.toBe(Native)
    expect(new MutationObserver(() => undefined)).toBeInstanceOf(Native)
    uninstall()
    uninstall = undefined
    expect(window.MutationObserver).toBe(Native)
  })
})
