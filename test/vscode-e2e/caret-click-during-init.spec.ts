import { settle, wf } from './webview-helpers'
// Task 445 — the first click into a freshly-opened document sometimes drops the caret: present,
// collapsed, at the right position, but PAINTS with zero height (task 439's exact failure mode).
//
// Root-caused by call-stack trace (tasks/445-first-click-drops-the-caret.md "Round 6", 4/4
// reproductions, identical every time): Vditor's OWN undo-snapshot machinery — `Undo.addCaret`,
// called once from a debounced `setTimeout` (`options.undoDelay`, default 800ms) for the initial
// undo-stack snapshot of a freshly-opened document — clones the live Range (`cloneRange`), then
// inserts a `<span class="vditor-wbr">` marker via `range.insertNode()` to bake the caret position
// into the snapshot HTML. `insertNode` on a Range anchored in a Text node SPLITS that node (DOM
// spec); DOM Ranges are LIVE, so `cloneRange`'s boundary auto-adjusts onto the split — landing on
// the (possibly now-EMPTY) pre-split half whenever the click was at or before the split point,
// e.g. a click near the top-left of a fresh document (offset 0 of the first text run — the common
// case, and what this spec clicks). Restoring onto an empty text node paints a caret with a
// ZERO-HEIGHT client rect: present, collapsed, at the "right" DOM position, and invisible.
//
// Fixed via `media-src/esbuild-shared.mjs`'s `patchUndoCaretSplitRestore` (chained onto the
// existing `undo/index.ts` registry entry, alongside `patchDmpInterop`): capture a character
// OFFSET before the split, and restore via that offset — re-resolved against the FRESH DOM after
// the split has already happened — through the caret AUTHORITY (`caret.ts`, ADR-0007 / task 446)
// instead of the stale `cloneRange`.
//
// Reproduces round 6's exact click timing/position (delay 0ms — clicked the INSTANT `.vditor-ir`
// appears, no settling first; position {x:20,y:12} on the with-text fixture, which round 6 found
// dropped the caret in 4 of 5 delays including 0ms) and samples `caretHeight` REPEATEDLY across
// the undo debounce window — round 5 measured flash-THEN-vanish with no self-heal, so a single
// post-click measurement would miss it (same reasoning as caret-authority-rebuild.spec.ts). Also
// asserts the caret STAYS at the clicked character offset throughout, per the fix's own claim: the
// caret must end up where the user clicked, not merely somewhere paintable.
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

const TEXT_FIXTURE = path.join(__dirname, 'fixtures', 'caret-on-open-text.md')

// Everything that decides whether a caret is DRAWN (not just present), plus a DOM-shape-independent
// "where is it" measurement: a character offset relative to the whole IR editable, computed the
// same way caret.ts / caret-preserve.ts do it. The fix does not (and cannot) stop Vditor's own
// marker-insert from splitting the clicked text node — even patched, the DOM node holding the caret
// after the debounce fires may not be object-identical to the one clicked into — so correctness is
// checked by character offset, not node identity.
const MEASURE = () => {
  const sel = window.getSelection()
  const r = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null
  const editor = (
    window as unknown as {
      vditor?: { vditor?: { ir?: { element?: HTMLElement } } }
    }
  ).vditor?.vditor?.ir?.element
  let charOffset = -1
  if (r && editor?.contains(r.startContainer)) {
    const pre = r.cloneRange()
    pre.selectNodeContents(editor)
    pre.setEnd(r.startContainer, r.startOffset)
    charOffset = pre.toString().length
  }
  return {
    rangeCount: sel?.rangeCount ?? 0,
    collapsed: r?.collapsed ?? null,
    caretHeight: r ? Math.round(r.getBoundingClientRect().height) : -1,
    charOffset,
  }
}
type Measurement = ReturnType<typeof MEASURE>

test('the first click keeps a paintable caret at the clicked position through the undo-snapshot debounce (task 445)', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(60_000)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const [uri] = args as [string]
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand('workbench.action.closeAllEditors')
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(uri),
        'vmde.editor',
      )
    },
    [TEXT_FIXTURE] as [string],
  )
  const frame = wf(workbox)
  // Do NOT settle before clicking — round 6's reproduction is specifically about clicking WHILE
  // finish-init/Vditor's own construction is still in flight; every one of task 445's four
  // NEGATIVE probes settled first and that is exactly why they read clean.
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 20, y: 12 } })

  const baseline = (await frame
    .locator('body')
    .evaluate(MEASURE)) as Measurement
  expect(baseline.rangeCount, 'a Range exists right after the click').toBe(1)
  expect(
    baseline.caretHeight,
    'the caret is paintable right after the click (sanity)',
  ).toBeGreaterThan(0)
  expect(
    baseline.charOffset,
    'a real character offset was resolved at the clicked position',
  ).toBeGreaterThanOrEqual(0)

  // Sample across the undo-snapshot debounce window (default 800ms) — repeatedly, because round 5
  // measured this as flash-THEN-vanish (never self-heals once it drops), not "never painted".
  const samples: Measurement[] = []
  for (let i = 0; i < 5; i++) {
    await settle(frame, 300)
    samples.push((await frame.locator('body').evaluate(MEASURE)) as Measurement)
  }
  // eslint-disable-next-line no-console
  console.log(
    `[caret-click-during-init] baseline=${JSON.stringify(baseline)} samples=${JSON.stringify(samples)}`,
  )

  for (const [i, m] of samples.entries()) {
    expect(m.rangeCount, `sample ${i}: a Range still exists`).toBe(1)
    expect(
      m.charOffset,
      `sample ${i}: the caret is still at the CLICKED character offset, not merely somewhere`,
    ).toBe(baseline.charOffset)
    // THE assertion this spec exists for: not merely present, but PAINTABLE. A zero-height Range
    // here is task 439's exact regression, this time caused by Vditor's own undo-snapshot restore
    // (task 445) rather than VMDE's init code.
    expect(
      m.caretHeight,
      `sample ${i}: the caret survived the undo-snapshot debounce AND is paintable`,
    ).toBeGreaterThan(0)
  }
})
