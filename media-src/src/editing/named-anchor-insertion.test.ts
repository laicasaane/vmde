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

it('maps retained WYSIWYG endpoints after More focus replaces the live range', async () => {
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
    acquireExactAuthority: async () => ({
      exact: markdown,
      rendered: markdown,
    }),
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
  // Task 642: only the visible strings are renamed; the control name stays for Task 644.
  expect(dialog.getAttribute('aria-label')).toBe('Insert ID')
  expect(dialog.querySelector('label')?.firstChild?.textContent).toBe('ID ')
  const input = dialog.elements.namedItem('anchor-name') as HTMLInputElement
  input.value = 'wys-repeat'
  dialog.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await new Promise((done) => setTimeout(done, 10))

  expect(markdown).toBe(
    'prefix target prefix <a name="wys-repeat"></a>target prefix target',
  )
})

// Task 630 S1 (RED): the dialog acquires exact authority on submit, plans on the acquired exact
// text and posts with a rollback. The module has no acquire seam yet, so `acquireExactAuthority` and
// `postExact(markdown, opts)` are declared here and cast onto the product type.
interface ExactEdit {
  rollback?: { restore(): void }
  before?: string
}
type AcquiredPair = { exact: string; rendered: string }
type ExactDeps = Parameters<typeof configureNamedAnchorInsertion>[0] & {
  acquireExactAuthority(): Promise<AcquiredPair | null>
  postExact(markdown: string, opts?: ExactEdit): void
}

// Extra blank lines normalize away, so a rendered offset differs from the host offset.
const HOST_EXACT = 'Alpha\n\n\n\nBeta target\n\n* * *\n\nGamma\n'
const RENDERED = 'Alpha\n\nBeta target\n\n---\n\nGamma\n'

function anchorHarness(acquire: () => Promise<AcquiredPair | null>) {
  document.body.innerHTML =
    '<div class="vditor-toolbar"><button data-type="more">More</button><button data-type="insert-anchor">Insert anchor</button></div><div class="vditor-wysiwyg"><p></p></div>'
  const toolbar = document.querySelector<HTMLElement>('.vditor-toolbar')!
  const more = document.querySelector<HTMLButtonElement>('[data-type="more"]')!
  const action = document.querySelector<HTMLButtonElement>(
    '[data-type="insert-anchor"]',
  )!
  const editor = document.querySelector<HTMLElement>('.vditor-wysiwyg')!
  const paragraph = editor.querySelector('p')!
  paragraph.textContent = RENDERED
  const text = paragraph.firstChild as Text
  const host = { text: HOST_EXACT, owned: null as string | null, restored: 0 }
  let shown = RENDERED
  const setValue = vi.fn((next: string) => {
    shown = next
  })
  const outer = {
    getCurrentMode: () => 'wysiwyg',
    getValue: () => shown,
    setValue,
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
  const acquireExactAuthority = vi.fn(acquire)
  const postExact = vi.fn((markdown: string, opts?: ExactEdit) => {
    const before = opts?.before ?? host.owned
    if (before !== host.text) {
      shown = host.text
      opts?.rollback?.restore()
      host.restored++
      return
    }
    host.text = markdown
    host.owned = markdown
  })
  configureNamedAnchorInsertion({
    setApplying: () => undefined,
    postExact,
    snapshotMarkdown: () => RENDERED,
    acquireExactAuthority,
    onError: (error) => {
      throw error
    },
  } as ExactDeps)
  dispose = installNamedAnchorInsertion()

  const range = document.createRange()
  range.setStart(text, RENDERED.indexOf('Gamma'))
  range.collapse(true)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  document.dispatchEvent(new Event('selectionchange'))
  more.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  action.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  document.dispatchEvent(new CustomEvent('vmde-insert-named-anchor'))
  const submit = async () => {
    const dialog = document.querySelector<HTMLFormElement>(
      '[data-vmde-anchor-dialog]',
    )!
    ;(dialog.elements.namedItem('anchor-name') as HTMLInputElement).value =
      'target-id'
    dialog.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    )
    // The delayed acquire case resolves on a timer, so settle past one macrotask too.
    await new Promise((done) => setTimeout(done, 10))
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
  }
  return {
    host,
    shown: () => shown,
    setValue,
    acquireExactAuthority,
    postExact,
    submit,
  }
}

it.each([
  ['after a trusted edit (host round trip)', true],
  ['on a fresh document (owned pair)', false],
] as const)(
  'Insert ID %s acquires on submit and splices into the acquired exact text',
  async (_name, delayed) => {
    const h = anchorHarness(async () => {
      if (delayed) await new Promise((done) => setTimeout(done, 1))
      h.host.owned = h.host.text
      return { exact: h.host.text, rendered: h.shown() }
    })
    await h.submit()

    expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
    expect(h.postExact).toHaveBeenCalledOnce()
    expect(h.postExact.mock.calls[0][1]).toEqual({
      rollback: { restore: expect.any(Function) },
    })
    // The anchor lands at the mapped host offset; every other byte stays the host's.
    expect(h.host.text).toBe(
      HOST_EXACT.replace('Gamma', '<a name="target-id"></a>Gamma'),
    )
  },
)

it('Insert ID refuses a stale host: no write, rollback runs, the DOM shows the host text', async () => {
  const drifted = `${HOST_EXACT}Delta\n`
  const h = anchorHarness(async () => {
    h.host.owned = h.host.text
    const pair = { exact: h.host.text, rendered: h.shown() }
    h.host.text = drifted
    return pair
  })
  await h.submit()

  expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(h.postExact.mock.calls[0][1]).toEqual({
    rollback: { restore: expect.any(Function) },
  })
  expect(h.host.restored).toBe(1)
  expect(h.host.text).toBe(drifted)
  expect(h.shown()).toBe(drifted)
})

it('Insert ID declines without a write or a DOM change when acquisition fails', async () => {
  const h = anchorHarness(async () => null)
  await h.submit()

  expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(h.setValue).not.toHaveBeenCalled()
  expect(h.postExact).not.toHaveBeenCalled()
  expect(h.shown()).toBe(RENDERED)
})

it('Insert ID declines when the host rendering moved while the dialog was open', async () => {
  const h = anchorHarness(async () => ({
    exact: `${HOST_EXACT}Moved\n`,
    rendered: `${RENDERED}Moved\n`,
  }))
  await h.submit()

  expect(h.acquireExactAuthority).toHaveBeenCalledOnce()
  expect(h.setValue).not.toHaveBeenCalled()
  expect(h.postExact).not.toHaveBeenCalled()
})
