// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { patchLuteGapRepair } from '../../../src/shared/lute-gap-repair'
import { patchLuteTableCodePipes } from '../../../src/shared/table-code-pipes'
import { definitionHeavyMarkdown } from '../../../test/vscode-e2e/definition-heavy-markdown'
import { createModelSession, type ModelSession } from '../bridge/model-session'
import { createUnitFeed } from '../bridge/unit-feed'
import type { UnitLute } from '../bridge/unit-lute'
import { promoteThematicBreaks } from '../editing/gap-paragraph'
import {
  spinUnit,
  type UnitSpinDeps,
  type UnitSpinResult,
} from '../editing/unit-spin'
import { applyBareUrlsWithin } from '../links/bare-url-decorate'
import type { LiveUnit, UnitFeed, UnitsChange } from '../util/unit-changes'
import { countBudget, countedLute, type Factor } from './budget-harness'
import { createRealLute } from './real-lute'

// Task 733 / 017 (Q-130): DEFINITION_UNITS ships false until the definition path is proven in VS Code;
// these tests prove that path, so they read the constant as true (the guard-off cases pass `false`).
vi.mock('../util/unit-changes', async (original) => ({
  ...(await original<typeof import('../util/unit-changes')>()),
  DEFINITION_UNITS: true,
}))

// Task 733 / 017-T1 (task 017 sections 6.6, 6.8, 6.12 item 3): the consumer rows of the counted budget
// tests (B-04, B-06, B-10, B-11, B-13, B-14) repeated on the definitions fixture. Each row drives the
// feed of a live session and one representative consumer per row. Before 017-I1 the model is off for
// this document ('unit-without-kind'); the scope helper of 012-19 (`forEachChangeScope`) is loaded at
// run time so its absence is an assertion, not an import error.

const IMPACT_MODULE = '../util/mutation-impact'
type ForEachChangeScope = (
  change: UnitsChange,
  visit: (el: HTMLElement) => void,
) => void
let forEachChangeScope: ForEachChangeScope | undefined
let lute: UnitLute & {
  SetToC(on: boolean): void
  SpinVditorIRDOM(html: string): string
}

beforeAll(async () => {
  const real = createRealLute('ir')
  patchLuteTableCodePipes(real.lute)
  patchLuteGapRepair(real.lute)
  real.lute.SetToC(true)
  lute = countedLute(real.lute)
  forEachChangeScope = (await import(/* @vite-ignore */ IMPACT_MODULE))
    .forEachChangeScope
})

interface Live {
  session: ModelSession
  feed: UnitFeed
  root: HTMLElement
  changes: UnitsChange[]
  frames: Array<() => void>
}
const opened: ModelSession[] = []

function openFeed(factor: Factor): Live {
  const markdown = definitionHeavyMarkdown(factor)
  const root = document.createElement('pre')
  root.className = 'vditor-reset vditor-ir'
  root.innerHTML = lute.Md2VditorIRDOM(markdown)
  document.body.append(root)
  const frames: Array<() => void> = []
  const session = createModelSession({
    win: window,
    getRoot: () => root,
    getLute: () => lute,
    getMode: () => 'ir',
    isPreviewShowing: () => false,
    isStreaming: () => false,
    isComposing: () => false,
    e2e: false,
    countFallbackPublication: () => undefined,
    requestAnimationFrame: (cb) => frames.push(cb),
    cancelAnimationFrame: () => undefined,
    now: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    inViewport: () => false,
  })
  opened.push(session)
  session.onHostText(markdown, 1)
  session.onEditDomComplete()
  const feed = createUnitFeed(
    session,
    { flush: () => undefined },
    {
      isComposing: () => false,
      root: () => root,
    },
  )
  expect(feed.isLive(), 'feed live over the definitions fixture').toBe(true)
  const changes: UnitsChange[] = []
  feed.onUnitsChanged((change) => {
    changes.push(change)
  })
  return { session, feed, root, changes, frames }
}

/** Edits the first text of `el` (pre-touch first), syncs, and returns the emitted non-build change. */
function edit(
  live: Live,
  el: HTMLElement,
  text: string,
): UnitsChange | undefined {
  el.dispatchEvent(new Event('beforeinput', { bubbles: true }))
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  const node = walker.nextNode() as Text
  node.data += text
  live.changes.length = 0
  live.session.deltaPort().prepareDelta(1)
  for (const cb of live.frames.splice(0)) cb()
  return live.changes.find((change) => change.cause !== 'build')
}

const definitionOf = (live: Live): HTMLElement =>
  live.root.querySelector('[data-type="link-ref-defs-block"]') as HTMLElement
const referencingParagraph = (live: Live): HTMLElement =>
  Array.from(live.root.children).find((el) =>
    (el.textContent ?? '').startsWith('First paragraph'),
  ) as HTMLElement

function scopesOf(change: UnitsChange | undefined): HTMLElement[] {
  expect(
    forEachChangeScope,
    'forEachChangeScope exists (012-19-I)',
  ).toBeDefined()
  const out: HTMLElement[] = []
  if (change) forEachChangeScope?.(change, (el) => out.push(el))
  return out
}

afterEach(() => {
  for (const session of opened.splice(0)) session.dispose()
  document.body.replaceChildren()
})

describe.each<Factor>([1, 4, 16])(
  'definitions fixture at factor %i',
  (factor) => {
    it('B-04: a referencing paragraph edit decorates its scope only (bare-url decorator)', () => {
      const live = openFeed(factor)
      const paragraph = referencingParagraph(live)
      const scopes = scopesOf(edit(live, paragraph, 'x'))
      expect(scopes).toEqual([paragraph])
      const nodes = paragraph.querySelectorAll('*').length + 1
      const { counts } = countBudget(live.root, () => {
        for (const scope of scopes) applyBareUrlsWithin(scope)
      })
      expect(counts.rootQueries).toBe(0)
      expect(counts.nodesWalked + counts.queriedNodes).toBeLessThanOrEqual(
        nodes + 8,
      )
    }, 30_000)

    it('B-06 and B-10: a definition edit is non-whole and names no table or list (no table or diagram pass)', () => {
      const live = openFeed(factor)
      const definition = definitionOf(live)
      const change = edit(live, definition, '')
      expect(change?.whole).toBe(false)
      expect(change?.structural).toEqual([])
      expect(scopesOf(change)).toEqual([definition])
    }, 30_000)

    it('B-11: the gap-paragraph pass visits only the top level of the root', () => {
      const live = openFeed(factor)
      const { counts } = countBudget(live.root, () =>
        promoteThematicBreaks(live.root, null),
      )
      expect(counts.rootQueries).toBe(0)
      expect(counts.nodesWalked).toBeLessThanOrEqual(
        live.root.children.length + 8,
      )
    }, 30_000)

    it('B-13: the feed maps a caret in a definition and in a footnote to their units (settle re-spins the unit)', () => {
      const live = openFeed(factor)
      const definition = definitionOf(live)
      expect(live.feed.liveUnitOf(definition.firstChild as Node)?.kind).toBe(
        'definition',
      )
      const note = live.root.querySelector(
        '[data-type="footnotes-def"] p',
      ) as HTMLElement
      const unit = live.feed.liveUnitOf(note.firstChild as Node)
      expect(unit?.kind).toBe('footnote')
      expect(unit?.top.getAttribute('data-type')).toBe('footnotes-block')
    }, 30_000)

    it('B-14: a definition unit spin makes at most one flush and one selection write', () => {
      const live = openFeed(factor)
      const definition = definitionOf(live)
      const unit = live.feed.liveUnitOf(
        definition.firstChild as Node,
      ) as LiveUnit
      expect(unit?.kind).toBe('definition')
      const deps = {
        liveUnitOf: (node: Node) => live.feed.liveUnitOf(node),
        spinCell: (): UnitSpinResult => ({ kind: 'refused', reason: 'shape' }),
        spinListItem: (): UnitSpinResult => ({
          kind: 'refused',
          reason: 'shape',
        }),
        spinListItems: (): UnitSpinResult => ({
          kind: 'refused',
          reason: 'shape',
        }),
        isSettleRespin: () => false,
        listItemSpin: true,
        isModelLive: () => true,
        spinDefinition: (html: string): UnitSpinResult => ({
          kind: 'spun',
          html: lute.SpinVditorIRDOM(html),
        }),
      }
      const range = document.createRange()
      range.setStart(definition.firstChild as Node, 3)
      range.collapse(true)
      const event = new InputEvent('input', {
        inputType: 'insertText',
        data: 'x',
      })
      const { result, counts } = countBudget(live.root, () =>
        spinUnit(deps as UnitSpinDeps, range, live.root, event),
      )
      expect(result).toBe(true)
      expect(counts.flushes).toBeLessThanOrEqual(1)
      expect(counts.selectionWrites).toBeLessThanOrEqual(1)
      expect(counts.rootQueries).toBe(0)
    }, 30_000)
  },
)
