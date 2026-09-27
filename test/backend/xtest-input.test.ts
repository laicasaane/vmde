import { beforeEach, describe, expect, it, vi } from 'vitest'

const { runFileMock } = vi.hoisted(() => ({ runFileMock: vi.fn() }))

vi.mock('node:child_process', () => ({ execFile: vi.fn() }))
vi.mock('node:util', () => ({ promisify: () => runFileMock }))

import { createXtestInput } from '../../test/vscode-e2e/helpers/xtest-input'

const DISPLAY = ':99'
const MAPPED_XID = '0x52'

function electronApp() {
  return {
    browserWindow: vi.fn().mockResolvedValue({
      evaluate: vi.fn(async (callback) =>
        callback({
          getNativeWindowHandle: () => Buffer.from([0x52, 0, 0, 0]),
          getTitle: () => 'VMDE XTEST fixture',
          isVisible: () => true,
          getContentBounds: () => ({ x: 10, y: 20, width: 800, height: 600 }),
        }),
      ),
    }),
  }
}

function configureX11({
  active = MAPPED_XID,
  focused = MAPPED_XID,
}: {
  active?: string | string[]
  focused?: string | string[]
} = {}) {
  const next = (value: string | string[]) => {
    const values = Array.isArray(value) ? value : [value]
    const fallback = values.at(-1) ?? MAPPED_XID
    return () => values.shift() ?? fallback
  }
  const nextActive = next(active)
  const nextFocused = next(focused)
  runFileMock.mockImplementation(async (_command, args) => {
    if (args[0] === '-display') return { stdout: 'XTEST\n', stderr: '' }
    if (args[0] === '-id') return { stdout: 'xwininfo', stderr: '' }
    if (args[0] === 'getwindowpid') return { stdout: '123', stderr: '' }
    if (args[0] === 'getactivewindow')
      return { stdout: nextActive(), stderr: '' }
    if (args[0] === 'getwindowfocus')
      return { stdout: nextFocused(), stderr: '' }
    return { stdout: '', stderr: '' }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('DISPLAY', DISPLAY)
})

describe('createXtestInput', () => {
  it('routes modifier clicks through XTEST in mapped client screen coordinates', async () => {
    configureX11()
    const page = { evaluate: vi.fn().mockResolvedValue(1) }
    const input = await createXtestInput(electronApp() as never, page as never)
    await input.clickWithModifier('Control_L', { x: 30, y: 40 })
    expect(runFileMock.mock.calls.slice(-4).map(([, args]) => args)).toEqual([
      ['mousemove', '--sync', '40', '60'],
      ['keydown', '--', 'Control_L'],
      ['click', '1'],
      ['keyup', '--', 'Control_L'],
    ])
  })

  it('releases the held modifier even when the XTEST click fails', async () => {
    configureX11()
    const original = runFileMock.getMockImplementation()!
    runFileMock.mockImplementation(async (...args) => {
      if (args[1][0] === 'click') throw new Error('injected click failure')
      return original(...args)
    })
    const page = { evaluate: vi.fn().mockResolvedValue(1) }
    const input = await createXtestInput(electronApp() as never, page as never)
    await expect(
      input.clickWithModifier('Control_L', { x: 30, y: 40 }),
    ).rejects.toThrow('injected click failure')
    expect(runFileMock.mock.calls.at(-1)![1]).toEqual([
      'keyup',
      '--',
      'Control_L',
    ])
  })

  it.each([
    [1, { x: -1, y: 40 }],
    [1, { x: 800, y: 40 }],
    [1, { x: Number.NaN, y: 40 }],
    [2, { x: 30, y: 40 }],
  ])(
    'refuses ambiguous or out-of-client modifier click coordinates (%s, %j)',
    async (scale, point) => {
      configureX11()
      const input = await createXtestInput(
        electronApp() as never,
        { evaluate: vi.fn().mockResolvedValue(scale) } as never,
      )
      await expect(input.clickWithModifier('Control_L', point)).rejects.toThrow(
        'requires an in-client point',
      )
      expect(runFileMock.mock.calls.map(([, args]) => args[0])).not.toContain(
        'keydown',
      )
    },
  )

  it('uses bounded focused-route xdotool input with an end-of-options separator', async () => {
    configureX11()
    const input = await createXtestInput(electronApp() as never, {} as never)

    await input.key('Escape')
    await input.type('--window')

    const invocations = runFileMock.mock.calls.map(
      ([, args]) => args as string[],
    )
    expect(invocations).toContainEqual([
      'key',
      '--clearmodifiers',
      '--',
      'Escape',
    ])
    expect(invocations).toContainEqual([
      'type',
      '--clearmodifiers',
      '--delay',
      '20',
      '--',
      '--window',
    ])
    expect(invocations.map(([command]) => command)).not.toContain(
      'windowactivate',
    )
    expect(invocations.map(([command]) => command)).not.toContain('windowfocus')
    expect(invocations.flat()).not.toContain('--window=')
    for (const [, , options] of runFileMock.mock.calls) {
      expect(options).toMatchObject({ timeout: 5_000, killSignal: 'SIGTERM' })
    }
  })

  it('reacquires and rechecks focus when the mapped workbox client is not focused', async () => {
    configureX11({
      active: ['0x53', MAPPED_XID],
      focused: ['83', '82'],
    })
    const input = await createXtestInput(electronApp() as never, {} as never)

    await input.key('Escape')

    const invocations = runFileMock.mock.calls.map(
      ([, args]) => args as string[],
    )
    expect(invocations).toContainEqual(['windowactivate', '--sync', MAPPED_XID])
    expect(invocations).toContainEqual(['windowfocus', '--sync', MAPPED_XID])
    expect(invocations).toContainEqual([
      'key',
      '--clearmodifiers',
      '--',
      'Escape',
    ])
  })

  it('rejects a focused window with the same Electron PID but a different XID', async () => {
    configureX11({ active: '0x53', focused: '83' })
    const input = await createXtestInput(electronApp() as never, {} as never)

    await expect(input.key('Escape')).rejects.toThrow(
      'do not equal workbox BrowserWindow',
    )

    expect(runFileMock.mock.calls.map(([, args]) => args[0])).not.toContain(
      'key',
    )
  })
})
