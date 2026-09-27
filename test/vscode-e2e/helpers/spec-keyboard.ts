import type { ElectronApplication, Page } from 'playwright-core'
import { createXtestInput } from './xtest-input'

// Keep these older regression specs runnable as browser-input diagnostics in the
// default suite. Task 578 acceptance sets VMDE_XTEST=1: setup failure then throws,
// and every key/type goes through the verified X11 client with no fallback.
const DIAGNOSTIC_KEYS = {
  Escape: 'Escape',
  Return: 'Enter',
  End: 'End',
  Down: 'ArrowDown',
  Up: 'ArrowUp',
  'shift+Right': 'Shift+ArrowRight',
  'ctrl+z': 'Control+z',
  'ctrl+y': 'Control+y',
  'ctrl+a': 'Control+a',
  'ctrl+Return': 'Control+Enter',
} as const

export async function createSpecKeyboard(
  electronApp: ElectronApplication,
  workbox: Page,
) {
  if (process.env.VMDE_XTEST === '1') {
    const input = await createXtestInput(electronApp, workbox)
    await input.activateAndFocus()
    const { display, xid, pid, visible } = input.client
    console.log(
      '[keyboard XTEST]',
      JSON.stringify({ display, xid, pid, visible }),
    )
    return input
  }
  console.log('[keyboard diagnostic] browser protocol; not OS-input evidence')
  return {
    key: async (key: keyof typeof DIAGNOSTIC_KEYS) => {
      const mapped = DIAGNOSTIC_KEYS[key]
      if (!mapped) throw new Error(`Unsupported diagnostic key: ${key}`)
      await workbox.keyboard.press(mapped)
    },
    type: async (text: string, delayMs = 20) => {
      await workbox.keyboard.type(text, { delay: delayMs })
    },
    clickWithModifier: async (
      keysym: string,
      point: { x: number; y: number },
    ) => {
      if (keysym !== 'Control_L')
        throw new Error(`Unsupported diagnostic click modifier: ${keysym}`)
      await workbox.keyboard.down('Control')
      try {
        await workbox.mouse.click(point.x, point.y)
      } finally {
        await workbox.keyboard.up('Control')
      }
    },
  }
}

export type SpecKeyboard = Awaited<ReturnType<typeof createSpecKeyboard>>
