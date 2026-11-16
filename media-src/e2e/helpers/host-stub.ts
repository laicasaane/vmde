import type { Page } from '@playwright/test'

// Task 733 / 024 (plan D-14 section 4.1, Q-140): a host stand-in for the Chromium harness smoke
// stage. It keeps the host text, applies the webview's `edit`, `edit-delta` and `history-delta` posts
// as the host does, answers an `edit` with `rebind: true` once (the host's `answerRebind`), and
// resynchronizes with one `update` of a new epoch when a delta does not match (shared rules 3.6).
// Not modelled: save, `exact-authority`, epochs across a reload, restart memory (run 1 covers them).
// Every other post is recorded by its kind only; no text is kept beyond the host text.

export interface HostStubState {
  text: string
  epoch: number
  accepted: number
  resyncs: number
  rebinds: number
  kinds: string[]
}

/** Installs the stub's `acquireVsCodeApi` before the page's scripts run; `ready` gets the `init` update. */
export async function installHostStub(
  page: Page,
  init: { content: string; options?: Record<string, unknown> },
): Promise<void> {
  await page.addInitScript(
    (setup) => {
      type Position = { line: number; character: number }
      type Change = {
        start: Position
        end: Position
        oldText: string
        text: string
      }
      const state = {
        text: setup.content,
        epoch: 0,
        accepted: 0,
        resyncs: 0,
        rebinds: 0,
        kinds: [] as string[],
      }
      // The last accepted delta sequence of the current epoch (the host's `acceptedSequence`).
      let lastSequence = 0
      ;(window as any).__vmdeHostStub = state
      const answer = (message: unknown) => window.postMessage(message, '*')

      /** The offset of `position` in `text` (`\n` line endings), or -1 when it is outside the text. */
      const offsetOf = (text: string, position: Position): number => {
        let offset = 0
        for (let line = 0; line < position.line; line++) {
          const next = text.indexOf('\n', offset)
          if (next < 0) return -1
          offset = next + 1
        }
        const lineEnd = text.indexOf('\n', offset)
        const end = lineEnd < 0 ? text.length : lineEnd
        return offset + position.character <= end
          ? offset + position.character
          : -1
      }

      /** The text after `changes` (ranges of the pre-edit text), or undefined when one does not match. */
      const applied = (changes: Change[]): string | undefined => {
        const ranges: Array<{ from: number; to: number; text: string }> = []
        let previousTo = 0
        for (const change of changes) {
          const from = offsetOf(state.text, change.start)
          const to = offsetOf(state.text, change.end)
          if (from < previousTo || to < from) return undefined
          if (state.text.slice(from, to) !== change.oldText) return undefined
          ranges.push({ from, to, text: change.text })
          previousTo = to
        }
        let out = state.text
        for (let i = ranges.length - 1; i >= 0; i--)
          out =
            out.slice(0, ranges[i].from) +
            ranges[i].text +
            out.slice(ranges[i].to)
        return out
      }

      const resync = () => {
        state.resyncs++
        state.epoch++
        const afterSequence = lastSequence
        lastSequence = 0
        answer({
          command: 'update',
          type: 'update',
          content: state.text,
          epoch: state.epoch,
          afterSequence,
        })
      }

      const onReady = () =>
        answer({
          command: 'update',
          type: 'init',
          content: setup.content,
          cdn: '/vditor',
          options: setup.options,
          theme: 'light',
          wiki: { enabled: false },
          e2e: true,
          epoch: 0,
        })

      // A whole-text edit; one with `rebind: true` is answered once, as the host's `answerRebind`.
      const onEdit = (posted: any) => {
        state.text = posted.content
        state.accepted++
        if (posted.rebind !== true) return
        state.rebinds++
        const editSequence =
          typeof posted.sequence === 'number' ? posted.sequence : undefined
        answer({
          command: 'rebind',
          epoch: state.epoch,
          afterSequence: lastSequence,
          content: state.text,
          ...(editSequence === undefined ? {} : { editSequence }),
        })
      }

      // An `edit-delta` or `history-delta`: accepted on the current epoch and the next sequence when
      // every `oldText` matches, else answered by a resynchronization.
      const onDelta = (posted: any) => {
        const inOrder =
          posted.epoch === state.epoch &&
          posted.sequence === lastSequence + 1 &&
          Array.isArray(posted.changes)
        const next = inOrder ? applied(posted.changes) : undefined
        if (next === undefined) {
          resync()
          return
        }
        state.text = next
        lastSequence = posted.sequence
        state.accepted++
      }

      const receive = (posted: any) => {
        const kind = typeof posted?.command === 'string' ? posted.command : '?'
        state.kinds.push(kind)
        if (kind === 'ready') onReady()
        else if (kind === 'edit') onEdit(posted)
        else if (kind === 'edit-delta' || kind === 'history-delta')
          onDelta(posted)
      }

      ;(window as any).acquireVsCodeApi = () => ({
        postMessage: receive,
        getState: () => undefined,
        setState: () => undefined,
      })
    },
    { content: init.content, options: init.options ?? {} },
  )
}

/** A copy of the stub's state. */
export function hostStubState(page: Page): Promise<HostStubState> {
  return page.evaluate(() => {
    const state = (window as any).__vmdeHostStub as HostStubState | undefined
    if (!state) throw new Error('host stub not installed')
    return { ...state, kinds: [...state.kinds] }
  })
}
