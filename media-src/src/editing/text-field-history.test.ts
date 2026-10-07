// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyTextFieldHistory,
  installTextFieldHistory,
  isTextField,
  resetTextFieldHistory,
} from './text-field-history'

// Task 603 item 2 (Amendment 3) — the VMDE-owned history of the webview's text fields. jsdom
// events are never trusted, so the recording listeners are driven with trusted-shaped event
// objects through a stub document that keeps the listeners it was given; real jsdom fields carry
// the value and selection, and `applyTextFieldHistory` dispatches real events on them.
describe('text field history', () => {
  let field: HTMLInputElement
  let dispose: () => void
  const listeners = new Map<string, (event: unknown) => void>()

  function fire(type: string, init: Record<string, unknown> = {}) {
    listeners.get(type)?.({
      type,
      target: field,
      isTrusted: true,
      isComposing: false,
      inputType: 'insertText',
      ...init,
    })
  }

  // One user edit: beforeinput, the value change the browser makes, then input.
  function edit(
    next: string,
    selection?: [number, number],
    init: Record<string, unknown> = {},
  ) {
    fire('beforeinput', init)
    field.value = next
    const caret = selection ?? [next.length, next.length]
    field.setSelectionRange(caret[0], caret[1])
    fire('input', init)
  }

  const type = (text: string) => {
    for (const char of text) edit(field.value + char)
  }

  function installFake() {
    const doc = {
      addEventListener: (name: string, fn: (event: unknown) => void) =>
        listeners.set(name, fn),
      removeEventListener: (name: string) => listeners.delete(name),
    }
    dispose = installTextFieldHistory(doc as unknown as Document)
  }

  beforeEach(() => {
    field = document.createElement('input')
    field.type = 'text'
    document.body.append(field)
    installFake()
  })
  afterEach(() => {
    dispose()
    field.remove()
    listeners.clear()
  })

  it('undoes and redoes a typed edit with its selection, one entry per edit', () => {
    type('abc')
    expect(applyTextFieldHistory(field, 'undo')).toBe(true)
    expect(field.value).toBe('ab')
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2])
    expect(applyTextFieldHistory(field, 'undo')).toBe(true)
    expect(applyTextFieldHistory(field, 'undo')).toBe(true)
    expect(field.value).toBe('')
    // The history is exhausted: nothing happens.
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('')
    expect(applyTextFieldHistory(field, 'redo')).toBe(true)
    expect(field.value).toBe('a')
    expect(applyTextFieldHistory(field, 'redo')).toBe(true)
    expect(applyTextFieldHistory(field, 'redo')).toBe(true)
    expect(field.value).toBe('abc')
    expect([field.selectionStart, field.selectionEnd]).toEqual([3, 3])
    expect(applyTextFieldHistory(field, 'redo')).toBe(false)
  })

  it('restores the replaced selection on Undo and the caret after the edit on Redo', () => {
    type('hello')
    // Select "ell", then replace it with "a".
    field.setSelectionRange(1, 4)
    edit('hao', [2, 2], { inputType: 'insertText' })
    // `edit` took the selection AFTER the setSelectionRange above, as the browser would.
    expect(applyTextFieldHistory(field, 'undo')).toBe(true)
    expect(field.value).toBe('hello')
    expect([field.selectionStart, field.selectionEnd]).toEqual([1, 4])
    expect(applyTextFieldHistory(field, 'redo')).toBe(true)
    expect(field.value).toBe('hao')
    expect([field.selectionStart, field.selectionEnd]).toEqual([2, 2])
  })

  it('dispatches a bubbling input event of type historyUndo or historyRedo', () => {
    type('a')
    const seen: { inputType: string; trusted: boolean; target: unknown }[] = []
    const onInput = (event: Event) =>
      seen.push({
        inputType: (event as InputEvent).inputType,
        trusted: event.isTrusted,
        target: event.target,
      })
    document.addEventListener('input', onInput)
    applyTextFieldHistory(field, 'undo')
    applyTextFieldHistory(field, 'redo')
    document.removeEventListener('input', onInput)
    expect(seen).toEqual([
      { inputType: 'historyUndo', trusted: false, target: field },
      { inputType: 'historyRedo', trusted: false, target: field },
    ])
  })

  it('does nothing and fires nothing for an empty history', () => {
    const onInput = vi.fn()
    field.addEventListener('input', onInput)
    field.value = 'seed'
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(applyTextFieldHistory(field, 'redo')).toBe(false)
    expect(field.value).toBe('seed')
    expect(onInput).not.toHaveBeenCalled()
  })

  it('clears the Redo stack when a new edit follows an Undo', () => {
    type('ab')
    applyTextFieldHistory(field, 'undo')
    edit('aQ')
    expect(applyTextFieldHistory(field, 'redo')).toBe(false)
    expect(field.value).toBe('aQ')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('a')
  })

  it('treats a value written by the app as the new base (drift reset)', () => {
    type('abc')
    // Find's seed: a programmatic value, with no event.
    field.value = 'seed'
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('seed')
    // Typing on top of the seed: Undo returns to the seed, not to the older typing.
    edit('seedX')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('seed')
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
  })

  it('starts afresh on an explicit reset, even for a written value equal to the last one', () => {
    type('abc')
    // The app writes the same text it already holds (Find reopened with an equal seed).
    field.value = 'abc'
    resetTextFieldHistory(field)
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('abc')
    // Redo is gone too, and recording starts from the seed.
    edit('abcd')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('abc')
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
  })

  it('clears the Redo stack on a reset', () => {
    type('ab')
    applyTextFieldHistory(field, 'undo')
    resetTextFieldHistory(field)
    expect(applyTextFieldHistory(field, 'redo')).toBe(false)
  })

  it('a reset of a field never seen is a no-op', () => {
    const fresh = document.createElement('input')
    expect(() => resetTextFieldHistory(fresh)).not.toThrow()
  })

  it('resets at the next edit when the value drifted before it', () => {
    type('abc')
    field.value = 'zzz'
    edit('zzzq')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('zzz')
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
  })

  it('records one entry for a whole composition, and Undo during it does nothing', () => {
    type('a')
    fire('compositionstart')
    // Composition edits are skipped one by one.
    edit('a日', undefined, { isComposing: true })
    edit('a日本', undefined, { isComposing: true })
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('a日本')
    fire('compositionend')
    expect(applyTextFieldHistory(field, 'undo')).toBe(true)
    expect(field.value).toBe('a')
    expect(applyTextFieldHistory(field, 'redo')).toBe(true)
    expect(field.value).toBe('a日本')
    applyTextFieldHistory(field, 'undo')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('')
  })

  it('records no entry for a composition that changed nothing', () => {
    type('a')
    fire('compositionstart')
    fire('compositionend')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('')
  })

  it('ignores untrusted events, composing events and history input types', () => {
    edit('x', undefined, { isTrusted: false })
    edit('xy', undefined, { isComposing: true })
    edit('xyz', undefined, { inputType: 'historyUndo' })
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('xyz')
  })

  it('drops the history when an input arrives with no beforeinput before it', () => {
    type('ab')
    field.value = 'abc'
    fire('input')
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
    expect(field.value).toBe('abc')
    // Recording works again afterwards.
    edit('abcd')
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('abc')
  })

  it('keeps at most 100 entries, dropping the oldest', () => {
    type('x'.repeat(120))
    let undone = 0
    while (applyTextFieldHistory(field, 'undo')) undone++
    expect(undone).toBe(100)
    expect(field.value).toBe('x'.repeat(20))
  })

  it('keeps a separate history per field', () => {
    const other = document.createElement('textarea')
    document.body.append(other)
    type('ab')
    fire('beforeinput', { target: other })
    other.value = 'Q'
    fire('input', { target: other })
    applyTextFieldHistory(field, 'undo')
    expect(field.value).toBe('a')
    expect(other.value).toBe('Q')
    expect(applyTextFieldHistory(other, 'undo')).toBe(true)
    expect(other.value).toBe('')
    other.remove()
  })

  it('restores the value of a type that exposes no selection', () => {
    const email = document.createElement('input')
    email.type = 'email'
    document.body.append(email)
    fire('beforeinput', { target: email })
    email.value = 'a@b.c'
    fire('input', { target: email })
    expect(() => applyTextFieldHistory(email, 'undo')).not.toThrow()
    expect(email.value).toBe('')
    email.remove()
  })

  it('keeps the restored value when the field rejects the selection', () => {
    type('ab')
    vi.spyOn(field, 'setSelectionRange').mockImplementation(() => {
      throw new DOMException('no selection', 'InvalidStateError')
    })
    expect(() => applyTextFieldHistory(field, 'undo')).not.toThrow()
    expect(field.value).toBe('a')
  })

  it('stops recording after the disposer runs', () => {
    dispose()
    expect(listeners.size).toBe(0)
    installFake()
  })

  it('ignores events whose target is not a text field', () => {
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    fire('beforeinput', { target: checkbox })
    fire('input', { target: checkbox })
    fire('compositionstart', { target: document.body })
    fire('compositionend', { target: document.body })
    expect(applyTextFieldHistory(field, 'undo')).toBe(false)
  })

  describe('isTextField', () => {
    it.each(['text', 'search', 'url', 'email', 'tel', 'password'])(
      'accepts an input of type %s',
      (kind) => {
        const input = document.createElement('input')
        input.type = kind
        expect(isTextField(input)).toBe(true)
      },
    )
    it('accepts a textarea', () => {
      expect(isTextField(document.createElement('textarea'))).toBe(true)
    })
    it.each(['checkbox', 'number', 'button', 'radio'])(
      'rejects an input of type %s',
      (kind) => {
        const input = document.createElement('input')
        input.type = kind
        expect(isTextField(input)).toBe(false)
      },
    )
    it('rejects other elements and null', () => {
      expect(isTextField(document.createElement('div'))).toBe(false)
      expect(isTextField(null)).toBe(false)
    })
  })
})
