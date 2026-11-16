export type E2EMode = 'ir' | 'wysiwyg' | 'sv'

/** Task 733 / 024: the shipped unit switches, so a real-VS-Code spec can skip a feature that ships off. */
export interface E2ESwitches {
  wysiwygUnits: boolean
  sourceUnits: boolean
  definitionUnits: boolean
  singleSelectionWrite: boolean
}

export interface E2EReadinessSnapshot {
  routerReady: boolean
  editorEpoch: number
  modeEpoch: number
  mode: E2EMode | null
  pending: Record<string, number>
  completed: Record<string, number>
  /** Absent until `recordE2ESwitches` runs. */
  switches?: E2ESwitches
}

declare global {
  interface Window {
    __vmdeE2EReadiness?: E2EReadinessSnapshot
  }
}

let routerInstalled = false
let ledger: E2EReadinessSnapshot | null = null

const emptyLedger = (): E2EReadinessSnapshot => ({
  routerReady: routerInstalled,
  editorEpoch: 0,
  modeEpoch: 0,
  mode: null,
  pending: {},
  completed: {},
})

export function configureE2EReadiness(enabled: boolean): void {
  if (!enabled) {
    ledger = null
    routerInstalled = false
    delete window.__vmdeE2EReadiness
    return
  }
  if (!ledger) ledger = emptyLedger()
  window.__vmdeE2EReadiness = ledger
}

export function markRouterReady(): void {
  routerInstalled = true
  if (!ledger) return
  ledger.routerReady = true
}

export function markEditorReady(mode: E2EMode): void {
  if (!ledger) return
  ledger.editorEpoch++
  ledger.mode = mode
}

export function markModeReady(mode: E2EMode): void {
  if (!ledger) return
  ledger.modeEpoch++
  ledger.mode = mode
}

/** Task 733 / 024: records the shipped switches once per editor init (end-to-end runs only). */
export function recordE2ESwitches(switches: E2ESwitches): void {
  if (!ledger) return
  ledger.switches = { ...switches }
}

export function beginE2EActivity(kind: string): () => void {
  const target = ledger
  if (!target)
    return () => {
      /* disabled outside the real-VS-Code E2E harness */
    }
  target.pending[kind] = (target.pending[kind] ?? 0) + 1
  let completed = false
  return () => {
    if (completed) return
    completed = true
    target.pending[kind] = Math.max(0, (target.pending[kind] ?? 1) - 1)
    target.completed[kind] = (target.completed[kind] ?? 0) + 1
  }
}

export function markE2EError(kind: string, error: unknown): void {
  if (!ledger) return
  const message = error instanceof Error ? error.message : String(error)
  const key = `${kind}:error:${message.slice(0, 120)}`
  ledger.completed[key] = (ledger.completed[key] ?? 0) + 1
}

export function snapshotE2EReadiness(): E2EReadinessSnapshot | null {
  if (!ledger) return null
  const snapshot: E2EReadinessSnapshot = {
    ...ledger,
    pending: { ...ledger.pending },
    completed: { ...ledger.completed },
  }
  if (ledger.switches) snapshot.switches = { ...ledger.switches }
  return snapshot
}
