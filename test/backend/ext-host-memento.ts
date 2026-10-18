// Task 657: a hand-stepped model of the VS Code extension-host global Memento, used to script the
// interleavings that lose a write. Two echo sources replace the local object:
//   1. the writer's own echo (`main()` queues it before the acknowledgement), and
//   2. the cross-process storage broadcast: the main process debounces storage changes and reads the
//      value it holds when the timer fires, so an OLDER stored value can reach the extension host
//      after the last acknowledgement (`deliverStaleEcho`).
// It also mirrors the rest of the host process. It mirrors the host process: `update` sets the local object at
// once and shares one pending promise per key; a scheduler tick (`flush`) sends the WHOLE local
// object to the main thread; the main thread (`main`) stores it and answers with an echo of the
// stored object followed by the acknowledgement; and a delivered echo REPLACES the local object, so
// a local `update` not yet flushed is discarded. Nothing runs on timers: the test calls the steps.
type Json = Record<string, unknown>

type Deferred = { resolve(): void; promise: Promise<void> }

type ToHost =
  | { kind: 'echo'; value: Json }
  | { kind: 'ack'; deferreds: Deferred[] }

const clone = (value: Json): Json => JSON.parse(JSON.stringify(value))

// Two microtask turns are not enough for the awaited chain in `write`, so yield generously.
const settleMicrotasks = async () => {
  for (let turn = 0; turn < 25; turn++) await Promise.resolve()
}

export function createExtHostMemento() {
  let local: Json = {}
  let pending = new Map<string, Deferred>()
  const toMain: { snapshot: Json; deferreds: Deferred[] }[] = []
  const toHost: ToHost[] = []
  const calls: { key: string; value: unknown }[] = []
  const state = { mainValue: {} as Json }
  const history: Json[] = []

  const memento = {
    get: (key: string): unknown => local[key],
    update(key: string, value: unknown): Promise<void> {
      calls.push({ key, value })
      local[key] = value
      const existing = pending.get(key)
      if (existing) return existing.promise
      let resolve!: () => void
      const promise = new Promise<void>((done) => {
        resolve = done
      })
      const deferred: Deferred = { resolve, promise }
      pending.set(key, deferred)
      return promise
    },
    keys: () => Object.keys(local),
    setKeysForSync: () => undefined,

    /** Scheduler tick: send the whole local object plus the pending promises to the main thread. */
    flush(): boolean {
      if (pending.size === 0) return false
      toMain.push({ snapshot: clone(local), deferreds: [...pending.values()] })
      pending = new Map()
      return true
    },
    /** Main thread: store the oldest snapshot, queue its echo, then its acknowledgement. */
    main(): boolean {
      const entry = toMain.shift()
      if (!entry) return false
      state.mainValue = clone(entry.snapshot)
      history.push(clone(state.mainValue))
      toHost.push({ kind: 'echo', value: clone(state.mainValue) })
      toHost.push({ kind: 'ack', deferreds: entry.deferreds })
      return true
    },
    /** Extension host: take the next item (echo replaces the local object; ack settles promises). */
    deliver(): boolean {
      const item = toHost.shift()
      if (!item) return false
      apply(item)
      return true
    },
    /** Deliver only the next echo, leaving acknowledgements queued. */
    deliverEcho(): boolean {
      const index = toHost.findIndex((item) => item.kind === 'echo')
      if (index < 0) return false
      apply(toHost.splice(index, 1)[0])
      return true
    },
    /** The debounced broadcast of an older stored snapshot lands now: it replaces the local object
     * (`history[index]`, oldest first) without touching the main-thread value. */
    deliverStaleEcho(index: number) {
      const older = history[index]
      if (!older) throw new Error(`no stored snapshot ${index}`)
      local = clone(older)
    },
    /** Another window of the same profile stored `value`: queue a whole-object echo of it. */
    injectEcho(value: Json) {
      toHost.push({ kind: 'echo', value: clone(value) })
    },
    /** Run flush, main and deliver until nothing is left, yielding for follow-up `update` calls. */
    async drain() {
      await settleMicrotasks()
      for (let round = 0; round < 50; round++) {
        const flushed = memento.flush()
        const mained = memento.main()
        let delivered = false
        while (memento.deliver()) delivered = true
        await settleMicrotasks()
        if (!flushed && !mained && !delivered && pending.size === 0) return
      }
      throw new Error('ext-host memento did not go idle')
    },
    settle: settleMicrotasks,
    get mainValue(): Json {
      return state.mainValue
    },
    /** Every snapshot the main thread stored, oldest first (`mainValue` is the last). */
    history,
    calls,
  }

  function apply(item: ToHost) {
    if (item.kind === 'echo') local = clone(item.value)
    else for (const deferred of item.deferreds) deferred.resolve()
  }

  return memento
}
