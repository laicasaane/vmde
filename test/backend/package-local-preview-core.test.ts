import {
  createWriteStream,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const CORE_URL = new URL(
  '../../scripts/package-local-preview-core.mjs',
  import.meta.url,
)
const cleanupPaths: string[] = []
const require = createRequire(import.meta.url)
const { ZipFile } = require('yazl')

afterEach(() => {
  vi.restoreAllMocks()
  while (cleanupPaths.length > 0) {
    rmSync(cleanupPaths.pop() ?? '', { recursive: true, force: true })
  }
})

async function loadCore() {
  try {
    return await import(CORE_URL.href)
  } catch {
    return undefined
  }
}

function writeJson(file: string, value: unknown) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function commandResult(stdout: string | Buffer, status = 0) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), status }
}

function stateGit(untracked = Buffer.alloc(0)) {
  return (_repo: string, args: string[]) => {
    if (args[0] === 'rev-parse') return commandResult('abc123\n')
    if (args[0] === 'symbolic-ref') return commandResult('refs/heads/dev\n')
    if (args[0] === 'status') return commandResult('status')
    if (args[0] === 'for-each-ref') return commandResult('refs')
    if (args[0] === 'ls-files') return commandResult(untracked)
    if (args[0] === 'diff' && args[1] === '--cached') {
      return commandResult('staged')
    }
    if (args[0] === 'diff') return commandResult('unstaged')
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  }
}

function createDependencyInstall(repo: string) {
  const requirements = [
    {
      root: repo,
      name: 'vmde',
      packages: ['@vscode/vsce', 'esbuild', 'typescript', 'yauzl'],
    },
    {
      root: join(repo, 'media-src'),
      name: 'media-src',
      packages: ['esbuild', 'vditor'],
    },
  ]
  for (const requirement of requirements) {
    const modules = join(requirement.root, 'node_modules')
    mkdirSync(modules, { recursive: true })
    writeJson(join(modules, '.package-lock.json'), {
      name: requirement.name,
      lockfileVersion: 3,
    })
    for (const packageName of requirement.packages) {
      const packageRoot = join(modules, packageName)
      mkdirSync(packageRoot, { recursive: true })
      writeJson(join(packageRoot, 'package.json'), {
        name: packageName,
        version: '1.2.3',
      })
    }
  }
}

function createSelectedPackage(
  packageRoot: string,
  fixture: {
    name: string
    version: string
    publisher?: string
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
    optionalDependencies: Record<string, string>
    exactVersions: Record<string, string>
  },
) {
  mkdirSync(packageRoot, { recursive: true })
  const { exactVersions, ...manifest } = fixture
  writeJson(join(packageRoot, 'package.json'), manifest)
  const packages: Record<string, unknown> = { '': manifest }
  for (const [dependencyName, dependencyVersion] of Object.entries(
    exactVersions,
  )) {
    packages[`node_modules/${dependencyName}`] = {
      version: dependencyVersion,
    }
    const installedRoot = join(packageRoot, 'node_modules', dependencyName)
    mkdirSync(installedRoot, { recursive: true })
    writeJson(join(installedRoot, 'package.json'), {
      name: dependencyName,
      version: dependencyVersion,
    })
  }
  writeJson(join(packageRoot, 'package-lock.json'), {
    name: fixture.name,
    version: fixture.version,
    lockfileVersion: 3,
    packages,
  })
}

function createSelectedManifests(root: string, version = '1.4.0') {
  createSelectedPackage(root, {
    name: 'vmde',
    version,
    publisher: 'Laicasaane',
    dependencies: { '@scope/runtime': '^2.0.0' },
    devDependencies: { tool: '^1.0.0' },
    optionalDependencies: { 'optional-tool': '^3.0.0' },
    exactVersions: {
      '@scope/runtime': '2.4.1',
      tool: '1.2.3',
      'optional-tool': '3.1.0',
    },
  })
  createSelectedPackage(join(root, 'media-src'), {
    name: 'media-src',
    version: '0.0.0',
    dependencies: { 'media-runtime': '^4.0.0' },
    devDependencies: { 'media-tool': '^5.0.0' },
    optionalDependencies: { '@scope/media-optional': '^6.0.0' },
    exactVersions: {
      'media-runtime': '4.2.0',
      'media-tool': '5.1.0',
      '@scope/media-optional': '6.3.0',
    },
  })
}

async function writeVsix(
  file: string,
  options: {
    version: string
    packageName?: string
    packagePublisher?: string
    identityName?: string
    identityPublisher?: string
    prerelease?: string | null
  },
) {
  const packageName = options.packageName ?? 'vmde'
  const packagePublisher = options.packagePublisher ?? 'Laicasaane'
  const identityName = options.identityName ?? packageName
  const identityPublisher = options.identityPublisher ?? packagePublisher
  const prerelease =
    options.prerelease === undefined ? 'true' : options.prerelease
  const prereleaseProperty =
    prerelease === null
      ? ''
      : `<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="${prerelease}"/>`
  const zip = new ZipFile()
  zip.addBuffer(
    Buffer.from(
      JSON.stringify({
        name: packageName,
        publisher: packagePublisher,
        version: options.version,
      }),
    ),
    'extension/package.json',
  )
  zip.addBuffer(
    Buffer.from(
      `<PackageManifest><Metadata><Identity Id="${identityName}" Publisher="${identityPublisher}" Version="${options.version}"/><Properties>${prereleaseProperty}</Properties></Metadata></PackageManifest>`,
    ),
    'extension.vsixmanifest',
  )
  await new Promise<void>((resolvePromise, reject) => {
    zip.outputStream
      .pipe(createWriteStream(file))
      .once('close', resolvePromise)
      .once('error', reject)
    zip.end()
  })
}

describe('local preview packaging core', () => {
  it('provides an importable side-effect-free core', async () => {
    expect(await loadCore()).toBeDefined()
  })

  it('filters every protected path before invoking the byte capture callback', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const opened: string[] = []
    const result = core.captureSafeUntrackedFiles(
      [
        'notes/safe.bin',
        'LOCAL_AGENT_TASK.md',
        'artifacts/input.vsix',
        'nested/node_modules/secret',
        '.vmde-local-preview-scratch/secret',
        '.vmde-preview-old/secret',
        '../escape',
        '..\\escape',
        '/absolute',
      ],
      (relativePath: string) => {
        opened.push(relativePath)
        return { path: relativePath, bytes: Buffer.from('safe') }
      },
    )

    expect(opened).toEqual(['notes/safe.bin'])
    expect(result).toEqual([
      { path: 'notes/safe.bin', bytes: Buffer.from('safe') },
    ])
  })

  it('keeps a registered worktree root intact after removal fails', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const removeTemp = vi.fn()
    const result = core.cleanupOwnedResources({
      worktreePath: '/temp/root/worktree',
      tempRoot: '/temp/root',
      registrationState: 'registered',
      removeWorktree: () => {
        throw new Error('busy')
      },
      hasRegistration: () => true,
      removeTemp,
    })

    expect(removeTemp).not.toHaveBeenCalled()
    expect(result.map((error: Error) => error.message)).toEqual([
      expect.stringContaining('Git worktree registration remains for'),
      expect.stringContaining('Temporary path remains at'),
    ])
  })

  it('keeps the root when deregistration reports success but registration remains', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const removeTemp = vi.fn()
    const result = core.cleanupOwnedResources({
      worktreePath: '/temp/root/worktree',
      tempRoot: '/temp/root',
      registrationState: 'registered',
      removeWorktree: vi.fn(),
      hasRegistration: () => true,
      removeTemp,
    })

    expect(removeTemp).not.toHaveBeenCalled()
    expect(result.map((error: Error) => error.message)).toEqual([
      expect.stringContaining('Git worktree registration remains for'),
      expect.stringContaining('Temporary path remains at'),
    ])
  })

  it('removes the root only after confirmed deregistration', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const removeTemp = vi.fn()
    expect(
      core.cleanupOwnedResources({
        worktreePath: '/temp/root/worktree',
        tempRoot: '/temp/root',
        registrationState: 'registered',
        removeWorktree: vi.fn(),
        hasRegistration: () => false,
        removeTemp,
      }),
    ).toEqual([])
    expect(removeTemp).toHaveBeenCalledOnce()
  })

  it('preserves the exact root when registration state is unknown', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const removeWorktree = vi.fn()
    const removeTemp = vi.fn()
    const result = core.cleanupOwnedResources({
      worktreePath: '/temp/root/worktree',
      tempRoot: '/temp/root',
      registrationState: 'unknown',
      removeWorktree,
      hasRegistration: vi.fn(),
      removeTemp,
    })

    expect(removeWorktree).not.toHaveBeenCalled()
    expect(removeTemp).not.toHaveBeenCalled()
    expect(result.map((error: Error) => error.message)).toEqual([
      'Git worktree registration state is unknown for: /temp/root/worktree',
      'Temporary path remains at: /temp/root',
    ])
  })

  it('rejects artifact symlinks and copies without following an existing destination', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    const repo = join(sandbox, 'repo')
    const outside = join(sandbox, 'outside')
    mkdirSync(repo)
    mkdirSync(outside)
    symlinkSync(outside, join(repo, 'artifacts'), 'dir')

    expect(() => core.validateArtifactsDirectory(repo, false)).toThrow(
      'must not be a symbolic link',
    )
    rmSync(join(repo, 'artifacts'), { recursive: true })
    mkdirSync(join(repo, 'artifacts'))
    const source = join(sandbox, 'source.vsix')
    const outsideFile = join(outside, 'outside.vsix')
    writeFileSync(source, 'archive')
    writeFileSync(outsideFile, 'sentinel')
    symlinkSync(outsideFile, join(repo, 'artifacts/preview.vsix'))

    expect(() =>
      core.copyFileNoFollow(source, join(repo, 'artifacts/preview.vsix')),
    ).toThrow()
    expect(readFileSync(outsideFile, 'utf8')).toBe('sentinel')

    rmSync(join(repo, 'artifacts/preview.vsix'))
    rmSync(join(repo, 'artifacts'), { recursive: true })
    symlinkSync(join(outside, 'missing'), join(repo, 'artifacts'), 'dir')
    expect(() => core.validateArtifactsDirectory(repo, false)).toThrow(
      'must not be a symbolic link',
    )
  })

  it('normalizes equivalent worktree paths for platform comparison', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    expect(core.normalizeWorktreePath('/tmp/one/../two')).toBe(
      core.normalizeWorktreePath(resolve('/tmp/two')),
    )
    expect(
      core.hasWorktreeRegistration(
        `worktree ${resolve('/tmp/two')}\nHEAD abc\n`,
        '/tmp/one/../two',
      ),
    ).toBe(true)
    expect(core.hasWorktreeRegistration('', '/tmp/two')).toBe(false)
  })

  it('captures Git buffers without enumerating untracked files in committed mode', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const runGit = vi.fn(stateGit())
    const state = core.capturePrimaryState('/repo', runGit, {
      knownHead: 'abc123',
      captureUntracked: false,
    })

    expect(state.selectedUntracked).toEqual([])
    expect(runGit.mock.calls.some(([, args]) => args[0] === 'ls-files')).toBe(
      false,
    )
    expect(() =>
      core.assertPrimaryStateEqual('/repo', state, runGit),
    ).not.toThrow()
    expect(() =>
      core.capturePrimaryState('/repo', runGit, { knownHead: 'different' }),
    ).toThrow('Primary HEAD changed')
  })

  it('captures and materializes only safe regular untracked files', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    writeFileSync(join(sandbox, 'safe.bin'), Buffer.from([0, 1, 255]))
    writeFileSync(join(sandbox, 'LOCAL_AGENT_TASK.md'), 'protected')
    const listed = Buffer.from('safe.bin\0LOCAL_AGENT_TASK.md\0')
    const runGit = vi.fn(stateGit(listed))
    const state = core.capturePrimaryState(sandbox, runGit, {
      knownHead: 'abc123',
      captureUntracked: true,
    })

    expect(
      state.selectedUntracked.map((entry: { path: string }) => entry.path),
    ).toEqual(['safe.bin'])
    const worktree = join(sandbox, 'worktree')
    mkdirSync(worktree)
    core.materializeSelectedUntracked(worktree, state.selectedUntracked)
    expect(readFileSync(join(worktree, 'safe.bin'))).toEqual(
      Buffer.from([0, 1, 255]),
    )
    expect(() =>
      core.assertPrimaryStateEqual(sandbox, state, runGit),
    ).not.toThrow()
    expect(() =>
      core.materializeSelectedUntracked(worktree, [
        { path: '../escape', mode: 0o644, bytes: Buffer.from('unsafe') },
      ]),
    ).toThrow('Unsafe untracked input path')
  })

  it('preflights required install markers and package manifests', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    createDependencyInstall(sandbox)

    expect(core.validateDependencyPreflight(sandbox)).toEqual([
      join(sandbox, 'node_modules'),
      join(sandbox, 'media-src/node_modules'),
    ])
    rmSync(join(sandbox, 'media-src/node_modules/vditor/package.json'))
    expect(() => core.validateDependencyPreflight(sandbox)).toThrow(
      'Dependency preflight failed',
    )
  })

  it('checks selected package-lock declarations and npm dependency reports', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    createSelectedManifests(sandbox)

    expect(core.resolveSelectedDirectDependencies(sandbox)).toEqual([
      { name: '@scope/runtime', version: '2.4.1' },
      { name: 'optional-tool', version: '3.1.0' },
      { name: 'tool', version: '1.2.3' },
    ])
    expect(
      core.resolveSelectedDirectDependencies(join(sandbox, 'media-src')),
    ).toEqual([
      { name: '@scope/media-optional', version: '6.3.0' },
      { name: 'media-runtime', version: '4.2.0' },
      { name: 'media-tool', version: '5.1.0' },
    ])

    expect(() =>
      core.validateSelectedDependencyConsistency(sandbox, () =>
        commandResult('{"problems":["extraneous: ignored"]}', 1),
      ),
    ).not.toThrow()
    expect(() =>
      core.validateSelectedDependencyConsistency(sandbox, () =>
        commandResult('{"problems":["invalid: tool@1.2.3"]}', 1),
      ),
    ).toThrow('Selected dependency install is inconsistent')

    const manifest = JSON.parse(
      readFileSync(join(sandbox, 'package.json'), 'utf8'),
    )
    manifest.devDependencies.tool = '^2.0.0'
    writeJson(join(sandbox, 'package.json'), manifest)
    expect(() =>
      core.validateSelectedDependencyConsistency(sandbox, () =>
        commandResult('{}'),
      ),
    ).toThrow('Selected package and lock devDependencies differ')
  })

  it('rejects incomplete and lock-only-stale exact dependency entries', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    createSelectedManifests(sandbox)
    const lockPath = join(sandbox, 'package-lock.json')
    const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'))
    const rootEntry = lockfile.packages['']
    lockfile.packages = { '': rootEntry }
    writeJson(lockPath, lockfile)

    expect(() => core.resolveSelectedDirectDependencies(sandbox)).toThrow(
      'missing exact lockfile entry',
    )

    createSelectedManifests(sandbox)
    const staleLock = JSON.parse(readFileSync(lockPath, 'utf8'))
    staleLock.packages['node_modules/tool'].version = '1.2.4'
    writeJson(lockPath, staleLock)
    expect(() => core.resolveSelectedDirectDependencies(sandbox)).toThrow(
      'installed version must equal selected lock version',
    )
  })

  it('derives and validates preview manifests from an even selected baseline', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    createSelectedManifests(sandbox)

    const baseline = core.readSelectedBaseline(sandbox)
    expect(baseline).toEqual({
      packageName: 'vmde',
      publisher: 'Laicasaane',
      productionVersion: '1.4.0',
    })
    expect(
      core.derivePreviewArtifact(
        ['vmde-1.5.2-preview.vsix', 'vmde-1.7.99-preview.vsix'],
        baseline,
        'abc1234',
      ),
    ).toEqual({
      version: '1.5.3',
      name: 'vmde-1.5.3-preview-abc1234.vsix',
    })
    expect(() => core.derivePreviewArtifact([], baseline, '../unsafe')).toThrow(
      'short commit hash',
    )

    createSelectedManifests(sandbox, '1.5.3')
    expect(() => core.readSelectedBaseline(sandbox)).toThrow('even minor')
    createSelectedManifests(sandbox)
    const manifestPath = join(sandbox, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    manifest.publisher = 'laicasaane'
    writeJson(manifestPath, manifest)
    expect(() => core.readSelectedBaseline(sandbox)).toThrow(
      'package.json publisher must equal Laicasaane',
    )
    createSelectedManifests(sandbox)
    const lockPath = join(sandbox, 'package-lock.json')
    const lockfile = JSON.parse(readFileSync(lockPath, 'utf8'))
    lockfile.version = '1.4.1'
    writeJson(lockPath, lockfile)
    expect(() => core.readSelectedBaseline(sandbox)).toThrow(
      'package-lock.json version must equal 1.4.0',
    )
    createSelectedManifests(sandbox, '1.5.3')
    expect(() => core.validateTemporaryManifests(sandbox, '1.5.4')).toThrow(
      'Temporary package.json version',
    )
  })

  it('creates, validates, scans, and safely copies the direct artifacts directory', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    expect(core.validateArtifactsDirectory(sandbox, false).exists).toBe(false)
    const artifacts = core.validateArtifactsDirectory(sandbox, true)
    writeFileSync(join(artifacts.path, 'one.vsix'), 'one')
    writeFileSync(join(artifacts.path, 'two.txt'), 'two')
    expect(
      core.captureIgnoredArtifactNames(sandbox, (name: string) =>
        name.endsWith('.vsix'),
      ),
    ).toEqual(['one.vsix'])

    const source = join(sandbox, 'source.vsix')
    const destination = join(artifacts.path, 'copy.vsix')
    writeFileSync(source, 'archive bytes')
    core.copyFileNoFollow(source, destination)
    expect(readFileSync(destination, 'utf8')).toBe('archive bytes')
  })

  it('validates packaged version and prerelease metadata from real ZIP entries', async () => {
    const core = await loadCore()
    expect(core).toBeDefined()
    if (!core) return
    const sandbox = mkdtempSync(join(tmpdir(), 'vmde-preview-core-'))
    cleanupPaths.push(sandbox)
    const valid = join(sandbox, 'valid.vsix')
    const invalid = join(sandbox, 'invalid.vsix')
    const wrongPackagePublisher = join(sandbox, 'wrong-package-publisher.vsix')
    const wrongIdentityPublisher = join(
      sandbox,
      'wrong-identity-publisher.vsix',
    )
    const wrongIdentityId = join(sandbox, 'wrong-identity-id.vsix')
    const production = join(sandbox, 'production.vsix')
    await writeVsix(valid, { version: '1.5.1' })
    await writeVsix(invalid, { version: '1.5.1', prerelease: 'false' })
    await writeVsix(wrongPackagePublisher, {
      version: '1.5.1',
      packagePublisher: 'laicasaane',
      identityPublisher: 'Laicasaane',
    })
    await writeVsix(wrongIdentityPublisher, {
      version: '1.5.1',
      identityPublisher: 'laicasaane',
    })
    await writeVsix(wrongIdentityId, {
      version: '1.5.1',
      identityName: 'not-vmde',
    })
    await writeVsix(production, { version: '1.4.0', prerelease: null })

    const expected = {
      packageName: 'vmde',
      publisher: 'Laicasaane',
      version: '1.5.1',
      prerelease: true,
    }
    await expect(core.validateVsix(valid, expected)).resolves.toBeUndefined()
    await expect(
      core.validateVsix(valid, { ...expected, version: '1.5.2' }),
    ).rejects.toThrow('extension/package.json version')
    await expect(core.validateVsix(invalid, expected)).rejects.toThrow(
      'prerelease property',
    )
    await expect(
      core.validateVsix(wrongPackagePublisher, expected),
    ).rejects.toThrow('extension/package.json publisher')
    await expect(
      core.validateVsix(wrongIdentityPublisher, expected),
    ).rejects.toThrow('manifest Identity Publisher')
    await expect(core.validateVsix(wrongIdentityId, expected)).rejects.toThrow(
      'manifest Identity Id',
    )
    await expect(
      core.validateVsix(production, {
        ...expected,
        version: '1.4.0',
        prerelease: false,
      }),
    ).resolves.toBeUndefined()
  })
})
