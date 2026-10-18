import type { Page } from '@playwright/test'
import { expect, test } from './coverage-fixture'

// Task 654: an inline raw HTML `<a href>` is shown as a link (underline, link color) in IR and
// WYSIWYG while the saved Markdown stays byte-identical. Fixture: html-subscript harness `?fixture=link`.

type Mode = 'ir' | 'wysiwyg'
const MODES: readonly Mode[] = ['ir', 'wysiwyg']
const PANE: Record<Mode, string> = {
  ir: '.vditor-ir .vditor-reset',
  wysiwyg: '.vditor-wysiwyg .vditor-reset',
}
// Accepted anchors (Preview renders them as `a[href]`): visible body text of each.
const ACCEPTED = [
  'plainlink',
  'attrslink',
  'amplink',
  'nestedbody',
  'onelink',
  'twolink',
  'emptytext',
  'reltext',
]
// Controls: no href, or an href Preview's sanitizer drops. They keep the source look.
const CONTROLS = ['idtext', 'nametext', 'jstext', 'datatext']

async function open(page: Page, mode: Mode, observe = true) {
  await page.goto(
    `/html-subscript.html?mode=${mode}&fixture=link${observe ? '' : '&observe=0'}`,
  )
  await page.waitForFunction(() => (window as any).__ready === true)
}
const getValue = (page: Page) =>
  page.evaluate(() => (window as any).vditor.getValue() as string)
const source = (page: Page) =>
  page.evaluate(() => (window as any).__source as string)

// Value of the same mode with no reader attached: what decoration must never change.
async function baseline(page: Page, mode: Mode) {
  const plain = await page.context().newPage()
  await open(plain, mode, false)
  const value = await getValue(plain)
  const preview = await plain.evaluate(() =>
    (window as any).vditor.vditor.lute.Md2HTML((window as any).__source),
  )
  await plain.close()
  return { value, preview: preview as string }
}

test.describe('HTML link presentation (Task 654)', () => {
  for (const mode of MODES) {
    test(`${mode}: accepted anchors look like the Markdown link; controls keep their source`, async ({
      page,
    }) => {
      await open(page, mode)
      const state = await page.evaluate(
        ({ pane, mode, accepted, controls }) => {
          const root = document.querySelector(pane)!
          const look = (el: Element) => {
            const cs = getComputedStyle(el)
            return {
              line: cs.textDecorationLine,
              style: cs.textDecorationStyle,
              offset: cs.textUnderlineOffset,
              color: cs.color,
            }
          }
          const reference =
            mode === 'ir'
              ? root.querySelector('.vditor-ir__link')!
              : Array.from(root.querySelectorAll('a')).find(
                  (a) => a.textContent === 'mdlink',
                )!
          const spans = Array.from(root.querySelectorAll('span.vmde-html-link'))
          const hiddenMarkers = spans.every(
            (span) =>
              (span.previousElementSibling as HTMLElement).style.display ===
                'none' &&
              (span.nextElementSibling as HTMLElement).style.display === 'none',
          )
          const para = (text: string) =>
            Array.from(root.querySelectorAll('p')).find((p) =>
              p.textContent?.includes(text),
            )!
          return {
            reference: look(reference),
            spans: spans.map((s) => ({
              text: s.textContent,
              href: s.getAttribute('data-vmde-html-link-href'),
              role: s.getAttribute('role'),
              hasNavigable: s.hasAttribute('href') || s.hasAttribute('target'),
              ...look(s),
            })),
            hiddenMarkers,
            controls: controls.map((text: string) => {
              const p = para(text)
              const markers = Array.from(
                p.querySelectorAll('[data-type="html-inline"]'),
              )
              return {
                text,
                decorated: !!p.querySelector('.vmde-html-link'),
                markerHiddenByUs: markers.some(
                  (m) =>
                    (m as HTMLElement).style.display === 'none' ||
                    m.getAttribute('aria-hidden') === 'true',
                ),
                markerWidth: Math.max(
                  ...markers.map((m) => m.getBoundingClientRect().width),
                ),
                textKept: p.textContent?.includes('<a'),
              }
            }),
            accepted,
          }
        },
        { pane: PANE[mode], mode, accepted: ACCEPTED, controls: CONTROLS },
      )
      expect(state.spans).toHaveLength(ACCEPTED.length)
      for (const span of state.spans) {
        expect(span.line).toBe('underline')
        expect(span.style).toBe('solid')
        expect(span.offset).toBe('2px')
        expect(span.color).toBe(state.reference.color)
        expect(span.role).toBe('link')
        expect(span.hasNavigable).toBe(false)
      }
      expect(
        state.spans.map((s) => s.text?.split(' ')[0].replace(/​/g, '')),
      ).toEqual(
        expect.arrayContaining(
          ACCEPTED.map((t) => (t === 'nestedbody' ? 'nestedbody' : t)),
        ),
      )
      expect(state.spans.find((s) => s.text?.startsWith('amplink'))?.href).toBe(
        '?a=1&b=2',
      )
      expect(
        state.spans.find((s) => s.text?.startsWith('emptytext'))?.href,
      ).toBe('')
      expect(state.hiddenMarkers).toBe(true)
      for (const control of state.controls) {
        expect(control.decorated, control.text).toBe(false)
        expect(control.markerHiddenByUs, control.text).toBe(false)
        expect(control.textKept, control.text).toBe(true)
        // WYSIWYG shows the tag text at rest; IR collapses markers by Vditor CSS (measured in S1).
        if (mode === 'wysiwyg')
          expect(control.markerWidth, control.text).toBeGreaterThan(0)
      }
    })

    test(`${mode}: caret entry reveals the source, an edit round-trips, leaving decorates again`, async ({
      page,
    }) => {
      await open(page, mode)
      const base = await baseline(page, mode)
      const link = page.locator(`${PANE[mode]} span.vmde-html-link`, {
        hasText: 'plainlink',
      })
      await link.click()
      const paragraph = page
        .locator(`${PANE[mode]} p`, { hasText: 'Plain' })
        .first()
      await expect(paragraph.locator('span.vmde-html-link')).toHaveCount(0)
      await expect(paragraph).toContainText(
        '<a href="https://example.com/plain">',
      )
      await page.keyboard.type('Z')
      const edited = await getValue(page)
      expect(edited.split('Z')).toHaveLength(2)
      expect(edited.replace('Z', '')).toBe(base.value)
      await page.locator(`${PANE[mode]} p`, { hasText: 'Amp' }).first().click()
      await expect(
        page.locator(`${PANE[mode]} span.vmde-html-link`),
      ).toHaveCount(ACCEPTED.length)
      expect((await getValue(page)).replace('Z', '')).toBe(base.value)
    })

    test(`${mode}: getValue is identical before decoration, decorated, and after reveal and redecorate`, async ({
      page,
    }) => {
      await open(page, mode)
      const base = await baseline(page, mode)
      if (mode === 'ir') expect(base.value).toBe(`${await source(page)}\n`)
      expect(await getValue(page)).toBe(base.value)
      await page
        .locator(`${PANE[mode]} span.vmde-html-link`, { hasText: 'onelink' })
        .click()
      await expect(
        page.locator(`${PANE[mode]} span.vmde-html-link`),
      ).toHaveCount(ACCEPTED.length - 1)
      expect(await getValue(page)).toBe(base.value)
      await page.locator(`${PANE[mode]} p`, { hasText: 'Amp' }).first().click()
      await expect(
        page.locator(`${PANE[mode]} span.vmde-html-link`),
      ).toHaveCount(ACCEPTED.length)
      expect(await getValue(page)).toBe(base.value)
    })

    test(`${mode}: Ctrl+click reaches the document click handler on the attached link span`, async ({
      page,
    }) => {
      await open(page, mode)
      // Same position as link-click-fix.ts: a bubble-phase listener on `document`, after the
      // reader's own listener on the editor root. It must still see the decorated span.
      await page.evaluate(() => {
        ;(window as any).__clicks = []
        document.addEventListener('click', (e) => {
          const span = (e.target as Element).closest<HTMLElement>(
            '[data-vmde-html-link="1"]',
          )
          ;(window as any).__clicks.push(span?.dataset.vmdeHtmlLinkHref ?? null)
        })
      })
      const link = page.locator(`${PANE[mode]} span.vmde-html-link`, {
        hasText: 'twolink',
      })
      await link.click({ modifiers: ['Control'] })
      expect(await page.evaluate(() => (window as any).__clicks)).toEqual([
        'https://example.com/two',
      ])
      // The source is revealed afterwards, like a Markdown link, and nothing was edited.
      await expect(
        page.locator(`${PANE[mode]} span.vmde-html-link`, {
          hasText: 'twolink',
        }),
      ).toHaveCount(0)
      const base = await baseline(page, mode)
      expect(await getValue(page)).toBe(base.value)
    })

    test(`${mode}: Preview output of the fixture is unchanged and renders the anchors`, async ({
      page,
    }) => {
      await open(page, mode)
      const base = await baseline(page, mode)
      const after = await page.evaluate(() => ({
        preview: (window as any).vditor.vditor.lute.Md2HTML(
          (window as any).__source,
        ) as string,
      }))
      expect(after.preview).toBe(base.preview)
      const anchors = await page.evaluate((html) => {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        return Array.from(doc.querySelectorAll('a')).map((a) => [
          a.getAttribute('href'),
          a.textContent,
        ])
      }, after.preview)
      expect(anchors).toEqual(
        expect.arrayContaining([
          ['https://example.com/plain', 'plainlink'],
          ['https://example.com/attrs', 'attrslink'],
          ['?a=1&b=2', 'amplink'],
          ['./target.md', 'reltext'],
          [null, 'idtext'],
          [null, 'jstext'],
          [null, 'datatext'],
        ]),
      )
    })
  }
})
