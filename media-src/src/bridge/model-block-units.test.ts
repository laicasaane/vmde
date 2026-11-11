// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest'
import type { Unit, UnitKind } from './text-model'
import { modelBlockUnits } from './model-block-units'

afterEach(() => {
  document.body.replaceChildren()
})

function element(tag = 'p'): HTMLElement {
  const el = document.createElement(tag)
  document.body.append(el)
  return el
}

function unit(
  kind: UnitKind,
  start: number,
  end: number,
  members: HTMLElement[] = [element()],
  overrides: Partial<Unit<HTMLElement>> = {},
): Unit<HTMLElement> {
  return {
    kind,
    el: members[0],
    members,
    start,
    end,
    startLine: 0,
    proof: 'none',
    html: undefined,
    canon: undefined,
    forms: [],
    children: [],
    dirty: false,
    explicit: false,
    changedAt: 0,
    ...overrides,
  }
}

function session(
  units: readonly Unit<HTMLElement>[] | undefined,
  text: string | undefined = 'model text',
) {
  return {
    confirmedUnits: () => units,
    confirmedSnapshot: () =>
      units && text !== undefined ? { text, epoch: 1 } : undefined,
  }
}

it('lists non-empty top-level units in order with their members and the model text', () => {
  const group = [element('div'), element('div'), element('div')]
  const cell = unit('cell', 40, 43)
  const row = unit('row', 40, 50, [], { children: [cell], el: undefined })
  const units = [
    unit('front-matter', 0, 10),
    unit('paragraph', 12, 12), // empty: left out
    unit('html-group', 14, 30, group),
    unit('table', 32, 60, [element('table')], { children: [row] }),
    unit('paragraph', 62, 70),
  ]

  const result = modelBlockUnits(session(units, 'model text'))

  expect(result?.exact).toBe('model text')
  expect(result?.units).toHaveLength(4)
  expect(result?.units.map((u) => u.kind)).toEqual([
    'front-matter',
    'html-group',
    'table',
    'paragraph',
  ])
  for (const [i, source] of [
    units[0],
    units[2],
    units[3],
    units[4],
  ].entries()) {
    const mapped = result!.units[i]!
    expect(mapped.element).toBe(source!.members[0])
    expect(mapped.members).toEqual(source!.members)
    expect(mapped.start).toBe(source!.start)
    expect(mapped.end).toBe(source!.end)
  }
  expect(result!.units[1]!.members).toHaveLength(3)
  expect(result!.units.map((u) => u.movable)).toEqual([false, true, true, true])
})

it('returns undefined when the session is not confirmed', () => {
  expect(modelBlockUnits(session(undefined))).toBeUndefined()
})

it('returns undefined when any unit is opaque', () => {
  const units = [
    unit('paragraph', 0, 4),
    unit('table', 6, 20, undefined, { proof: 'opaque' }),
  ]
  expect(modelBlockUnits(session(units))).toBeUndefined()
})

it('returns undefined for zero units, for only empty units and for a detached first member', () => {
  expect(modelBlockUnits(session([]))).toBeUndefined()
  expect(modelBlockUnits(session([unit('paragraph', 3, 3)]))).toBeUndefined()
  const detached = document.createElement('p')
  expect(
    modelBlockUnits(session([unit('paragraph', 0, 4, [detached])])),
  ).toBeUndefined()
  const removed = element()
  const gone = unit('paragraph', 6, 9, [removed])
  removed.remove()
  expect(
    modelBlockUnits(session([unit('paragraph', 0, 4), gone])),
  ).toBeUndefined()
})

it('returns undefined when the snapshot is missing', () => {
  expect(
    modelBlockUnits({
      confirmedUnits: () => [unit('paragraph', 0, 4)],
      confirmedSnapshot: () => undefined,
    }),
  ).toBeUndefined()
})
