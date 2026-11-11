import type { BlockHandleUnit } from '../nav/source-block-index'
import type { ModelSession } from './model-session'

// Task 733 / 005: maps the confirmed top-level model units to the source-block index's units, so
// the index can serve hover without a whole-document Lute call. `nav` never imports this module;
// `boot/finish-init.ts` injects it. Entries are display-only: every block action re-resolves fresh
// units and matches them by member identity, so model offsets never reach an action.

/**
 * `undefined` sends the index to its existing path: the model is not confirmed, a top-level unit is
 * opaque (the existing path keeps its own proof) or has no connected first member (a removed or
 * detached element), or nothing would be listed (an empty document keeps today's `null`).
 */
export function modelBlockUnits(
  session: Pick<ModelSession, 'confirmedUnits' | 'confirmedSnapshot'>,
): { exact: string; units: BlockHandleUnit[] } | undefined {
  const modelUnits = session.confirmedUnits()
  if (!modelUnits?.length) return undefined
  const text = session.confirmedSnapshot()?.text
  if (text === undefined) return undefined
  const units: BlockHandleUnit[] = []
  for (const unit of modelUnits) {
    const element = unit.members[0]
    if (unit.proof === 'opaque' || !element?.isConnected) return undefined
    // An empty unit (an empty paragraph) has no bytes and gets no handle.
    if (unit.start === unit.end) continue
    units.push({
      element,
      members: unit.members,
      start: unit.start,
      end: unit.end,
      // Top-level units are never cells or rows; the scan kinds are the movable kinds.
      kind: unit.kind as BlockHandleUnit['kind'],
      movable: unit.kind !== 'front-matter',
    })
  }
  return units.length ? { exact: text, units } : undefined
}
