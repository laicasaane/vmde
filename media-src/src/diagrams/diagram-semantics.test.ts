// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ENGINES } from '../diagram-kit/engine-registry'
import {
  applyDiagramSemantics,
  observeDiagramSemantics,
} from './diagram-semantics'
import { installScreenReaderSemantics } from '../util/screen-reader'

describe('diagram screen-reader semantics', () => {
  beforeEach(() => {
    document.body.innerHTML =
      '<div id="app"><div class="vditor-preview"></div></div>'
    installScreenReaderSemantics('diagram.md')
  })

  it('labels every registry-declared diagram wrapper from its first source line', () => {
    const preview = document.querySelector('.vditor-preview')!
    const diagrams = ENGINES.filter((engine) => engine.diagram)
    for (const engine of diagrams) {
      const wrapper = document.createElement('div')
      wrapper.className = `language-${engine.lang}`
      wrapper.dataset.processed = 'true'
      wrapper.dataset.code = `first ${engine.lang} line\nsecond line`
      wrapper.innerHTML = '<svg></svg>'
      preview.append(wrapper)
    }

    applyDiagramSemantics(document.getElementById('app')!)

    for (const engine of diagrams) {
      const wrapper = preview.querySelector<HTMLElement>(
        `.language-${engine.lang}`,
      )!
      expect(wrapper.getAttribute('role')).toBe('figure')
      expect(wrapper.getAttribute('aria-label')).toBe(
        `${engine.errorTitle} diagram`,
      )
      const visual = wrapper.querySelector('svg')!
      expect(visual.getAttribute('role')).toBe('img')
      expect(visual.getAttribute('aria-label')).toBe(
        `${engine.errorTitle} diagram: first ${engine.lang} line`,
      )
    }
  })

  it('announces a newly rendered diagram error through the one polite region', async () => {
    const preview = document.querySelector('.vditor-preview')!
    preview.innerHTML = `
      <div class="language-mermaid" data-processed="true" data-code="broken graph">
        <div class="vmde-diagram-error">
          <div class="vmde-diagram-error__title">Mermaid</div>
          <pre class="vmde-diagram-error__msg">Parse error</pre>
        </div>
      </div>`

    applyDiagramSemantics(document.getElementById('app')!)
    await Promise.resolve()

    expect(document.getElementById('vmde-live-region')?.textContent).toBe(
      'Mermaid diagram error: Parse error',
    )
  })

  // Task 643: a streamed Preview adds hundreds of whitespace text nodes per chunk under one large
  // parent. Searching that parent's whole subtree for a diagram for each of them was quadratic.
  it('does not search the parent subtree for a diagram when only a text node is added', async () => {
    const preview = document.querySelector<HTMLElement>('.vditor-preview')!
    preview.innerHTML = '<p>existing</p>'
    const stop = observeDiagramSemantics(document.getElementById('app'))
    const search = vi.spyOn(preview, 'querySelector')
    preview.append(document.createTextNode('\n'), document.createTextNode('\n'))
    await Promise.resolve()
    expect(search).not.toHaveBeenCalled()
    stop()
  })

  it('still notices a diagram element added later', async () => {
    const preview = document.querySelector<HTMLElement>('.vditor-preview')!
    const stop = observeDiagramSemantics(document.getElementById('app'))
    const wrapper = document.createElement('div')
    wrapper.innerHTML =
      '<div class="language-mermaid" data-processed="true" data-code="graph TD"><svg></svg></div>'
    preview.append(wrapper)
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)))
    expect(
      preview.querySelector('.language-mermaid')?.getAttribute('role'),
    ).toBe('figure')
    stop()
  })
})
