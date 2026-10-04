import { expect, test } from './coverage-fixture'
import {
  collapseCaret,
  getValue,
  gotoMouseops,
  selectAllContent,
  selectWithin,
  selectWord,
  setDoc,
  syntheticClipboard,
  tripleClick,
  UNSET,
} from './mouseops-helpers'

// NET (task 191 P0-1..3) — the copy/cut CLIPBOARD PAYLOAD on the real wire. A mouse
// copy/cut is a corruption path: the serialized markdown it puts on the clipboard must
// restore markers (**, `, [[..]]) and leak NO editor DOM (hljs spans, chip markup),
// and a cut must remove exactly the selected block and post exactly one edit. These
// drive Vditor's real copyEvent/cutEvent handlers (ir/index.ts, wysiwyg/index.ts,
// sv/index.ts) via a synthetic ClipboardEvent whose DataTransfer we read back.

test.describe('P0-1 IR copy payload', () => {
  test('cross-block selection serializes to exact markdown, restoring markers + [[wiki]], html empty', async ({
    page,
  }) => {
    await gotoMouseops(page, 'ir')
    await setDoc(
      page,
      '# Heading One\n\nProse with **bold text** and a [[Home]] wiki link.\n',
    )
    await selectAllContent(page)
    const { plain, html } = await syntheticClipboard(page, 'copy')

    // Markers + the wiki chip are serialized back to source, NOT the rendered DOM text.
    expect(plain).toContain('# Heading One')
    expect(plain).toContain('**bold text**')
    expect(plain).toContain('[[Home]]')
    // No editor DOM leaked into the clipboard (chip span / data-attrs / tags).
    expect(plain).not.toContain('wiki-link-chip')
    expect(plain).not.toContain('data-type')
    expect(plain).not.toMatch(/<[a-z]/i)
    // The IR copy handler always clears text/html (source markdown only).
    expect(html).toBe('')
  })

  test('triple-click selects the line marker-inclusive (** restored on copy)', async ({
    page,
  }) => {
    await gotoMouseops(page, 'ir')
    await setDoc(page, 'A paragraph with **bold word** in it.\n')
    // Real triple-click selects the whole rendered line; the hidden ** markers are in
    // the selectable flow, so the serialized copy restores them.
    await tripleClick(page, '.vditor-ir [data-block] , .vditor-ir p')
    const { plain } = await syntheticClipboard(page, 'copy')
    expect(plain).toContain('**bold word**')
  })

  test('empty (collapsed) selection is an early-return: clipboard untouched', async ({
    page,
  }) => {
    await gotoMouseops(page, 'ir')
    await setDoc(page, 'Some prose here.\n')
    await collapseCaret(page)
    const { plain, html } = await syntheticClipboard(page, 'copy')
    // range.toString() === '' → handler returns before touching the DataTransfer.
    expect(plain).toBe(UNSET)
    expect(html).toBe(UNSET)
  })
})

test.describe('P0-2 WYSIWYG copy branches', () => {
  test('inside inline code → backtick-wrapped code, html empty', async ({
    page,
  }) => {
    await gotoMouseops(page, 'wysiwyg')
    await setDoc(page, 'Text with `inline code` here.\n')
    await selectWithin(page, 'code')
    const { plain, html } = await syntheticClipboard(page, 'copy')
    // Vditor pads inline code with a ZWSP (U+200B) for caret positioning
    // (codeRender.ts:58); it currently rides along in the copied text — tracked as
    // Probe-19. Normalize it out so this NET protects the backtick-wrap branch, not
    // the ZWSP (and stays green if/when Probe-19 strips it).
    expect(plain.replace(/\u200b/g, '')).toBe('`inline code`')
    expect(html).toBe('')
  })

  test('inside a fenced code block → raw code (no fence), html empty', async ({
    page,
  }) => {
    await gotoMouseops(page, 'wysiwyg')
    await setDoc(page, '```js\nconst answer = 42\n```\n')
    await selectWithin(page, 'pre code')
    const { plain, html } = await syntheticClipboard(page, 'copy')
    // PRE>CODE branch copies the visible code text only (range.toString()), no ``` fence.
    expect(plain.trim()).toBe('const answer = 42')
    expect(plain).not.toContain('```')
    expect(html).toBe('')
  })

  test('inside a titled link → [text](href "title"), html empty', async ({
    page,
  }) => {
    await gotoMouseops(page, 'wysiwyg')
    await setDoc(page, 'See [the docs](https://example.com "My Title") now.\n')
    await selectWithin(page, 'a')
    const { plain, html } = await syntheticClipboard(page, 'copy')
    expect(plain).toBe('[the docs](https://example.com "My Title")')
    expect(html).toBe('')
  })

  test('cross-block incl a highlighted code fence → markdown, no hljs/span leak', async ({
    page,
  }) => {
    await gotoMouseops(page, 'wysiwyg')
    await setDoc(
      page,
      '# Title\n\nA paragraph with **bold**.\n\n```js\nconst x = 1\n```\n',
    )
    await selectAllContent(page)
    const { plain, html } = await syntheticClipboard(page, 'copy')
    expect(plain).toContain('# Title')
    expect(plain).toContain('**bold**')
    expect(plain).toContain('const x = 1')
    // The live-highlight spans (wysiwyg code highlighting) must NOT leak into markdown.
    expect(plain).not.toContain('hljs')
    expect(plain).not.toContain('<span')
    expect(plain).not.toContain('class=')
    expect(html).toBe('')
  })
})

test.describe('P0-3 Cut end-to-end (ir)', () => {
  test('real Ctrl+X preserves the non-collapsed range through cut and removes exactly it', async ({
    page,
  }) => {
    await gotoMouseops(page, 'ir')
    await setDoc(
      page,
      'Keep alpha. CUTTOKEN-EXACT-29-CHARS stays between omega.\n',
    )
    expect(await selectWord(page, 'CUTTOKEN-EXACT-29-CHARS')).toBe(
      'CUTTOKEN-EXACT-29-CHARS',
    )

    await page.keyboard.press('Control+x')

    await expect
      .poll(() => getValue(page))
      .toBe('Keep alpha.  stays between omega.\n')
    const observed = await page.evaluate(
      () =>
        (window as any).__cutSelection() as {
          collapsed: boolean
          text: string
          plain: string
        },
    )
    expect(observed.collapsed).toBe(false)
    expect(observed.text).toBe('CUTTOKEN-EXACT-29-CHARS')
    expect(observed.plain).toBe('CUTTOKEN-EXACT-29-CHARS')
  })

  test('cut copies the block to the clipboard AND removes it from the document after the deferred delete', async ({
    page,
  }) => {
    await gotoMouseops(page, 'ir')
    await setDoc(page, 'Keep this line.\n\nDELETE this paragraph.\n')
    // Select the second paragraph (the one to cut).
    await page.evaluate(() => {
      const el = (window as any).__modeEl() as HTMLElement
      el.focus()
      const p = Array.from(el.querySelectorAll('p')).find((n) =>
        n.textContent?.includes('DELETE this paragraph'),
      ) as HTMLElement
      const r = document.createRange()
      r.selectNodeContents(p)
      const s = getSelection()!
      s.removeAllRanges()
      s.addRange(r)
    })

    const { plain } = await syntheticClipboard(page, 'cut')
    // The cut payload is the same source markdown the copy handler produces.
    expect(plain).toContain('DELETE this paragraph')

    // fixCut defers Vditor's execCommand('delete') by a tick (utils.ts) — so the block
    // survives the synchronous cut handler and disappears only on the next task. Poll
    // (no fixed sleep) until the deferred delete has removed exactly the cut block and
    // left the untouched one intact — the data-loss net.
    await expect
      .poll(() => getValue(page), { timeout: 5_000, intervals: [50, 100, 200] })
      .not.toContain('DELETE this paragraph')
    expect(await getValue(page)).toContain('Keep this line.')
    // NOTE: the cut→save WIRE (a real edit landing on disk after the delete) is proven
    // at L3 in P0-4 (copy-clipboard.spec.ts, real Ctrl+X→Ctrl+S). A synthetic
    // ClipboardEvent's deferred execCommand mutates the DOM but does not drive Vditor's
    // input pipeline here, and the input→debounce→post plumbing is already covered by
    // edit-sync.test.ts + save-flush.spec.ts — so this L2 spec scopes to payload+removal.
  })
})

test.describe('P1-19 sv source-pane copy', () => {
  test('sv copy is verbatim source text (markers included); the handler leaves text/html untouched', async ({
    page,
  }) => {
    await gotoMouseops(page, 'sv')
    await setDoc(page, '## Heading Line\n\nBody line here.\n')
    await selectAllContent(page)
    const { plain, html } = await syntheticClipboard(page, 'copy')
    // sv copy = getSelectText: the RAW source, `##` marker included, verbatim (no Lute).
    expect(plain).toContain('## Heading Line')
    expect(plain).toContain('Body line here.')
    // Unlike ir/wysiwyg (which setData('text/html','')), the sv handler only sets
    // text/plain — text/html is left as the caller had it (our UNSET sentinel). This is the
    // asymmetry Probe-14 tracks (sv never clears the html slot).
    expect(html).toBe(UNSET)
  })
})

// Task 580 (CP2-11): the collapsed line copy/cut runs on `beforecopy`/`beforecut`, not on a
// Ctrl+C/X keydown match. A real key press makes Chromium run its own Copy/Cut command, which fires
// the before-event first; the expansion there must give the same line copy and exact line cut in
// every mode.
test.describe('collapsed line copy and cut through the before-events', () => {
  for (const mode of ['ir', 'wysiwyg', 'sv'] as const) {
    test(`${mode}: a collapsed Ctrl+C copies the line and a collapsed Ctrl+X cuts exactly it`, async ({
      page,
    }) => {
      await gotoMouseops(page, mode)
      await setDoc(page, 'Keep this line.\n\nLINE alpha to cut.\n')
      const before = await getValue(page)
      await page.evaluate(() => {
        ;(window as any).__installClipboardLine()
        const payload: Record<string, string> = {}
        ;(window as any).__linePayload = payload
        const el = (window as any).__modeEl() as HTMLElement
        // Added after Vditor's listener on the same element, so it reads what Vditor wrote.
        for (const type of ['copy', 'cut'])
          el.addEventListener(type, (event) => {
            payload[type] =
              (event as ClipboardEvent).clipboardData?.getData('text/plain') ??
              ''
          })
      })
      const caret = () =>
        page.evaluate(() => {
          const el = (window as any).__modeEl() as HTMLElement
          el.focus()
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const i = (n.textContent ?? '').indexOf('alpha')
            if (i < 0) continue
            const r = document.createRange()
            r.setStart(n, i + 2)
            r.collapse(true)
            getSelection()?.removeAllRanges()
            getSelection()?.addRange(r)
            return
          }
          throw new Error('alpha not found')
        })
      const payload = () =>
        page.evaluate(
          () => (window as any).__linePayload as Record<string, string>,
        )

      await caret()
      await page.keyboard.press('Control+c')
      await expect
        .poll(async () => (await payload()).copy)
        .toContain('LINE alpha to cut.')
      // Split mode renders this whole source as ONE `div[data-block]`, so its "line" is that block,
      // both paragraphs included. That is expandToLine's existing sv behaviour (unchanged here),
      // not something the before-event route introduced.
      const svOneBlock = mode === 'sv'
      if (!svOneBlock)
        expect((await payload()).copy).not.toContain('Keep this line.')
      expect(await getValue(page)).toBe(before)

      await caret()
      await page.keyboard.press('Control+x')
      await expect
        .poll(() => getValue(page))
        .not.toContain('LINE alpha to cut.')
      expect((await payload()).cut).toContain('LINE alpha to cut.')
      if (!svOneBlock) expect(await getValue(page)).toContain('Keep this line.')
    })
  }
})
