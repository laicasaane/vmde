import { debug } from './host-log'

// Task 657: the VS Code global Memento can show an OLDER value of a key after several quick writes,
// and can persist it.
//   What it fixes: three Preview toggles about 100 ms apart (on, off, on) left the stored value off,
//   although the host received the messages in order and every `update` was acknowledged.
//   Why: the stale value is produced after the acknowledgements, outside our code. `update` flushes
//   the whole local object to the renderer, where the storage class waits `RE.DEFAULT_FLUSH_DELAY`
//   (100 ms, trailing) before it reaches the main process. The main process debounces its change
//   event by `STORAGE_CHANGE_DEBOUNCE_TIME` (100 ms, trailing) and `serializeStorageChangeEvents`
//   reads the value it holds WHEN THE TIMER FIRES. With writes 100 ms apart that is an older write,
//   and it is broadcast to every window including the writer. `acceptExternal` replaces the renderer
//   cache with it and `$acceptValue` makes the extension host's `_storageListener` reassign the whole
//   local object, so `get` returns the old value after the last write was acknowledged. Any later
//   `update` of ANY key then flushes that stale object and persists it. The `Memento` contract
//   (`@types/vscode`) promises nothing about this and has no change event.
//   How: each write records the last local intent for its key. Reads of these keys go through `get`,
//   which returns the intent while it lives, so a stale window is invisible to readers. A single
//   interval checks every intent against the store for a bounded quiet window and writes the
//   intended value again when the store drifted to a value this window wrote earlier. A drift to a
//   value this window never wrote is another window's genuine change: it is accepted. Writes are
//   never queued: `update` is called at once (so call order equals message order and a never-settled
//   `update` blocks nobody).

export type StateStore = {
  get(key: string): unknown
  update(key: string, value: unknown): PromiseLike<void>
}

export type LastWriteWins = {
  /** Store `value`; resolves when the store acknowledged it (not at the end of the check window). */
  write(key: string, value: unknown): Promise<void>
  /** The last local intent for `key` while it lives, else the store's value. */
  get(key: string): unknown
  /** Stop the check timer and forget every intent; writes nothing. */
  dispose(): void
}

// The stale broadcast lands about 300 ms after the last write (100 ms renderer delay + 100 ms main
// debounce + hops). CHECK_MS bounds how long a stale stored copy can sit; WINDOW_MS is a quiet period
// of about five times the measured landing time; each repair is a new write and restarts it.
const CHECK_MS = 250
const WINDOW_MS = 1500
// Each repair writes the intended value again; the bound keeps a store that keeps reverting from
// being fought forever (for example two windows writing the same key).
const MAX_REPAIRS = 3
const HISTORY_MAX = 8

type Intent = {
  value: unknown
  // The base (the value before the first write of this chain) then every value written since.
  history: unknown[]
  quietMs: number
  repairs: number
}

const helpers = new WeakMap<StateStore, LastWriteWins>()

/** The helper for `store`, shared by everything that reads and writes that store object, so the
 * per-key intent is one value however many editors write. */
export function lastWriteWinsFor(store: StateStore): LastWriteWins {
  let helper = helpers.get(store)
  if (!helper) {
    helper = createLastWriteWins(store)
    helpers.set(store, helper)
  }
  return helper
}

// Booleans, numbers and undefined compare by identity. Stored objects (saved options, emoji
// recents) come back from a storage echo as parsed copies, so they compare by their JSON form.
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function createLastWriteWins(store: StateStore): LastWriteWins {
  const intents = new Map<string, Intent>()
  let timer: ReturnType<typeof setInterval> | undefined
  // After dispose the helper is a plain pass-through: no intent, no timer.
  let disposed = false

  const stopIfIdle = () => {
    if (intents.size > 0 || timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  // Returns true when it wrote the intended value again.
  function checkDrift(key: string, intent: Intent): boolean {
    const stored = store.get(key)
    if (sameValue(stored, intent.value)) return false
    if (!intent.history.some((seen) => sameValue(seen, stored))) {
      // A value this window never wrote: another window's genuine change.
      intents.delete(key)
      debug('state changed elsewhere', key)
      return false
    }
    if (intent.repairs >= MAX_REPAIRS) {
      intents.delete(key)
      debug('state write not confirmed', key)
      return false
    }
    intent.repairs++
    intent.quietMs = 0
    try {
      Promise.resolve(store.update(key, intent.value)).then(
        undefined,
        (error) => debug('state repair failed', key, error),
      )
    } catch (error) {
      // A synchronous throw must not stop the other keys' checks or the idle cleanup.
      debug('state repair failed', key, error)
    }
    return true
  }

  function tick() {
    for (const [key, intent] of [...intents]) {
      if (intents.get(key) !== intent) continue
      try {
        if (checkDrift(key, intent) || !intents.has(key)) continue
        intent.quietMs += CHECK_MS
        if (intent.quietMs >= WINDOW_MS) intents.delete(key)
      } catch (error) {
        // One key's failure must not skip the others or the idle cleanup below.
        intents.delete(key)
        debug('state check failed', key, error)
      }
    }
    stopIfIdle()
  }

  function ensureTimer() {
    if (timer !== undefined) return
    timer = setInterval(tick, CHECK_MS)
    // The check must not keep the extension host alive.
    ;(timer as { unref?: () => void }).unref?.()
  }

  async function write(key: string, value: unknown): Promise<void> {
    if (disposed) {
      await store.update(key, value)
      return
    }
    const previous = intents.get(key)
    const history = previous?.history ?? [store.get(key)]
    history.push(value)
    if (history.length > HISTORY_MAX) history.splice(1, 1) // never drop the base
    const intent: Intent = { value, history, quietMs: 0, repairs: 0 }
    intents.set(key, intent)
    // First store call on purpose: call order equals message order.
    let acknowledged: PromiseLike<void>
    try {
      acknowledged = store.update(key, value)
    } catch (error) {
      // A synchronous throw leaves nothing for a timer to verify.
      if (intents.get(key) === intent) intents.delete(key)
      stopIfIdle()
      throw error
    }
    ensureTimer()
    await acknowledged
    // A newer write owns the key and runs its own check. Otherwise this is the local-race repair: an
    // echo that replaced the local object between the update and its flush.
    if (intents.get(key) === intent) {
      checkDrift(key, intent)
      stopIfIdle()
    }
  }

  return {
    write,
    get: (key) => {
      if (disposed) return store.get(key)
      const intent = intents.get(key)
      return intent ? intent.value : store.get(key)
    },
    dispose() {
      disposed = true
      if (timer !== undefined) clearInterval(timer)
      timer = undefined
      intents.clear()
    },
  }
}
