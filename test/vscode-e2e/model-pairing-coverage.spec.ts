import { appendFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { reopenVmdeFixture } from './webview-helpers'

// Task 733 / 004-D: how many of the repository's fixtures does the text model pair? Every `.md`
// fixture is opened in IR and the model is given until its idle proof ends (or 20 s). One JSON line
// per file (state, off reason, unit counts, `timeout`), written to the path in VMDE_COVERAGE_OUT
// when it is set. The lines hold file names, state names and counts only, never document text.
// The spec asserts only that every file produced a line and none threw: the numbers are evidence
// for the pairing coverage record (Q-3), not a gate.

const FIXTURES = path.join(__dirname, 'fixtures')
const PER_FILE_TIMEOUT_MS = 20_000
const EDITOR_MOUNT_TIMEOUT_MS = 30_000

interface CoverageLine {
  file: string
  state: string
  offReason: string | null
  units: number
  proven: number
  opaque: number
  timeout: boolean
  error?: string
}

function markdownFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...markdownFiles(full))
    else if (entry.endsWith('.md')) out.push(full)
  }
  return out
}

const files = markdownFiles(FIXTURES)

test.afterEach(async ({ evaluateInVSCode }) => {
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.defaultMode',
      undefined,
      vscode.ConfigurationTarget.Global,
    )
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  }, [] as string[])
})

type Page = import('@playwright/test').Page
type Frame =
  ReturnType<typeof reopenVmdeFixture> extends Promise<infer F> ? F : never

interface RawStats {
  state: string
  offReason?: string
  units: number
  proven: number
  opaque: number
}

const readStats = (frame: Frame): Promise<RawStats | null> =>
  frame
    .locator('body')
    .evaluate(
      () =>
        (window as unknown as { __vmdeModelShadowStats?: RawStats })
          .__vmdeModelShadowStats ?? null,
    )

/** Declined for a reason other than "not built yet", or fully proven. */
const settled = (s: RawStats | null): boolean =>
  s !== null &&
  ((s.state === 'off' && s.offReason !== 'not-mounted') ||
    (s.state === 'live' && s.proven + s.opaque === s.units))

/**
 * Open one fixture and return its frame. A file whose IR editor never mounts (conflict markers open
 * the conflict view) is a result, not a failure: the line says `not-mounted`. Any other error is
 * recorded as an error.
 */
async function mountFrame(
  workbox: Page,
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  file: string,
  line: CoverageLine,
): Promise<Frame | CoverageLine> {
  try {
    return await reopenVmdeFixture(
      evaluateInVSCode,
      workbox,
      file,
      EDITOR_MOUNT_TIMEOUT_MS,
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : ''
    if (/Timeout .* exceeded/u.test(reason))
      return { ...line, state: 'not-mounted', offReason: 'editor-not-mounted' }
    return { ...line, error: reason.split('\n')[0] || 'error' }
  }
}

/** Open one fixture in IR and wait for the model to settle, or for the per-file timeout. */
async function measure(
  workbox: Page,
  evaluateInVSCode: Parameters<typeof reopenVmdeFixture>[0],
  file: string,
): Promise<CoverageLine> {
  const line: CoverageLine = {
    file: path.relative(FIXTURES, file).split(path.sep).join('/'),
    state: 'unknown',
    offReason: null,
    units: 0,
    proven: 0,
    opaque: 0,
    timeout: false,
  }
  const opened = await mountFrame(workbox, evaluateInVSCode, file, line)
  if ('file' in opened) return opened
  const frame = opened
  try {
    const deadline = Date.now() + PER_FILE_TIMEOUT_MS
    for (;;) {
      const s = await readStats(frame)
      if (s) Object.assign(line, { ...s, offReason: s.offReason ?? null })
      if (settled(s)) return line
      if (Date.now() > deadline) return { ...line, timeout: true }
      await workbox.waitForTimeout(250)
    }
  } catch (error) {
    return {
      ...line,
      error: error instanceof Error ? error.message.split('\n')[0] : 'error',
    }
  }
}

test(`the model pairs or declines every fixture (${files.length} files)`, async ({
  workbox,
  evaluateInVSCode,
}) => {
  test.setTimeout(6_000_000)
  const out = process.env.VMDE_COVERAGE_OUT
  if (out) rmSync(out, { force: true })
  await evaluateInVSCode(async (vscode: typeof import('vscode')) => {
    const config = vscode.workspace.getConfiguration('vmde')
    await config.update(
      'editor.defaultMode',
      'ir',
      vscode.ConfigurationTarget.Global,
    )
  }, [] as string[])

  const lines: CoverageLine[] = []
  for (const file of files) {
    const line = await measure(workbox, evaluateInVSCode, file)
    lines.push(line)
    const text = JSON.stringify(line)
    console.log(`MODEL-COVERAGE ${text}`)
    if (out) appendFileSync(out, `${text}\n`)
  }

  expect(lines, 'one line per fixture').toHaveLength(files.length)
  expect(
    lines.filter((line) => line.error !== undefined).map((line) => line.file),
    'no fixture threw',
  ).toEqual([])
})
