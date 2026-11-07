import { fileURLToPath } from 'node:url'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import {
  canonicalizeIrMarkdown,
  prerenderPrefix,
  prewarmLute,
  renderForMode,
  renderWikiChipsInHtml,
  reserializeMarkdown,
} from '../../src/lute/lute-host'
import {
  isLuteArtifactBuilt,
  waitForLuteWarm,
  warnLuteArtifactMissing,
} from './lute-artifact'

// The real extension root — lute-host reads media/vditor/dist/js/lute/lute.min.js
// from here and runs it in an isolated vm (same path the host uses at runtime).
const ROOT = fileURLToPath(new URL('../..', import.meta.url))

// task 476: the WASM boot's cost is CPU-bound and scales with machine contention, not code —
// give it a ceiling sized for a busy box, not an idle one. (Pure-logic tests above stay fast;
// this only raises the CEILING, not their actual runtime.)
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })

const LUTE_BUILT = isLuteArtifactBuilt(ROOT)
if (!LUTE_BUILT)
  warnLuteArtifactMissing('lute-host renderForMode > after warmup', ROOT)

// prerenderPrefix is pure — no Lute needed. It bounds what we feed Lute: small
// docs pass through; long docs are cut to a clean leading slice for the overlay.
describe('prerenderPrefix', () => {
  it('passes through a document within the cap unchanged', () => {
    const md = '# Title\n\nshort body\n'
    expect(prerenderPrefix(md)).toBe(md)
  })

  it('truncates a long document to a clean block boundary', () => {
    const para = (n: number) => `## Section ${n}\n\nLorem ipsum dolor sit.\n\n`
    let md = '# Title\n\n'
    for (let i = 0; i < 500; i++) md += para(i)
    const out = prerenderPrefix(md)
    expect(out.length).toBeLessThan(md.length)
    expect(out.length).toBeLessThanOrEqual(12_000)
    // keeps the very top, drops the far tail
    expect(out).toContain('Section 0')
    expect(out).not.toContain('Section 499')
    // cut on a block boundary → ends with a whole block, not a half-written line
    expect(/(Lorem ipsum dolor sit\.|## Section \d+)$/.test(out)).toBe(true)
  })

  it('drops a dangling unterminated code fence at the cut', () => {
    // a long lead-in, then an opened-but-not-closed fence near the cap
    const head = `${'filler paragraph text.\n\n'.repeat(450)}`
    const md = `${head}\`\`\`js\nconst x = 1\n${'// line\n'.repeat(2000)}`
    const out = prerenderPrefix(md)
    // even number of fence lines (the unterminated one was dropped)
    expect((out.match(/^```/gm) || []).length % 2).toBe(0)
  })

  it('drops an unterminated fence even when the doc OPENS with it (offset 0)', () => {
    // the only fence is on the very first line — the old guard missed this because
    // it cut on '\n```' (which needs a preceding newline) while counting '^```'
    const md = `\`\`\`js\n${'const x = 1\n'.repeat(3000)}`
    const out = prerenderPrefix(md)
    expect((out.match(/^```/gm) || []).length % 2).toBe(0)
  })
})

// renderWikiChipsInHtml is pure — no Lute needed. It rewrites [[…]] literals in
// the host-rendered overlay HTML into the same chip spans the live editor emits.
describe('renderWikiChipsInHtml', () => {
  it('rewrites a simple [[link]] to a chip span', () => {
    const out = renderWikiChipsInHtml('<p data-block="0">[[Home]]</p>')
    expect(out).toContain('class="wiki-link-chip"')
    expect(out).toContain('data-wiki-target="Home"')
    expect(out).toContain('data-wiki-source="[[Home]]"')
    expect(out).toContain('>Home</span>')
    expect(out).not.toContain('[[Home]]</p>')
  })

  it('uses the label for [[target|label]] but targets the key', () => {
    const out = renderWikiChipsInHtml('<p>[[Target|Display Label]]</p>')
    expect(out).toContain('data-wiki-target="Target"')
    expect(out).toContain('data-wiki-source="[[Target|Display Label]]"')
    expect(out).toContain('>Display Label</span>')
  })

  it('rewrites multiple links on one line', () => {
    const out = renderWikiChipsInHtml('<p>[[A]] and [[B]]</p>')
    expect(out.match(/wiki-link-chip/g)).toHaveLength(2)
  })

  it('escapes HTML in target/label', () => {
    const out = renderWikiChipsInHtml('<p>[[A&B]]</p>')
    expect(out).toContain('data-wiki-target="A&amp;B"')
    expect(out).toContain('>A&amp;B</span>')
  })

  it('leaves HTML without wiki links untouched', () => {
    const html = '<p>Just text with [single] brackets</p>'
    expect(renderWikiChipsInHtml(html)).toBe(html)
  })
})

describe('lute-host renderForMode', () => {
  it('skips split (sv) mode — structurally different, no overlay', () => {
    expect(renderForMode(ROOT, '# Heading\n', 'sv')).toBeUndefined()
  })

  it('returns undefined before Lute is warm (no host block on first open)', () => {
    // a freshly imported module: Lute not loaded yet → no synchronous host render,
    // it only kicks a prewarm so the NEXT open is covered.
    expect(renderForMode(ROOT, '# Heading\n', 'ir')).toBeUndefined()
  })

  describe.skipIf(!LUTE_BUILT)('after warmup', () => {
    beforeAll(async () => {
      prewarmLute(ROOT)
      // prewarm defers the (~250 ms synchronous) load via setTimeout(0); poll for real
      // readiness rather than a fixed sleep (see waitForLuteWarm — task 476).
      await waitForLuteWarm()
    })

    it('renders IR DOM with the source marker for ir mode', () => {
      const html = renderForMode(ROOT, '# Heading One\n', 'ir')
      expect(html).toContain('Heading One')
      // the literal "#" source marker span — IR only
      expect(html).toContain('vditor-ir__marker--heading')
    })

    it('renders WYSIWYG DOM without the IR source marker', () => {
      const html = renderForMode(ROOT, '# Heading One\n', 'wysiwyg')
      expect(html).toContain('Heading One')
      expect(html).not.toContain('vditor-ir__marker--heading')
    })

    it('matches resource-scoped Markdown extension flags without leaking between renders', () => {
      const md = '[toc]\n\n# One\n\n==marked== x^2^ H~2~O ~~strike~~\n'
      const enabled = renderForMode(ROOT, md, 'ir', false, {
        toc: true,
        mark: true,
        supSub: true,
      })
      expect(enabled).toContain('class="vditor-toc"')
      expect(enabled).toMatch(/<mark[^>]*>marked<\/mark>/)
      expect(enabled).toMatch(/<sup[^>]*>2<\/sup>/)
      expect(enabled).toMatch(/<sub[^>]*>2<\/sub>/)
      expect(enabled?.match(/<s\b/g)).toHaveLength(1)

      const disabled = renderForMode(ROOT, md, 'ir', false, {
        toc: false,
        mark: false,
        supSub: false,
      })
      expect(disabled).not.toContain('class="vditor-toc"')
      expect(disabled).not.toContain('<mark>')
      expect(disabled).not.toContain('<sup>')
      expect(disabled).not.toContain('<sub>')
      expect(disabled?.match(/<s\b/g)).toHaveLength(2)
    })

    it('pre-renders a truncated prefix for a long document (no host freeze)', () => {
      const para = (n: number) => `## Section ${n}\n\nbody text here.\n\n`
      let md = '# Top Heading\n\n'
      for (let i = 0; i < 600; i++) md += para(i)
      const html = renderForMode(ROOT, md, 'ir')
      expect(html).toBeDefined()
      // the top of the document is painted…
      expect(html).toContain('Top Heading')
      expect(html).toContain('Section 0')
      // …but the far tail is not (it was truncated for the overlay)
      expect(html).not.toContain('Section 599')
    })

    it('renders wiki [[links]] as chips when wikiEnabled (instant-paint match)', () => {
      const html = renderForMode(ROOT, 'See [[Home]] here.\n', 'ir', true)
      expect(html).toContain('class="wiki-link-chip"')
      expect(html).toContain('data-wiki-target="Home"')
      expect(html).not.toContain('[[Home]]</') // no raw literal left in text
    })

    it('leaves [[links]] as literal text when wiki is disabled', () => {
      const html = renderForMode(ROOT, 'See [[Home]] here.\n', 'ir', false)
      expect(html).toContain('[[Home]]')
      expect(html).not.toContain('wiki-link-chip')
    })

    it('does not leak Lute into the shared host global', () => {
      expect((globalThis as { Lute?: unknown }).Lute).toBeUndefined()
    })

    // The equivalence signal the minimal-diff write-back (task 61) relies on:
    // reserializeMarkdown(block) === editor block ⇒ block unchanged ⇒ keep original.
    it('reserializeMarkdown round-trips prose and reflows an unpadded table (task 61)', () => {
      // prose is a fixed point (no reflow) — round-trips byte-for-byte
      expect(reserializeMarkdown(ROOT, 'Just a paragraph.\n')?.trim()).toBe(
        'Just a paragraph.',
      )
      // a hand-written unpadded table reflows to Lute's padded canonical form —
      // so original unpadded bytes != reserialized, which is how an *untouched*
      // table is matched (reserialize(original) === editor's padded output).
      const padded = reserializeMarkdown(ROOT, '|a|b|\n|-|-|\n|1|2|\n')
      expect(padded).toContain('| a | b |')
    })

    // Task 704, Decision D1: a `|` between the backticks of a code span in a table row is part of
    // the code span. Row I57 is the Owner's report (5 columns; the code span holds five bare pipes).
    describe('table code-span pipes (task 704)', () => {
      const HEADER =
        '| Id | Question | Provisional answer and evidence | Alternative to offer | Task |'
      const I57 =
        "| I57 | Which operations the sample cycle kind supports (F11; the task text has no `EnterAt`). | `Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll`, as `StageListSingle`, because its replay re-enters through `EnterAtAsync`. | The task's set, which makes every replay fail. | [F11](../F11-sample-custom-kind.md) |"
      const TABLE = `${HEADER}\n|---|---|---|---|---|\n${I57}\n`
      const CODE = 'Add | Enter | EnterAt | Leave | LeaveActive | LeaveAll'
      const row = (html: string | undefined, id: string) =>
        html?.match(
          new RegExp(`<tr>(?:(?!</tr>)[\\s\\S])*?>${id}<[\\s\\S]*?</tr>`),
        )?.[0] ?? ''
      // Collapse Lute's table padding and the `\|` form, so a check reads the row's content.
      const squash = (s: string) =>
        s.replace(/\\\|/g, '|').replace(/ {2,}/g, ' ')

      it('renders the IR DOM of the I57 row with 5 cells and the full code span', () => {
        const tr = row(renderForMode(ROOT, TABLE, 'ir'), 'I57')
        expect(tr).not.toBe('')
        expect(tr.match(/<td\b/g)).toHaveLength(5)
        expect(tr).toContain(`<code data-newline="1">${CODE}</code>`)
        expect(tr).toContain('EnterAtAsync')
      })

      it('renders the WYSIWYG DOM of the I57 row with 5 cells and the full code span', () => {
        const tr = row(renderForMode(ROOT, TABLE, 'wysiwyg'), 'I57')
        expect(tr.match(/<td\b/g)).toHaveLength(5)
        expect(tr).toContain(CODE)
      })

      // The pre-task escape only repaired a row with MORE cells than the header. A row whose GFM
      // cell count already matches (here 3 of 3) is split too, and D1 does not allow that.
      it('keeps a code span with a pipe whole on a row whose GFM cell count is already correct', () => {
        const md = '| a | b | c |\n|---|---|---|\n| `x|y` | z |\n'
        const html = renderForMode(ROOT, md, 'ir')
        expect(html).toContain('<code data-newline="1">x|y</code>')
        expect(html).not.toContain('>y`<')
      })

      it('reserializeMarkdown keeps every cell of the I57 row', () => {
        const out = reserializeMarkdown(ROOT, TABLE)
        const line =
          out?.split('\n').find((l) => /^\|\s*I57\s*\|/.test(l)) ?? ''
        expect(squash(line)).toContain(`\`${CODE}\``)
        expect(squash(line)).toContain(
          'because its replay re-enters through `EnterAtAsync`.',
        )
        expect(squash(line)).toContain('[F11](../F11-sample-custom-kind.md) |')
      })

      it('reserializeMarkdown keeps the code span of a row whose GFM cell count is already correct', () => {
        const out = reserializeMarkdown(
          ROOT,
          '| a | b | c |\n|---|---|---|\n| `x|y` | z |\n',
        )
        const line = out?.split('\n').find((l) => l.includes('z')) ?? ''
        expect(squash(line)).toContain('`x|y`')
      })

      it('canonicalizeIrMarkdown agrees with reserializeMarkdown for that table', () => {
        expect(canonicalizeIrMarkdown(ROOT, TABLE)).toBe(
          reserializeMarkdown(ROOT, TABLE),
        )
      })
    })

    it.each([
      [
        'paragraphs, headings, nested loose lists, and CRLF',
        '# Seed\r\n\r\nParagraph with **bold** and [link](./note.md).\r\n\r\n1. first\r\n\r\n   - nested\r\n\r\n2. second\r\n',
      ],
      [
        'tables, quotes, fenced code, references, and footnotes',
        '| a | b |\n| - | - |\n| 1 | 2 |\n\n> quote\n\n```ts\nconst x = 1\n```\n\n[ref]: ./target.md\n\nUse [ref][ref] and footnote[^1].\n\n[^1]: note\n',
      ],
      [
        'HTML, callouts, wiki literals, and code-reference-like tokens',
        '<details>\n<summary>More</summary>\n\nbody\n</details>\n\n> [!NOTE]\n> callout\n\n[[Wiki Page]] and `src/file.ts:12`.\n',
      ],
    ])('builds the same forced seed canonical for %s', (_label, markdown) => {
      expect(canonicalizeIrMarkdown(ROOT, markdown)).toBe(
        reserializeMarkdown(ROOT, markdown),
      )
    })
  })
})
