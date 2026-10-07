import { test, expect } from './coverage-fixture'
import type { Page } from '@playwright/test'
import type { Target } from './format-hotkey-gate-harness'

// Task 596 S3 — behaviour. A toolbar hotkey runs by clicking the Vditor toolbar button, and the
// click obeys the button's `vditor-menu--disabled` / `vditor-menu--current` classes, which
// Vditor's highlight rewrites only 200 ms after a click or keyup. A selection moved by program
// (no highlight run) therefore makes the hotkey act on the previous context: the rows below are
// the measured corruptions and no-ops of tasks/596 ("Problem" table).
//
// Each row: settle the caret in context A (Vditor's own highlight runs), move the selection to B
// by program, and act at once. Three runs per row, on the same document:
//   fresh  - highlight allowed to settle at B, then a plain click: Vditor's correct result.
//   plain  - no highlight at B, plain click: the pre-596 hotkey, which keeps the stale result.
//   gated  - no highlight at B, `clickToolbarHotkeyButton` (the product gate and click).
// `gated` must equal `fresh`; `plain` documents what the stale classes did, and that this
// harness really reproduces the stale window (a RED control for the gate).

type Mode = 'ir' | 'wysiwyg'

const DOC = [
  '# Heading one',
  '',
  'Alpha bravo charlie delta.',
  '',
  'Echo `foxtrot` golf hotel.',
  '',
  '**India** juliet kilo.',
  '',
  '- lima mike',
  '- november',
  '  - sierra',
  '',
  '> oscar papa',
  '',
].join('\n')

/** DOC with each [from, to] replaced once; `from` must exist, so a row cannot rot silently. */
function edit(...pairs: ReadonlyArray<readonly [string, string]>): string {
  let out = DOC
  for (const [from, to] of pairs) {
    if (!out.includes(from)) throw new Error(`fixture lost: ${from}`)
    out = out.replace(from, to)
  }
  return out
}

const word = (needle: string): Target => ({ text: [needle, 0, needle.length] })
const caret = (needle: string): Target => ({ text: [needle, 2, 0] })

interface Row {
  id: string
  mode: Mode
  /** Context whose highlight settles first (its stale classes are what the click then sees). */
  settle: Target
  /** Where the selection moves by program, with no highlight run. */
  to: Target
  name: string
  /** Document after Vditor's correct (fresh) click. */
  fresh: string
  /** Document after the stale (pre-596) click. */
  stale: string
  /** Headings opens a picker panel instead of editing; its visibility after the click. */
  panel?: { fresh: 'block' | 'none'; stale: 'block' | 'none' }
}

const ROWS: Row[] = [
  // Inline code and bold.
  {
    id: 'in code -> plain word, inline-code (stale current: no-op)',
    mode: 'ir',
    settle: word('foxtrot'),
    to: word('bravo'),
    name: 'inline-code',
    fresh: edit(['bravo', '`bravo`']),
    stale: DOC,
  },
  {
    id: 'in code -> plain word, bold (stale disabled: no-op)',
    mode: 'ir',
    settle: word('foxtrot'),
    to: word('bravo'),
    name: 'bold',
    fresh: edit(['bravo', '**bravo**']),
    stale: DOC,
  },
  {
    id: 'plain -> word in code, bold (stale enabled: corrupts the code span)',
    mode: 'ir',
    settle: word('bravo'),
    to: word('foxtrot'),
    name: 'bold',
    fresh: DOC,
    stale: edit(['`foxtrot`', '`**foxtrot**`']),
  },
  {
    id: 'plain -> word in code, inline-code (stale not current: nested code)',
    mode: 'ir',
    settle: word('bravo'),
    to: word('foxtrot'),
    name: 'inline-code',
    fresh: edit(['`foxtrot`', 'foxtrot']),
    stale: edit(['`foxtrot`', '``foxtrot``']),
  },
  {
    id: 'plain -> bold word, bold (stale not current: ****India****)',
    mode: 'ir',
    settle: word('bravo'),
    to: word('India'),
    name: 'bold',
    fresh: edit(['**India**', 'India']),
    stale: edit(['**India**', '****India****']),
  },
  {
    id: 'bold word -> plain word, bold (stale current: no-op)',
    mode: 'ir',
    settle: word('India'),
    to: word('bravo'),
    name: 'bold',
    fresh: edit(['bravo', '**bravo**']),
    stale: DOC,
  },
  // Quote.
  {
    id: 'plain -> quote text, quote (stale not current: >> oscar papa)',
    mode: 'ir',
    settle: word('bravo'),
    to: word('oscar'),
    name: 'quote',
    fresh: edit(['> oscar papa', 'oscar papa']),
    stale: edit(['> oscar papa\n', '>> oscar papa\n>>\n']),
  },
  {
    id: 'quote text -> plain word, quote (stale current: no-op)',
    mode: 'ir',
    settle: word('oscar'),
    to: word('bravo'),
    name: 'quote',
    fresh: edit(['Alpha bravo', '> Alpha bravo']),
    stale: DOC,
  },
  // Headings and list family.
  {
    id: 'heading -> plain caret, headings (stale current: picker stays hidden)',
    mode: 'ir',
    settle: caret('Heading'),
    to: caret('bravo'),
    name: 'headings',
    fresh: DOC,
    stale: DOC,
    panel: { fresh: 'block', stale: 'none' },
  },
  {
    id: 'plain -> list item caret, list (stale not current: no-op)',
    mode: 'ir',
    settle: caret('bravo'),
    to: caret('lima'),
    name: 'list',
    // Removing the list leaves the paragraphs and the nested item as its own list.
    fresh: edit([
      '- lima mike\n- november\n  - sierra\n\n>',
      'lima mike\n\nnovember\n\n- sierra\n\n\n>',
    ]),
    stale: DOC,
  },
  {
    id: 'plain -> second list item, indent (stale disabled: no-op)',
    mode: 'ir',
    settle: caret('bravo'),
    to: caret('november'),
    name: 'indent',
    fresh: edit(['- november\n  - sierra', '  - november\n    - sierra']),
    stale: DOC,
  },
  {
    id: 'plain -> nested item, outdent (stale disabled: no-op)',
    mode: 'ir',
    settle: caret('bravo'),
    to: caret('sierra'),
    name: 'outdent',
    fresh: edit(['  - sierra', '- sierra']),
    stale: DOC,
  },
  // WYSIWYG.
  {
    id: 'heading -> plain word, bold (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: word('Heading'),
    to: word('bravo'),
    name: 'bold',
    fresh: edit(['bravo', '**bravo**']),
    stale: DOC,
  },
  {
    id: 'in code -> plain word, inline-code (stale current: no-op)',
    mode: 'wysiwyg',
    settle: word('foxtrot'),
    to: word('bravo'),
    name: 'inline-code',
    fresh: edit(['bravo', '`bravo`']),
    stale: DOC,
  },
  {
    id: 'plain -> word in code, inline-code (stale not current: no-op)',
    mode: 'wysiwyg',
    settle: word('bravo'),
    to: word('foxtrot'),
    name: 'inline-code',
    fresh: edit(['`foxtrot`', 'foxtrot']),
    stale: DOC,
  },
  {
    id: 'in code -> paragraph contents (STRONG first), inline-code (stale current: removes the bold)',
    mode: 'wysiwyg',
    settle: word('foxtrot'),
    to: { contents: { sel: 'p', has: 'India' } },
    name: 'inline-code',
    fresh: DOC,
    stale: edit(['**India**', 'India']),
  },
  {
    id: 'quote text -> paragraph contents (STRONG first), quote (stale current: removes the bold)',
    mode: 'wysiwyg',
    settle: word('oscar'),
    to: { contents: { sel: 'p', has: 'India' } },
    name: 'quote',
    fresh: edit(['**India**', '> **India**']),
    stale: edit(['**India**', 'India']),
  },
  {
    id: 'plain -> quote text, quote (stale not current: >> oscar papa)',
    mode: 'wysiwyg',
    settle: word('bravo'),
    to: word('oscar'),
    name: 'quote',
    fresh: edit(['> oscar papa', 'oscar papa']),
    stale: edit(['> oscar papa\n', '>> oscar papa\n>>\n']),
  },
  {
    id: 'quote text -> plain word, quote (stale current: no-op)',
    mode: 'wysiwyg',
    settle: word('oscar'),
    to: word('bravo'),
    name: 'quote',
    fresh: edit(['Alpha bravo', '> Alpha bravo']),
    stale: DOC,
  },
  {
    id: 'plain -> second list item, indent (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: caret('bravo'),
    to: caret('november'),
    name: 'indent',
    fresh: edit(['- november\n  - sierra', '  - november\n    - sierra']),
    stale: DOC,
  },
  {
    id: 'plain -> nested item, outdent (stale disabled: no-op)',
    mode: 'wysiwyg',
    settle: caret('bravo'),
    to: caret('sierra'),
    name: 'outdent',
    fresh: edit(['  - sierra', '- sierra']),
    stale: DOC,
  },
]

interface Outcome {
  settled: boolean
  staleClasses: string
  gateClasses: string
  panel: string
  value: string
}

type Variant = 'fresh' | 'plain' | 'gated'

/** One run of a row on a fresh document in the page's current mode. */
async function run(page: Page, row: Row, variant: Variant): Promise<Outcome> {
  return page.evaluate(
    async ({ doc, row, variant }) => {
      const gate = (window as any).__gate
      const editor = (window as any).vditor
      editor.setValue(doc)
      await new Promise((resolve) => setTimeout(resolve, 50))
      // Context A: Vditor's own highlight runs and settles.
      gate.place(row.settle)
      gate.poisonAndSchedule()
      const settled = (await gate.waitHighlight(2000)).ok
      // Move by program: no click, no keyup, so no highlight run at B.
      gate.place(row.to)
      if (variant === 'fresh') {
        gate.poisonAndSchedule()
        await gate.waitHighlight(2000)
      }
      const panelElement =
        editor.vditor.toolbar.elements.headings.querySelector(
          '.vditor-hint',
        ) as HTMLElement
      panelElement.style.display = 'none'
      const staleClasses = JSON.stringify(gate.snapshot()[row.name])
      const gateClasses = JSON.stringify(gate.expected()[row.name])
      if (variant === 'gated') {
        if (!gate.gatedClick(row.name))
          throw new Error('gate refused the click')
      } else gate.plainClick(row.name)
      return {
        settled,
        staleClasses,
        gateClasses,
        panel: panelElement.style.display,
        value: editor.getValue() as string,
      }
    },
    { doc: DOC, row, variant },
  )
}

async function openMode(page: Page, mode: Mode) {
  await page.goto('/format-hotkey-gate.html')
  await page.waitForFunction(() => (window as any).__ready === true)
  if (mode !== 'ir')
    await page.evaluate((target) => {
      const toolbar = (window as any).vditor.vditor.toolbar
      toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector(`button[data-mode="${target}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
  await expect
    .poll(() => page.evaluate(() => (window as any).vditor.getCurrentMode()))
    .toBe(mode)
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`gated hotkey click equals Vditor's fresh result (${mode})`, async ({
    page,
  }) => {
    await openMode(page, mode)
    const wrong: string[] = []
    for (const row of ROWS.filter((r) => r.mode === mode)) {
      const fresh = await run(page, row, 'fresh')
      const gated = await run(page, row, 'gated')
      // The row is a real stale window: at the click the button's classes differ from the gate.
      expect(gated.settled, `${row.id}: context A settles`).toBe(true)
      expect(gated.staleClasses, `${row.id}: stale classes differ`).not.toBe(
        gated.gateClasses,
      )
      if (fresh.value !== row.fresh)
        wrong.push(`${row.id}: fresh ${JSON.stringify(fresh.value)}`)
      if (gated.value !== row.fresh)
        wrong.push(`${row.id}: gated ${JSON.stringify(gated.value)}`)
      if (row.panel && gated.panel !== row.panel.fresh)
        wrong.push(`${row.id}: gated panel ${gated.panel}`)
    }
    expect(wrong).toEqual([])
  })

  test(`a plain click keeps the stale result, so the gate is what fixes it (${mode})`, async ({
    page,
  }) => {
    await openMode(page, mode)
    const wrong: string[] = []
    for (const row of ROWS.filter((r) => r.mode === mode)) {
      const plain = await run(page, row, 'plain')
      if (plain.value !== row.stale)
        wrong.push(`${row.id}: plain ${JSON.stringify(plain.value)}`)
      if (row.panel && plain.panel !== row.panel.stale)
        wrong.push(`${row.id}: plain panel ${plain.panel}`)
      // Every row must differ from the fresh result in the document or the panel, else it
      // would not need the gate.
      const same =
        row.stale === row.fresh &&
        (!row.panel || row.panel.stale === row.panel.fresh)
      if (same) wrong.push(`${row.id}: stale equals fresh`)
    }
    expect(wrong).toEqual([])
  })
}
