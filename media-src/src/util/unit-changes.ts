import type { MovableKind } from '../../../src/shared/block-move'

// Live units of the text model as other modules see them (Task 733). Types only: `editing` and
// `nav` read units through injected functions and never import `bridge`. The feed part (changes,
// lines, `UnitFeed`) follows in task 005.

type LiveUnitKind = MovableKind | 'cell'

export interface LiveUnit {
  /** The cell, the li, or the first member of a block. */
  readonly el: HTMLElement
  readonly members: readonly HTMLElement[]
  readonly kind: LiveUnitKind
  /** The top-level element that holds it: the table, the list, or `el`. */
  readonly top: HTMLElement
}
