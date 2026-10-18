// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearWrapHints,
  createWrapHintSpan,
  insertWrapHint,
  installWrapHintRecordFilter,
  hintMeasureClone,
  isOwnHintRecord,
  requestWrapHintReplan,
  setMeasureCloneHinter,
  stripWrapHints,
  stripWrapHintsWithin,
  WRAP_HINT_REPLAN_EVENT,
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

// Task 640 S2d: the seam between the table layout (chrome) and the hint engine (editing).
describe('table measurement clones (Task 640 S2d, Task 639 interaction)', () => {
  it('stripWrapHintsWithin removes every hint below the root, at any depth, and merges the text again', () => {
    document.body.innerHTML = `<table><tbody><tr><td>aaaa/${HINT}bbbb</td><td><code>cc/${HINT}dd${HINT}ee</code></td></tr></tbody></table>`
    const table = document.querySelector('table') as HTMLTableElement
    expect(stripWrapHintsWithin(table)).toBe(true)
    expect(table.querySelectorAll('.vmde-wrap-hint')).toHaveLength(0)
    expect(table.textContent).toBe('aaaa/bbbbcc/ddee')
    expect(table.querySelector('td')?.childNodes).toHaveLength(1)
    expect(table.querySelector('code')?.childNodes).toHaveLength(1)
  })

  it('stripWrapHintsWithin changes nothing and reports false for a table without hints', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td>aaaa/bbbb</td></tr></tbody></table>'
    const table = document.querySelector('table') as HTMLTableElement
    const before = table.innerHTML
    expect(stripWrapHintsWithin(table)).toBe(false)
    expect(table.innerHTML).toBe(before)
  })

  it('hintMeasureClone does nothing without a registered hinter and calls the hinter with the layout it was given', () => {
    document.body.innerHTML =
      '<table><tbody><tr><td>a</td></tr></tbody></table>'
    const clone = document.querySelector('table') as HTMLTableElement
    expect(() => hintMeasureClone(clone, [10], 20)).not.toThrow()
    const calls: unknown[][] = []
    const unregister = setMeasureCloneHinter((...args) => calls.push(args))
    hintMeasureClone(clone, [10, 12], 20)
    expect(calls).toEqual([[clone, [10, 12], 20]])
    unregister()
    hintMeasureClone(clone, [10], 20)
    expect(calls).toHaveLength(1)
  })

  it('requestWrapHintReplan reaches a listener on an ancestor with the table as the event target', () => {
    document.body.innerHTML =
      '<div id="surface"><table><tbody><tr><td>a</td></tr></tbody></table></div>'
    const surface = document.getElementById('surface') as HTMLElement
    const targets: EventTarget[] = []
    surface.addEventListener(WRAP_HINT_REPLAN_EVENT, (event) =>
      targets.push(event.target as EventTarget),
    )
    const table = surface.querySelector('table') as HTMLTableElement
    requestWrapHintReplan(table)
    expect(targets).toEqual([table])
  })
})
