import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '../..')
const PIPELINES = '.azure/pipelines'
const GITHUB_WORKFLOW_HASHES = {
  'ci.yml': '9b441eb425cc25ed3170952ae4db4471c7fc3c23009e01337cd7ed9c7259ddcc',
  'nightly.yml':
    'b82c6ef674793197f16701baadbeda6fbf5063c9240a05a5ceb874b09149d499',
  'publish.yml':
    '25cfaf5357b57e298adc09963e2630e296f6940b8193498d87abc0a0bb3e44e7',
  'pr-webview-smoke.yml':
    'd01b5f6d72fc6a73aca6aa963b46a7adf74ae277bf3d7597da74a1349bbc3bed',
  'release.yml':
    'af57e8d2f0dbab186a024ce2a18bbe50a62bce128c92128096a14af1437d772f',
}

const read = (path: string) => readFileSync(resolve(ROOT, path), 'utf8')
const pipeline = (name: string) => {
  const source = read(`${PIPELINES}/${name}`)
  return { source, yaml: parse(source) as Record<string, unknown> }
}
type Step = Record<string, unknown>
type Job = Record<string, unknown> & { steps: Step[] }
const fixtures: string[] = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true })
  }
})

const jobs = (yaml: Record<string, unknown>) => yaml.jobs as Job[]
const steps = (yaml: Record<string, unknown>) => jobs(yaml)[0].steps
const allSteps = (yaml: Record<string, unknown>) =>
  jobs(yaml).flatMap((job) => job.steps)
const namedJob = (yaml: Record<string, unknown>, name: string) => {
  const job = jobs(yaml).find((candidate) => candidate.job === name)
  expect(job, `missing job: ${name}`).toBeDefined()
  return job as Job
}
const namedStep = (yaml: Record<string, unknown>, displayName: string) => {
  const step = steps(yaml).find(
    (candidate) => candidate.displayName === displayName,
  )
  expect(step, `missing step: ${displayName}`).toBeDefined()
  return step as Step
}
const scriptOf = (step: Step) => {
  expect(typeof step.script).toBe('string')
  return step.script as string
}
const inlineScriptOf = (step: Step) => {
  const inputs = step.inputs as Record<string, unknown> | undefined
  expect(typeof inputs?.inlineScript).toBe('string')
  return inputs?.inlineScript as string
}
const scriptStep = (yaml: Record<string, unknown>, displayName: string) =>
  scriptOf(namedStep(yaml, displayName))
const ordered = (yaml: Record<string, unknown>, displayNames: string[]) => {
  const indexes = displayNames.map((displayName) =>
    steps(yaml).findIndex((step) => step.displayName === displayName),
  )
  expect(indexes).not.toContain(-1)
  expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
}
const excludesAll = (filters: unknown) =>
  (filters as { exclude?: string[] } | undefined)?.exclude?.includes('*') ??
  false

describe('Azure Marketplace pipeline contracts', () => {
  it('keeps exactly the two approved Azure entrypoints', () => {
    expect(readdirSync(resolve(ROOT, PIPELINES)).sort()).toEqual([
      'preview.yml',
      'release.yml',
    ])
  })

  it.each(['preview.yml', 'release.yml'])(
    'runs %s on the U2602 agent pool',
    (name) => {
      expect(pipeline(name).yaml.pool).toEqual({ name: 'U2602' })
    },
  )

  it('runs preview only for pushes to main', () => {
    const { yaml } = pipeline('preview.yml')
    expect(yaml.trigger).toEqual({ branches: { include: ['main'] } })
    expect(yaml.pr).toBe('none')
  })

  it('runs production only for broadly matched tags, never branches', () => {
    const { yaml } = pipeline('release.yml')
    expect(yaml.trigger).toEqual({
      branches: { exclude: ['*'] },
      tags: { include: ['*'] },
    })
    expect(yaml.pr).toBe('none')
  })

  it('keeps preview branch-only and production tag-only trigger domains disjoint', () => {
    const preview = pipeline('preview.yml').yaml.trigger as Record<
      string,
      unknown
    >
    const release = pipeline('release.yml').yaml.trigger as Record<
      string,
      unknown
    >

    expect(preview.tags).toBeUndefined()
    expect(excludesAll(release.branches)).toBe(true)
    expect({
      preview: {
        branches: !excludesAll(preview.branches),
        tags: preview.tags !== undefined,
      },
      release: {
        branches: !excludesAll(release.branches),
        tags: !excludesAll(release.tags),
      },
    }).toEqual({
      preview: { branches: true, tags: false },
      release: { branches: false, tags: true },
    })
  })

  it.each(['preview.yml', 'release.yml'])(
    'uses Node 24, enforces reviewed install scripts, and avoids duplicate install audits in %s',
    (name) => {
      const { yaml } = pipeline(name)
      expect(steps(yaml)).toContainEqual(
        expect.objectContaining({
          task: 'UseNode@1',
          inputs: { version: '24.x' },
        }),
      )
      expect(scriptStep(yaml, 'Install root dependencies')).toBe(
        'npm ci --strict-allow-scripts --no-audit --no-fund',
      )
      expect(scriptStep(yaml, 'Install webview dependencies')).toBe(
        'npm --prefix media-src ci --strict-allow-scripts --no-audit --no-fund',
      )
      expect(scriptStep(yaml, 'Audit host dependencies')).toBe(
        'npm run audit:host',
      )
      expect(scriptStep(yaml, 'Audit webview dependencies')).toBe(
        'npm run audit:webview',
      )
      expect(scriptStep(yaml, 'Audit vendored runtimes')).toBe(
        'npm run audit:vendor',
      )
      expect(steps(yaml).some((step) => step.script === 'npm run audit')).toBe(
        false,
      )
      expect(scriptStep(yaml, 'Audit D2 Go call graph')).toBe(
        'npm run audit:d2-go',
      )
      expect(scriptStep(yaml, 'Run unit tests')).toBe('npm test')
    },
  )

  it('guards the preview branch and uses a shell version before Azure exposes it to later steps', () => {
    const { yaml } = pipeline('preview.yml')
    const branchStep = namedStep(yaml, 'Validate preview branch')
    expect(branchStep.env).toEqual({
      BUILD_SOURCEBRANCH: '$(Build.SourceBranch)',
    })
    expect(scriptOf(branchStep)).toContain(
      'if [ "${BUILD_SOURCEBRANCH}" != "refs/heads/main" ]; then',
    )
    const deriveStep = namedStep(yaml, 'Derive disposable preview version')
    expect(deriveStep.env).toEqual({ BUILD_BUILDID: '$(Build.BuildId)' })
    const derive = scriptOf(deriveStep)
    expect(derive).toContain(
      'preview_version="$(node scripts/version-contract.mjs preview package.json package-lock.json "${BUILD_BUILDID}")"',
    )
    expect(derive).toContain(
      'echo "##vso[task.setvariable variable=VMDE_VERSION;isReadOnly=true]${preview_version}"',
    )
    expect(derive).toContain(
      'npm version "$preview_version" --no-git-tag-version --ignore-scripts',
    )
    expect(derive).not.toContain('npm version "$(vmdeVersion)"')
  })

  it('validates exact production tags and main reachability before installation', () => {
    const { yaml } = pipeline('release.yml')
    const validationStep = namedStep(
      yaml,
      'Validate production tag and main reachability',
    )
    const releaseValidation = scriptOf(validationStep)
    expect(validationStep.env).toEqual({
      BUILD_SOURCEBRANCH: '$(Build.SourceBranch)',
      BUILD_SOURCEVERSION: '$(Build.SourceVersion)',
      SYSTEM_ACCESSTOKEN: '$(System.AccessToken)',
    })
    expect(releaseValidation).toContain(
      'tag="${BUILD_SOURCEBRANCH#refs/tags/}"',
    )
    expect(releaseValidation).toContain(
      'node scripts/version-contract.mjs release "${tag}" package.json package-lock.json --azure',
    )
    expect(releaseValidation).toContain(
      'git -c http.extraheader="AUTHORIZATION: bearer ${SYSTEM_ACCESSTOKEN}" fetch origin +refs/heads/main:refs/remotes/origin/main',
    )
    expect(releaseValidation).toContain(
      'git merge-base --is-ancestor "${BUILD_SOURCEVERSION}" "refs/remotes/origin/main"',
    )
    expect(releaseValidation).toContain('[ -n "${SYSTEM_ACCESSTOKEN}" ]')
    expect(steps(yaml)[0]).toEqual(
      expect.objectContaining({
        checkout: 'self',
        fetchDepth: 0,
        fetchTags: true,
        persistCredentials: false,
      }),
    )
  })

  it.skipIf(process.platform === 'win32')(
    'passes a hostile valid Git tag as literal argv without executing it as Bash',
    () => {
      const { yaml } = pipeline('release.yml')
      const source = scriptStep(
        yaml,
        'Validate production tag and main reachability',
      )
      const azureExpanded = source.replaceAll(
        '$(Build.SourceBranchName)',
        '$(id)',
      )
      const fixture = mkdtempSync(resolve(tmpdir(), 'vmde-azure-hostile-tag-'))
      fixtures.push(fixture)
      const bin = resolve(fixture, 'bin')
      const marker = resolve(fixture, 'id-ran')
      const argsFile = resolve(fixture, 'node-args')
      expect(
        spawnSync('git', ['check-ref-format', 'refs/tags/$(id)']).status,
      ).toBe(0)
      mkdirSync(bin)
      writeFileSync(
        resolve(bin, 'id'),
        '#!/bin/sh\nprintf invoked > "$VMDE_ID_MARKER"\nprintf injected-tag\n',
        { mode: 0o755 },
      )
      writeFileSync(
        resolve(bin, 'node'),
        '#!/bin/sh\nprintf "%s\\0" "$@" > "$VMDE_NODE_ARGS"\nexit 79\n',
        { mode: 0o755 },
      )

      const result = spawnSync('bash', ['-c', azureExpanded], {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          BUILD_SOURCEBRANCH: 'refs/tags/$(id)',
          BUILD_SOURCEVERSION: '0123456789abcdef',
          SYSTEM_ACCESSTOKEN: 'not-a-real-token',
          VMDE_ID_MARKER: marker,
          VMDE_NODE_ARGS: argsFile,
        },
      })

      expect(result.status).toBe(79)
      expect(existsSync(marker)).toBe(false)
      expect(readFileSync(argsFile).toString('utf8').split('\0')).toEqual([
        'scripts/version-contract.mjs',
        'release',
        '$(id)',
        'package.json',
        'package-lock.json',
        '--azure',
        '',
      ])
    },
  )

  it.each(['preview.yml', 'release.yml'])(
    'keeps Azure macro interpolation out of Bash source in %s',
    (name) => {
      const { yaml } = pipeline(name)
      for (const step of allSteps(yaml)) {
        if (typeof step.script !== 'string') continue
        expect(step.script).not.toMatch(/\$\((?:Build|System|VMDE)[^)]*\)/)
      }
    },
  )

  it('scopes the repository and log archive access tokens to their steps', () => {
    const { yaml } = pipeline('release.yml')
    const validation = namedStep(
      yaml,
      'Validate production tag and main reachability',
    )
    const archiveJob = namedJob(yaml, 'archive_logs')
    const archive = archiveJob.steps.find(
      (step) => step.displayName === 'Archive Azure DevOps run logs',
    ) as Step
    const tokenSteps = allSteps(yaml).filter(
      (step) =>
        (step.env as Record<string, unknown> | undefined)
          ?.SYSTEM_ACCESSTOKEN !== undefined,
    )
    expect(tokenSteps).toEqual([validation, archive])
    expect(scriptOf(validation)).not.toContain('echo "${SYSTEM_ACCESSTOKEN}')
    for (const step of allSteps(yaml)) {
      if (step === validation || step === archive) continue
      expect(JSON.stringify(step)).not.toContain('System.AccessToken')
      expect(JSON.stringify(step)).not.toContain('SYSTEM_ACCESSTOKEN')
      expect(JSON.stringify(step)).not.toContain('http.extraheader')
    }
  })

  it.each(['preview.yml', 'release.yml'])(
    'archives %s logs in an always-running dependent job',
    (name) => {
      const { yaml } = pipeline(name)
      const mainJobName = name === 'preview.yml' ? 'preview' : 'release'
      const archiveJob = namedJob(yaml, 'archive_logs')
      const archive = archiveJob.steps.find(
        (step) => step.displayName === 'Archive Azure DevOps run logs',
      ) as Step
      const script = scriptOf(archive)

      expect(jobs(yaml)).toHaveLength(2)
      expect(archiveJob.dependsOn).toBe(mainJobName)
      expect(archiveJob.condition).toBe('always()')
      expect(archiveJob.steps[0]).toEqual({ checkout: 'none' })
      expect(steps(yaml)).not.toContain(archive)
      expect(archive.env).toEqual({
        SYSTEM_ACCESSTOKEN: '$(System.AccessToken)',
        SYSTEM_COLLECTIONURI: '$(System.CollectionUri)',
        SYSTEM_TEAMPROJECT: '$(System.TeamProject)',
        SYSTEM_TEAMPROJECTID: '$(System.TeamProjectId)',
        BUILD_DEFINITIONNAME: '$(Build.DefinitionName)',
        BUILD_BUILDID: '$(Build.BuildId)',
      })
      expect(script).toContain('set -euo pipefail')
      expect(script).toContain(
        'destination="${HOME}/Azure/Logs/${SYSTEM_TEAMPROJECT}/${BUILD_DEFINITIONNAME}/${BUILD_BUILDID}"',
      )
      expect(script).toContain('mkdir -p "$destination"')
      expect(script).toContain('curl --fail --silent --show-error --location')
      expect(script).toContain(
        '--header "Authorization: Bearer ${SYSTEM_ACCESSTOKEN}"',
      )
      expect(script).toContain('--header "Accept: application/zip"')
      expect(script).toContain('--output "${destination}/logs.zip"')
      expect(script).toContain(
        '"${SYSTEM_COLLECTIONURI}${SYSTEM_TEAMPROJECTID}/_apis/build/builds/${BUILD_BUILDID}/logs?api-version=7.1"',
      )
      expect(script).not.toMatch(/echo.*SYSTEM_ACCESSTOKEN/)
    },
  )

  it.each([
    ['preview.yml', 'artifacts/vmde-$(VMDE_VERSION)-preview.vsix', true],
    ['release.yml', 'artifacts/vmde-$(VMDE_VERSION).vsix', false],
  ])(
    'packages %s exactly once, verifies its archive, and reuses the same VSIX path',
    (name, vsixPath, prerelease) => {
      const { yaml } = pipeline(name)
      const packageName = prerelease
        ? 'Package prerelease VSIX'
        : 'Package production VSIX'
      const verifyName = prerelease
        ? 'Verify prerelease archive metadata'
        : 'Verify production archive metadata'
      const packageScript = scriptStep(yaml, packageName)
      const verifyScript = scriptStep(yaml, verifyName)
      const artifactStep = namedStep(
        yaml,
        prerelease
          ? 'Publish preview VSIX artifact'
          : 'Publish production VSIX artifact',
      )
      const publishStep = namedStep(
        yaml,
        prerelease
          ? 'Publish preview VSIX to Marketplace'
          : 'Publish production VSIX to Marketplace',
      )
      const publishScript = inlineScriptOf(publishStep)
      const publishCommand = publishScript
        .replace(/\\\n\s*/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

      expect(packageScript.match(/npm run package:vsix/g)).toHaveLength(1)
      expect(packageScript).toContain(
        `VSIX="artifacts/vmde-\${VMDE_VERSION}${prerelease ? '-preview' : ''}.vsix"`,
      )
      expect(packageScript).toContain('--out "$VSIX"')
      expect(verifyScript).toContain('unzip -p "$VSIX" extension/package.json')
      expect(verifyScript).toContain('unzip -p "$VSIX" extension.vsixmanifest')
      expect(verifyScript).toContain('grep -Fq "Version=\\"${VMDE_VERSION}\\""')
      expect(artifactStep.inputs).toEqual(
        expect.objectContaining({ targetPath: vsixPath }),
      )
      expect(publishStep.task).toBe('AzureCLI@2')
      expect(publishStep.inputs).toEqual(
        expect.objectContaining({
          azureSubscription: 'Visual Studio Marketplace',
          scriptType: 'bash',
          scriptLocation: 'inlineScript',
        }),
      )
      expect(publishCommand).toContain(
        'npx @vscode/vsce publish --azure-credential --packagePath "$VSIX"',
      )
      expect(publishCommand).not.toContain('./node_modules/.bin/vsce')
      expect(publishCommand).not.toMatch(/(?:^|\s)--pat(?:\s|$)/)
      expect(publishCommand).not.toMatch(/(?:^|\s)-p(?:\s|$)/)
      if (prerelease) {
        expect(verifyScript).toContain(
          'Microsoft.VisualStudio.Code.PreRelease.*Value="true"',
        )
        expect(publishCommand).toContain(
          'npx @vscode/vsce publish --azure-credential --packagePath "$VSIX" --pre-release',
        )
      } else {
        expect(verifyScript).toContain(
          'if unzip -p "$VSIX" extension.vsixmanifest | grep -q',
        )
        expect(publishCommand).not.toContain('--pre-release')
      }
    },
  )

  it.each(['preview.yml', 'release.yml'])(
    'authenticates only the final Marketplace publish task through Entra federation in %s',
    (name) => {
      const { source, yaml } = pipeline(name)
      const publishingSteps = steps(yaml).filter((step) =>
        String(
          (step.inputs as Record<string, unknown> | undefined)?.inlineScript ??
            step.script ??
            '',
        ).includes('@vscode/vsce publish'),
      )
      expect(publishingSteps).toHaveLength(1)
      expect(publishingSteps[0]).toEqual(
        expect.objectContaining({
          task: 'AzureCLI@2',
          inputs: expect.objectContaining({
            azureSubscription: 'Visual Studio Marketplace',
            scriptType: 'bash',
            scriptLocation: 'inlineScript',
          }),
        }),
      )
      expect(publishingSteps[0].env).toBeUndefined()
      expect(source).not.toContain('VSCE_PAT')
      expect(source).not.toContain('AZURE_DEVOPS_EXT_PAT')
      expect(source).not.toMatch(/\bvsce\s+login\b/)
      expect(
        steps(yaml).some((step) =>
          String(
            (step.inputs as Record<string, unknown> | undefined)
              ?.inlineScript ??
              step.script ??
              '',
          ).includes('--skip-duplicate'),
        ),
      ).toBe(false)
    },
  )

  it('orders preview validation through Marketplace publication', () => {
    const { yaml } = pipeline('preview.yml')
    ordered(yaml, [
      'Validate preview branch',
      'Install root dependencies',
      'Install webview dependencies',
      'Audit host dependencies',
      'Audit webview dependencies',
      'Audit vendored runtimes',
      'Audit D2 Go call graph',
      'Run unit tests',
      'Derive disposable preview version',
      'Package prerelease VSIX',
      'Verify prerelease archive metadata',
      'Publish preview VSIX artifact',
      'Publish preview VSIX to Marketplace',
    ])
  })

  it('orders production validation through Marketplace publication', () => {
    const { yaml } = pipeline('release.yml')
    ordered(yaml, [
      'Validate production tag and main reachability',
      'Install root dependencies',
      'Install webview dependencies',
      'Audit host dependencies',
      'Audit webview dependencies',
      'Audit vendored runtimes',
      'Audit D2 Go call graph',
      'Run unit tests',
      'Package production VSIX',
      'Verify production archive metadata',
      'Publish production VSIX artifact',
      'Publish production VSIX to Marketplace',
    ])
  })

  it('leaves every current GitHub workflow byte-identical to HEAD', () => {
    for (const [name, expectedHash] of Object.entries(GITHUB_WORKFLOW_HASHES)) {
      const actualHash = createHash('sha256')
        .update(read(`.github/workflows/${name}`))
        .digest('hex')
      expect(actualHash).toBe(expectedHash)
    }
  })
})
