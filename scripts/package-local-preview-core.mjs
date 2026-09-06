import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import {
  derivePreviewVersion,
  nextPreviewArtifactCounter,
  parseNumericVersion,
  validateLockfileRootVersion,
  validateProductionBaseline,
} from './version-contract.mjs'

export const COMMITTED_HEAD = 'Committed HEAD'
export const INCLUDE_LOCAL_EDITS = 'Include local edits'
export const TEMP_PREFIX = 'vmde-local-preview-'

const VMDE_PACKAGE_NAME = 'vmde'
const VMDE_PUBLISHER = 'Laicasaane'
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024
const COPY_BUFFER_BYTES = 64 * 1024
const require = createRequire(import.meta.url)
const yauzl = require('yauzl')

export function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

export function stdoutBuffer(result) {
  return Buffer.isBuffer(result.stdout)
    ? result.stdout
    : Buffer.from(result.stdout ?? '')
}

function splitNul(buffer) {
  const values = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    values.push(buffer.subarray(start, index).toString('utf8'))
    start = index + 1
  }
  if (start < buffer.length) {
    values.push(buffer.subarray(start).toString('utf8'))
  }
  return values.filter(Boolean)
}

export function parseSelection(value) {
  if (value === COMMITTED_HEAD || value === INCLUDE_LOCAL_EDITS) return value
  throw new Error(
    `Expected preview input "${COMMITTED_HEAD}" or "${INCLUDE_LOCAL_EDITS}": ${String(value)}`,
  )
}

export function isSafeUntrackedPath(relativePath) {
  if (
    !relativePath ||
    relativePath.includes('\\') ||
    path.posix.isAbsolute(relativePath) ||
    path.win32.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath
  ) {
    return false
  }
  const segments = relativePath.split('/')
  if (
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    return false
  }
  if (relativePath === 'LOCAL_AGENT_TASK.md') return false
  if (segments[0] === 'artifacts') return false
  if (segments.includes('node_modules')) return false
  if (
    segments[0].startsWith(`.${TEMP_PREFIX}`) ||
    segments[0].startsWith('.vmde-preview-')
  ) {
    return false
  }
  return true
}

export function captureSafeUntrackedFiles(relativePaths, captureFile) {
  return relativePaths
    .filter(isSafeUntrackedPath)
    .map((relativePath) => captureFile(relativePath))
}

function sameStat(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  )
}

function readStableSelectedFile(repoRoot, relativePath) {
  if (!isSafeUntrackedPath(relativePath)) {
    throw new Error(`Unsafe untracked input path: ${relativePath}`)
  }
  const absolutePath = path.join(repoRoot, relativePath)
  const pathStat = lstatSync(absolutePath)
  if (!pathStat.isFile()) {
    throw new Error(
      `Selected untracked input is not a regular file: ${relativePath}`,
    )
  }
  const descriptor = openSync(
    absolutePath,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  try {
    const before = fstatSync(descriptor, { bigint: true })
    if (!before.isFile()) {
      throw new Error(
        `Selected untracked input is not a regular file: ${relativePath}`,
      )
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor, { bigint: true })
    if (!sameStat(before, after)) {
      throw new Error(`Untracked input changed while captured: ${relativePath}`)
    }
    return {
      path: relativePath,
      mode: Number(before.mode),
      bytes,
    }
  } finally {
    closeSync(descriptor)
  }
}

function captureSelectedUntracked(repoRoot, runGit) {
  const listed = stdoutBuffer(
    runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']),
  )
  return captureSafeUntrackedFiles(splitNul(listed), (relativePath) =>
    readStableSelectedFile(repoRoot, relativePath),
  )
}

const DIFF_ARGS = [
  '--binary',
  '--full-index',
  '--no-ext-diff',
  '--no-textconv',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
]

export function capturePrimaryState(repoRoot, runGit, options = {}) {
  const head = stdoutBuffer(
    runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
  )
  if (options.knownHead && head.toString('utf8').trim() !== options.knownHead) {
    throw new Error(
      `Primary HEAD changed during capture: expected ${options.knownHead}`,
    )
  }
  return {
    head,
    branch: stdoutBuffer(
      runGit(repoRoot, ['symbolic-ref', '--quiet', 'HEAD'], {
        allowedStatuses: [0, 1],
      }),
    ),
    status: stdoutBuffer(
      runGit(repoRoot, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=all',
        '--ignored=no',
      ]),
    ),
    staged: stdoutBuffer(runGit(repoRoot, ['diff', '--cached', ...DIFF_ARGS])),
    unstaged: stdoutBuffer(runGit(repoRoot, ['diff', ...DIFF_ARGS])),
    refs: stdoutBuffer(
      runGit(repoRoot, [
        'for-each-ref',
        '--format=%(refname)%00%(objectname)%00%(symref)',
      ]),
    ),
    selectedUntracked: options.captureUntracked
      ? captureSelectedUntracked(repoRoot, runGit)
      : [],
  }
}

function assertBufferEqual(name, actual, expected) {
  if (!actual.equals(expected)) {
    throw new Error(
      `Primary Git-visible ${name} changed during preview packaging`,
    )
  }
}

export function assertPrimaryStateEqual(repoRoot, expected, runGit) {
  const actual = capturePrimaryState(repoRoot, runGit)
  for (const name of [
    'head',
    'branch',
    'status',
    'staged',
    'unstaged',
    'refs',
  ]) {
    assertBufferEqual(name, actual[name], expected[name])
  }
  for (const selected of expected.selectedUntracked) {
    const actualFile = readStableSelectedFile(repoRoot, selected.path)
    if (
      actualFile.mode !== selected.mode ||
      !actualFile.bytes.equals(selected.bytes)
    ) {
      throw new Error(
        `Primary selected untracked bytes changed during preview packaging: ${selected.path}`,
      )
    }
  }
}

export function materializeSelectedUntracked(worktreePath, entries) {
  for (const entry of entries) {
    if (!isSafeUntrackedPath(entry.path)) {
      throw new Error(`Unsafe untracked input path: ${entry.path}`)
    }
    const segments = entry.path.split('/')
    let current = worktreePath
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment)
      if (existsSync(current)) {
        if (!lstatSync(current).isDirectory()) {
          throw new Error(`Unsafe untracked parent in snapshot: ${entry.path}`)
        }
      } else {
        mkdirSync(current)
      }
    }
    const target = path.resolve(worktreePath, entry.path)
    const boundary = `${path.resolve(worktreePath)}${path.sep}`
    if (!target.startsWith(boundary) || existsSync(target)) {
      throw new Error(`Unsafe or conflicting untracked path: ${entry.path}`)
    }
    const descriptor = openSync(
      target,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      entry.mode & 0o777,
    )
    try {
      let offset = 0
      while (offset < entry.bytes.length) {
        offset += writeSync(
          descriptor,
          entry.bytes,
          offset,
          entry.bytes.length - offset,
        )
      }
    } finally {
      closeSync(descriptor)
    }
  }
}

function readJson(file, context) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${context}: ${file} (${errorMessage(error)})`)
  }
}

const INSTALL_REQUIREMENTS = [
  {
    relativeRoot: '.',
    markerName: 'vmde',
    packages: ['@vscode/vsce', 'esbuild', 'typescript', 'yauzl'],
  },
  {
    relativeRoot: 'media-src',
    markerName: 'media-src',
    packages: ['esbuild', 'vditor'],
  },
]

export function validateDependencyPreflight(repoRoot) {
  const dependencyPaths = []
  for (const requirement of INSTALL_REQUIREMENTS) {
    const installRoot = path.join(repoRoot, requirement.relativeRoot)
    const nodeModules = path.join(installRoot, 'node_modules')
    try {
      if (!statSync(nodeModules).isDirectory())
        throw new Error('not a directory')
      const marker = readJson(
        path.join(nodeModules, '.package-lock.json'),
        'Invalid dependency install marker',
      )
      if (
        marker.name !== requirement.markerName ||
        marker.lockfileVersion !== 3
      ) {
        throw new Error(
          `unexpected install marker for ${requirement.markerName}`,
        )
      }
      for (const packageName of requirement.packages) {
        const installed = readJson(
          path.join(nodeModules, packageName, 'package.json'),
          'Invalid installed package manifest',
        )
        if (
          installed.name !== packageName ||
          typeof installed.version !== 'string'
        ) {
          throw new Error(`invalid installed package ${packageName}`)
        }
      }
    } catch (error) {
      throw new Error(
        `Dependency preflight failed for ${nodeModules}: ${errorMessage(error)}`,
      )
    }
    dependencyPaths.push(nodeModules)
  }
  return dependencyPaths
}

function directDependencyDeclarations(manifest) {
  return {
    dependencies: manifest.dependencies ?? {},
    devDependencies: manifest.devDependencies ?? {},
    optionalDependencies: manifest.optionalDependencies ?? {},
  }
}

function stableJson(value) {
  const sorted = {}
  for (const key of Object.keys(value).sort()) sorted[key] = value[key]
  return JSON.stringify(sorted)
}

function validateManifestLockDependencies(packageRoot) {
  const manifest = readJson(
    path.join(packageRoot, 'package.json'),
    'Invalid selected package manifest',
  )
  const lockfile = readJson(
    path.join(packageRoot, 'package-lock.json'),
    'Invalid selected lockfile',
  )
  const lockRoot = lockfile.packages?.['']
  if (!lockRoot)
    throw new Error(`Selected lockfile has no root package: ${packageRoot}`)
  const manifestDependencies = directDependencyDeclarations(manifest)
  const lockDependencies = directDependencyDeclarations(lockRoot)
  for (const field of Object.keys(manifestDependencies)) {
    if (
      stableJson(manifestDependencies[field]) !==
      stableJson(lockDependencies[field])
    ) {
      throw new Error(
        `Selected package and lock ${field} differ in ${packageRoot}`,
      )
    }
  }
  return { manifest, lockfile }
}

export function resolveSelectedDirectDependencies(packageRoot) {
  const { manifest, lockfile } = validateManifestLockDependencies(packageRoot)
  const dependencyNames = new Set()
  for (const declarations of Object.values(
    directDependencyDeclarations(manifest),
  )) {
    for (const dependencyName of Object.keys(declarations)) {
      dependencyNames.add(dependencyName)
    }
  }
  return [...dependencyNames].sort().map((dependencyName) => {
    const lockKey = `node_modules/${dependencyName}`
    const selectedEntry = lockfile.packages?.[lockKey]
    if (!selectedEntry || typeof selectedEntry.version !== 'string') {
      throw new Error(
        `Selected dependency is missing exact lockfile entry ${lockKey} in ${packageRoot}`,
      )
    }
    const installed = readJson(
      path.join(packageRoot, 'node_modules', dependencyName, 'package.json'),
      'Invalid linked installed package manifest',
    )
    if (installed.name !== dependencyName) {
      throw new Error(
        `Linked installed package name must equal ${dependencyName}: ${String(installed.name)}`,
      )
    }
    if (installed.version !== selectedEntry.version) {
      throw new Error(
        `Linked installed version must equal selected lock version for ${dependencyName}: ${String(installed.version)} !== ${selectedEntry.version}`,
      )
    }
    return { name: dependencyName, version: selectedEntry.version }
  })
}

function dependencyProblems(result, packageRoot) {
  let report
  try {
    report = JSON.parse(stdoutBuffer(result).toString('utf8'))
  } catch (error) {
    throw new Error(
      `Could not read npm dependency report for ${packageRoot}: ${errorMessage(error)}`,
    )
  }
  return (report.problems ?? []).filter(
    (problem) =>
      problem.startsWith('missing:') || problem.startsWith('invalid:'),
  )
}

export function validateSelectedDependencyConsistency(
  worktreePath,
  runNpmList,
) {
  for (const relativeRoot of ['.', 'media-src']) {
    const packageRoot = path.join(worktreePath, relativeRoot)
    resolveSelectedDirectDependencies(packageRoot)
    const result = runNpmList(packageRoot)
    const problems = dependencyProblems(result, packageRoot)
    if (problems.length > 0) {
      throw new Error(
        `Selected dependency install is inconsistent in ${packageRoot}: ${problems.join('; ')}`,
      )
    }
  }
}

export function readSelectedBaseline(worktreePath) {
  const manifest = readJson(
    path.join(worktreePath, 'package.json'),
    'Invalid selected package manifest',
  )
  const lockfile = readJson(
    path.join(worktreePath, 'package-lock.json'),
    'Invalid selected lockfile',
  )
  validateProductionBaseline(manifest, lockfile)
  if (manifest.name !== VMDE_PACKAGE_NAME) {
    throw new Error(
      `Selected package.json name must equal ${VMDE_PACKAGE_NAME}: ${String(manifest.name)}`,
    )
  }
  if (manifest.publisher !== VMDE_PUBLISHER) {
    throw new Error(
      `Selected package.json publisher must equal ${VMDE_PUBLISHER}: ${String(manifest.publisher)}`,
    )
  }
  return {
    packageName: manifest.name,
    publisher: manifest.publisher,
    productionVersion: manifest.version,
  }
}

export function derivePreviewArtifact(
  artifactNames,
  baseline,
  shortCommitHash,
  requestedVersion,
) {
  if (!/^[0-9a-f]{7,64}$/.test(shortCommitHash)) {
    throw new Error(
      `Expected a lowercase hexadecimal short commit hash: ${String(shortCommitHash)}`,
    )
  }
  const counter = nextPreviewArtifactCounter(
    artifactNames,
    baseline.packageName,
    baseline.productionVersion,
  )
  const calculatedVersion = derivePreviewVersion(
    baseline.productionVersion,
    String(counter),
  )
  const version = requestedVersion ?? calculatedVersion
  try {
    parseNumericVersion(version)
  } catch {
    throw new Error(`Expected numeric preview version X.Y.Z: ${String(version)}`)
  }
  return {
    version,
    name: `${baseline.packageName}-${version}-preview-${shortCommitHash}.vsix`,
  }
}

export function validateTemporaryManifests(worktreePath, previewVersion) {
  const manifest = readJson(
    path.join(worktreePath, 'package.json'),
    'Invalid temporary package manifest',
  )
  const lockfile = readJson(
    path.join(worktreePath, 'package-lock.json'),
    'Invalid temporary lockfile',
  )
  if (manifest.version !== previewVersion) {
    throw new Error(
      `Temporary package.json version must equal ${previewVersion}: ${String(manifest.version)}`,
    )
  }
  validateLockfileRootVersion(lockfile, previewVersion)
}

export function validateArtifactsDirectory(repoRoot, create) {
  const realRoot = realpathSync(repoRoot)
  const artifactPath = path.join(realRoot, 'artifacts')
  let artifactStat
  try {
    artifactStat = lstatSync(artifactPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!artifactStat) {
    if (!create) return { path: artifactPath, exists: false }
    mkdirSync(artifactPath)
    artifactStat = lstatSync(artifactPath)
  }
  if (artifactStat.isSymbolicLink()) {
    throw new Error(
      `Primary artifacts path must not be a symbolic link: ${artifactPath}`,
    )
  }
  if (!artifactStat.isDirectory()) {
    throw new Error(
      `Primary artifacts path must be a directory: ${artifactPath}`,
    )
  }
  const realArtifacts = realpathSync(artifactPath)
  if (
    normalizeWorktreePath(realArtifacts) !==
    normalizeWorktreePath(path.join(realRoot, 'artifacts'))
  ) {
    throw new Error(
      `Primary artifacts path escapes the repository: ${artifactPath}`,
    )
  }
  return { path: artifactPath, exists: true }
}

export function captureIgnoredArtifactNames(repoRoot, isIgnored) {
  const artifacts = validateArtifactsDirectory(repoRoot, false)
  if (!artifacts.exists) return []
  return readdirSync(artifacts.path, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => isIgnored(path.posix.join('artifacts', name)))
}

export function copyFileNoFollow(source, destination) {
  const sourceDescriptor = openSync(
    source,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
  )
  let destinationDescriptor
  let destinationStat
  try {
    destinationDescriptor = openSync(
      destination,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        (constants.O_NOFOLLOW ?? 0),
      0o666,
    )
    destinationStat = fstatSync(destinationDescriptor, { bigint: true })
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
    for (;;) {
      const bytesRead = readSync(
        sourceDescriptor,
        buffer,
        0,
        buffer.length,
        null,
      )
      if (bytesRead === 0) break
      let offset = 0
      while (offset < bytesRead) {
        offset += writeSync(
          destinationDescriptor,
          buffer,
          offset,
          bytesRead - offset,
        )
      }
    }
    fsyncSync(destinationDescriptor)
  } catch (error) {
    if (destinationDescriptor !== undefined && destinationStat) {
      closeSync(destinationDescriptor)
      destinationDescriptor = undefined
      try {
        const current = lstatSync(destination, { bigint: true })
        if (
          current.dev === destinationStat.dev &&
          current.ino === destinationStat.ino
        ) {
          unlinkSync(destination)
        }
      } catch {
        // Preserve the original copy error; cleanup is best effort and inode-bound.
      }
    }
    throw error
  } finally {
    closeSync(sourceDescriptor)
    if (destinationDescriptor !== undefined) closeSync(destinationDescriptor)
  }
}

function readArchiveEntries(file, requestedNames) {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(file, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        reject(openError ?? new Error(`Could not open VSIX archive: ${file}`))
        return
      }
      const entries = new Map()
      let settled = false
      const fail = (error) => {
        if (settled) return
        settled = true
        zipFile.close()
        reject(error)
      }
      zipFile.once('error', fail)
      zipFile.once('end', () => {
        if (settled) return
        settled = true
        resolvePromise(entries)
      })
      zipFile.on('entry', (entry) => {
        if (!requestedNames.has(entry.fileName)) {
          zipFile.readEntry()
          return
        }
        if (entries.has(entry.fileName)) {
          fail(new Error(`VSIX contains duplicate entry: ${entry.fileName}`))
          return
        }
        if (entry.uncompressedSize > MAX_MANIFEST_BYTES) {
          fail(new Error(`VSIX manifest entry is too large: ${entry.fileName}`))
          return
        }
        zipFile.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) {
            fail(
              streamError ??
                new Error(`Could not read VSIX entry: ${entry.fileName}`),
            )
            return
          }
          const chunks = []
          let size = 0
          stream.on('data', (chunk) => {
            size += chunk.length
            if (size > MAX_MANIFEST_BYTES) {
              stream.destroy(
                new Error(`VSIX entry is too large: ${entry.fileName}`),
              )
              return
            }
            chunks.push(Buffer.from(chunk))
          })
          stream.once('error', fail)
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

function xmlAttribute(tag, name) {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  ).exec(tag)
  return match?.[1] ?? match?.[2]
}

export async function validateVsix(file, expected) {
  if (!existsSync(file) || !statSync(file).isFile()) {
    throw new Error(
      `Preview package command did not create the expected VSIX: ${file}`,
    )
  }
  const extensionPackage = 'extension/package.json'
  const vsixManifest = 'extension.vsixmanifest'
  const entries = await readArchiveEntries(
    file,
    new Set([extensionPackage, vsixManifest]),
  )
  for (const entry of [extensionPackage, vsixManifest]) {
    if (!entries.has(entry)) {
      throw new Error(`VSIX is missing required entry: ${entry}`)
    }
  }
  const manifest = JSON.parse(entries.get(extensionPackage).toString('utf8'))
  if (manifest.name !== expected.packageName) {
    throw new Error(
      `VSIX extension/package.json name must equal ${expected.packageName}: ${String(manifest.name)}`,
    )
  }
  if (manifest.publisher !== expected.publisher) {
    throw new Error(
      `VSIX extension/package.json publisher must equal ${expected.publisher}: ${String(manifest.publisher)}`,
    )
  }
  if (manifest.version !== expected.version) {
    throw new Error(
      `VSIX extension/package.json version must equal ${expected.version}: ${String(manifest.version)}`,
    )
  }
  const xml = entries.get(vsixManifest).toString('utf8')
  const identity = /<Identity\b[^>]*>/i.exec(xml)?.[0]
  const identityName = identity ? xmlAttribute(identity, 'Id') : undefined
  const identityPublisher = identity
    ? xmlAttribute(identity, 'Publisher')
    : undefined
  const identityVersion = identity
    ? xmlAttribute(identity, 'Version')
    : undefined
  if (identityName !== expected.packageName) {
    throw new Error(
      `VSIX manifest Identity Id must equal ${expected.packageName}: ${String(identityName)}`,
    )
  }
  if (identityPublisher !== expected.publisher) {
    throw new Error(
      `VSIX manifest Identity Publisher must equal ${expected.publisher}: ${String(identityPublisher)}`,
    )
  }
  if (identityVersion !== expected.version) {
    throw new Error(
      `VSIX manifest Identity Version must equal ${expected.version}: ${String(identityVersion)}`,
    )
  }
  const prerelease = (xml.match(/<Property\b[^>]*>/gi) ?? []).find(
    (property) =>
      xmlAttribute(property, 'Id') === 'Microsoft.VisualStudio.Code.PreRelease',
  )
  const prereleaseValue = xmlAttribute(
    prerelease ?? '',
    'Value',
  )?.toLowerCase()
  if (expected.prerelease && prereleaseValue !== 'true') {
    throw new Error('VSIX prerelease property must equal true')
  }
  if (!expected.prerelease && prereleaseValue === 'true') {
    throw new Error('VSIX production archive must not be marked prerelease')
  }
}

export function normalizeWorktreePath(worktreePath) {
  const normalized = path.normalize(path.resolve(worktreePath))
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function hasWorktreeRegistration(porcelain, worktreePath) {
  const expected = normalizeWorktreePath(worktreePath)
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some(
      (line) =>
        normalizeWorktreePath(line.slice('worktree '.length)) === expected,
    )
}

export function cleanupOwnedResources({
  worktreePath,
  tempRoot,
  registrationState,
  removeWorktree,
  hasRegistration,
  removeTemp,
}) {
  const errors = []
  if (registrationState === 'unknown') {
    errors.push(
      new Error(
        `Git worktree registration state is unknown for: ${worktreePath}`,
      ),
    )
    if (tempRoot) {
      errors.push(new Error(`Temporary path remains at: ${tempRoot}`))
    }
    return errors
  }
  let registrationRemains = registrationState === 'registered'
  let removalFailed = false
  if (registrationState === 'registered') {
    try {
      removeWorktree()
    } catch (error) {
      removalFailed = true
      errors.push(
        new Error(
          `Git worktree registration remains for: ${worktreePath} (${errorMessage(error)})`,
        ),
      )
    }
    if (!removalFailed) {
      try {
        registrationRemains = hasRegistration()
      } catch (error) {
        registrationRemains = true
        errors.push(
          new Error(
            `Could not confirm Git worktree deregistration for: ${worktreePath} (${errorMessage(error)})`,
          ),
        )
      }
      if (registrationRemains) {
        errors.push(
          new Error(`Git worktree registration remains for: ${worktreePath}`),
        )
      }
    }
  } else if (registrationState === 'absent') {
    registrationRemains = false
  } else {
    throw new Error(
      `Invalid worktree registration state: ${String(registrationState)}`,
    )
  }

  if (removalFailed || registrationRemains) {
    if (tempRoot)
      errors.push(new Error(`Temporary path remains at: ${tempRoot}`))
    return errors
  }
  if (tempRoot) {
    try {
      removeTemp()
    } catch (error) {
      errors.push(
        new Error(
          `Temporary path remains at: ${tempRoot} (${errorMessage(error)})`,
        ),
      )
    }
  }
  return errors
}

export function removeTempRoot(tempRoot) {
  rmSync(tempRoot, { recursive: true, force: true })
}
