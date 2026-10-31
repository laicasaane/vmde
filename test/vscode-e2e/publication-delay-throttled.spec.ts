/**
 * Task 624 S4 — publication while the webview's timers are throttled to a 1 s grid.
 *
 * Task 602 S1e recorded a journey in which every timer-driven webview event fell on one ~1 s grid,
 * so the 250 ms edit-sync debounce kept being re-armed by each key and no `edit` was posted for
 * about 4 s while keys were arriving. Chromium's throttling cannot be forced from a spec, so the
 * spec simulates it: every webview `setTimeout` of 100 ms or more is moved to the first 1,000 ms
 * boundary of `performance.now()` at or after its requested time (it never fires early).
 *
 * Contract (Task 624, overdue rule): while keys arrive at 440 ms gaps, each key except the last is
 * contained in a posted `edit` no later than one frame (50 ms) after the next key's `input` event;
 * the last key is posted within 250 ms + the 1,000 ms grid + one frame (1,300 ms) of its keydown,
 * the best the rule can do because nothing follows it to publish earlier.
 *
 * Modes: IR prose and Split View on a small document, where the bound applies (the prose fast path
 * and Split View call `options.input()` per key). WYSIWYG and IR keys outside the prose fast path
 * publish from the checkpoint by design and are not covered.
 *
 * Run (inside an isolated Xvfb/Openbox session, after `node build.mjs`):
 * `VMDE_XTEST=1 npm --prefix test/vscode-e2e test -- publication-delay-throttled.spec.ts`.
 */
import { expect, test } from 'vscode-test-playwright'
import {
  closeAll,
  evalFrame,
  type Kit,
  type Mode,
  makeKit,
  openDocument,
  select,
} from './helpers/shortcut-xtest-kit'
import { waitForInitialUndoSnapshot } from './webview-helpers'

const ANCHOR = 'delta.'
const DOC =
  '# Probe\n\nAlpha bravo charlie delta.\n\nEcho foxtrot golf hotel.\n\nIndia juliet kilo lima.\n'
const KEYS = 'abcdefghijkl'
const GAP_MS = 440
const FRAME_MS = 50
const GRID_MS = 1000
const LAST_KEY_BOUND_MS = 250 + GRID_MS + FRAME_MS

function installThrottle(_body: Element): boolean {
  const w = window as any
  if (w.__t624) return true
  const t: any = { keys: [], inputs: [], posts: [], throttled: 0 }
  const trusted = (list: any[], event: Event, extra: object = {}) => {
    if (event.isTrusted) list.push({ t: Date.now(), ...extra })
  }
  window.addEventListener(
    'keydown',
    (event) => trusted(t.keys, event, { key: event.key }),
    true,
  )
  document.addEventListener('input', (event) => trusted(t.inputs, event), true)
  const api = w.vscode
  const post = api.postMessage
  const wrapper = Object.create(api)
  Object.defineProperty(wrapper, 'postMessage', {
    enumerable: true,
    value: (message: any, ...rest: unknown[]) => {
      if (message?.command === 'edit' && typeof message.content === 'string')
        t.posts.push({ t: Date.now(), content: message.content })
      return post.call(api, message, ...rest)
    },
  })
  w.vscode = wrapper
  // Move each timer of 100 ms or more to the first grid boundary at or after its requested time.
  const original = window.setTimeout.bind(window)
  w.__t624Original = original
  ;(window as any).setTimeout = (
    handler: TimerHandler,
    delay?: number,
    ...args: unknown[]
  ) => {
    const wanted = Number(delay) || 0
    if (wanted < 100 || typeof handler !== 'function')
      return original(handler, delay, ...args)
    const now = performance.now()
    const target = Math.ceil((now + wanted) / 1000) * 1000
    t.throttled++
    return original(handler, target - now, ...args)
  }
  w.__t624 = t
  return true
}

function readThrottle(_body: Element) {
  const t = (window as any).__t624
  return {
    keys: t.keys as { t: number; key: string }[],
    inputs: t.inputs as { t: number }[],
    posts: t.posts as { t: number; content: string }[],
    throttled: t.throttled as number,
  }
}

function removeThrottle(_body: Element): void {
  const w = window as any
  if (w.__t624Original) window.setTimeout = w.__t624Original
}

type Page = ReturnType<typeof readThrottle>

const containsKeys = (page: Page, count: number) =>
  page.posts.find((p) => p.content.includes(ANCHOR + KEYS.slice(0, count)))

// The keys whose first containing `edit` came after their limit (or never).
function lateKeys(page: Page): string[] {
  const late: string[] = []
  for (let index = 0; index < KEYS.length; index++) {
    const post = containsKeys(page, index + 1)
    const limit =
      index === KEYS.length - 1
        ? page.keys[index].t + LAST_KEY_BOUND_MS
        : page.inputs[index + 1].t + FRAME_MS
    if (!post) late.push(`key ${index + 1}: never published`)
    else if (post.t > limit)
      late.push(`key ${index + 1}: ${post.t - limit} ms past its limit`)
  }
  return late
}

async function typeKeys(kit: Kit): Promise<void> {
  for (let index = 0; index < KEYS.length; index++) {
    await kit.xtest.type(KEYS[index])
    if (index < KEYS.length - 1) await kit.workbox.waitForTimeout(GAP_MS)
  }
}

// Wait for the last key to be published, or for the longest legitimate delay to pass.
async function readWhenPublished(kit: Kit): Promise<Page> {
  const deadline = Date.now() + 4_000
  let page = await evalFrame(kit, readThrottle, 0)
  while (!containsKeys(page, KEYS.length) && Date.now() < deadline) {
    await kit.workbox.waitForTimeout(100)
    page = await evalFrame(kit, readThrottle, 0)
  }
  return page
}

const cases: [string, Mode][] = [
  ['IR prose', 'ir'],
  ['Split View', 'sv'],
]

test.describe('Task 624 S4 publication under throttled timers', () => {
  test.skip(
    process.env.VMDE_XTEST !== '1',
    'requires isolated Xvfb/Openbox XTEST',
  )

  test.afterEach(async ({ evaluateInVSCode }) => {
    await evaluateInVSCode(async (vscode) => {
      await vscode.workspace
        .getConfiguration('vmde')
        .update('editor.defaultMode', undefined, true)
    })
  })

  for (const [title, mode] of cases) {
    test(`${title}: keys are published while 1 s-grid timers starve the debounce`, async ({
      workbox,
      electronApp,
      evaluateInVSCode,
      baseDir,
    }) => {
      test.setTimeout(240_000)
      const kit = await makeKit(
        workbox,
        electronApp,
        evaluateInVSCode,
        baseDir,
        'Task 624 S4',
      )
      const ctx = await openDocument(kit, `t624-${mode}.md`, DOC, mode)
      try {
        await waitForInitialUndoSnapshot(kit.frame())
        expect(await evalFrame(kit, installThrottle, 0), 'probe').toBe(true)
        await select(ctx, ANCHOR, { collapsed: true, offset: ANCHOR.length })
        await typeKeys(kit)
        const page = await readWhenPublished(kit)
        // Setup validity first: the failure below must be about publication, not delivery.
        expect(page.throttled, 'timers were throttled').toBeGreaterThan(0)
        expect(page.keys.map((k) => k.key).join(''), 'keys delivered').toBe(
          KEYS,
        )
        expect(page.inputs.length, 'input events').toBe(KEYS.length)
        expect(lateKeys(page), 'keys published past their limit').toEqual([])
      } finally {
        await evalFrame(kit, removeThrottle, 0).catch(() => undefined)
        await closeAll(kit, ctx.file)
      }
    })
  }
})
