#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  COMMITTED_HEAD,
  INCLUDE_LOCAL_EDITS,
  TEMP_PREFIX,
  assertPrimaryStateEqual,
  captureIgnoredArtifactNames,
  capturePrimaryState,
  cleanupOwnedResources,
  copyFileNoFollow,
  derivePreviewArtifact,
  errorMessage,
  hasWorktreeRegistration,
  materializeSelectedUntracked,
  parseSelection,
  readSelectedBaseline,
  removeTempRoot,
  stdoutBuffer,
  validateArtifactsDirectory,
  validateDependencyPreflight,
  validateSelectedDependencyConsistency,
  validateTemporaryManifests,
  validateVsix,
} from './package-local-preview-core.mjs'

const MAX_COMMAND_BUFFER = 1024 * 1024 * 1024

function runProcess(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: options.encoding ?? null,
    maxBuffer: MAX_COMMAND_BUFFER,
  })
  if (result.error) throw result.error
  const allowedStatuses = options.allowedStatuses ?? [0]
  if (!allowedStatuses.includes(result.status)) {
    const stderr = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString('utf8').trim()
      : String(result.stderr ?? '').trim()
    throw new Error(
      `${options.label ?? `${command} ${args.join(' ')}`} failed${stderr ? `: ${stderr}` : ''}`,
    )
  }
  return result
}

function gitEnvironment(hooksPath) {
  if (!hooksPath) return process.env
  return {
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.hooksPath',
    GIT_CONFIG_VALUE_0: hooksPath,
  }
}

function runGit(repoRoot, args, options = {}) {
  return runProcess('git', args, {
    ...options,
    cwd: repoRoot,
    env: gitEnvironment(options.hooksPath),
    label: options.label ?? `git ${args.join(' ')}`,
  })
}

function resolveRepositoryRoot() {
  const root = stdoutBuffer(
    runProcess('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      label: 'Resolve repository root',
    }),
  )
    .toString('utf8')
    .trim()
  if (!root) throw new Error('Git repository root is empty')
  return realpathSync(root)
}

function isIgnored(repoRoot, relativePath, includeTracked = false) {
  const result = runGit(
    repoRoot,
    [
      'check-ignore',
      '--quiet',
      ...(includeTracked ? ['--no-index'] : []),
      '--',
      relativePath,
    ],
    { allowedStatuses: [0, 1] },
  )
  return result.status === 0
}

function applyPatch(worktreePath, patch, staged) {
  if (patch.length === 0) return
  runGit(
    worktreePath,
    [
      'apply',
      '--binary',
      '--whitespace=nowarn',
      ...(staged ? ['--index'] : []),
      '-',
    ],
    {
      input: patch,
      label: staged ? 'Apply staged snapshot' : 'Apply unstaged snapshot',
    },
  )
}

function linkDependencies(worktreePath, dependencyPaths) {
  const links = [
    path.join(worktreePath, 'node_modules'),
    path.join(worktreePath, 'media-src', 'node_modules'),
  ]
  for (let index = 0; index < links.length; index += 1) {
    const link = links[index]
    if (existsSync(link)) {
      throw new Error(
        `Selected snapshot already contains dependency path: ${link}`,
      )
    }
    mkdirSync(path.dirname(link), { recursive: true })
    symlinkSync(
      dependencyPaths[index],
      link,
      process.platform === 'win32' ? 'junction' : 'dir',
    )
  }
}

function runNpmList(packageRoot) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return runProcess(npm, ['ls', '--depth=0', '--json'], {
    cwd: packageRoot,
    allowedStatuses: [0, 1],
    label: `Inspect selected dependencies in ${packageRoot}`,
  })
}

function updateTemporaryVersion(worktreePath, previewVersion) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  runProcess(
    npm,
    ['version', previewVersion, '--no-git-tag-version', '--ignore-scripts'],
    { cwd: worktreePath, label: 'Update temporary preview version' },
  )
  validateTemporaryManifests(worktreePath, previewVersion)
}

function packageTemporaryVsix(worktreePath, output) {
  runProcess(
    process.execPath,
    ['scripts/package-vsix.mjs', '--pre-release', '--out', output],
    { cwd: worktreePath, label: 'Preview package command' },
  )
}

function registrationExists(repoRoot, worktreePath) {
  const porcelain = stdoutBuffer(
    runGit(repoRoot, ['worktree', 'list', '--porcelain']),
  ).toString('utf8')
  return hasWorktreeRegistration(porcelain, worktreePath)
}

function cleanup(
  repoRoot,
  worktreePath,
  tempRoot,
  registrationState,
  hooksPath,
) {
  return cleanupOwnedResources({
    worktreePath,
    tempRoot,
    registrationState,
    removeWorktree: () =>
      runGit(repoRoot, ['worktree', 'remove', '--force', worktreePath], {
        hooksPath,
        label: `Remove owned Git worktree ${worktreePath}`,
      }),
    hasRegistration: () => registrationExists(repoRoot, worktreePath),
    removeTemp: () => removeTempRoot(tempRoot),
  })
}

function throwCollectedErrors(errors) {
  if (errors.length === 0) return
  throw new Error(errors.map(errorMessage).join('\n'))
}

async function packageLocalPreview(selection) {
  const selectedInput = parseSelection(selection)
  const repoRoot = resolveRepositoryRoot()
  const head = stdoutBuffer(
    runGit(repoRoot, ['rev-parse', '--verify', 'HEAD^{commit}']),
  )
    .toString('utf8')
    .trim()
  const shortHead = stdoutBuffer(
    runGit(repoRoot, ['rev-parse', '--short=7', head]),
  )
    .toString('utf8')
    .trim()
  const dependencies = validateDependencyPreflight(repoRoot)
  const artifactNames = captureIgnoredArtifactNames(repoRoot, (relativePath) =>
    isIgnored(repoRoot, relativePath),
  )
  const capturedState = capturePrimaryState(repoRoot, runGit, {
    knownHead: head,
    captureUntracked: selectedInput === INCLUDE_LOCAL_EDITS,
  })

  let tempRoot
  let hooksPath
  let worktreePath
  let registrationState = 'absent'
  let completedArtifact
  const errors = []
  try {
    tempRoot = mkdtempSync(path.join(tmpdir(), TEMP_PREFIX))
    hooksPath = path.join(tempRoot, 'empty-hooks')
    mkdirSync(hooksPath)
    worktreePath = path.join(tempRoot, 'worktree')
    try {
      runGit(repoRoot, ['worktree', 'add', '--detach', worktreePath, head], {
        hooksPath,
        label: 'Create detached preview worktree',
      })
      registrationState = 'registered'
    } catch (addError) {
      try {
        registrationState = registrationExists(repoRoot, worktreePath)
          ? 'registered'
          : 'absent'
      } catch (registrationError) {
        registrationState = 'unknown'
        throw new Error(
          `${errorMessage(addError)}\nCould not determine Git worktree registration for: ${worktreePath} (${errorMessage(registrationError)})`,
        )
      }
      throw addError
    }

    if (selectedInput === INCLUDE_LOCAL_EDITS) {
      applyPatch(worktreePath, capturedState.staged, true)
      applyPatch(worktreePath, capturedState.unstaged, false)
      materializeSelectedUntracked(
        worktreePath,
        capturedState.selectedUntracked,
      )
    }
    linkDependencies(worktreePath, dependencies)
    validateSelectedDependencyConsistency(worktreePath, runNpmList)

    const baseline = readSelectedBaseline(worktreePath)
    const artifact = derivePreviewArtifact(artifactNames, baseline, shortHead)
    const temporaryOutput = path.join(tempRoot, artifact.name)
    const primaryRelativeOutput = path.posix.join('artifacts', artifact.name)
    if (!isIgnored(repoRoot, primaryRelativeOutput, true)) {
      throw new Error(
        `Preview artifact output must be Git-ignored: ${primaryRelativeOutput}`,
      )
    }

    updateTemporaryVersion(worktreePath, artifact.version)
    packageTemporaryVsix(worktreePath, temporaryOutput)
    await validateVsix(temporaryOutput, {
      packageName: baseline.packageName,
      publisher: baseline.publisher,
      version: artifact.version,
      prerelease: true,
    })

    const artifactDirectory = validateArtifactsDirectory(repoRoot, true)
    completedArtifact = path.join(artifactDirectory.path, artifact.name)
    copyFileNoFollow(temporaryOutput, completedArtifact)
  } catch (error) {
    errors.push(error)
  } finally {
    errors.push(
      ...cleanup(
        repoRoot,
        worktreePath,
        tempRoot,
        registrationState,
        hooksPath,
      ),
    )
    try {
      assertPrimaryStateEqual(repoRoot, capturedState, runGit)
    } catch (error) {
      errors.push(error)
    }
  }

  throwCollectedErrors(errors)
  console.log(`Local preview VSIX ready: ${completedArtifact}`)
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1])

if (isDirectRun) {
  const selectedInput = process.argv[2]
  if (process.argv.length !== 3) {
    console.error(
      `Usage: package-local-preview.mjs "${COMMITTED_HEAD}|${INCLUDE_LOCAL_EDITS}"`,
    )
    process.exitCode = 1
  } else {
    try {
      await packageLocalPreview(selectedInput)
    } catch (error) {
      console.error(errorMessage(error))
      process.exitCode = 1
    }
  }
}
