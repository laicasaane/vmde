import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { ElectronApplication, Page } from 'playwright-core'

const runFile = promisify(execFile)
const XDTOOL = '/usr/bin/xdotool'
const XDpyInfo = '/usr/bin/xdpyinfo'
const XWININFO = '/usr/bin/xwininfo'
const COMMAND_TIMEOUT_MS = 5_000

export interface XtestClient {
  display: string
  xid: string
  pid: number
  title: string
  visible: boolean
}

export interface XtestInput {
  client: XtestClient
  activateAndFocus(): Promise<void>
  key(keysym: string): Promise<void>
  type(text: string, delayMs?: number): Promise<void>
}

function x11Error(message: string): Error {
  return new Error(`[xtest-input] ${message}`)
}

async function run(command: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await runFile(command, args, {
      encoding: 'utf8',
      env: process.env,
      timeout: COMMAND_TIMEOUT_MS,
      killSignal: 'SIGTERM',
    })
    return stdout.trim()
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw x11Error(`${command} ${args.join(' ')} failed: ${detail}`)
  }
}

function xidFromOutput(value: string, command: string): string {
  const xid = value.trim()
  if (!/^0x[\da-f]+$/i.test(xid) && !/^\d+$/.test(xid)) {
    throw x11Error(
      `${command} returned an invalid XID: ${JSON.stringify(value)}`,
    )
  }
  const numeric = BigInt(xid)
  if (numeric === 0n) {
    throw x11Error(`${command} returned XID 0`)
  }
  return `0x${numeric.toString(16)}`
}

async function windowPid(xid: string): Promise<number> {
  const output = await run(XDTOOL, ['getwindowpid', xid])
  const pid = Number.parseInt(output, 10)
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw x11Error(
      `xdotool getwindowpid ${xid} returned ${JSON.stringify(output)}`,
    )
  }
  return pid
}

async function focusedWindowIds(): Promise<string[]> {
  const [active, focused] = await Promise.all([
    run(XDTOOL, ['getactivewindow']),
    run(XDTOOL, ['getwindowfocus']),
  ])
  return [
    xidFromOutput(active, 'xdotool getactivewindow'),
    xidFromOutput(focused, 'xdotool getwindowfocus'),
  ]
}

async function focusedWindowIsMappedClient(
  client: XtestClient,
): Promise<boolean> {
  const ids = await focusedWindowIds()
  return ids.every((xid) => xid === client.xid)
}

async function assertMappedClientFocus(client: XtestClient): Promise<void> {
  const ids = await focusedWindowIds()
  if (ids.some((xid) => xid !== client.xid)) {
    throw x11Error(
      `focused clients (${ids.join(', ')}) do not equal workbox BrowserWindow ${client.xid}`,
    )
  }
}

/**
 * Creates an XTEST route for the Electron BrowserWindow that owns `workbox`.
 *
 * `key()` and `type()` deliberately omit xdotool's `--window`: after verifying and activating the
 * mapped X11 client, they use xdotool's focused-input path rather than its targeted send-event route.
 */
export async function createXtestInput(
  electronApp: ElectronApplication,
  workbox: Page,
): Promise<XtestInput> {
  if (process.platform !== 'linux') {
    throw x11Error('XTEST input is supported only on Linux X11 test hosts')
  }
  const display = process.env.DISPLAY
  if (!display)
    throw x11Error('DISPLAY is required; start the test in the Xvfb shell')

  const extensions = await run(XDpyInfo, [
    '-display',
    display,
    '-queryExtensions',
  ])
  if (!/\bXTEST\b/.test(extensions)) {
    throw x11Error(`XTEST is unavailable on DISPLAY=${display}`)
  }

  // browserWindow(workbox) prevents selecting an arbitrary Electron window when VS Code has more
  // than one top-level client. Linux returns the native X11 Window ID in the first 32 bits.
  const nativeWindow = await electronApp.browserWindow(workbox)
  const mapped = await nativeWindow.evaluate((window) => {
    const handle = window.getNativeWindowHandle()
    if (handle.length < 4)
      throw new Error('native window handle is shorter than an XID')
    const xid = handle.readUInt32LE(0)
    if (xid === 0) throw new Error('native window handle contains XID 0')
    return {
      xid: `0x${xid.toString(16)}`,
      title: window.getTitle(),
      visible: window.isVisible(),
    }
  })
  const xid = xidFromOutput(mapped.xid, 'BrowserWindow.getNativeWindowHandle')

  // Both tools inherit this test process's DISPLAY. xwininfo proves the mapped native handle is a
  // client on that display; xdotool then proves it resolves to a live process before any key is sent.
  await run(XWININFO, ['-display', display, '-id', xid])
  const client: XtestClient = {
    display,
    xid,
    pid: await windowPid(xid),
    title: mapped.title,
    visible: mapped.visible,
  }

  const activateAndFocus = async () => {
    // Preserve the currently focused Electron child when it already belongs to this exact workbox
    // client. Re-focusing on every synthetic key can steal the toolbar/menu focus under test.
    if (await focusedWindowIsMappedClient(client)) return
    await run(XDTOOL, ['windowactivate', '--sync', client.xid])
    await run(XDTOOL, ['windowfocus', '--sync', client.xid])
    await assertMappedClientFocus(client)
  }

  return {
    client,
    activateAndFocus,
    key: async (keysym) => {
      await activateAndFocus()
      await run(XDTOOL, ['key', '--clearmodifiers', '--', keysym])
    },
    type: async (text, delayMs = 20) => {
      if (!Number.isSafeInteger(delayMs) || delayMs < 0) {
        throw x11Error(
          `type delay must be a non-negative integer, got ${delayMs}`,
        )
      }
      await activateAndFocus()
      await run(XDTOOL, [
        'type',
        '--clearmodifiers',
        '--delay',
        String(delayMs),
        '--',
        text,
      ])
    },
  }
}
