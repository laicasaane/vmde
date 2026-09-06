import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const HELPER = join(ROOT, 'scripts/package-local-preview.mjs')
const REAL_GIT = ['/usr/bin/git', '/bin/git'].find(existsSync) ?? 'git'
const require = createRequire(import.meta.url)
const yauzl = require('yauzl') as typeof import('yauzl')

const cleanups: Array<() => void> = []

afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.()
})

function runGit(
  repo: string,
  args: string[],
  encoding: BufferEncoding = 'utf8',
) {
  return execFileSync(REAL_GIT, args, {
    cwd: repo,
    encoding,
    env: {
      ...process.env,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'VMDE test',
      GIT_CONFIG_KEY_1: 'user.email',
      GIT_CONFIG_VALUE_1: 'vmde-test@example.invalid',
    },
  })
}

function splitNul(buffer: Buffer) {
  const values: string[] = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    values.push(buffer.subarray(start, index).toString('utf8'))
    start = index + 1
  }
  if (start < buffer.length)
    values.push(buffer.subarray(start).toString('utf8'))
  return values.filter(Boolean)
}

function gitBuffer(repo: string, args: string[]) {
  return runGit(repo, args, 'buffer') as Buffer
}

function snapshotPrimary(repo: string) {
  const untracked = splitNul(
    gitBuffer(repo, ['ls-files', '--others', '--exclude-standard', '-z']),
  ).map((path) => {
    const absolute = join(repo, path)
    const stat = lstatSync(absolute)
    return {
      path,
      mode: stat.mode,
      bytes: stat.isSymbolicLink()
        ? Buffer.from(readlinkSync(absolute))
        : readFileSync(absolute),
    }
  })

  return {
    head: gitBuffer(repo, ['rev-parse', '--verify', 'HEAD^{commit}']),
    branch: gitBuffer(repo, ['symbolic-ref', '--quiet', 'HEAD']),
    status: gitBuffer(repo, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
      '--ignored=no',
    ]),
    staged: gitBuffer(repo, [
      'diff',
      '--cached',
      '--binary',
      '--full-index',
      '--no-ext-diff',
    ]),
    unstaged: gitBuffer(repo, [
      'diff',
      '--binary',
      '--full-index',
      '--no-ext-diff',
    ]),
    refs: gitBuffer(repo, [
      'for-each-ref',
      '--format=%(refname)%00%(objectname)%00%(symref)',
    ]),
    untracked,
  }
}

const PACKAGE_STUB = String.raw`#!/usr/bin/env node
import { appendFileSync, createWriteStream, existsSync, lstatSync, readFileSync, rmSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'

const require = createRequire(import.meta.url)
const { ZipFile } = require('yazl')
const args = process.argv.slice(2)
if (args.length !== 3 || args[0] !== '--pre-release' || args[1] !== '--out') {
  throw new Error('expected one guarded prerelease package command with an explicit output')
}
if (!resolve(args[2]).startsWith(resolve(process.cwd(), '..'))) {
  throw new Error('expected output below the helper-owned temporary root')
}
if (process.env.VMDE_PREVIEW_TEST_COUNT) {
  appendFileSync(process.env.VMDE_PREVIEW_TEST_COUNT, 'package\n')
}

const mode = readFileSync('package-mode.txt', 'utf8').trim()
if (mode === 'fail') process.exit(23)

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
const bytes = (path) => existsSync(path) ? readFileSync(path).toString('base64') : null
const evidence = {
  source: bytes('source.txt'),
  overlap: bytes('overlap.txt'),
  binary: bytes('binary.bin'),
  safe: bytes('safe-untracked.bin'),
  protected: existsSync('LOCAL_AGENT_TASK.md'),
  artifactInput: existsSync('artifacts/input-only.txt'),
  ignored: existsSync('ignored-secret.txt'),
  dependencyInput: existsSync('nested/node_modules/secret.txt'),
  scratchInput: existsSync('.vmde-local-preview-scratch/secret.txt'),
  unsafeInput: existsSync('..\\escape.txt'),
  rootDependenciesLinked: lstatSync('node_modules').isSymbolicLink(),
  mediaDependenciesLinked: lstatSync('media-src/node_modules').isSymbolicLink(),
  packageVersion: pkg.version,
  lockVersion: lock.version,
  lockRootVersion: lock.packages[''].version,
}

const archiveVersion = mode === 'bad-version' ? '9.9.9' : pkg.version
const packagePublisher =
  mode === 'bad-package-publisher' ? 'laicasaane' : pkg.publisher
const identityPublisher =
  mode === 'bad-identity-publisher' ? 'laicasaane' : pkg.publisher
const identityId = mode === 'bad-identity-id' ? 'not-vmde' : pkg.name
const prereleaseValue = mode === 'bad-prerelease' ? 'false' : 'true'
const archivePackage = { ...pkg, publisher: packagePublisher }
const manifest = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<PackageManifest>',
  '  <Metadata>',
  '    <Identity Language="en-US" Publisher="' + identityPublisher + '" Id="' + identityId + '" Version="' + archiveVersion + '"/>',
  '    <Properties>',
  '      <Property Value="' + prereleaseValue + '" Id="Microsoft.VisualStudio.Code.PreRelease"/>',
  '    </Properties>',
  '  </Metadata>',
  '</PackageManifest>',
].join('\n')

const zip = new ZipFile()
zip.addBuffer(Buffer.from(JSON.stringify(archivePackage)), 'extension/package.json')
zip.addBuffer(Buffer.from(manifest), 'extension.vsixmanifest')
zip.addBuffer(Buffer.from(JSON.stringify(evidence)), 'extension/evidence.json')
await new Promise((resolvePromise, reject) => {
  zip.outputStream
    .pipe(createWriteStream(args[2]))
    .once('close', resolvePromise)
    .once('error', reject)
  zip.end()
})
if (process.env.VMDE_PREVIEW_TEST_SWAP_ARTIFACTS && process.env.VMDE_PREVIEW_TEST_SWAP_TARGET) {
  rmSync(process.env.VMDE_PREVIEW_TEST_SWAP_ARTIFACTS, { recursive: true, force: true })
  symlinkSync(
    process.env.VMDE_PREVIEW_TEST_SWAP_TARGET,
    process.env.VMDE_PREVIEW_TEST_SWAP_ARTIFACTS,
    'dir',
  )
}
`

interface Fixture {
  sandbox: string
  repo: string
  countFile: string
}

function createFixture(mode = 'ok'): Fixture {
  const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-fixture-'))
  const repo = join(sandbox, 'repo')
  const countFile = join(sandbox, 'package-count.txt')
  mkdirSync(join(repo, 'scripts'), { recursive: true })
  mkdirSync(join(repo, 'media-src'), { recursive: true })
  runGit(sandbox, ['init', '--initial-branch=dev', repo])

  writeFileSync(
    join(repo, 'package.json'),
    `${JSON.stringify(
      {
        name: 'vmde',
        publisher: 'Laicasaane',
        version: '1.4.0',
        devDependencies: {
          '@vscode/vsce': '^3.9.2',
          esbuild: '^0.28.2',
          typescript: '^7.0.2',
          yauzl: '^3.4.0',
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(repo, 'package-lock.json'),
    `${JSON.stringify(
      {
        name: 'vmde',
        version: '1.4.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'vmde',
            version: '1.4.0',
            devDependencies: {
              '@vscode/vsce': '^3.9.2',
              esbuild: '^0.28.2',
              typescript: '^7.0.2',
              yauzl: '^3.4.0',
            },
          },
          'node_modules/@vscode/vsce': { version: '3.9.2' },
          'node_modules/esbuild': { version: '0.28.2' },
          'node_modules/typescript': { version: '7.0.2' },
          'node_modules/yauzl': { version: '3.4.0' },
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(repo, '.gitignore'),
    [
      'artifacts/',
      'node_modules/',
      '**/node_modules/',
      'ignored-secret.txt',
    ].join('\n'),
  )
  writeFileSync(join(repo, 'scripts/package-vsix.mjs'), PACKAGE_STUB)
  writeFileSync(
    join(repo, 'media-src/package.json'),
    `${JSON.stringify(
      {
        name: 'media-src',
        version: '0.0.0',
        dependencies: { vditor: '^3.11.3' },
        devDependencies: { esbuild: '^0.28.2' },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(repo, 'media-src/package-lock.json'),
    `${JSON.stringify(
      {
        name: 'media-src',
        version: '0.0.0',
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: 'media-src',
            version: '0.0.0',
            dependencies: { vditor: '^3.11.3' },
            devDependencies: { esbuild: '^0.28.2' },
          },
          'node_modules/esbuild': { version: '0.28.2' },
          'node_modules/vditor': { version: '3.11.3' },
        },
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(join(repo, 'package-mode.txt'), `${mode}\n`)
  writeFileSync(join(repo, 'source.txt'), 'committed source\n')
  writeFileSync(join(repo, 'overlap.txt'), 'base overlap\n')
  writeFileSync(join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 3]))
  runGit(repo, ['add', '.'])
  runGit(repo, ['commit', '-m', 'fixture baseline'])
  runGit(repo, ['tag', 'fixture-tag'])

  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'), 'dir')
  symlinkSync(
    join(ROOT, 'media-src/node_modules'),
    join(repo, 'media-src/node_modules'),
    'dir',
  )

  cleanups.push(() => rmSync(sandbox, { recursive: true, force: true }))
  return { sandbox, repo, countFile }
}

function runHelper(
  fixture: Fixture,
  mode: 'Committed HEAD' | 'Include local edits',
  pathPrefix?: string,
  extraEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(process.execPath, [HELPER, mode], {
    cwd: fixture.repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: pathPrefix
        ? `${pathPrefix}${delimiter}${process.env.PATH}`
        : process.env.PATH,
      VMDE_PREVIEW_TEST_COUNT: fixture.countFile,
      ...extraEnvironment,
    },
  })
}

function packageCount(fixture: Fixture) {
  if (!existsSync(fixture.countFile)) return 0
  return readFileSync(fixture.countFile, 'utf8').trim().split('\n').length
}

function artifactFiles(repo: string) {
  const directory = join(repo, 'artifacts')
  if (!existsSync(directory)) return []
  return readdirSync(directory)
    .filter((file) => file.endsWith('.vsix'))
    .sort()
}

async function readZipEntries(file: string, requested: string[]) {
  return new Promise<Map<string, Buffer>>((resolvePromise, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) return reject(openError)
      const entries = new Map<string, Buffer>()
      zipFile.once('error', reject)
      zipFile.once('end', () => resolvePromise(entries))
      zipFile.on('entry', (entry) => {
        if (!requested.includes(entry.fileName)) {
          zipFile.readEntry()
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError)
          const chunks: Buffer[] = []
          stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          stream.once('error', reject)
          stream.once('end', () => {
            entries.set(entry.fileName, Buffer.concat(chunks))
            zipFile.readEntry()
          })
        })
      })
      zipFile.readEntry()
    })
  })
}

async function readEvidence(repo: string, artifact: string) {
  const entries = await readZipEntries(join(repo, 'artifacts', artifact), [
    'extension/evidence.json',
  ])
  return JSON.parse(
    entries.get('extension/evidence.json')?.toString('utf8') ?? '',
  )
}

function installGitWrapper(fixture: Fixture, body: string) {
  const bin = join(fixture.sandbox, 'bin')
  mkdirSync(bin)
  const wrapper = join(bin, 'git')
  writeFileSync(wrapper, `#!/bin/sh\n${body}\n`)
  chmodSync(wrapper, 0o755)
  return bin
}

describe('guarded local preview task', { timeout: 15_000 }, () => {
  it('offers exactly one defaulted two-choice preview task', () => {
    const source = readFileSync(join(ROOT, '.vscode/tasks.json'), 'utf8')
    const config = JSON.parse(source.slice(source.indexOf('{')))
    const tasks = config.tasks.filter(
      (task: { label?: string }) =>
        task.label === 'Preview: package local VSIX',
    )
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      type: 'process',
      command: 'node',
      args: [
        '${workspaceFolder}/scripts/package-local-preview.mjs',
        '${input:previewPackageInput}',
      ],
      options: { cwd: '${workspaceFolder}' },
      problemMatcher: [],
    })
    expect(config.inputs).toContainEqual({
      id: 'previewPackageInput',
      type: 'pickString',
      description: 'Snapshot to package as a local preview VSIX',
      options: ['Committed HEAD', 'Include local edits'],
      default: 'Committed HEAD',
    })

    const manifest = JSON.parse(
      readFileSync(join(ROOT, 'package.json'), 'utf8'),
    )
    const lockfile = JSON.parse(
      readFileSync(join(ROOT, 'package-lock.json'), 'utf8'),
    )
    expect(manifest.devDependencies.yauzl).toBe('^3.4.0')
    expect(lockfile.packages[''].devDependencies.yauzl).toBe('^3.4.0')
  })

  it.skipIf(process.platform === 'win32')(
    'does not enumerate or capture any untracked content in committed mode',
    () => {
      const fixture = createFixture()
      writeFileSync(
        join(fixture.repo, 'untracked.txt'),
        'must not be captured\n',
      )
      const wrapper = installGitWrapper(
        fixture,
        `if [ "$1" = "ls-files" ]; then
  echo "committed mode attempted untracked capture" >&2
  exit 91
fi
exec "${REAL_GIT}" "$@"`,
      )

      const result = runHelper(fixture, 'Committed HEAD', wrapper)

      expect(result.status, result.stderr).toBe(0)
      expect(result.stderr).not.toContain('attempted untracked capture')
      expect(packageCount(fixture)).toBe(1)
    },
  )

  it('filters hostile excluded paths before opening their bytes in local mode', () => {
    const fixture = createFixture()
    const excluded = [
      'LOCAL_AGENT_TASK.md',
      '.vmde-local-preview-scratch',
      '..\\escape.txt',
    ]
    for (const relativePath of excluded) {
      writeFileSync(join(fixture.repo, relativePath), 'must never be opened')
      chmodSync(join(fixture.repo, relativePath), 0)
    }
    writeFileSync(
      join(fixture.repo, 'safe-untracked.bin'),
      Buffer.from([1, 0, 2]),
    )

    const result = runHelper(fixture, 'Include local edits')

    for (const relativePath of excluded) {
      chmodSync(join(fixture.repo, relativePath), 0o600)
    }
    expect(result.status, result.stderr).toBe(0)
    expect(packageCount(fixture)).toBe(1)
  })

  it('packages only committed HEAD by default and counts the exact ignored preview line', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.repo, 'artifacts'))
    for (const file of [
      'vmde-1.5.1-preview.vsix',
      'vmde-1.5.7-preview.vsix',
      'vmde-1.5.bad-preview.vsix',
      'vmde-1.7.50-preview.vsix',
      'other-1.5.90-preview.vsix',
      'vmde-1.5.99.vsix',
    ]) {
      writeFileSync(join(fixture.repo, 'artifacts', file), file)
    }
    writeFileSync(
      join(fixture.repo, 'artifacts/vmde-1.5.100-preview.vsix'),
      'tracked artifact-like file',
    )
    runGit(fixture.repo, [
      'add',
      '--force',
      'artifacts/vmde-1.5.100-preview.vsix',
    ])
    runGit(fixture.repo, ['commit', '-m', 'track an artifact-like fixture'])
    writeFileSync(join(fixture.repo, 'source.txt'), 'local source\n')
    writeFileSync(
      join(fixture.repo, 'safe-untracked.bin'),
      Buffer.from([10, 0, 255]),
    )
    writeFileSync(join(fixture.repo, 'LOCAL_AGENT_TASK.md'), 'protected\n')

    const before = snapshotPrimary(fixture.repo)
    const shortHead = runGit(fixture.repo, [
      'rev-parse',
      '--short=7',
      'HEAD^{commit}',
    ]).trim()
    const result = runHelper(fixture, 'Committed HEAD')
    const artifact = `vmde-1.5.8-preview-${shortHead}.vsix`

    expect(result.status, result.stderr).toBe(0)
    expect(packageCount(fixture)).toBe(1)
    expect(artifactFiles(fixture.repo)).toContain(artifact)
    const evidence = await readEvidence(fixture.repo, artifact)
    expect(Buffer.from(evidence.source, 'base64').toString()).toBe(
      'committed source\n',
    )
    expect(evidence.safe).toBeNull()
    expect(evidence.protected).toBe(false)
    expect(evidence.rootDependenciesLinked).toBe(true)
    expect(evidence.mediaDependenciesLinked).toBe(true)
    expect(evidence.packageVersion).toBe('1.5.8')
    expect(evidence.lockVersion).toBe('1.5.8')
    expect(evidence.lockRootVersion).toBe('1.5.8')
    expect(snapshotPrimary(fixture.repo)).toEqual(before)
  })

  it('applies one captured local snapshot in staged-then-unstaged order with binary-safe exclusions', async () => {
    const fixture = createFixture()
    writeFileSync(join(fixture.repo, 'overlap.txt'), 'staged overlap\n')
    writeFileSync(join(fixture.repo, 'binary.bin'), Buffer.from([0, 255, 2, 3]))
    const localManifest = JSON.parse(
      readFileSync(join(fixture.repo, 'package.json'), 'utf8'),
    )
    localManifest.version = '2.6.4'
    writeFileSync(
      join(fixture.repo, 'package.json'),
      `${JSON.stringify(localManifest, null, 2)}\n`,
    )
    const localLock = JSON.parse(
      readFileSync(join(fixture.repo, 'package-lock.json'), 'utf8'),
    )
    localLock.version = '2.6.4'
    localLock.packages[''].version = '2.6.4'
    writeFileSync(
      join(fixture.repo, 'package-lock.json'),
      `${JSON.stringify(localLock, null, 2)}\n`,
    )
    runGit(fixture.repo, [
      'add',
      'overlap.txt',
      'binary.bin',
      'package.json',
      'package-lock.json',
    ])
    writeFileSync(join(fixture.repo, 'overlap.txt'), 'unstaged overlap\n')
    writeFileSync(
      join(fixture.repo, 'binary.bin'),
      Buffer.from([0, 255, 2, 254]),
    )

    const capturedSafe = Buffer.from([0, 10, 128, 255])
    writeFileSync(join(fixture.repo, 'safe-untracked.bin'), capturedSafe)
    writeFileSync(join(fixture.repo, 'LOCAL_AGENT_TASK.md'), 'protected\n')
    writeFileSync(join(fixture.repo, 'ignored-secret.txt'), 'ignored\n')
    mkdirSync(join(fixture.repo, 'artifacts'))
    writeFileSync(join(fixture.repo, 'artifacts/input-only.txt'), 'artifact\n')
    mkdirSync(join(fixture.repo, 'nested/node_modules'), { recursive: true })
    writeFileSync(
      join(fixture.repo, 'nested/node_modules/secret.txt'),
      'dependency\n',
    )
    mkdirSync(join(fixture.repo, '.vmde-local-preview-scratch'))
    writeFileSync(
      join(fixture.repo, '.vmde-local-preview-scratch/secret.txt'),
      'scratch\n',
    )
    writeFileSync(join(fixture.repo, '..\\escape.txt'), 'unsafe\n')

    const raceOriginal = join(fixture.sandbox, 'safe-original.bin')
    writeFileSync(raceOriginal, capturedSafe)
    const gitWrapper = installGitWrapper(
      fixture,
      `if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  printf 'changed after capture' > "$VMDE_RACE_PATH"
  exec "$VMDE_REAL_GIT" "$@"
fi
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  cp "$VMDE_RACE_ORIGINAL" "$VMDE_RACE_PATH"
  exec "$VMDE_REAL_GIT" "$@"
fi
exec "$VMDE_REAL_GIT" "$@"`,
    )
    const before = snapshotPrimary(fixture.repo)
    const shortHead = runGit(fixture.repo, [
      'rev-parse',
      '--short=7',
      'HEAD^{commit}',
    ]).trim()
    const result = spawnSync(
      process.execPath,
      [HELPER, 'Include local edits'],
      {
        cwd: fixture.repo,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${gitWrapper}${delimiter}${process.env.PATH}`,
          VMDE_PREVIEW_TEST_COUNT: fixture.countFile,
          VMDE_REAL_GIT: REAL_GIT,
          VMDE_RACE_PATH: join(fixture.repo, 'safe-untracked.bin'),
          VMDE_RACE_ORIGINAL: raceOriginal,
        },
      },
    )

    expect(result.status, result.stderr).toBe(0)
    expect(packageCount(fixture)).toBe(1)
    const artifact = `vmde-2.7.1-preview-${shortHead}.vsix`
    expect(artifactFiles(fixture.repo)).toEqual([artifact])
    const evidence = await readEvidence(fixture.repo, artifact)
    expect(Buffer.from(evidence.overlap, 'base64').toString()).toBe(
      'unstaged overlap\n',
    )
    expect(Buffer.from(evidence.binary, 'base64')).toEqual(
      Buffer.from([0, 255, 2, 254]),
    )
    expect(Buffer.from(evidence.safe, 'base64')).toEqual(capturedSafe)
    expect(evidence).toMatchObject({
      protected: false,
      artifactInput: false,
      ignored: false,
      dependencyInput: false,
      scratchInput: false,
      unsafeInput: false,
      rootDependenciesLinked: true,
      mediaDependenciesLinked: true,
      packageVersion: '2.7.1',
      lockVersion: '2.7.1',
      lockRootVersion: '2.7.1',
    })
    expect(snapshotPrimary(fixture.repo)).toEqual(before)
  })

  it.each([
    ['fail', 'Preview package command failed'],
    ['bad-version', 'VSIX manifest Identity Version'],
    ['bad-package-publisher', 'VSIX extension/package.json publisher'],
    ['bad-identity-publisher', 'VSIX manifest Identity Publisher'],
    ['bad-identity-id', 'VSIX manifest Identity Id'],
    ['bad-prerelease', 'VSIX prerelease property'],
  ])(
    'never copies an output when packaging validation mode is %s',
    (mode, message) => {
      const fixture = createFixture(mode)
      const before = snapshotPrimary(fixture.repo)
      const result = runHelper(fixture, 'Committed HEAD')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(message)
      expect(packageCount(fixture)).toBe(1)
      expect(artifactFiles(fixture.repo)).toEqual([])
      expect(snapshotPrimary(fixture.repo)).toEqual(before)
      const worktrees = runGit(fixture.repo, [
        'worktree',
        'list',
        '--porcelain',
      ])
      expect(worktrees.match(/^worktree /gm)).toHaveLength(1)
    },
  )

  it('rejects a locally renamed package before invoking the package command', () => {
    const fixture = createFixture()
    const manifest = JSON.parse(
      readFileSync(join(fixture.repo, 'package.json'), 'utf8'),
    )
    manifest.name = '../outside'
    writeFileSync(
      join(fixture.repo, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    runGit(fixture.repo, ['add', 'package.json'])

    const result = runHelper(fixture, 'Include local edits')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'Selected package.json name must equal vmde',
    )
    expect(packageCount(fixture)).toBe(0)
    expect(artifactFiles(fixture.repo)).toEqual([])
  })

  it('cleans its exact registration when worktree add reports failure after creation', () => {
    const fixture = createFixture()
    const beforeTempRoots = new Set(
      readdirSync(tmpdir()).filter((name) =>
        name.startsWith('vmde-local-preview-'),
      ),
    )
    const wrapper = installGitWrapper(
      fixture,
      `if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  "$VMDE_REAL_GIT" "$@" || exit $?
  echo "intentional post-create failure" >&2
  exit 74
fi
exec "$VMDE_REAL_GIT" "$@"`,
    )
    const result = spawnSync(process.execPath, [HELPER, 'Committed HEAD'], {
      cwd: fixture.repo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${wrapper}${delimiter}${process.env.PATH}`,
        VMDE_PREVIEW_TEST_COUNT: fixture.countFile,
        VMDE_REAL_GIT: REAL_GIT,
      },
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('intentional post-create failure')
    expect(packageCount(fixture)).toBe(0)
    expect(artifactFiles(fixture.repo)).toEqual([])
    const worktrees = runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
    expect(worktrees.match(/^worktree /gm)).toHaveLength(1)
    expect(
      new Set(
        readdirSync(tmpdir()).filter((name) =>
          name.startsWith('vmde-local-preview-'),
        ),
      ),
    ).toEqual(beforeTempRoots)
  })

  it.skipIf(process.platform === 'win32')(
    'preserves a partially registered worktree when registration lookup fails',
    () => {
      const fixture = createFixture()
      const marker = join(fixture.sandbox, 'worktree-add-failed')
      const wrapper = installGitWrapper(
        fixture,
        `if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  "$VMDE_REAL_GIT" "$@" || exit $?
  : > "$VMDE_REGISTRATION_MARKER"
  echo "intentional post-create failure" >&2
  exit 74
fi
if [ "$1" = "worktree" ] && [ "$2" = "list" ] && [ -f "$VMDE_REGISTRATION_MARKER" ]; then
  echo "intentional registration query failure" >&2
  exit 75
fi
exec "$VMDE_REAL_GIT" "$@"`,
      )
      const result = runHelper(fixture, 'Committed HEAD', wrapper, {
        VMDE_REAL_GIT: REAL_GIT,
        VMDE_REGISTRATION_MARKER: marker,
      })

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('intentional post-create failure')
      expect(result.stderr).toContain(
        'Could not determine Git worktree registration',
      )
      const residualMatch = result.stderr.match(
        /Temporary path remains at: (\/tmp\/vmde-local-preview-[^\s]+)/,
      )
      expect(residualMatch, result.stderr).not.toBeNull()
      const tempRoot = residualMatch?.[1] ?? ''
      const worktree = join(tempRoot, 'worktree')
      expect(existsSync(tempRoot)).toBe(true)
      expect(existsSync(worktree)).toBe(true)
      expect(
        runGit(fixture.repo, ['worktree', 'list', '--porcelain']),
      ).toContain(`worktree ${worktree}`)
      expect(packageCount(fixture)).toBe(0)

      runGit(fixture.repo, ['worktree', 'remove', '--force', worktree])
      rmSync(tempRoot, { recursive: true, force: true })
    },
  )

  it('reports only its exact residual when owned worktree cleanup fails', () => {
    const fixture = createFixture()
    const sibling = join(fixture.sandbox, 'sibling-worktree')
    runGit(fixture.repo, ['worktree', 'add', '--detach', sibling, 'HEAD'])
    const wrapper = installGitWrapper(
      fixture,
      `if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then
  echo "intentional cleanup failure" >&2
  exit 73
fi
exec "${REAL_GIT}" "$@"`,
    )

    const result = runHelper(fixture, 'Committed HEAD', wrapper)

    expect(result.status).not.toBe(0)
    const match = result.stderr.match(
      /Git worktree registration remains for: (\/tmp\/vmde-local-preview-[^\s]+\/worktree)/,
    )
    expect(match, result.stderr).not.toBeNull()
    const residual = match?.[1] ?? ''
    const listed = runGit(fixture.repo, ['worktree', 'list', '--porcelain'])
    expect(listed).toContain(`worktree ${realpathSync(fixture.repo)}`)
    expect(listed).toContain(`worktree ${sibling}`)
    expect(listed).toContain(`worktree ${residual}`)
    expect(existsSync(dirname(residual))).toBe(true)
    expect(statSync(dirname(residual)).isDirectory()).toBe(true)

    runGit(fixture.repo, ['worktree', 'remove', '--force', residual])
    rmSync(dirname(residual), { recursive: true, force: true })
    runGit(fixture.repo, ['worktree', 'remove', '--force', sibling])
    expect(basename(residual)).toBe('worktree')
  })

  it('rejects an existing artifacts symlink before creating a worktree or package', () => {
    const fixture = createFixture()
    const outside = join(fixture.sandbox, 'outside-artifacts')
    mkdirSync(outside)
    symlinkSync(outside, join(fixture.repo, 'artifacts'), 'dir')

    const result = runHelper(fixture, 'Committed HEAD')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'artifacts path must not be a symbolic link',
    )
    expect(packageCount(fixture)).toBe(0)
    expect(readdirSync(outside)).toEqual([])
    expect(
      runGit(fixture.repo, ['worktree', 'list', '--porcelain']).match(
        /^worktree /gm,
      ),
    ).toHaveLength(1)
  })

  it('revalidates an artifacts directory swapped to a symlink before copy', () => {
    const fixture = createFixture()
    const artifacts = join(fixture.repo, 'artifacts')
    const outside = join(fixture.sandbox, 'outside-artifacts')
    mkdirSync(artifacts)
    mkdirSync(outside)

    const result = runHelper(fixture, 'Committed HEAD', undefined, {
      VMDE_PREVIEW_TEST_SWAP_ARTIFACTS: artifacts,
      VMDE_PREVIEW_TEST_SWAP_TARGET: outside,
    })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'artifacts path must not be a symbolic link',
    )
    expect(packageCount(fixture)).toBe(1)
    expect(readdirSync(outside)).toEqual([])
    rmSync(artifacts)
    mkdirSync(artifacts)
  })

  it.each(['root-empty', 'media-incomplete'])(
    'rejects incomplete reusable dependency installs before worktree creation: %s',
    (mode) => {
      const fixture = createFixture()
      if (mode === 'root-empty') {
        rmSync(join(fixture.repo, 'node_modules'))
        mkdirSync(join(fixture.repo, 'node_modules'))
      } else {
        rmSync(join(fixture.repo, 'media-src/node_modules'))
        mkdirSync(join(fixture.repo, 'media-src/node_modules'))
        writeFileSync(
          join(fixture.repo, 'media-src/node_modules/.package-lock.json'),
          '{}\n',
        )
        mkdirSync(join(fixture.repo, 'media-src/node_modules/esbuild'))
        writeFileSync(
          join(fixture.repo, 'media-src/node_modules/esbuild/package.json'),
          '{"name":"esbuild","version":"0.28.2"}\n',
        )
      }

      const result = runHelper(fixture, 'Committed HEAD')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Dependency preflight failed')
      expect(packageCount(fixture)).toBe(0)
      expect(
        runGit(fixture.repo, ['worktree', 'list', '--porcelain']).match(
          /^worktree /gm,
        ),
      ).toHaveLength(1)
    },
  )

  it('rejects selected dependency declarations that do not match the linked install', () => {
    const fixture = createFixture()
    const manifest = JSON.parse(
      readFileSync(join(fixture.repo, 'package.json'), 'utf8'),
    )
    const lockfile = JSON.parse(
      readFileSync(join(fixture.repo, 'package-lock.json'), 'utf8'),
    )
    manifest.devDependencies['@vscode/vsce'] = '999.0.0'
    lockfile.packages[''].devDependencies['@vscode/vsce'] = '999.0.0'
    writeFileSync(
      join(fixture.repo, 'package.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
    writeFileSync(
      join(fixture.repo, 'package-lock.json'),
      `${JSON.stringify(lockfile, null, 2)}\n`,
    )
    runGit(fixture.repo, ['add', 'package.json', 'package-lock.json'])

    const result = runHelper(fixture, 'Include local edits')

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'Selected dependency install is inconsistent',
    )
    expect(packageCount(fixture)).toBe(0)
  })

  it('uses exact root and media lock entries for every current fixture dependency', () => {
    const fixture = createFixture()
    const rootLock = JSON.parse(
      readFileSync(join(fixture.repo, 'package-lock.json'), 'utf8'),
    )
    const mediaLock = JSON.parse(
      readFileSync(join(fixture.repo, 'media-src/package-lock.json'), 'utf8'),
    )
    expect(
      Object.fromEntries(
        Object.entries(rootLock.packages)
          .filter(([key]) => key.startsWith('node_modules/'))
          .map(([key, value]) => [key, (value as { version: string }).version]),
      ),
    ).toEqual({
      'node_modules/@vscode/vsce': '3.9.2',
      'node_modules/esbuild': '0.28.2',
      'node_modules/typescript': '7.0.2',
      'node_modules/yauzl': '3.4.0',
    })
    expect(
      Object.fromEntries(
        Object.entries(mediaLock.packages)
          .filter(([key]) => key.startsWith('node_modules/'))
          .map(([key, value]) => [key, (value as { version: string }).version]),
      ),
    ).toEqual({
      'node_modules/esbuild': '0.28.2',
      'node_modules/vditor': '3.11.3',
    })

    const result = runHelper(fixture, 'Committed HEAD')
    expect(result.status, result.stderr).toBe(0)
    expect(packageCount(fixture)).toBe(1)
  })

  it.each([
    ['root-incomplete', 'package-lock.json'],
    ['media-incomplete', 'media-src/package-lock.json'],
    ['root-lock-bump', 'package-lock.json'],
    ['media-lock-bump', 'media-src/package-lock.json'],
  ])(
    'rejects incomplete or stale exact selected dependency locks: %s',
    (mode, relativeLock) => {
      const fixture = createFixture()
      const lockPath = join(fixture.repo, relativeLock)
      const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'))
      if (mode === 'root-incomplete') {
        lockfile.packages = { '': lockfile.packages[''] }
      } else if (mode === 'media-incomplete') {
        delete lockfile.packages['node_modules/vditor']
      } else if (mode === 'root-lock-bump') {
        lockfile.packages['node_modules/@vscode/vsce'].version = '3.9.3'
      } else {
        lockfile.packages['node_modules/esbuild'].version = '0.28.3'
      }
      writeFileSync(lockPath, `${JSON.stringify(lockfile, null, 2)}\n`)
      runGit(fixture.repo, ['add', relativeLock])

      const result = runHelper(fixture, 'Include local edits')

      expect(result.status).not.toBe(0)
      expect(result.stderr).toMatch(
        /missing exact lockfile entry|installed version must equal selected lock version/,
      )
      expect(packageCount(fixture)).toBe(0)
    },
  )

  it.skipIf(process.platform === 'win32')(
    'disables worktree hooks with an existing helper-owned directory',
    () => {
      const fixture = createFixture()
      const observed = join(fixture.sandbox, 'hooks-path.txt')
      const wrapper = installGitWrapper(
        fixture,
        `if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then
  if [ ! -d "$GIT_CONFIG_VALUE_0" ]; then
    echo "hook path is not a directory: $GIT_CONFIG_VALUE_0" >&2
    exit 92
  fi
  printf '%s' "$GIT_CONFIG_VALUE_0" > "$VMDE_HOOK_PATH_OBSERVED"
fi
exec "${REAL_GIT}" "$@"`,
      )

      const result = runHelper(fixture, 'Committed HEAD', wrapper, {
        VMDE_HOOK_PATH_OBSERVED: observed,
      })

      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(observed, 'utf8')).toContain('vmde-local-preview-')
    },
  )
})
