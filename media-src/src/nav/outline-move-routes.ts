import type { HostMessage, WebviewMessage } from '../../../src/shared/protocol'
import {
  scanSourceHeadings,
  sourceHeadingLabel,
} from '../../../src/shared/section-move'
import type { OutlineSectionMoveRequest } from './outline-reorder'

// Task 630: the webview side of the host-planned outline section move, for both routes. The host
// owns the text and the plan (`editor-session.ts`, `applyExactGuarded`); the webview only proves it
// holds the host's bytes, mirrors the move locally and reports. Both routes pull the host text with
// `publish` first (so typing is on the host and the owned pair is the host text), then use the
// request / prepare / apply / outcome handshake below. DOM, Undo and edit-sync work is injected
// (`OutlineMoveDeps`) so the handshake is testable without an editor.

type PrepareMessage = Extract<
  HostMessage,
  { command: 'prepare-outline-section-move' }
>
type OutcomeMessage = Extract<
  HostMessage,
  { command: 'outline-section-move-outcome' }
>

export interface OutlineHeadingIdentity {
  start: number
  level: number
}

export interface OutlineMoveDeps<Local> {
  /** Pull the host text after publishing pending typing (`acquireExactAuthority({ publish: true })`);
   * `null` when there is no proof of the live rendering. */
  acquire(): Promise<{ exact: string; rendered: string } | null>
  /** The exact bytes the webview owns right now, or `null` (never the rendering). */
  snapshotExact(): string | null
  /** The editor that asked is still there and writable. */
  editorLive(): boolean
  post(message: WebviewMessage): void
  newRequestId(): string
  /** Mirror the move in the editor (checkpoints around `setValue`, applying flag held). */
  applyLocal(after: string): Local
  /** Commit the native Undo record and take ownership of `after`. `false`: nothing could be recorded. */
  recordApplied(local: Local, before: string, after: string): boolean
  /** Put the host's text back (stale or failed outcome). */
  replaceContent(content: string): void
  /** Take ownership of `after` after an applied move. */
  reown(after: string): void
}

interface Pending<Local> {
  local: Local | undefined
  before: string
  after: string
  resolve(): void
}

/** The outline rows' labels on exact source, in the form the host compares. */
export function exactOutlineLabels(exact: string): string[] {
  return scanSourceHeadings(exact).map((heading) =>
    sourceHeadingLabel(exact, heading),
  )
}

/**
 * Route (b): the host names headings by their offset in the host text. Map them to indices on the
 * acquired exact text; `null` when either identity is not a heading there (the host text moved on).
 */
export function planOutlineMoveByIdentity(
  exact: string,
  source: OutlineHeadingIdentity,
  target: OutlineHeadingIdentity,
  placement: 'before' | 'after',
): OutlineSectionMoveRequest | null {
  const headings = scanSourceHeadings(exact)
  const find = (identity: OutlineHeadingIdentity) =>
    headings.findIndex(
      (heading) =>
        heading.start === identity.start && heading.level === identity.level,
    )
  const sourceIndex = find(source)
  const targetIndex = find(target)
  if (sourceIndex < 0 || targetIndex < 0) return null
  return {
    sourceIndex,
    targetIndex,
    placement,
    rowLabels: headings.map((heading) => sourceHeadingLabel(exact, heading)),
  }
}

export function createOutlineMoveRoutes<Local>(deps: OutlineMoveDeps<Local>) {
  const pending = new Map<string, Pending<Local>>()

  const send = (request: OutlineSectionMoveRequest): Promise<void> =>
    new Promise<void>((resolve) => {
      const requestId = deps.newRequestId()
      pending.set(requestId, {
        local: undefined,
        before: '',
        after: '',
        resolve,
      })
      deps.post({
        command: 'request-outline-section-move',
        requestId,
        ...request,
      })
    })

  /** Route (a): the webview outline reorder. Resolves once the move is over (any outcome). */
  const requestByIndex = async (
    request: OutlineSectionMoveRequest,
  ): Promise<void> => {
    if (!(await deps.acquire()) || !deps.editorLive()) return
    await send(request)
  }

  /** Route (b): the native outline tree drag, named by host-text offsets. */
  const requestByIdentity = async (
    source: OutlineHeadingIdentity,
    target: OutlineHeadingIdentity,
    placement: 'before' | 'after',
  ): Promise<void> => {
    const pair = await deps.acquire()
    if (!pair || !deps.editorLive()) return
    const request = planOutlineMoveByIdentity(
      pair.exact,
      source,
      target,
      placement,
    )
    if (request) await send(request)
  }

  /** The host planned the move on `message.before`; mirror it only while we own those bytes. */
  const prepare = (message: PrepareMessage): void => {
    const entry = pending.get(message.requestId)
    if (!entry) return
    if (!deps.editorLive() || deps.snapshotExact() !== message.before) {
      // Not a silent return: the host drops its binding and the caller's promise resolves, with no
      // `setValue` (the editor already shows what the user has).
      pending.delete(message.requestId)
      deps.post({
        command: 'cancel-outline-section-move',
        requestId: message.requestId,
      })
      entry.resolve()
      return
    }
    entry.before = message.before
    entry.after = message.after
    entry.local = deps.applyLocal(message.after)
    deps.post({
      command: 'apply-outline-section-move',
      requestId: message.requestId,
      uri: message.uri,
      version: message.version,
      before: message.before,
      after: message.after,
    })
  }

  const finish = (message: OutcomeMessage): void => {
    const entry = pending.get(message.requestId)
    if (!entry) return
    pending.delete(message.requestId)
    if (message.status === 'applied') {
      const recorded =
        entry.local !== undefined &&
        deps.recordApplied(entry.local, entry.before, entry.after)
      if (!recorded && message.content) deps.replaceContent(message.content)
      // An applied move leaves the host holding `after`; own it so the next action needs no pull.
      deps.reown(entry.after)
    } else if (message.content) deps.replaceContent(message.content)
    entry.resolve()
  }

  return {
    requestByIndex,
    requestByIdentity,
    prepare,
    finish,
    pendingCount: () => pending.size,
  }
}
