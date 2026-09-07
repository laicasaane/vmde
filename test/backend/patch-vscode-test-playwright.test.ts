import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '../..')
const PATCH = path.join(ROOT, 'scripts', 'patch-vscode-test-playwright.mjs')
const legacyMarkers = [
  'vmde patch (task 481/482)',
  'vmarkd patch (task 481/482)',
]
const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function fixture(): string {
  const pkgDir = path.join(
    mkdtempSync(path.join(tmpdir(), 'vmde-vscode-test-playwright-')),
    'node_modules',
    'vscode-test-playwright',
  )
  temps.push(path.dirname(path.dirname(pkgDir)))
  mkdirSync(path.join(pkgDir, 'dist', 'injected'), { recursive: true })
  return pkgDir
}

function writeFixture(pkgDir: string, main: string, injected: string) {
  writeFileSync(path.join(pkgDir, 'dist', 'index.js'), main)
  writeFileSync(path.join(pkgDir, 'dist', 'injected', 'index.js'), injected)
}

function runPatch(pkgDir: string) {
  return spawnSync(process.execPath, [PATCH], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, VMDE_VSCODE_TEST_PLAYWRIGHT_DIR: pkgDir },
  })
}

const legacyPatchedMain = (legacyMarker: string) => `
const env = { ...process.env };
for (const prop in env) {
    if (/^VSCODE_/i.test(prop))
        delete env[prop];
}
// ${legacyMarker}: server address transport
const electronApp = await test_1._electron.launch({
    executablePath: installPath,
    env,
    args: [
        '--no-sandbox',
        '--disable-gpu-sandbox',
                    '--disable-updates',
                    '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
        \`--extensions-dir=\${extensionsDir ?? path.join(cachePath, 'extensions')}\`,
        \`--user-data-dir=\${userDataDir ?? path.join(cachePath, 'user-data')}\`,
        \`--extensionTestsPath=\${path.join(__dirname, 'injected', 'index')}\`,
        ...(extensionDevelopmentPath ? [\`--extensionDevelopmentPath=\${extensionDevelopmentPath}\`] : []),
        baseDir,
    ],
});
`

const legacyPatchedInjected = (legacyMarker: string) =>
  `// ${legacyMarker}: server address transport`

const cleanMain = String.raw`            const env = { ...process.env };
            for (const prop in env) {
                if (/^VSCODE_/i.test(prop))
                    delete env[prop];
            }
    _evaluator: async ({ playwright, electronApp, workbox, vscodeTrace }, use, testInfo) => {
        const electronAppImpl = await playwright._toImpl(electronApp);
        const pageImpl = await playwright._toImpl(workbox);
        // check recent logs or wait for URL to access VSCode test server
        const vscodeTestServerRegExp = /^VSCodeTestServer listening on (http:\/\/.*)$/;
        const process = electronAppImpl._process;
        const recentLogs = electronAppImpl._nodeConnection._browserLogsCollector.recentLogs();
        let [match] = recentLogs.map(s => s.match(vscodeTestServerRegExp)).filter(Boolean);
        if (!match) {
            match = await waitForLine(process, vscodeTestServerRegExp);
        }
        const ws = new ws_1.WebSocket(match[1]);
        await new Promise(r => ws.once('open', r));
        const traceMode = getTraceMode(vscodeTrace);
        const captureTrace = shouldCaptureTrace(traceMode, testInfo);
        const evaluator = new vscodeHandle_1.VSCodeEvaluator(ws, captureTrace ? pageImpl : undefined);
        await use(evaluator);
        ws.close();
    },
                    '--disable-updates',
                    '--skip-welcome',`

const cleanInjected =
  'process.stderr.write(`VSCodeTestServer listening on http://localhost:${address.port}\\n`);'

describe('patch-vscode-test-playwright X11 launch option', () => {
  it('adds the literal optional X11 flag to a clean launch-array fixture', () => {
    const pkgDir = fixture()
    writeFixture(pkgDir, cleanMain, cleanInjected)

    const result = runPatch(pkgDir)

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
    const patched = readFileSync(path.join(pkgDir, 'dist', 'index.js'), 'utf8')
    expect(patched).toContain(
      "...(process.env.VMDE_XTEST === '1' ? ['--ozone-platform=x11'] : []),",
    )
  })

  it.each(legacyMarkers)(
    'updates a %s task-481-patched fixture only once',
    (legacyMarker) => {
      const pkgDir = fixture()
      writeFixture(
        pkgDir,
        legacyPatchedMain(legacyMarker),
        legacyPatchedInjected(legacyMarker),
      )

      expect(runPatch(pkgDir).status).toBe(0)
      const once = readFileSync(path.join(pkgDir, 'dist', 'index.js'), 'utf8')
      const result = runPatch(pkgDir)

      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0)
      expect(readFileSync(path.join(pkgDir, 'dist', 'index.js'), 'utf8')).toBe(
        once,
      )
    },
  )

  it('rejects a task-481-patched fixture whose launch-array anchor drifted', () => {
    const pkgDir = fixture()
    writeFixture(
      pkgDir,
      legacyPatchedMain(legacyMarkers[0]).replace(
        "'--disable-updates',",
        "'--updates-disabled',",
      ),
      legacyPatchedInjected(legacyMarkers[0]),
    )

    const result = runPatch(pkgDir)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'XTEST Electron launch arguments anchor not found',
    )
  })
})
