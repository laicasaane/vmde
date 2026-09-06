import { wf } from './webview-helpers'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'

// PROBE (task 190 P1) — undo AND redo interop. undo-dirty-probe covers undo-to-start; the REDO
// direction (Ctrl+Y after Ctrl+Z) was never exercised. Type a distinctive marker, undo it away,
// then redo it back — proving the webview→Vditor undo stack round-trips in both directions and
// the document reflects each step.
const SRC = path.join(__dirname, 'fixtures', 'doc-sync.md')
const MARK = 'REDOMARK'

test('type → undo → redo round-trips the document', async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(280_000)
  const tmp = path.join(tmpdir(), 'vmde-undo-redo.md')
  writeFileSync(tmp, readFileSync(SRC, 'utf8'))
  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [tmp] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await expect
    .poll(() => frame.locator('.vditor-ir').first().innerText())
    .toContain('CARET-ANCHOR')

  const docText = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === args[0],
        )
        return doc?.getText() ?? ''
      },
      [tmp] as [string],
    ) as Promise<string>

  const docVersion = () =>
    evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        const doc = vscode.workspace.textDocuments.find(
          (d) => d.uri.fsPath === args[0],
        )
        return doc?.version ?? -1
      },
      [tmp] as [string],
    ) as Promise<number>

  // Vditor's opening undo snapshot is debounce-owned; establish it before measuring the typed
  // transition's stack growth so an init-only push cannot satisfy the readiness condition.
  await frame
    .locator('body')
    .evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500)))
  const initialUndoStackLength = await frame.locator('body').evaluate(() => {
    const inner = (window as unknown as { vditor: { vditor: any } }).vditor
      .vditor
    return inner.undo[inner.currentMode].undoStack.length
  })

  // Caret at the end of CARET-ANCHOR, type the marker.
  // Give the nested webview iframe PAGE-LEVEL keyboard focus before typing (click the editor's
  // top-left margin). The evaluate below only does a DOM-level p.focus(); keyboard.type() dispatches
  // to the top Electron window, so without this the keystrokes race the focus and drop
  // non-deterministically. Harness focus fix, not product behaviour.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await frame.locator('body').evaluate(() => {
    const p = [...document.querySelectorAll('.vditor-ir p')].find((x) =>
      x.textContent?.includes('CARET-ANCHOR'),
    ) as HTMLElement | undefined
    const t = p?.lastChild as Text | null
    if (!t) throw new Error('caret anchor not found')
    const r = document.createRange()
    r.setStart(t, (t.textContent ?? '').length)
    r.collapse(true)
    const s = window.getSelection()
    s?.removeAllRanges()
    s?.addRange(r)
    p?.focus()
  })
  await workbox.keyboard.type(MARK, { delay: 50 })
  await expect.poll(docText, { timeout: 20_000 }).toContain(MARK)
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const inner = (window as unknown as { vditor: { vditor: any } }).vditor
          .vditor
        return inner.undo[inner.currentMode].undoStack.length
      }),
    )
    .toBeGreaterThan(initialUndoStackLength)
  expect((await docText()).includes(MARK), 'typed marker reached doc').toBe(
    true,
  )

  // Undo it away (Vditor's own undo, routed from the captured Ctrl+Z).
  // The host-document polls above cross the Electron/webview boundary. Under sustained full-suite
  // load the nested iframe occasionally loses page-level keyboard focus during that round trip even
  // though its DOM selection remains. Re-establish the same real editor focus used before typing so
  // the following physical chords cannot be delivered to the workbench instead of the webview.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+z')
  await expect.poll(docText, { timeout: 20_000 }).not.toContain(MARK)
  expect((await docText()).includes(MARK), 'undo removed the marker').toBe(
    false,
  )

  // Redo it back (Ctrl+Y) — the direction undo-dirty-probe never covered.
  await frame
    .locator('.vditor-ir')
    .first()
    .click({ position: { x: 4, y: 4 } })
  await workbox.keyboard.press('Control+y')
  await expect.poll(docText, { timeout: 20_000 }).toContain(MARK)
  const afterRedo = await docText()
  // eslint-disable-next-line no-console
  console.log(`[undo-redo] afterRedo hasMark=${afterRedo.includes(MARK)}`)
  expect(afterRedo.includes(MARK), 'redo restored the marker').toBe(true)

  // ---------------------------------------------------------------------------------------------
  // Task 463 — undo-keybind patch experiment. The assertions above only check the RESULTING text,
  // which is identical whether Vditor's own undo/redo engine handled the chord OR VS Code's native
  // document-level undo/redo did (both end up restoring the same bytes) — so they would pass even
  // with NEITHER `undo-keybind.ts`'s interceptor NOR the `patchUndoToolbarGate` build patch in
  // place. This matrix names the engine instead, using two signals that don't depend on either:
  //
  //   - engineCalls.{undo,redo}: wraps `vditor.undo.undo`/`.redo` (the ONE `Undo` instance, shared
  //     across all three edit modes — `Vditor`'s constructor creates it once) so ANY call, from
  //     either mechanism, increments a counter.
  //   - doc.version delta across an undo/redo-to-completion loop: our own forwarded edits (from
  //     Vditor's diff-based undo, synced through the normal edit-forward pipeline) each bump the
  //     TextDocument version by exactly 1. If VS Code's native undo/redo command ALSO fires for
  //     some keypress in the loop, that is a SEPARATE mutation of the TextDocument and bumps the
  //     version an EXTRA time — so `versionDelta === engineCallDelta` for the whole loop proves
  //     every document mutation traced back to an engine call our wrapper saw; a version delta
  //     bigger than the engine-call delta proves something else (VS Code's native undo/redo)
  //     mutated the document too. This is robust to Vditor's own keystroke-grouping granularity
  //     (undo/index.ts's `addToUndoStack` debounces, so "one Ctrl+Z" doesn't always mean "one typed
  //     character" — the equality holds regardless of how many presses a full round-trip took).
  await frame.locator('body').evaluate(() => {
    const inner = (window as unknown as { vditor: { vditor: any } }).vditor
      .vditor
    const calls = { undo: 0, redo: 0 }
    ;(
      window as unknown as { __vmdeUndoEngineCalls: typeof calls }
    ).__vmdeUndoEngineCalls = calls
    const origUndo = inner.undo.undo.bind(inner.undo)
    const origRedo = inner.undo.redo.bind(inner.undo)
    inner.undo.undo = (v: unknown) => {
      calls.undo++
      return origUndo(v)
    }
    inner.undo.redo = (v: unknown) => {
      calls.redo++
      return origRedo(v)
    }
  })
  const engineCalls = () =>
    frame.locator('body').evaluate(
      () =>
        (
          window as unknown as {
            __vmdeUndoEngineCalls: { undo: number; redo: number }
          }
        ).__vmdeUndoEngineCalls,
    ) as Promise<{ undo: number; redo: number }>

  async function switchMode(mode: 'ir' | 'wysiwyg' | 'sv') {
    // NOTE: locator.evaluate(fn, arg) passes the matched ELEMENT as fn's first param and `arg` as
    // the SECOND — `(_body, m) =>` below, not `(m) =>` (that bug silently swallowed every one of
    // these args on the first pass, including `settle()`'s own `ms`).
    await frame.locator('body').evaluate((_body, m) => {
      const v = (window as unknown as { vditor: { vditor: any } }).vditor.vditor
      if (v.currentMode === m) return
      v.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      )
      document
        .querySelector(`button[data-mode="${m}"]`)
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    }, mode)
    await frame.locator(`.vditor-${mode}`).first().waitFor({ timeout: 60_000 })
    await frame
      .locator('body')
      .evaluate(() => new Promise((r) => setTimeout(r, 1000)))
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const inner = (window as unknown as { vditor: { vditor: any } })
            .vditor.vditor
          return inner.undo[inner.currentMode].undoStack.length
        }),
      )
      .toBeGreaterThanOrEqual(1)
  }

  // Generic across modes: ir/wysiwyg have per-block <p> elements, sv is a single <pre> of raw
  // source text — a TreeWalker over text nodes finds "CARET-ANCHOR" in either shape.
  async function placeCaretAtAnchor(rootSelector: string) {
    const found = await frame.locator('body').evaluate((_body, sel) => {
      const root = document.querySelector(sel) as HTMLElement | null
      if (!root) return false
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      let node: Text | null
      // biome-ignore lint/suspicious/noAssignInExpressions: TreeWalker idiom
      while ((node = walker.nextNode() as Text | null)) {
        if (node.textContent?.includes('CARET-ANCHOR')) {
          const r = document.createRange()
          r.setStart(node, (node.textContent ?? '').length)
          r.collapse(true)
          const s = window.getSelection()
          s?.removeAllRanges()
          s?.addRange(r)
          root.focus()
          return true
        }
      }
      return false
    }, rootSelector)
    expect(found, `CARET-ANCHOR text node found in ${rootSelector}`).toBe(true)
  }

  async function settle(ms: number) {
    await frame
      .locator('body')
      .evaluate((_body, t) => new Promise((r) => setTimeout(r, t)), ms)
  }

  const webviewHas = (tag: string) =>
    frame
      .locator('body')
      .evaluate(
        (_body, expectedTag) =>
          (window as any).vditor.getValue().includes(expectedTag),
        tag,
      )

  // Shared setup: click into the editable element, place the caret at CARET-ANCHOR, type `tag`,
  // and settle. Used by both verify* helpers below and the focus-outside leg.
  async function typeTag(rootSelector: string, tag: string) {
    const stackLength = await frame.locator('body').evaluate(() => {
      const inner = (window as unknown as { vditor: { vditor: any } }).vditor
        .vditor
      return inner.undo[inner.currentMode].undoStack.length
    })
    await frame
      .locator(rootSelector)
      .first()
      .click({ position: { x: 4, y: 4 } })
    await placeCaretAtAnchor(rootSelector)
    await workbox.keyboard.type(tag, { delay: 50 })
    // task 512: retain — cascade window proves no delayed second engine mutation
    await settle(CASCADE_SETTLE_MS)
    await expect
      .poll(() =>
        frame.locator('body').evaluate(() => {
          const inner = (window as unknown as { vditor: { vditor: any } })
            .vditor.vditor
          return inner.undo[inner.currentMode].undoStack.length
        }),
      )
      .toBeGreaterThan(stackLength)
    await expect
      .poll(() =>
        frame.locator('body').evaluate((_body, expectedTag) => {
          const inner = (window as unknown as { vditor: { vditor: any } })
            .vditor.vditor
          return inner.undo[inner.currentMode].lastText.includes(expectedTag)
        }, tag),
      )
      .toBe(true)
  }

  // Type `tag`, undo it away, and confirm it's gone — the common setup for "test a redo chord"
  // and for the focus-outside leg below, which also needs a pending redo to attempt.
  async function setupPendingRedo(rootSelector: string, tag: string) {
    await typeTag(rootSelector, tag)
    for (let attempt = 0; attempt < 15 && (await webviewHas(tag)); attempt++) {
      await workbox.keyboard.press('Control+z')
    }
    await settle(CASCADE_SETTLE_MS)
    expect(
      (await docText()).includes(tag),
      `${tag} undone before redo test`,
    ).toBe(false)
  }

  // Shared discriminator assertion: a content transition can cross caret-only Vditor snapshots,
  // but must still produce exactly one native document mutation. Those local no-ops are not host
  // history steps; a version delta above one means native history fired more than once.
  function assertSingleDocumentMutation(
    chord: string,
    rootSelector: string,
    kind: 'undo' | 'redo',
    before: { version: number; calls: { undo: number; redo: number } },
    after: { version: number; calls: { undo: number; redo: number } },
  ) {
    const versionDelta = after.version - before.version
    const engineDelta = after.calls[kind] - before.calls[kind]
    expect(
      engineDelta,
      `${chord} on ${rootSelector}: Vditor's own ${kind} engine handled the transition`,
    ).toBeGreaterThanOrEqual(1)
    expect(
      versionDelta,
      `${chord} on ${rootSelector}: exactly one doc mutation for one content transition ` +
        `(versionDelta=${versionDelta} engineDelta=${engineDelta}); caret-only engine calls must ` +
        `remain host no-ops`,
    ).toBe(1)
  }

  // Vditor debounces BOTH ends of a single undo/redo step, cascaded:
  //   - typing → an undo-stack PUSH is debounced by `options.undoDelay` (800ms, ir/process.ts,
  //     wysiwyg/afterRenderEvent.ts, sv/process.ts all key off it identically) so a fast typed
  //     burst becomes ONE undo-stack entry.
  //   - undo()/redo() itself runs `renderDiff()` synchronously, but that in turn calls
  //     `execAfterRender()`, which is the SAME debounced `undoDelay` path again before it invokes
  //     `vditor.options.input(text)` — the callback that schedules `pending-edit.ts`'s OWN 250ms
  //     host-forward debounce (edit-sync.ts).
  // A single chord press therefore does not reach the TextDocument for up to ~800+250ms. Verified
  // the hard way first: a tight retry loop (press, settle 150ms, check, repeat) reset these nested
  // debounce timers on every iteration and coalesced 2 engine calls into 1 host mutation — a false
  // "extra native undo" looked identical to "the debounce ate a press". Fixed by pressing the
  // chord EXACTLY ONCE and settling past the full cascade before reading version/engineCalls, so
  // each press maps to at most one host mutation and the comparison is meaningful.
  // task 512: retain — these are deliberate debounce-cascade observation windows, not positive
  // completion guesses. Engine-call/document-version equality is only meaningful after both the
  // 800ms Vditor and 250ms host-forward timers have had time to expose a delayed second mutation.
  const CASCADE_SETTLE_MS = 2200

  async function verifyUndoChord(
    rootSelector: string,
    tag: string,
    chord: string,
  ) {
    await typeTag(rootSelector, tag)
    expect((await docText()).includes(tag), `${tag} typed`).toBe(true)

    const before = { version: await docVersion(), calls: await engineCalls() }
    for (let attempt = 0; attempt < 15 && (await webviewHas(tag)); attempt++) {
      await workbox.keyboard.press(chord)
    }
    await settle(CASCADE_SETTLE_MS)
    const after = { version: await docVersion(), calls: await engineCalls() }

    assertSingleDocumentMutation(chord, rootSelector, 'undo', before, after)
    expect(
      (await docText()).includes(tag),
      `${chord} on ${rootSelector} removed ${tag}`,
    ).toBe(false)
  }

  // Same shape, but for redo: undo `tag` away first (plain Ctrl+Z, already proven above), THEN
  // press the redo `chord` once.
  async function verifyRedoChord(
    rootSelector: string,
    tag: string,
    chord: string,
  ) {
    await setupPendingRedo(rootSelector, tag)

    const before = { version: await docVersion(), calls: await engineCalls() }
    for (let attempt = 0; attempt < 15 && !(await webviewHas(tag)); attempt++) {
      await workbox.keyboard.press(chord)
    }
    await settle(CASCADE_SETTLE_MS)
    const after = { version: await docVersion(), calls: await engineCalls() }

    expect(
      (await docText()).includes(tag),
      `${chord} on ${rootSelector} restored ${tag}`,
    ).toBe(true)
    assertSingleDocumentMutation(chord, rootSelector, 'redo', before, after)
  }

  // ir (already the active mode) — both chords the interceptor handled, plus the toolbar's own.
  await verifyUndoChord('.vditor-ir', 'T1IUNDO', 'Control+z')
  await verifyRedoChord('.vditor-ir', 'T2IREDO', 'Control+y')
  await verifyRedoChord('.vditor-ir', 'T3ISHIFTZ', 'Control+Shift+z')

  await switchMode('wysiwyg')
  await verifyUndoChord('.vditor-wysiwyg', 'T1WUNDO', 'Control+z')
  await verifyRedoChord('.vditor-wysiwyg', 'T2WREDO', 'Control+y')
  await verifyRedoChord('.vditor-wysiwyg', 'T3WSHIFTZ', 'Control+Shift+z')

  await switchMode('sv')
  await verifyUndoChord('.vditor-sv', 'T1SUNDO', 'Control+z')
  await verifyRedoChord('.vditor-sv', 'T2SREDO', 'Control+y')
  await verifyRedoChord('.vditor-sv', 'T3SSHIFTZ', 'Control+Shift+z')

  // The one behavioural difference between the interceptor and a Vditor-source patch:
  // undo-keybind.ts binds on `window`, so it fires no matter what has DOM focus inside the
  // webview. Vditor's own handler (explicit gate + toolbar-hotkey fallback) is bound on the editor
  // element itself (`hotkeyEvent(vditor, this.element)`, all three modes) — a keydown whose TARGET
  // is outside that element (toolbar, elsewhere in the webview) never reaches it. Measured (task
  // 463) with only a source patch and no interceptor: focus outside the editor made ⇧⌘Z do
  // NOTHING at all (no engine call, no doc mutation — not even VS Code's native redo). This is the
  // regression test for that gap staying closed: set up a real pending redo, move focus OUTSIDE
  // the editable element, and confirm the (window-bound) interceptor still redoes it.
  await switchMode('ir')
  const OUTSIDE_TAG = 'T4IOUTSIDE'
  await setupPendingRedo('.vditor-ir', OUTSIDE_TAG)

  const outsideResult = await frame.locator('body').evaluate(async () => {
    const probe = document.createElement('button')
    probe.textContent = 'vmde-463-focus-probe'
    probe.style.cssText = 'position:fixed;top:0;left:0;opacity:0;'
    document.body.appendChild(probe)
    probe.focus()
    const focusedOutside =
      document.activeElement === probe &&
      !document
        .querySelector('.vditor-ir')
        ?.contains(document.activeElement as Node)
    return { focusedOutside }
  })
  expect(
    outsideResult.focusedOutside,
    'throwaway probe actually holds DOM focus outside the editor',
  ).toBe(true)

  const before = { version: await docVersion(), calls: await engineCalls() }
  await workbox.keyboard.press('Control+Shift+z')
  // task 512: retain — cascade window proves focus-outside redo has no delayed second mutation
  await settle(CASCADE_SETTLE_MS)
  const after = { version: await docVersion(), calls: await engineCalls() }

  expect(
    (await docText()).includes(OUTSIDE_TAG),
    'focus-outside ⇧⌘Z: the window-bound interceptor redoes it even though DOM focus is outside ' +
      'the editable element — the reach a Vditor-source patch cannot get',
  ).toBe(true)
  assertSingleDocumentMutation(
    'Control+Shift+z (focus outside editor)',
    '.vditor-ir',
    'redo',
    before,
    after,
  )

  rmSync(tmp, { force: true })
})
