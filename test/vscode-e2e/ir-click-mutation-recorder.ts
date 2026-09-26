/** Task 578: test-only, text-free mutation evidence. Install BEFORE the work counter probe so
 * sourceIdentity retains the unwrapped getValue and cannot charge serialization to a click. */
export interface ClickNodeSummary {
  id: number
  nodeName: string
  className: string
  dataType: string | null
  textLen: number
}

export interface ClickMutationRecord {
  batch: number
  t: number
  lastEvent: { type: string; t: number; target: ClickNodeSummary | null } | null
  type: string
  target: ClickNodeSummary
  admitted: boolean
  attributeName: string | null
  oldLen: number | null
  newLen: number | null
  sameValue: boolean | null
  sameText: boolean | null
  markerClass: string
  added: (ClickNodeSummary & { outerHTMLHash: string })[]
  removed: (ClickNodeSummary & { outerHTMLHash: string })[]
  restoredPair: number[]
}

export interface ClickMutationResult {
  label: string
  records: ClickMutationRecord[]
  events: NonNullable<ClickMutationRecord['lastEvent']>[]
  caret: { node: ClickNodeSummary | null; offset: number }
}

export interface ClickSourceIdentity {
  utf16Length: number
  utf8Bytes: number
  sha256: string
}

export function installIrClickMutationRecorder(): void {
  const win = window as any
  if (win.__vmdeIrClickRecorder) return
  const outer = win.vditor
  if (!outer?.getValue) throw new Error('Task 578 editor is not ready')
  const getValue = outer.getValue.bind(outer)
  const activeRoot = (): HTMLElement => {
    const inner = outer.vditor
    return inner.currentMode === 'ir' ? inner.ir.element : inner.wysiwyg.element
  }

  // Verbatim copy of media-src/src/nav/source-block-index.ts::relevantMutations.
  // ir-click-index.spec.ts guards drift without exposing a new product API.
  function relevantMutations(records: MutationRecord[]): boolean {
    return records.some(
      (record) =>
        record.type !== 'attributes' ||
        (![
          'class',
          'style',
          'data-vmde-foldable',
          'data-vmde-list-foldable',
        ].includes(record.attributeName ?? '') &&
          !record.attributeName?.startsWith('aria-')),
    )
  }

  let armed = false
  let label = ''
  let root: HTMLElement
  let batch = 0
  let startedAt = 0
  let lastEvent: ClickMutationRecord['lastEvent'] = null
  let events: ClickMutationResult['events'] = []
  let records: ClickMutationRecord[] = []
  let pending: Promise<void>[] = []
  let nextNodeId = 0
  const ids = new WeakMap<Node, number>()
  const nodeId = (node: Node): number => {
    let id = ids.get(node)
    if (!id) {
      id = ++nextNodeId
      ids.set(node, id)
    }
    return id
  }
  const describe = (node: Node): ClickNodeSummary => ({
    id: nodeId(node),
    nodeName: node.nodeName,
    className:
      node instanceof Element ? (node.getAttribute('class') ?? '') : '',
    dataType: node instanceof Element ? node.getAttribute('data-type') : null,
    textLen: node.textContent?.length ?? 0,
  })
  const sha256 = async (value: string): Promise<string> =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join('')
  const changedNode = (node: Node) => {
    const summary = { ...describe(node), outerHTMLHash: '' }
    // Capture the string synchronously at delivery; only its digest leaves this closure.
    const html =
      node instanceof Element ? node.outerHTML : (node.nodeValue ?? '')
    pending.push(
      sha256(html).then((hash) => {
        summary.outerHTMLHash = hash
      }),
    )
    return summary
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one observer callback preserves delivery order and handles all three MutationRecord variants without retaining source values.
  const collect = (mutations: MutationRecord[]) => {
    if (!armed || mutations.length === 0) return
    batch++
    for (const [index, record] of mutations.entries()) {
      // The next oldValue is the intermediate new value when one node is written repeatedly
      // within a delivered batch; reading only the live DOM would misreport same-value writes.
      const next = mutations
        .slice(index + 1)
        .find(
          (candidate) =>
            candidate.target === record.target &&
            candidate.type === record.type &&
            candidate.attributeName === record.attributeName,
        )
      const value = next
        ? next.oldValue
        : record.type === 'attributes'
          ? (record.target as Element).getAttribute(record.attributeName!)
          : record.type === 'characterData'
            ? record.target.nodeValue
            : null
      records.push({
        batch,
        t: performance.now() - startedAt,
        lastEvent,
        type: record.type,
        target: describe(record.target),
        admitted: relevantMutations([record]),
        attributeName: record.attributeName,
        oldLen: record.oldValue?.length ?? null,
        newLen: value?.length ?? null,
        sameValue:
          record.type === 'attributes' ? record.oldValue === value : null,
        sameText:
          record.type === 'characterData' ? record.oldValue === value : null,
        markerClass: Array.from(record.target.parentElement?.classList ?? [])
          .filter((name) => name.startsWith('vditor-ir__marker'))
          .join(' '),
        added: Array.from(record.addedNodes, changedNode),
        removed: Array.from(record.removedNodes, changedNode),
        restoredPair: [],
      })
    }
  }
  const observer = new MutationObserver(collect)
  for (const type of [
    'pointerdown',
    'mousedown',
    'mouseup',
    'click',
    'selectionchange',
    'focus',
    'blur',
  ]) {
    // Window capture runs before the link popover's document capture handlers, which can call
    // stopImmediatePropagation. Document listeners installed after app startup miss those clicks.
    window.addEventListener(
      type,
      (event) => {
        if (!armed) return
        lastEvent = {
          type,
          t: performance.now() - startedAt,
          target: event.target instanceof Node ? describe(event.target) : null,
        }
        events.push(lastEvent)
      },
      true,
    )
  }

  win.__vmdeIrClickRecorder = {
    get armed() {
      return armed
    },
    async sourceIdentity(): Promise<ClickSourceIdentity> {
      if (armed)
        throw new Error('sourceIdentity must be outside the armed window')
      const source = getValue()
      return {
        utf16Length: source.length,
        utf8Bytes: new TextEncoder().encode(source).length,
        sha256: await sha256(source),
      }
    },
    start(nextLabel: string) {
      observer.disconnect()
      root = activeRoot()
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        characterDataOldValue: true,
      })
      records = []
      events = []
      pending = []
      batch = 0
      label = nextLabel
      lastEvent = null
      startedAt = performance.now()
      armed = true
    },
    async stop(): Promise<ClickMutationResult> {
      collect(observer.takeRecords())
      armed = false
      observer.disconnect()
      await Promise.all(pending)
      // This is a same-node/same-hash candidate pair, not a proof about the index observer's
      // batches: currentKey() may split them with takeRecords(). Checkpoint 2 must prove that.
      for (const record of records) {
        record.restoredPair = record.added
          .filter((node) =>
            records.some((other) =>
              other.removed.some(
                (removed) =>
                  removed.id === node.id &&
                  removed.outerHTMLHash === node.outerHTMLHash,
              ),
            ),
          )
          .map((node) => node.id)
      }
      const selection = window.getSelection()
      return {
        label,
        records,
        events,
        caret: {
          node: selection?.anchorNode ? describe(selection.anchorNode) : null,
          offset: selection?.anchorOffset ?? 0,
        },
      }
    },
  }
}
