#!/usr/bin/env node
// Task 481/482 — patches the vendored `vscode-test-playwright@0.0.1-beta2` (in
// test/vscode-e2e/node_modules) so it works with playwright>=1.55.1, the minimum version that
// fixes GHSA-7mvr-c777-76hp (SSL-verification bypass when downloading browsers). Run automatically
// as test/vscode-e2e's `postinstall`, right after `npm install`/`npm ci` — same "patch a vendored
// dependency at a fixed point, anchor-asserted, throw loud on drift" philosophy as build.mjs's
// Vditor patches (ADR-0004), applied here to a plain node_modules package instead of an esbuild
// bundle, since this package is required directly by Node/Playwright, never bundled.
//
// The break: `vscode-test-playwright`'s `_evaluator` fixture calls the PRIVATE, unversioned
// `playwright._toImpl(handle)` to reach `electronAppImpl._process` / `_nodeConnection.
// _browserLogsCollector` and scrape the injected VSCodeTestServer's address off stderr.
// `_toImpl` was removed from `@playwright/test` somewhere between 1.52.0 and 1.55.1 (confirmed
// empirically 2026-08-07 — every fixed version we tried breaks identically). The maintainer's repo
// (github.com/ruifigueira/vscode-test-playwright) has been dormant since 2025-05-31 and never
// addressed this. A fork (github.com/greglamb/vscode-test-playwright, commit 1bb433fb) fixed it by
// having the injected side write its address to a file instead of relying on playwright internals
// — this patch is our own port of that same fix (not a dependency on that fork: no npm publish, no
// releases/tags, single contributor — see tasks/481/482 for the full reasoning), applied directly
// to the currently-installed dist/ output.
//
// Two files, two edits:
//   1. dist/injected/index.js (runs INSIDE the launched VS Code extension host) — after starting
//      the VSCodeTestServer, also write its address to the file named by the
//      PW_VSCODE_TEST_SERVER_FILE env var (write + atomic rename, so a reader never sees a partial
//      write), alongside the existing stderr line (kept, harmless).
//   2. dist/index.js (the playwright-side fixtures) —
//        a. electronApp fixture: set that env var before launching Electron.
//        b. _evaluator fixture: poll the file instead of playwright._toImpl(electronApp)/
//           _nodeConnection scraping. The recorder/trace path (_toImpl(workbox) for `pageImpl`)
//           is kept but guarded: used when available, degrades to no trace-of-vscode-evaluation
//           (UI tracing itself is unaffected) when playwright._toImpl doesn't exist or throws.
//
// Idempotent: `npm install` (not just `npm ci`) re-runs postinstall on an already-patched dist/, so
// this checks for its own marker first and no-ops rather than re-patching or false-failing on the
// (now absent) pre-patch anchor.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..')
const DEFAULT_PKG_DIR = path.join(
  ROOT,
  'test',
  'vscode-e2e',
  'node_modules',
  'vscode-test-playwright',
)
// Tests point this at a disposable package tree. Normal postinstall always uses the pinned fixture.
const PKG_DIR = process.env.VMDE_VSCODE_TEST_PLAYWRIGHT_DIR ?? DEFAULT_PKG_DIR
const MARKER = 'vmde patch (task 481/482)'
// The first checked-in patch emitted `vmde`; an installed fixture in the field uses the earlier
// `vmarkd` spelling. Treat either as task-481/482 so postinstall can add the separate XTEST patch.
const LEGACY_MARKERS = [MARKER, 'vmarkd patch (task 481/482)']
const XTEST_MARKER = 'vmde XTEST launch patch (task 553)'

function patchFile(file, edits, marker = LEGACY_MARKERS) {
  if (!existsSync(file)) {
    throw new Error(
      `[patch-vscode-test-playwright] ${file} not found — is vscode-test-playwright installed? Run npm --prefix test/vscode-e2e install first.`,
    )
  }
  let code = readFileSync(file, 'utf8')
  const markers = Array.isArray(marker) ? marker : [marker]
  if (markers.some((candidate) => code.includes(candidate))) {
    console.log(`[patch-vscode-test-playwright] ${path.basename(file)} already patched, skipping`)
    return
  }
  for (const { anchor, replacement, label } of edits) {
    if (!code.includes(anchor)) {
      throw new Error(
        `[patch-vscode-test-playwright] ${label} anchor not found in ${file} — vscode-test-playwright changed (still on 0.0.1-beta2?); re-verify this patch against its current dist output.`,
      )
    }
    code = code.replace(anchor, replacement)
  }
  writeFileSync(file, code)
  console.log(`[patch-vscode-test-playwright] patched ${path.basename(file)}`)
}

// 1. Injected side — write the server's address to PW_VSCODE_TEST_SERVER_FILE, not just stderr.
patchFile(path.join(PKG_DIR, 'dist', 'injected', 'index.js'), [
  {
    label: 'VSCodeTestServer stderr line',
    anchor:
      'process.stderr.write(`VSCodeTestServer listening on http://localhost:${address.port}\\n`);',
    replacement: `// ${MARKER}: also hand the address to the test runner via a file, since
        // playwright._toImpl (used by the old stderr-scraping discovery) is gone in
        // playwright>=1.55.1 — see scripts/patch-vscode-test-playwright.mjs.
        const __vmdeServerUrl = \`http://localhost:\${address.port}\`;
        process.stderr.write(\`VSCodeTestServer listening on \${__vmdeServerUrl}\\n\`);
        const __vmdeInfoFile = process.env.PW_VSCODE_TEST_SERVER_FILE;
        if (__vmdeInfoFile) {
            require('fs').writeFileSync(\`\${__vmdeInfoFile}.tmp\`, __vmdeServerUrl);
            require('fs').renameSync(\`\${__vmdeInfoFile}.tmp\`, __vmdeInfoFile);
        }`,
  },
])

// 2. Playwright side — set the env var, then discover the server via the file instead of _toImpl.
patchFile(path.join(PKG_DIR, 'dist', 'index.js'), [
  {
    label: 'electronApp env cleanup (PW_VSCODE_TEST_SERVER_FILE insertion point)',
    anchor: `            const env = { ...process.env };
            for (const prop in env) {
                if (/^VSCODE_/i.test(prop))
                    delete env[prop];
            }`,
    replacement: `            const env = { ...process.env };
            for (const prop in env) {
                if (/^VSCODE_/i.test(prop))
                    delete env[prop];
            }
            // ${MARKER}: tell the injected VSCodeTestServer where to write its address — see
            // scripts/patch-vscode-test-playwright.mjs.
            env.PW_VSCODE_TEST_SERVER_FILE = path.join(cachePath, \`vscode-test-server-\${testInfo.testId}.txt\`);`,
  },
  {
    label: '_evaluator fixture body',
    anchor: `    _evaluator: async ({ playwright, electronApp, workbox, vscodeTrace }, use, testInfo) => {
        const electronAppImpl = await playwright._toImpl(electronApp);
        const pageImpl = await playwright._toImpl(workbox);
        // check recent logs or wait for URL to access VSCode test server
        const vscodeTestServerRegExp = /^VSCodeTestServer listening on (http:\\/\\/.*)$/;
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
    },`,
    replacement: `    _evaluator: async ({ playwright, electronApp, workbox, vscodeTrace, _vscodeInstall }, use, testInfo) => {
        // ${MARKER}: playwright._toImpl was removed in playwright>=1.55.1 (the fix for
        // GHSA-7mvr-c777-76hp), which broke the original stderr/internals-scraping discovery of
        // the injected VSCodeTestServer. The injected side (dist/injected/index.js, also patched)
        // now writes its address to a file instead; poll for it here. Recorder/trace pageImpl
        // still uses _toImpl when available and degrades gracefully (UI tracing only) otherwise —
        // see scripts/patch-vscode-test-playwright.mjs for the full patch and reasoning.
        void electronApp;
        const infoFile = path.join(_vscodeInstall.cachePath, \`vscode-test-server-\${testInfo.testId}.txt\`);
        const deadline = Date.now() + 30000;
        let serverUrl;
        while (Date.now() < deadline) {
            try {
                const content = fs.readFileSync(infoFile, 'utf8').trim();
                if (content) {
                    serverUrl = content;
                    break;
                }
            }
            catch { }
            await new Promise(r => setTimeout(r, 100));
        }
        if (!serverUrl) {
            throw new Error(\`Timed out waiting for VSCodeTestServer address in \${infoFile}\`);
        }
        const ws = new ws_1.WebSocket(serverUrl);
        await new Promise((resolve, reject) => {
            ws.once('open', resolve);
            ws.once('error', reject);
        });
        const traceMode = getTraceMode(vscodeTrace);
        const captureTrace = shouldCaptureTrace(traceMode, testInfo);
        let pageImpl;
        if (captureTrace && typeof playwright._toImpl === 'function') {
            try {
                pageImpl = await playwright._toImpl(workbox);
            }
            catch { }
        }
        const evaluator = new vscodeHandle_1.VSCodeEvaluator(ws, pageImpl);
        await use(evaluator);
        ws.close();
    },`,
  },
])

// 3. Optional X11/XTEST route — this is deliberately a separate idempotent patch. Existing
// installs already bear MARKER from task 481/482, so folding this edit into the legacy list would
// make postinstall skip it forever. Electron removed the environment hint; launch must receive the
// literal Chromium flag when the focused OS-input suite opts in with VMDE_XTEST=1.
patchFile(
  path.join(PKG_DIR, 'dist', 'index.js'),
  [
    {
      label: 'XTEST Electron launch arguments',
      anchor: `                    '--disable-updates',
                    '--skip-welcome',`,
      replacement: `                    '--disable-updates',
                    // ${XTEST_MARKER}: use the X11 backend for server-level XTEST input.
                    ...(process.env.VMDE_XTEST === '1' ? ['--ozone-platform=x11'] : []),
                    '--skip-welcome',`,
    },
  ],
  XTEST_MARKER,
)
