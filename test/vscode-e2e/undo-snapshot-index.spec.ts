/**
 * Task 610 S4 — Vditor's Undo snapshot is source-neutral for the shared source index, in real VS
 * Code on the large synthetic fixture (IR and WYSIWYG).
 *
 * Acceptance 1 (zero avoidable index builds): the index is warmed in the same task right before
 * Vditor's opening checkpoint (the order that rebuilt it in the Task 604 attribution). After the
 * checkpoint the next hovers find the warm entry: 0 source-index builds and 0 block-handle
 * snapshot pairs. A later snapshot (the delayed one that follows a real edit, with caret restore)
 * then lands on a rebuilt entry and keeps it.
 * Acceptance 2 (control): a real OS-typed character still invalidates the index, so the shipped
 * hover path builds again, and the host receives the edited paragraph.
 * Acceptance 3 (budget and bytes): the warm lookup after each snapshot (the hover handler, from
 * mouse event to the next macrotask, excluding paint) stays within the Owner budget of 100 ms;
 * after the opening checkpoint the host text is byte-identical, clean and at its opening version;
 * each snapshot leaves the caret offset unchanged and adds exactly one Undo entry.
 *
 * The edit's own snapshot is a debounced Vditor timer. The spec holds it until the rebuilt entry
 * exists (a test-only queue in front of the unchanged snapshot call), so the order "warm entry,
 * then snapshot" is established instead of raced.
 *
 * `domRevision` is not exposed by the shipped webview. A bumped revision drops the entry and the
 * next read builds, so "0 builds after the snapshot" is the observable form of "revision kept".
 * Not covered here: Vditor's first-key recorder (`recordFirstPosition`) leaves a non-collapsed
 * Range, and the selection live-marker proof then writes text nodes into the root. That path
 * rebuilds for a reason outside the snapshot (see the task record). Every fixture comparison is a
 * boolean so failures never print source.
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { FIXTURE_SHA256 } from './find-replace-fixture-helpers'
import { createXtestInput } from './helpers/xtest-input'
import {
  type docText,
  ExtensionId,
  MarkdownEditorViewType,
  waitForE2EReadiness,
  wf,
} from './webview-helpers'

type Mode = 'ir' | 'wysiwyg'
type Frame = ReturnType<typeof wf>

const FIXTURE = path.join(
  __dirname,
  'fixtures',
  'large-observable-models-synthetic.md',
)
const BUDGET_MS = 100

interface MarkerLog {
  records: number
  markerAdded: number
  markerRemoved: number
  splitTails: number
  pairedTails: number
  textAdded: number
  /** Writes that are neither the Undo marker, its split tail nor an ignorable attribute. */
  foreign: number
  foreignKinds: string[]
}
interface Probe {
  warm: {
    ok: boolean
    reason: string
    undoDepthAtWarm: number
    buildsBefore: number
    buildsAfter: number
    coldMs: number
    caretInside: boolean
    caretSet: boolean
  } | null
  log: MarkerLog
  moves: { t0: number; t1: number }[]
  /** Undo depth at each index build, in order. */
  builds: number[]
}
interface Sample {
  builds: number
  snapshotPairs: number
  undoDepth: number
  caret: { collapsed: boolean; offset: number } | null
  log: MarkerLog
  moves: number
  buildDepths: number[]
}

// Installed before the webview loads. It keeps the opt-in build counters the shipped index reads,
// records every mousemove's handler time, tallies the Undo marker writes on the live root, and
// warms the index (a pointer move over a plain paragraph) in the same task right before Vditor's
// first `addToUndoStack`, which is the opening checkpoint.
function installProbe(mode: Mode) {
  const win = window as any
  // The shipped index counts builds by assigning `indexBuilds`; each assignment also records the
  // Undo depth at that moment, so the spec can order a build against a later snapshot.
  const builds: number[] = []
  let indexBuilds = 0
  const metrics = { blockHandleSnapshotCalls: 0 } as {
    blockHandleSnapshotCalls: number
    indexBuilds: number
  }
  Object.defineProperty(metrics, 'indexBuilds', {
    enumerable: true,
    get: () => indexBuilds,
    set(value: number) {
      indexBuilds = value
      const inner = win.vditor?.vditor
      builds.push(inner?.undo?.[inner.currentMode]?.undoStack?.length ?? -1)
    },
  })
  win.__vmdeBlockHandleCacheMetrics = metrics
  const probe: Probe = {
    warm: null,
    log: {
      records: 0,
      markerAdded: 0,
      markerRemoved: 0,
      splitTails: 0,
      pairedTails: 0,
      textAdded: 0,
      foreign: 0,
      foreignKinds: [],
    },
    moves: [],
    builds,
  }
  win.__undoSnapshotProbe = probe
  win.__undoSnapshotPlainParagraphs = (root: HTMLElement) =>
    Array.from(
      root.querySelectorAll<HTMLElement>(':scope > p[data-block="0"]'),
    ).filter(
      (p) =>
        (p.textContent?.length ?? 0) >= 60 &&
        !p.querySelector(
          mode === 'ir' ? '.vditor-ir__node' : 'a,strong,em,code,[data-type]',
        ),
    )

  let synthetic = false
  // The webview document is written with document.open(), which drops listeners registered on
  // window by an init script, so the spec arms this after the editor is ready. A capture listener
  // on window runs before every document-level handler for the event, and the channel message is
  // a later macrotask, so t1 - t0 covers all synchronous handler work for one mouse move.
  win.__undoSnapshotArmMoves = () => {
    const channel = new MessageChannel()
    channel.port1.onmessage = (event) => {
      probe.moves[event.data as number].t1 = performance.now()
    }
    window.addEventListener(
      'mousemove',
      () => {
        if (synthetic) return
        const t0 = performance.now()
        const index = probe.moves.push({ t0, t1: -1 }) - 1
        channel.port2.postMessage(index)
      },
      true,
    )
  }

  const isMarker = (node: Node) =>
    node instanceof HTMLElement && node.classList.contains('vditor-wbr')
  const ignorableAttribute = (name: string) =>
    [
      'class',
      'style',
      'data-vmde-foldable',
      'data-vmde-list-foldable',
    ].includes(name) || name.startsWith('aria-')
  const startLog = (root: HTMLElement) => {
    const log = probe.log
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page tally of marker, split and foreign records; this init-script function cannot call outside helpers.
    const observer = new MutationObserver((records) => {
      const truncated = new Set<Node>()
      for (const record of records)
        if (record.type === 'characterData') truncated.add(record.target)
      let pairedTruncations = 0
      for (const record of records) {
        log.records++
        if (record.type === 'attributes') {
          if (!ignorableAttribute(record.attributeName ?? '')) {
            log.foreign++
            log.foreignKinds.push(`attr:${record.attributeName}`)
          }
          continue
        }
        if (record.type === 'characterData') continue
        for (const node of Array.from(record.removedNodes)) {
          if (isMarker(node)) log.markerRemoved++
          else {
            log.foreign++
            log.foreignKinds.push(`removed:${node.nodeName}`)
          }
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node.nodeType === Node.TEXT_NODE) {
            log.textAdded++
            continue
          }
          if (!isMarker(node)) {
            log.foreign++
            log.foreignKinds.push(`added:${node.nodeName}`)
            continue
          }
          log.markerAdded++
          const head = record.previousSibling
          const tail = record.nextSibling
          if (
            head?.nodeType === Node.TEXT_NODE &&
            tail?.nodeType === Node.TEXT_NODE
          ) {
            log.splitTails++
            if (truncated.has(head)) {
              log.pairedTails++
              pairedTruncations++
            }
          }
        }
      }
      // A characterData record is the truncated half of a split unless it is a text edit.
      const textEdits = truncated.size - pairedTruncations
      if (textEdits > 0) {
        log.foreign += textEdits
        log.foreignKinds.push('characterData')
      }
    })
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
  }

  // Test-only scheduling: `__undoSnapshotHold(true)` queues later snapshot calls instead of
  // running them, and `__undoSnapshotHold(false)` runs the queue in order. The snapshot itself is
  // unchanged (same receiver and arguments, run by the wrapper under test); holding it only lets
  // the spec warm the index first, so the order "warm entry, then snapshot" is established
  // instead of raced against Vditor's 800 ms timer.
  const held = { open: true, queue: [] as Array<() => void> }
  win.__undoSnapshotHold = (hold: boolean) => {
    held.open = !hold
    if (hold) return 0
    const queued = held.queue.splice(0)
    for (const run of queued) run()
    return queued.length
  }
  let armed = false
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one in-page warm step with its failure exits; this init-script function cannot call outside helpers.
  const warmBeforeCheckpoint = (editor: any, original: () => void) => {
    const inner = editor.vditor
    const root = inner[inner.currentMode]?.element as HTMLElement | undefined
    const undoDepthAtWarm = (inner.undo[inner.currentMode].undoStack?.length ??
      0) as number
    const fail = (reason: string) => {
      probe.warm = {
        ok: false,
        reason,
        undoDepthAtWarm,
        buildsBefore: metrics.indexBuilds,
        buildsAfter: metrics.indexBuilds,
        coldMs: 0,
        caretInside: false,
        caretSet: false,
      }
      original()
    }
    if (!root?.isConnected) return fail('no connected editor root')
    const target = (win.__undoSnapshotPlainParagraphs(root) as HTMLElement[])[0]
    if (!target) return fail('no plain paragraph')
    const selection = getSelection()
    let caretSet = false
    if (!selection?.rangeCount || !root.contains(selection.anchorNode)) {
      const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
      const text = walker.nextNode()
      if (!text || (text.textContent?.length ?? 0) < 20)
        return fail('no text node for the caret')
      selection?.collapse(text, 10)
      caretSet = true
    }
    startLog(root)
    const buildsBefore = metrics.indexBuilds
    const box = target.getBoundingClientRect()
    synthetic = true
    const begin = performance.now()
    try {
      target.dispatchEvent(
        new MouseEvent('mousemove', {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 20,
          clientY: box.top + 4,
        }),
      )
    } finally {
      synthetic = false
    }
    const coldMs = performance.now() - begin
    probe.warm = {
      ok: true,
      reason: '',
      undoDepthAtWarm,
      buildsBefore,
      buildsAfter: metrics.indexBuilds,
      coldMs,
      caretInside: Boolean(
        getSelection()?.rangeCount &&
          root.contains(getSelection()?.anchorNode ?? null),
      ),
      caretSet,
    }
    original()
  }

  let editor: any
  Object.defineProperty(win, 'vditor', {
    configurable: true,
    get: () => editor,
    set(value) {
      editor = value
      const undo = value?.vditor?.undo
      if (armed || typeof undo?.addToUndoStack !== 'function') return
      armed = true
      const addToUndoStack = undo.addToUndoStack
      let first = true
      // Test-only: the first snapshot is the opening checkpoint. The warm happens immediately
      // before it, outside the wrapper under test (which wraps addCaret, called inside it).
      undo.addToUndoStack = function (this: unknown, ...args: unknown[]) {
        if (first) {
          first = false
          return warmBeforeCheckpoint(editor, () =>
            addToUndoStack.apply(this, args),
          )
        }
        if (held.open) return addToUndoStack.apply(this, args)
        held.queue.push(() => addToUndoStack.apply(this, args))
      }
    },
  })
}

async function sample(frame: Frame): Promise<Sample> {
  return frame.locator('body').evaluate(() => {
    const win = window as any
    const inner = win.vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    const metrics = win.__vmdeBlockHandleCacheMetrics
    const selection = getSelection()
    let caret: { collapsed: boolean; offset: number } | null = null
    if (selection?.rangeCount && root.contains(selection.anchorNode)) {
      const range = selection.getRangeAt(0)
      const head = document.createRange()
      head.selectNodeContents(root)
      head.setEnd(range.startContainer, range.startOffset)
      caret = { collapsed: range.collapsed, offset: head.toString().length }
    }
    const probe = win.__undoSnapshotProbe as Probe
    return {
      builds: metrics.indexBuilds as number,
      snapshotPairs: metrics.blockHandleSnapshotCalls as number,
      undoDepth: (inner.undo[inner.currentMode].undoStack?.length ??
        0) as number,
      caret,
      log: JSON.parse(JSON.stringify(probe.log)) as MarkerLog,
      moves: probe.moves.length,
      buildDepths: probe.builds.slice(),
    }
  })
}

async function movesSince(frame: Frame, from: number): Promise<number[]> {
  return frame.locator('body').evaluate((_body, start) => {
    const probe = (window as any).__undoSnapshotProbe as Probe
    return probe.moves
      .slice(start)
      .map((move) =>
        move.t1 < 0 ? Number.POSITIVE_INFINITY : move.t1 - move.t0,
      )
  }, from)
}

// Poll until the live root has been free of recorded writes for `stableSamples` sampling gaps of
// `gapMs`. Used to reach a state where a later write can be attributed to the step under test.
async function quiet(
  frame: Frame,
  label: string,
  stableSamples = 4,
  gapMs = 250,
): Promise<void> {
  let last = -1
  let stable = 0
  await expect
    .poll(
      async () => {
        const { log } = await sample(frame)
        stable = log.records === last ? stable + 1 : 0
        last = log.records
        await frame
          .locator('body')
          .evaluate(
            (_body, ms) => new Promise((resolve) => setTimeout(resolve, ms)),
            gapMs,
          )
        return stable
      },
      { timeout: 60_000, intervals: [0], message: label },
    )
    .toBeGreaterThanOrEqual(stableSamples)
}

// The planned paragraphs: the first two plain paragraphs, addressed by position so no attribute is
// written to the observed DOM.
async function plainParagraphIndexes(frame: Frame): Promise<number[]> {
  return frame.locator('body').evaluate(() => {
    const win = window as any
    const inner = win.vditor.vditor
    const root = inner[inner.currentMode].element as HTMLElement
    const plain = new Set(win.__undoSnapshotPlainParagraphs(root) as Element[])
    return Array.from(root.querySelectorAll(':scope > p[data-block="0"]'))
      .map((p, index) => (plain.has(p) ? index : -1))
      .filter((index) => index >= 0)
      .slice(0, 2)
  })
}

async function hostState(
  evaluateInVSCode: Parameters<typeof docText>[0],
  file: string,
) {
  return (await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      const document = vscode.workspace.textDocuments.find(
        (d) => d.uri.fsPath === args[0],
      )
      return {
        text: document?.getText() ?? '',
        dirty: document?.isDirty,
        version: document?.version,
      }
    },
    [file] as [string],
  )) as {
    text: string
    dirty: boolean | undefined
    version: number | undefined
  }
}

for (const mode of ['ir', 'wysiwyg'] as const) {
  test(`${mode}: Undo snapshots keep the warmed source index on the large fixture and a real edit still rebuilds it`, async ({
    workbox,
    electronApp,
    evaluateInVSCode,
    baseDir,
  }) => {
    test.setTimeout(300_000)
    const fixture = readFileSync(FIXTURE)
    expect(createHash('sha256').update(fixture).digest('hex')).toBe(
      FIXTURE_SHA256,
    )
    const original = fixture.toString('utf8')
    const file = path.join(baseDir, `undo-snapshot-index-${mode}.md`)
    writeFileSync(file, fixture)
    await workbox.context().addInitScript(installProbe, mode)
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.extensions.getExtension(args[0])?.activate()
        const config = vscode.workspace.getConfiguration('vmde')
        await config.update('editor.defaultMode', args[1], true)
        await config.update('restorePosition', false, true)
      },
      [ExtensionId, mode] as [string, string],
    )
    await evaluateInVSCode(
      async (vscode: typeof import('vscode'), args: string[]) => {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          vscode.Uri.file(args[0]),
          args[1],
        )
      },
      [file, MarkdownEditorViewType] as [string, string],
    )
    const frame = wf(workbox)
    await waitForE2EReadiness(
      frame,
      (state) =>
        state.routerReady && state.editorEpoch > 0 && state.mode === mode,
      { timeout: 90_000, message: `${mode} large fixture readiness` },
    )

    // --- Opening checkpoint (control): the index was warmed right before it. ---
    await expect
      .poll(
        () =>
          frame
            .locator('body')
            .evaluate(() => (window as any).__undoSnapshotProbe.warm !== null),
        {
          timeout: 60_000,
          message: 'the probe reached the opening checkpoint',
        },
      )
      .toBe(true)
    await expect
      .poll(async () => (await sample(frame)).undoDepth, { timeout: 60_000 })
      .toBeGreaterThanOrEqual(1)
    const warm = await frame
      .locator('body')
      .evaluate(() => (window as any).__undoSnapshotProbe.warm as Probe['warm'])
    console.log(JSON.stringify({ mode, warm }))
    // Non-vacuous: the warm happened before the checkpoint, built the index once, with a caret.
    expect(warm?.reason).toBe('')
    expect(warm?.ok).toBe(true)
    expect(warm?.undoDepthAtWarm).toBe(0)
    expect((warm?.buildsAfter ?? 0) - (warm?.buildsBefore ?? 0)).toBe(1)
    expect(warm?.caretInside).toBe(true)
    await quiet(frame, `${mode} quiet after the opening checkpoint`)
    const afterCheckpoint = await sample(frame)
    console.log(JSON.stringify({ mode, afterCheckpoint }))
    // The checkpoint really wrote and removed its marker and split a Text node, and nothing else
    // wrote to the live root, so a rebuild could only come from the snapshot.
    expect(afterCheckpoint.log.markerAdded).toBeGreaterThan(0)
    expect(afterCheckpoint.log.markerRemoved).toBe(
      afterCheckpoint.log.markerAdded,
    )
    expect(afterCheckpoint.log.splitTails).toBeGreaterThan(0)
    expect(afterCheckpoint.log.pairedTails).toBe(afterCheckpoint.log.splitTails)
    expect(afterCheckpoint.log.foreignKinds).toEqual([])
    expect(afterCheckpoint.undoDepth).toBe(1)
    expect(afterCheckpoint.builds).toBe(warm!.buildsAfter)

    const [firstIndex, secondIndex] = await plainParagraphIndexes(frame)
    expect(secondIndex).toBeGreaterThan(firstIndex)
    const paragraphs = frame.locator(
      `.vditor-${mode} .vditor-reset > p[data-block="0"]`,
    )
    const first = paragraphs.nth(firstIndex)
    const second = paragraphs.nth(secondIndex)

    await frame
      .locator('body')
      .evaluate(() => (window as any).__undoSnapshotArmMoves())
    // Alternate between the two paragraphs so every hover is a new pointer move.
    const hoverBoth = async () => {
      await second.hover()
      await first.hover()
    }
    const sampleBefore = await sample(frame)
    await hoverBoth()
    const afterCheckpointHover = await sample(frame)
    const checkpointMoves = await movesSince(frame, sampleBefore.moves)
    console.log(JSON.stringify({ mode, checkpointMoves }))
    // Acceptance 1: no index build and no block-handle snapshot pair after the checkpoint.
    expect(afterCheckpointHover.builds - sampleBefore.builds).toBe(0)
    expect(
      afterCheckpointHover.snapshotPairs - sampleBefore.snapshotPairs,
    ).toBe(0)
    // Acceptance 3: the warm lookup (the first pointer handler after the snapshot) is in budget.
    expect(checkpointMoves.length).toBeGreaterThan(0)
    expect(Math.max(...checkpointMoves)).toBeLessThanOrEqual(BUDGET_MS)
    // Acceptance 3: caret, Undo depth and host bytes did not move.
    expect(afterCheckpoint.caret?.collapsed).toBe(true)
    expect(afterCheckpointHover.undoDepth).toBe(1)
    const hostAfterCheckpoint = await hostState(evaluateInVSCode, file)
    expect(hostAfterCheckpoint.text === original).toBe(true)
    expect([hostAfterCheckpoint.dirty, hostAfterCheckpoint.version]).toEqual([
      false,
      1,
    ])

    // --- Later snapshot and control: a real OS-typed character is a source edit. It invalidates
    // the index, the next hover rebuilds, and the edit's own delayed Undo snapshot
    // (timer path, with caret restore) then lands on the rebuilt entry without dropping it. ---
    await first.click({ position: { x: 60, y: 8 } })
    await quiet(frame, `${mode} quiet after the click`)
    const beforeEdit = await sample(frame)
    const paragraphBefore = (await first.textContent()) ?? ''
    expect(beforeEdit.caret?.collapsed).toBe(true)
    expect(beforeEdit.undoDepth).toBe(1)
    const xtest = await createXtestInput(electronApp, workbox)
    expect(xtest.client.visible).toBe(true)
    await xtest.activateAndFocus()
    // The edit's own re-render is debounced, and its Undo snapshot is a further 800 ms timer. Hold
    // that snapshot until the rebuilt entry exists, so the order is established, not raced.
    await frame
      .locator('body')
      .evaluate(() => (window as any).__undoSnapshotHold(true))
    await xtest.type('x')
    await quiet(frame, `${mode} quiet after the typed character`, 3, 100)
    const typed = await sample(frame)
    expect(typed.undoDepth).toBe(beforeEdit.undoDepth)
    let lastBuilds = typed.builds
    let stableCycles = 0
    for (let cycle = 0; cycle < 8 && stableCycles < 2; cycle++) {
      await hoverBoth()
      const { builds } = await sample(frame)
      stableCycles = builds === lastBuilds ? stableCycles + 1 : 0
      lastBuilds = builds
    }
    expect(stableCycles).toBe(2)
    const rebuilt = await sample(frame)
    console.log(JSON.stringify({ mode, beforeEdit, typed, rebuilt }))
    // Acceptance 2: the real edit invalidated the index (the shipped hover path built again). The
    // held snapshot has not run, so every one of those builds precedes it.
    expect(rebuilt.builds - beforeEdit.builds).toBeGreaterThanOrEqual(1)
    expect(rebuilt.undoDepth).toBe(beforeEdit.undoDepth)
    // Release the held snapshot: it now runs against the rebuilt entry.
    const released = await frame
      .locator('body')
      .evaluate(() => (window as any).__undoSnapshotHold(false) as number)
    expect(released).toBeGreaterThan(0)
    await expect
      .poll(async () => (await sample(frame)).undoDepth, { timeout: 30_000 })
      .toBe(beforeEdit.undoDepth + 1)
    await quiet(frame, `${mode} quiet after the edit's snapshot`)
    const afterSnapshot = await sample(frame)
    // Non-vacuous: the edit's snapshot wrote and removed one more marker pair with its split, and
    // nothing else wrote to the root after the rebuild.
    expect(afterSnapshot.log.markerAdded - rebuilt.log.markerAdded).toBe(1)
    expect(afterSnapshot.log.markerRemoved - rebuilt.log.markerRemoved).toBe(1)
    expect(afterSnapshot.log.pairedTails - rebuilt.log.pairedTails).toBe(1)
    expect(afterSnapshot.log.foreign).toBe(rebuilt.log.foreign)
    // Acceptance 3: the snapshot did not move the caret (the edit left it collapsed after the "x").
    expect(afterSnapshot.caret).toEqual(typed.caret)
    await hoverBoth()
    const afterSnapshotHover = await sample(frame)
    const snapshotMoves = await movesSince(frame, afterSnapshot.moves)
    console.log(
      JSON.stringify({
        mode,
        afterSnapshot,
        afterSnapshotHover,
        snapshotMoves,
      }),
    )
    // Acceptance 1: the later snapshot kept the rebuilt entry, so the next hovers build nothing.
    expect(afterSnapshotHover.builds - afterSnapshot.builds).toBe(0)
    expect(afterSnapshotHover.snapshotPairs - afterSnapshot.snapshotPairs).toBe(
      0,
    )
    // Acceptance 3: the warm lookup after the snapshot is in budget.
    expect(snapshotMoves.length).toBeGreaterThan(0)
    expect(Math.max(...snapshotMoves)).toBeLessThanOrEqual(BUDGET_MS)
    // Acceptance 2 (source-correct): the host received the edit. The editor serializes the whole
    // document, so only the edited paragraph is compared: its text now holds exactly one more "x"
    // and the host text contains that paragraph.
    const paragraphAfter = (await first.textContent()) ?? ''
    expect(paragraphAfter.length).toBe(paragraphBefore.length + 1)
    expect(
      Array.from(paragraphAfter).some(
        (c, i) =>
          c === 'x' &&
          `${paragraphAfter.slice(0, i)}${paragraphAfter.slice(i + 1)}` ===
            paragraphBefore,
      ),
    ).toBe(true)
    await expect
      .poll(async () =>
        (await hostState(evaluateInVSCode, file)).text.includes(paragraphAfter),
      )
      .toBe(true)
    const edited = await hostState(evaluateInVSCode, file)
    expect(edited.dirty).toBe(true)
  })
}
