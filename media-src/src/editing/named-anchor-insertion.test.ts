// @vitest-environment jsdom

import { afterEach, expect, it, vi } from 'vitest'
import {
  configureNamedAnchorInsertion,
  installNamedAnchorInsertion,
} from './named-anchor-insertion'

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

it('maps retained WYSIWYG endpoints after More focus replaces the live range', () => {
  document.body.innerHTML =
    '<div class="vditor-toolbar"><button data-type="more">More</button><button data-type="insert-anchor">Insert anchor</button></div><div class="vditor-wysiwyg"><p>prefix target prefix target prefix target</p></div>'
  const toolbar = document.querySelector<HTMLElement>('.vditor-toolbar')!
  const more = document.querySelector<HTMLButtonElement>('[data-type="more"]')!
  const action = document.querySelector<HTMLButtonElement>(
    '[data-type="insert-anchor"]',
  )!
  const editor = document.querySelector<HTMLElement>('.vditor-wysiwyg')!
  const text = editor.querySelector('p')!.firstChild as Text
  let markdown = text.data
  const outer = {
    getCurrentMode: () => 'wysiwyg',
    getValue: () => markdown,
    setValue: (next: string) => {
      markdown = next
    },
    focus: () => undefined,
    vditor: {
      currentMode: 'wysiwyg',
      wysiwyg: { element: editor },
      lute: {
        VditorDOM2Md: (html: string) => {
          const scratch = document.createElement('div')
          scratch.innerHTML = html
          return scratch.textContent ?? ''
        },
        VditorIRDOM2Md: (html: string) => html,
      },
      undo: { addToUndoStack: () => undefined },
      toolbar: {
        element: toolbar,
        elements: { preview: document.createElement('div') },
      },
    },
  }
  ;(window as unknown as { vditor: unknown }).vditor = outer
  vi.stubGlobal('requestAnimationFrame', () => 1)
  configureNamedAnchorInsertion({
    setApplying: () => undefined,
    postExact: () => undefined,
    onError: (error) => {
      throw error
    },
  })
  dispose = installNamedAnchorInsertion()

  const range = document.createRange()
  range.setStart(text, 'prefix target prefix '.length)
  range.collapse(true)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))

  more.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  more.focus()
  const reset = document.createRange()
  reset.setStart(text, 0)
  reset.collapse(true)
  selection.removeAllRanges()
  selection.addRange(reset)
  document.dispatchEvent(new Event('selectionchange'))
  action.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  document.dispatchEvent(new CustomEvent('vmde-insert-named-anchor'))

  const dialog = document.querySelector<HTMLFormElement>(
    '[data-vmde-anchor-dialog]',
  )!
  const input = dialog.elements.namedItem('anchor-name') as HTMLInputElement
  input.value = 'wys-repeat'
  dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))

  expect(markdown).toBe(
    'prefix target prefix <a name="wys-repeat"></a>target prefix target',
  )
})
