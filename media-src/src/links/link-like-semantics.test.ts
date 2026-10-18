// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { applyLinkLikeSemantics } from './link-like-semantics'

describe('injected link-like semantics', () => {
  it('labels wiki, missing-wiki, prose code-ref, and inline-code ref shapes', () => {
    document.body.innerHTML = `
      <div id="root">
        <span data-wiki-link="1" data-wiki-target="Home">Home</span>
        <span data-wiki-link="1" data-wiki-target="Missing" data-wiki-missing="1">Missing</span>
        <span data-code-ref="1" data-code-ref-path="src/a.ts" data-code-ref-line="4" data-code-ref-col="2">src/a.ts:4:2</span>
        <code data-code-ref="1" data-code-ref-path="src/b.ts" data-code-ref-line="9">src/b.ts:9</code>
      </div>`
    const root = document.getElementById('root')!

    applyLinkLikeSemantics(root)

    const elements = root.querySelectorAll<HTMLElement>(
      '[data-wiki-link], [data-code-ref]',
    )
    expect(
      [...elements].map((element) => element.getAttribute('role')),
    ).toEqual(['link', 'link', 'link', 'link'])
    expect(
      [...elements].map((element) => element.getAttribute('aria-label')),
    ).toEqual([
      'Open wiki page Home',
      'Missing wiki page Missing',
      'Open code reference src/a.ts, line 4, column 2',
      'Open code reference src/b.ts, line 9',
    ])
  })

  it('labels a bare URL span with its href (Task 655)', () => {
    document.body.innerHTML = `
      <div id="root"><span class="vmde-bare-url" data-bare-url="1" data-bare-url-href="mailto:a@b.co">a@b.co</span></div>`
    const root = document.getElementById('root')!
    applyLinkLikeSemantics(root)
    const span = root.querySelector<HTMLElement>('[data-bare-url]')!
    expect(span.getAttribute('role')).toBe('link')
    expect(span.getAttribute('aria-label')).toBe('Open link mailto:a@b.co')
  })

  it('is idempotent and leaves ordinary prose unchanged', () => {
    document.body.innerHTML = '<p id="root">ordinary prose</p>'
    const root = document.getElementById('root')!
    applyLinkLikeSemantics(root)
    applyLinkLikeSemantics(root)
    expect(root.attributes).toHaveLength(1)
    expect(root.textContent).toBe('ordinary prose')
  })
})
