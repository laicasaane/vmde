// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRealLute } from '../testing/real-lute'
import { applyCaretInside, CARET_INSIDE_CLASS, linkLikeAt } from './caret-link'
import { applyCodeRefs } from './code-ref-decorate'
import {
  _resetCodeRefResolutionForTests,
  applyCodeRefResolution,
  requestCodeRefResolution,
} from './code-ref-resolve'
import { reintroduceChips, rewriteWikiChipsToSource } from './wiki-serialize'

afterEach(() => {
  _resetCodeRefResolutionForTests()
  vi.useRealTimers()
})

for (const mode of ['ir', 'wysiwyg'] as const) {
  describe(`caret class real-Lute parity: ${mode}`, () => {
    const lute = createRealLute(mode)
    const rootFor = (source: string) => {
      const root = document.createElement('pre')
      root.className = 'vditor-reset'
      root.innerHTML = lute.render(source)
      return root
    }
    const assertParity = (
      root: HTMLElement,
      targets: HTMLElement[],
      caretTarget = true,
    ) => {
      expect(targets.length).toBeGreaterThan(0)
      const before = lute.serialize(root.innerHTML)
      for (const target of targets) {
        expect(linkLikeAt(target)).toBe(caretTarget ? target : null)
        applyCaretInside(root, target)
        expect(target.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
        expect(lute.serialize(root.innerHTML)).toBe(before)
        applyCaretInside(root, null)
        expect(lute.serialize(root.innerHTML)).toBe(before)
      }
    }

    it.each([
      [
        'inline and title',
        'Before [label](https://example.test/a "title") after.\n',
        'a[href], .vditor-ir__link',
        true,
      ],
      [
        'reference',
        'Before [label][id] after.\n\n[id]: https://example.test/a "title"\n',
        '[data-type="link-ref"]',
        false,
      ],
      [
        'linked image',
        'Before [![alt](image.png)](https://example.test/a) after.\n',
        mode === 'ir' ? '[data-type="a"]' : 'a[href]',
        mode === 'wysiwyg',
      ],
      [
        'autolink',
        'Before <https://example.test/a> after.\n',
        'a[href], .vditor-ir__link',
        true,
      ],
    ] as const)(
      'serializes %s identically with and without the class',
      (_name, source, selector, caretTarget) => {
        const root = rootFor(source)
        // Reference spans and IR image-only links are not current caret targets.
        // Still reproduce the scratch probe's broader serializer claim explicitly.
        assertParity(
          root,
          [...root.querySelectorAll<HTMLElement>(selector)],
          caretTarget,
        )
      },
    )

    it('preserves inline-code and prose code references decorated by the real adapter', () => {
      vi.useFakeTimers()
      const post = vi.fn()
      requestCodeRefResolution('src/a.ts', post)
      vi.advanceTimersByTime(50)
      applyCodeRefResolution(post.mock.calls[0][0].requestId, ['src/a.ts'])
      const root = rootFor('See src/a.ts:1 and `src/a.ts:2`.\n')
      applyCodeRefs(root, post)
      const targets = [
        ...root.querySelectorAll<HTMLElement>('[data-code-ref="1"]'),
      ]
      expect(targets.map((target) => target.nodeName)).toEqual(['SPAN', 'CODE'])
      assertParity(root, targets)
    })

    it('rewrites a classed wiki chip to the same exact source before real serialization', () => {
      const root = rootFor('See [[Home|display]] after.\n')
      root.innerHTML = reintroduceChips(root.innerHTML)
      const chip = root.querySelector<HTMLElement>('[data-wiki-link="1"]')!
      expect(chip).not.toBeNull()
      const before = rewriteWikiChipsToSource(root.innerHTML)
      const markdown = lute.serialize(before)
      applyCaretInside(root, chip)
      expect(linkLikeAt(chip)).toBe(chip)
      expect(chip.classList.contains(CARET_INSIDE_CLASS)).toBe(true)
      expect(rewriteWikiChipsToSource(root.innerHTML)).toBe(before)
      expect(lute.serialize(rewriteWikiChipsToSource(root.innerHTML))).toBe(
        markdown,
      )
      expect(markdown).toContain('[[Home|display]]')
      applyCaretInside(root, null)
      expect(lute.serialize(rewriteWikiChipsToSource(root.innerHTML))).toBe(
        markdown,
      )
    })
  })
}
