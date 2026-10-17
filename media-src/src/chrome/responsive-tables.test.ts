// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixResponsiveTables } from './responsive-tables'

function mountTables(): {
  firstBlock: HTMLElement
  first: HTMLTableElement
  second: HTMLTableElement
} {
  document.body.innerHTML = `<div class="vditor"><pre class="vditor-reset">
    <div id="first-block" data-block="0"><table id="first"><tbody><tr><td>A</td></tr></tbody></table></div>
    <div id="second-block" data-block="0"><table id="second"><tbody><tr><td>B</td></tr></tbody></table></div>
  </pre></div>`
  return {
    firstBlock: document.getElementById('first-block')!,
    first: document.getElementById('first') as HTMLTableElement,
    second: document.getElementById('second') as HTMLTableElement,
  }
}

async function flushMutationAndDebounce(): Promise<void> {
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(16)
}

describe('fixResponsiveTables mutation locality', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.useRealTimers()
    document.body.replaceChildren()
  })

  it('normalizes only the table inside the block changed by a mutation batch', async () => {
    const { first, second } = mountTables()
    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    const unrelatedRemove = vi.spyOn(second, 'removeAttribute')

    first.tBodies[0].appendChild(document.createElement('tr'))
    await flushMutationAndDebounce()

    expect(first.style.width).toBe(
      'calc(100% - var(--vmde-indent-offset, 0px))',
    )
    expect(unrelatedRemove).not.toHaveBeenCalled()
  })

  it('keeps window resize as a deliberate full-table normalization', async () => {
    const { second } = mountTables()
    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()
    const remove = vi.spyOn(second, 'removeAttribute')

    window.dispatchEvent(new Event('resize'))
    await vi.advanceTimersByTimeAsync(16)

    expect(remove).toHaveBeenCalledWith('width')
  })

  it('does not override an important details hidden-state display', async () => {
    const { first } = mountTables()
    const style = document.createElement('style')
    style.textContent =
      '.vditor-reset [data-vmde-details-hidden] { display: none !important; }'
    document.body.prepend(style)
    first.setAttribute('data-vmde-details-hidden', '')

    fixResponsiveTables()
    await flushMutationAndDebounce()
    await flushMutationAndDebounce()

    expect(getComputedStyle(first).display).toBe('none')
    first.removeAttribute('data-vmde-details-hidden')
    expect(getComputedStyle(first).display).toBe('table')
  })
})
