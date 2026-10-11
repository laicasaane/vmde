#!/usr/bin/env node
/*
 * fetch-markmap — rebuild the Markmap 0.18.12 browser library with advisory-clean linkification.
 *
 * Usage:
 *   node media-src/scripts/fetch-markmap.mjs 0.18.12 --write
 *
 * The immutable upstream source archive and its pnpm workspace exist only under the OS temporary
 * directory. The temporary root receives overrides for markdown-it 14.3.1 and linkify-it 5.0.2;
 * this repository keeps npm as its only package manager and receives only the final combined bundle,
 * licenses, and provenance metadata.
 */
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const execFile = promisify(execFileCallback)
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const MEDIA_SRC_DIR = path.resolve(SCRIPT_DIR, '..')
const VENDOR_DIR = path.join(MEDIA_SRC_DIR, 'vendor/markmap')
const VERSION = '0.18.12'
const SOURCE_COMMIT = '205367a24603dc187f67da1658940c6cade20dce'
const MARKDOWN_IT_VERSION = '14.3.1'
const LINKIFY_IT_VERSION = '5.0.2'
const JOIN = '\n;\n'

const sha256 = (buffer) =>
  createHash('sha256').update(buffer).digest('hex')

const D3_ENTRY = `export {
  linkHorizontal,
  max,
  min,
  minIndex,
  scaleOrdinal,
  schemeCategory10,
  select,
  zoom,
  zoomIdentity,
  zoomTransform,
} from 'd3'
`

async function getBuffer(url) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'vmde-fetch-markmap' },
  })
  if (!response.ok) {
    throw new Error(`GET ${url} -> ${response.status} ${response.statusText}`)
  }
  return Buffer.from(await response.arrayBuffer())
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: '1', HUSKY: '0' },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}`))
    })
  })
}

function collectVersions(value, packageName, found = new Set()) {
  if (!value || typeof value !== 'object') return found
  if (value.name === packageName && typeof value.version === 'string') {
    found.add(value.version)
  }
  for (const [key, child] of Object.entries(value)) {
    if (
      key === packageName &&
      child &&
      typeof child === 'object' &&
      typeof child.version === 'string'
    ) {
      found.add(child.version)
    }
    collectVersions(child, packageName, found)
  }
  return found
}

function assertResolved(list, packageName, expected) {
  const versions = [...collectVersions(list, packageName)].sort()
  if (versions.length !== 1 || versions[0] !== expected) {
    throw new Error(
      `temporary Markmap workspace resolved ${packageName} to ${versions.join(', ') || 'nothing'}, expected ${expected}`,
    )
  }
}

async function buildD3Subset() {
  const result = await esbuild.build({
    stdin: { contents: D3_ENTRY, resolveDir: MEDIA_SRC_DIR, loader: 'js' },
    bundle: true,
    minify: true,
    format: 'iife',
    globalName: 'd3',
    platform: 'browser',
    write: false,
  })
  return Buffer.from(result.outputFiles[0].contents)
}

async function main() {
  const args = process.argv.slice(2)
  const version = args.find((arg) => !arg.startsWith('--'))
  const write = args.includes('--write')
  if (version !== VERSION) {
    throw new Error(
      `Usage: node media-src/scripts/fetch-markmap.mjs ${VERSION} [--write]`,
    )
  }

  const d3Package = JSON.parse(
    await fs.readFile(
      path.join(MEDIA_SRC_DIR, 'node_modules/d3/package.json'),
      'utf8',
    ),
  )
  const archiveUrl = `https://github.com/markmap/markmap/archive/${SOURCE_COMMIT}.tar.gz`
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vmde-markmap-'))
  try {
    const archive = await getBuffer(archiveUrl)
    const archivePath = path.join(tempDir, 'source.tar.gz')
    await fs.writeFile(archivePath, archive)
    await execFile('tar', ['-xzf', archivePath, '-C', tempDir])
    const workspace = path.join(tempDir, `markmap-${SOURCE_COMMIT}`)
    const workspaceConfigPath = path.join(workspace, 'pnpm-workspace.yaml')
    const workspaceConfig = await fs.readFile(workspaceConfigPath, 'utf8')
    if (/^overrides:/m.test(workspaceConfig) || /^allowBuilds:/m.test(workspaceConfig)) {
      throw new Error('upstream pnpm workspace already defines overrides or build policy')
    }
    await fs.writeFile(
      workspaceConfigPath,
      `${workspaceConfig.trimEnd()}\n\n` +
        `overrides:\n` +
        `  markdown-it: ${MARKDOWN_IT_VERSION}\n` +
        `  linkify-it: ${LINKIFY_IT_VERSION}\n\n` +
        `allowBuilds:\n` +
        `  esbuild: true\n` +
        `  nx: true\n`,
    )

    const libPackage = JSON.parse(
      await fs.readFile(
        path.join(workspace, 'packages/markmap-lib/package.json'),
        'utf8',
      ),
    )
    const viewPackage = JSON.parse(
      await fs.readFile(
        path.join(workspace, 'packages/markmap-view/package.json'),
        'utf8',
      ),
    )
    if (libPackage.version !== VERSION || viewPackage.version !== VERSION) {
      throw new Error(
        `source archive versions are markmap-lib ${libPackage.version} and markmap-view ${viewPackage.version}, expected ${VERSION}`,
      )
    }

    await run(
      'corepack',
      ['pnpm', 'install', '--frozen-lockfile=false'],
      workspace,
    )
    for (const prerequisite of [
      'markmap-common',
      'markmap-html-parser',
      'markmap-view',
    ]) {
      await run(
        'corepack',
        ['pnpm', '--filter', prerequisite, 'build:js'],
        workspace,
      )
    }
    await run(
      'corepack',
      ['pnpm', '--filter', 'markmap-lib', 'build:js'],
      workspace,
    )
    const { stdout: listJson } = await execFile(
      'corepack',
      [
        'pnpm',
        '--filter',
        'markmap-lib',
        'list',
        'markdown-it',
        'linkify-it',
        '--depth',
        '4',
        '--json',
      ],
      { cwd: workspace, maxBuffer: 10 * 1024 * 1024 },
    )
    const resolved = JSON.parse(listJson)
    assertResolved(resolved, 'markdown-it', MARKDOWN_IT_VERSION)
    assertResolved(resolved, 'linkify-it', LINKIFY_IT_VERSION)
    const { stdout: pnpmVersionOutput } = await execFile(
      'corepack',
      ['pnpm', '--version'],
      { cwd: workspace },
    )
    const pnpmVersion = pnpmVersionOutput.trim()

    const libJs = await fs.readFile(
      path.join(workspace, 'packages/markmap-lib/dist/browser/index.iife.js'),
    )
    const viewUrl = `https://unpkg.com/markmap-view@${VERSION}/dist/browser/index.js`
    const viewJs = await getBuffer(viewUrl)
    const d3Js = await buildD3Subset()
    const combined = Buffer.concat([
      d3Js,
      Buffer.from(JOIN),
      Buffer.from(libJs.toString('utf8').trimEnd()),
      Buffer.from(JOIN),
      Buffer.from(viewJs.toString('utf8').trimEnd()),
      Buffer.from('\n'),
    ])
    const combinedText = combined.toString('utf8')
    if (
      !combinedText.includes('window.markmap') ||
      !combinedText.includes('Transformer') ||
      !combinedText.includes('Markmap')
    ) {
      throw new Error('combined Markmap bundle lacks the required browser globals')
    }
    if (
      combinedText.includes(
        `re.src_email_name = '[\\\\-;:&=\\\\+\\\\$,\\\\.a-zA-Z0-9_][\\\\-;:&=\\\\+\\\\$,\\\\"\\\\.a-zA-Z0-9_]*'`,
      )
    ) {
      throw new Error('rebuilt Markmap bundle still contains the affected email expression')
    }

    const markmapLicense = (
      await fs.readFile(path.join(workspace, 'LICENSE'), 'utf8')
    ).trim()
    const d3License = (
      await fs.readFile(path.join(MEDIA_SRC_DIR, 'node_modules/d3/LICENSE'), 'utf8')
    ).trim()
    const license =
      `markmap-lib, markmap-view — MIT License\n` +
      `Source commit: ${SOURCE_COMMIT}\n\n` +
      `${markmapLicense}\n\n---\n\n` +
      `d3 ${d3Package.version} subset — ISC License\n\n${d3License}\n`
    const source = {
      version,
      description: `Combined offline bundle: d3 ${d3Package.version} subset + rebuilt markmap-lib ${VERSION} + release-matched markmap-view ${VERSION}.`,
      origin: {
        d3: 'https://github.com/d3/d3',
        'markmap-lib': archiveUrl,
        'markmap-view': viewUrl,
      },
      components: [
        { ecosystem: 'npm', name: 'markmap-lib', version: VERSION },
        { ecosystem: 'npm', name: 'markmap-view', version: VERSION },
        {
          ecosystem: 'npm',
          name: 'markdown-it',
          version: MARKDOWN_IT_VERSION,
        },
        {
          ecosystem: 'npm',
          name: 'linkify-it',
          version: LINKIFY_IT_VERSION,
        },
        {
          ecosystem: 'npm',
          name: 'd3',
          version: d3Package.version,
        },
      ],
      build: {
        sourceCommit: SOURCE_COMMIT,
        archiveSha256: sha256(archive),
        pnpmVersion,
        overrides: {
          'markdown-it': MARKDOWN_IT_VERSION,
          'linkify-it': LINKIFY_IT_VERSION,
        },
        commands: [
          'corepack pnpm install --frozen-lockfile=false',
          'corepack pnpm --filter markmap-common build:js',
          'corepack pnpm --filter markmap-html-parser build:js',
          'corepack pnpm --filter markmap-view build:js',
          'corepack pnpm --filter markmap-lib build:js',
          'corepack pnpm --filter markmap-lib list markdown-it linkify-it --depth 4 --json',
        ],
      },
      files: {
        'markmap.min.js': { sha256: sha256(combined) },
      },
    }

    if (!write) {
      console.log(
        `[fetch-markmap] verified rebuild ${source.files['markmap.min.js'].sha256.slice(0, 12)}…; pass --write to vendor it`,
      )
      return
    }
    await fs.mkdir(VENDOR_DIR, { recursive: true })
    await fs.writeFile(path.join(VENDOR_DIR, 'markmap.min.js'), combined)
    await fs.writeFile(path.join(VENDOR_DIR, 'LICENSE'), license)
    await fs.writeFile(
      path.join(VENDOR_DIR, 'source.json'),
      `${JSON.stringify(source, null, 2)}\n`,
    )
    console.log(
      `[fetch-markmap] pinned v${VERSION} with linkify-it ${LINKIFY_IT_VERSION} (sha256 ${source.files['markmap.min.js'].sha256.slice(0, 12)}…)`,
    )
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
