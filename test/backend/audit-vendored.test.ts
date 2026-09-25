import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  collectVendorComponents,
  queryOsv,
  summarizeOsvFindings,
} from '../../scripts/audit-vendored.mjs'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'vmde-vendor-audit-test-'))
  temps.push(root)
  return root
}

function writeSource(root: string, dir: string, value: unknown): void {
  mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(
    path.join(root, dir, 'source.json'),
    `${JSON.stringify(value)}\n`,
  )
}

describe('collectVendorComponents', () => {
  it('accepts repository vendor metadata and reports emoji assets as unscannable', async () => {
    const root = fileURLToPath(
      new URL('../../media-src/vendor', import.meta.url),
    )
    const { components, unscannable } = await collectVendorComponents(root)

    expect(components.length).toBeGreaterThan(0)
    expect(unscannable).toContainEqual(
      expect.objectContaining({ source: 'emoji' }),
    )
  })

  it('collects composites, de-duplicates exact coordinates, and retains source dirs', async () => {
    const root = fixtureRoot()
    writeSource(root, 'alpha', {
      components: [
        { ecosystem: 'npm', name: 'shared', version: '1.2.3' },
        { ecosystem: 'npm', name: 'alpha-only', version: '4.5.6' },
      ],
    })
    writeSource(root, 'beta', {
      components: [{ ecosystem: 'npm', name: 'shared', version: '1.2.3' }],
    })
    writeSource(root, 'commit-only', {
      advisoryAudit: {
        kind: 'unscannable',
        reason: 'commit pin has no package-version coordinate',
        reviewedAt: '2026-08-28',
      },
    })

    await expect(collectVendorComponents(root)).resolves.toEqual({
      components: [
        {
          ecosystem: 'npm',
          name: 'alpha-only',
          version: '4.5.6',
          sources: ['alpha'],
        },
        {
          ecosystem: 'npm',
          name: 'shared',
          version: '1.2.3',
          sources: ['alpha', 'beta'],
        },
      ],
      unscannable: [
        {
          source: 'commit-only',
          reason: 'commit pin has no package-version coordinate',
          reviewedAt: '2026-08-28',
        },
      ],
    })
  })

  it.each([
    ['missing decision', {}],
    [
      'range version',
      { components: [{ ecosystem: 'npm', name: 'pkg', version: '^1.2.3' }] },
    ],
    [
      'unsupported ecosystem',
      { components: [{ ecosystem: 'PyPI', name: 'pkg', version: '1.2.3' }] },
    ],
    [
      'malformed review date',
      {
        advisoryAudit: {
          kind: 'unscannable',
          reason: 'no coordinate',
          reviewedAt: 'today',
        },
      },
    ],
  ])('rejects %s metadata', async (_label, metadata) => {
    const root = fixtureRoot()
    writeSource(root, 'broken', metadata)
    await expect(collectVendorComponents(root)).rejects.toThrow(/broken/)
  })
})

describe('queryOsv', () => {
  const components = [
    {
      ecosystem: 'npm',
      name: 'one',
      version: '1.0.0',
      sources: ['alpha'],
    },
    {
      ecosystem: 'Go',
      name: 'example.test/two',
      version: 'v2.0.0',
      sources: ['beta'],
    },
  ]

  it('sends one exact-version query batch', async () => {
    let seenUrl = ''
    let seenBody = ''
    const result = await queryOsv(components, async (url, init) => {
      seenUrl = String(url)
      seenBody = String(init?.body)
      return { ok: true, json: async () => ({ results: [{}, {}] }) } as Response
    })
    expect(seenUrl).toBe('https://api.osv.dev/v1/querybatch')
    expect(JSON.parse(seenBody)).toEqual({
      queries: [
        { package: { ecosystem: 'npm', name: 'one' }, version: '1.0.0' },
        {
          package: { ecosystem: 'Go', name: 'example.test/two' },
          version: 'v2.0.0',
        },
      ],
    })
    expect(result).toEqual({ results: [{}, {}] })
  })

  it('surfaces network status failures', async () => {
    await expect(
      queryOsv(
        components,
        async () => ({ ok: false, status: 503 }) as Response,
      ),
    ).rejects.toThrow('OSV query failed: 503')
  })

  it('maps non-empty vulnerability results back to exact components and sources', () => {
    expect(
      summarizeOsvFindings(components, {
        results: [{ vulns: [{ id: 'OSV-ONE', summary: 'affected' }] }, {}],
      }),
    ).toEqual([
      {
        ecosystem: 'npm',
        name: 'one',
        version: '1.0.0',
        sources: ['alpha'],
        vulnerabilities: [{ id: 'OSV-ONE', summary: 'affected' }],
      },
    ])
  })
})
