// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { installSourcePaneState } from './source-pane-state'

// Task 733 (task 002): the writer behind `.vditor-content[data-vmde-source-pane="hidden"]`.
const ATTR = 'data-vmde-source-pane'

function makeContent(): HTMLElement {
  const content = document.createElement('div')
  content.className = 'vditor-content'
  document.body.append(content)
  return content
}

function makeSv(display?: string): HTMLElement {
  const sv = document.createElement('div')
  sv.className = 'vditor-sv'
  if (display) sv.style.display = display
  return sv
}

const flush = () => Promise.resolve()

afterEach(() => {
  document.body.replaceChildren()
})

describe('installSourcePaneState', () => {
  it('is hidden at install when there is no .vditor-sv (synchronously)', () => {
    const content = makeContent()
    const dispose = installSourcePaneState(content)
    expect(content.getAttribute(ATTR)).toBe('hidden')
    dispose()
  })

  it('is absent at install when .vditor-sv is shown, hidden when its display is none', () => {
    const shown = makeContent()
    shown.append(makeSv('block'))
    installSourcePaneState(shown)
    expect(shown.hasAttribute(ATTR)).toBe(false)

    const hidden = makeContent()
    hidden.append(makeSv('none'))
    installSourcePaneState(hidden)
    expect(hidden.getAttribute(ATTR)).toBe('hidden')
  })

  it('follows .vditor-sv added, hidden, shown and removed', async () => {
    const content = makeContent()
    installSourcePaneState(content)
    expect(content.getAttribute(ATTR)).toBe('hidden')

    const sv = makeSv('block')
    content.append(sv)
    await flush()
    expect(content.hasAttribute(ATTR)).toBe(false)

    sv.style.display = 'none'
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')

    sv.style.display = 'block'
    await flush()
    expect(content.hasAttribute(ATTR)).toBe(false)

    sv.remove()
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
  })

  it('treats the display:none form without a space the same way', async () => {
    const content = makeContent()
    const sv = makeSv('block')
    content.append(sv)
    installSourcePaneState(content)
    sv.setAttribute('style', 'display:none')
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
  })

  it('re-attaches the style observer when .vditor-sv is replaced', async () => {
    const content = makeContent()
    const first = makeSv('block')
    content.append(first)
    installSourcePaneState(content)

    const second = makeSv('block')
    first.replaceWith(second)
    await flush()
    expect(content.hasAttribute(ATTR)).toBe(false)

    second.style.display = 'none'
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')

    // The replaced element no longer drives the state.
    first.style.display = 'block'
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
  })

  it('ignores a .vditor-sv deeper than a direct child (no subtree)', async () => {
    const content = makeContent()
    installSourcePaneState(content)
    const wrapper = document.createElement('div')
    wrapper.append(makeSv('block'))
    content.append(wrapper)
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
  })

  it('runs no callback after dispose', async () => {
    const content = makeContent()
    const sv = makeSv('block')
    content.append(sv)
    const dispose = installSourcePaneState(content)
    dispose()
    sv.style.display = 'none'
    sv.remove()
    await flush()
    expect(content.hasAttribute(ATTR)).toBe(false)
  })

  it('a second install on the same element after the first dispose keeps one live writer', async () => {
    const content = makeContent()
    const sv = makeSv('block')
    content.append(sv)
    const first = installSourcePaneState(content)
    first()
    const second = installSourcePaneState(content)
    sv.style.display = 'none'
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
    second()
    sv.style.display = 'block'
    await flush()
    expect(content.getAttribute(ATTR)).toBe('hidden')
  })
})
