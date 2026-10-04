// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Task 580 CP2-10 — the heading and task commands send Vditor's former chord as a contained
// untrusted keydown on the active mode element; the edit-mode commands click the toolbar's mode
// choice. A listener on the mode element stands in for Vditor's own hotkey listener.
const h = vi.hoisted(() => ({
  root: null as HTMLElement | null,
  editMode: null as HTMLElement | null,
}))
vi.mock('../util/source-map', () => ({ activeModeElement: () => h.root }))
vi.mock('../util/inner-vditor', () => ({
  innerVditor: () => ({
    toolbar: { elements: h.editMode ? { 'edit-mode': h.editMode } : {} },
  }),
}))

import {
  EDIT_MODE_ACTIONS,
  runVditorChord,
  switchEditMode,
  VDITOR_CHORD_ACTIONS,
} from './vditor-chord-actions'

const chordFor = (action: string) =>
  VDITOR_CHORD_ACTIONS.find(([name]) => name === action)![1]

let root: HTMLElement
const removers: (() => void)[] = []

function listen(target: EventTarget, listener: (event: KeyboardEvent) => void) {
  const wrapped = (event: Event) => listener(event as KeyboardEvent)
  target.addEventListener('keydown', wrapped)
  removers.push(() => target.removeEventListener('keydown', wrapped))
}

beforeEach(() => {
  root = document.createElement('div')
  document.body.append(root)
  h.root = root
  h.editMode = null
  ;(window as any).vditor = {}
})

afterEach(() => {
  for (const remove of removers.splice(0)) remove()
  document.body.replaceChildren()
  delete (window as any).vditor
})

describe('VDITOR_CHORD_ACTIONS', () => {
  it('maps headings 1–6 and the task toggle to their former chords', () => {
    expect(VDITOR_CHORD_ACTIONS.map(([action]) => action)).toEqual([
      'heading-1',
      'heading-2',
      'heading-3',
      'heading-4',
      'heading-5',
      'heading-6',
      'toggle-task-checkbox',
    ])
    expect(chordFor('heading-5')).toEqual({
      key: '5',
      code: 'Digit5',
      altKey: true,
    })
    expect(EDIT_MODE_ACTIONS).toEqual([
      [
        'switch-to-wysiwyg',
        'wysiwyg',
        { key: '7', code: 'Digit7', altKey: true },
      ],
      ['switch-to-ir', 'ir', { key: '8', code: 'Digit8', altKey: true }],
      ['switch-to-sv', 'sv', { key: '9', code: 'Digit9', altKey: true }],
    ])
    expect(chordFor('toggle-task-checkbox')).toEqual({
      key: 'J',
      code: 'KeyJ',
      shiftKey: true,
    })
  })
})

describe('runVditorChord', () => {
  it('sends an untrusted Ctrl chord on Windows/Linux and keeps it on the mode element', () => {
    const seen = vi.fn((event: KeyboardEvent) => event.preventDefault())
    listen(root, seen)
    const bubbled = vi.fn()
    listen(window, bubbled)

    expect(runVditorChord(chordFor('heading-3'), false)).toBe(true)
    const event = seen.mock.calls[0][0]
    expect(event).toMatchObject({
      code: 'Digit3',
      ctrlKey: true,
      metaKey: false,
      altKey: true,
      shiftKey: false,
      isTrusted: false,
    })
    expect(bubbled).not.toHaveBeenCalled()
  })

  it('uses Cmd on macOS', () => {
    const seen = vi.fn()
    listen(root, seen)
    runVditorChord(chordFor('toggle-task-checkbox'), true)
    expect(seen.mock.calls[0][0]).toMatchObject({
      key: 'J',
      metaKey: true,
      ctrlKey: false,
      shiftKey: true,
    })
  })

  it('reports a chord Vditor did not handle', () => {
    expect(runVditorChord(chordFor('heading-4'), false)).toBe(false)
  })

  it('does nothing without an editor', () => {
    const seen = vi.fn()
    listen(root, seen)
    h.root = null
    expect(runVditorChord(chordFor('heading-1'), false)).toBe(false)
    delete (window as any).vditor
    h.root = root
    expect(runVditorChord(chordFor('heading-1'), false)).toBe(false)
    expect(seen).not.toHaveBeenCalled()
  })
})

describe('switchEditMode', () => {
  const chord = { key: '9', code: 'Digit9', altKey: true }

  it("clicks the toolbar's mode choice, so the choice is persisted and reported", () => {
    const item = document.createElement('div')
    item.innerHTML =
      '<button data-mode="wysiwyg"></button><button data-mode="sv"></button>'
    document.body.append(item)
    h.editMode = item
    const clicked = vi.fn()
    item.addEventListener('click', (event) =>
      clicked((event.target as HTMLElement).dataset.mode),
    )
    const keys = vi.fn()
    listen(root, keys)
    expect(switchEditMode('sv', chord)).toBe(true)
    expect(clicked).toHaveBeenCalledWith('sv')
    expect(keys).not.toHaveBeenCalled()
  })

  it('falls back to the former chord without the toolbar choice', () => {
    const keys = vi.fn((event: KeyboardEvent) => event.preventDefault())
    listen(root, keys)
    expect(switchEditMode('sv', chord)).toBe(true)
    expect(keys.mock.calls[0][0]).toMatchObject({
      code: 'Digit9',
      altKey: true,
      isTrusted: false,
    })
  })
})
