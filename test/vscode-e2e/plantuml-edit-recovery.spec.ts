import { wf } from './webview-helpers'
// PlantUML diagram-type recovery (task 178 follow-up) — real-VS-Code only.
//
// The vendored TeaVM PlantUML engine carried STICKY diagram-type state across render() calls on one
// shared instance: once it rendered a class diagram, a later VALID sequence source was misclassified as
// a class diagram and never recovered (user repro: edit an arrow into "-"/".->" → it flips to a class
// diagram of Alice/Bob and stays there). plantuml-render.ts now gives EACH render a FRESH engine (a
// cache-busted re-import → fresh module statics), so every render classifies its source independently.
//
// Two real-webview proofs the chromium harness can't give (TeaVM engine + the custom-editor pipeline):
//   1) recovery: sequence → class → sequence on ONE block recovers to a sequence svg.
//   2) multi-type: a class block followed by a sequence block both render with the CORRECT type
//      (pre-fix the 2nd block rendered wrong/blank — the concurrency face of the same shared-engine bug).
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const ALL = path.join(__dirname, 'fixtures', 'all-renderers.md')
const MULTI = path.join(__dirname, 'fixtures', 'plantuml-multi-type.md')

const open = (
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode'), args: string[]) => Promise<void>,
    args: [string],
  ) => Promise<void>,
  uri: string,
) =>
  evaluateInVSCode(
    async (vscode, args) => {
      const [u] = args
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(u),
        'vmde.editor',
      )
    },
    [uri],
  )

// A diagram is a CLASS diagram when its rendered <text> includes a standalone "C" (PlantUML's class
// icon letter); a sequence diagram of Alice/Bob never does.
const looksClass = (texts: string | null) =>
  !!texts && /(^|\|)C(\||$)/.test(texts)

test('editing a plantuml arrow sequence→class→sequence recovers (fresh engine per render)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await open(evaluateInVSCode, ALL)
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('.vditor-ir__preview .language-plantuml svg')
    .first()
    .waitFor({ timeout: 60_000 })

  // texts of the first rendered plantuml block
  const texts = () =>
    frame.locator('body').evaluate(() => {
      const el = document.querySelector(
        '.vditor-ir__preview .language-plantuml',
      )
      const svg = el?.querySelector('svg')
      return svg
        ? Array.from(svg.querySelectorAll('text'))
            .map((t) => t.textContent ?? '')
            .join('|')
        : null
    })

  // Read both ends of the edit pipeline. A rendered-family match can precede the source DOM's final
  // replacement; a source-only match can precede host writeback. The next edit is safe only when all
  // three agree and the SVG is not PlantUML's source-echoing error card.
  const sourceText = () =>
    frame.locator('body').evaluate(() => {
      const wrapper = document.querySelector('.language-plantuml')
      const node = wrapper?.closest('.vditor-ir__node') as HTMLElement | null
      const src = node?.querySelector('.vditor-ir__marker--pre')
      return (src?.textContent ?? '<none>').replace(/\s+/g, ' ').slice(0, 120)
    })
  const hostText = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) =>
        vscode.workspace.textDocuments
          .find((doc) => doc.uri.fsPath === args[0])
          ?.getText() ?? '',
      [ALL] as [string],
    ) as Promise<string>
  const renderErrored = (rendered: string | null) =>
    /Assumed diagram type|Syntax Error|Fatal parsing error|not supported by this release/i.test(
      rendered ?? '',
    )

  // Replace the first occurrence of `find` in the editable IR source with a real keyboard edit. Maps a
  // global source-textContent offset to a (node,offset) Range — robust to highlight span-splitting.
  // NOTE: locator.evaluate passes the matched ELEMENT first, the user arg SECOND → bind (_el, arg).
  const editSource = async (
    find: string,
    replacement: string,
    expectedClass: boolean,
    expectedSource: string,
  ) => {
    // PAGE-LEVEL keyboard focus into the nested webview iframe — `source.focus()` below is DOM-level
    // INSIDE the iframe, while `workbox.keyboard` dispatches to the top Electron window; without this
    // the replacement keystrokes race that focus and the source edit is silently dropped.
    await frame
      .locator('.vditor-ir')
      .first()
      .click({ position: { x: 4, y: 4 } })
    const ok = await frame.locator('body').evaluate((_el, needle) => {
      const wrapper = document.querySelector('.language-plantuml')
      const node = wrapper?.closest('.vditor-ir__node') as HTMLElement | null
      if (!node) return false
      const seed = (node.querySelector('.vditor-ir__marker--pre') ??
        node) as HTMLElement
      const sr = document.createRange()
      sr.selectNodeContents(seed)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(sr)
      node.classList.add('vditor-ir__node--expand')
      const source = node.querySelector(
        '.vditor-ir__marker--pre',
      ) as HTMLElement | null
      if (!source) return false
      const parts: { node: Text; start: number }[] = []
      let acc = ''
      const w = document.createTreeWalker(source, NodeFilter.SHOW_TEXT)
      let tn = w.nextNode() as Text | null
      while (tn) {
        parts.push({ node: tn, start: acc.length })
        acc += tn.textContent ?? ''
        tn = w.nextNode() as Text | null
      }
      const gi = acc.indexOf(needle)
      if (gi < 0) return false
      const loc = (g: number) => {
        for (let k = parts.length - 1; k >= 0; k--)
          if (g >= parts[k].start)
            return { node: parts[k].node, offset: g - parts[k].start }
        return { node: parts[0].node, offset: 0 }
      }
      const a = loc(gi)
      const b = loc(gi + needle.length)
      const r = document.createRange()
      r.setStart(a.node, a.offset)
      r.setEnd(b.node, b.offset)
      sel?.removeAllRanges()
      sel?.addRange(r)
      source.focus()
      return true
    }, find)
    expect(ok, `could not select "${find}" in the plantuml source`).toBe(true)
    await workbox.keyboard.type(replacement, { delay: 80 })
    await expect
      .poll(
        async () => {
          const rendered = await texts()
          const [source, host] = await Promise.all([sourceText(), hostText()])
          return (
            rendered !== null &&
            !renderErrored(rendered) &&
            looksClass(rendered) === expectedClass &&
            source.includes(expectedSource) &&
            host.includes(expectedSource)
          )
        },
        { timeout: 30_000 },
      )
      .toBe(true)
  }

  await expect
    .poll(
      async () => {
        const rendered = await texts()
        return (
          rendered !== null && !renderErrored(rendered) && !looksClass(rendered)
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)

  await editSource('->', '-', true, 'Alice - Bob') // class association
  // Assert the EDIT ITSELF landed before judging the render. Without this split, a dropped keystroke
  // (harness focus) and a regressed type-flip (product, task 350) fail identically — verified: the
  // observed failure was the source still reading "Alice -> Bob", i.e. the edit never landed.
  expect(await sourceText(), 'the source edit never landed').toContain(
    'Alice - Bob',
  )
  expect(looksClass(await texts())).toBe(true) // now a class diagram

  await editSource('-', '->', false, 'Alice -> Bob') // valid sequence arrow
  const recovered = await texts()
  // eslint-disable-next-line no-console
  console.log(`[recovery] texts=${recovered}`)
  expect(looksClass(recovered)).toBe(false) // RECOVERED to sequence (the bug: stayed class)
  expect(recovered).toContain('Hello')

  // user's 2nd report: a DOTTED arrow "Alice .-> Bob" (has an arrowhead, so the no-arrowhead rule
  // misses it) flips to a class diagram; deleting the dot back to "->" must recover.
  await editSource('->', '.->', true, 'Alice .-> Bob') // class
  expect(looksClass(await texts())).toBe(true)
  await editSource('.->', '->', false, 'Alice -> Bob') // valid sequence again
  const recovered2 = await texts()
  // eslint-disable-next-line no-console
  console.log(`[recovery .->] texts=${recovered2}`)
  expect(
    renderErrored(recovered2),
    'final recovery rendered an error card',
  ).toBe(false)
  expect(looksClass(recovered2)).toBe(false) // RECOVERED (the 2nd reported stuck case)
  expect(recovered2).toContain('Hello')
})

test('two plantuml blocks of different types both render correctly (no shared-engine poisoning)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  await open(evaluateInVSCode, MULTI)
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('.vditor-ir__preview .language-plantuml svg')
    .first()
    .waitFor({ timeout: 60_000 })

  const readAfter = () =>
    frame.locator('body').evaluate(() =>
      Array.from(
        document.querySelectorAll('.vditor-ir__preview .language-plantuml'),
      ).map((el) => {
        const svg = el.querySelector('svg')
        return {
          hasSvg: !!svg,
          texts: svg
            ? Array.from(svg.querySelectorAll('text'))
                .map((t) => t.textContent ?? '')
                .join('|')
            : null,
        }
      }),
    )
  await expect
    .poll(
      async () => {
        const current = await readAfter()
        return (
          current.length === 2 &&
          current[0].hasSvg &&
          looksClass(current[0].texts) &&
          current[1].hasSvg &&
          !looksClass(current[1].texts) &&
          !!current[1].texts?.includes('Alice')
        )
      },
      { timeout: 30_000 },
    )
    .toBe(true)
  const after = await readAfter()
  // eslint-disable-next-line no-console
  console.log(`[multi-type] ${JSON.stringify(after)}`)

  expect(after.length).toBe(2)
  // block 0 = class (Foo/Bar with the circled-C), block 1 = sequence (Alice/Bob, no standalone C)
  expect(after[0].hasSvg).toBe(true)
  expect(looksClass(after[0].texts)).toBe(true)
  expect(after[1].hasSvg).toBe(true) // pre-fix: false (blank) — the smoking-gun fact
  expect(looksClass(after[1].texts)).toBe(false)
  expect(after[1].texts).toContain('Alice')
})
