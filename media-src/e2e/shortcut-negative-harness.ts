// Task 580 CP2-14 — the negative shortcut sweep runs the REAL webview entry (main.ts), built from
// source with the shipped Vditor patches, so every VMDE keydown handler and every patched Vditor
// chord is live exactly as in the product. The spec's `acquireVsCodeApi` stub answers `ready` with
// an `init` message (as prerender-harness.ts does). Nothing maps keys to commands until the spec
// calls `__installKeybindingShim`; the shim then posts each matched command's route to this window,
// as the host's `webview.postMessage` would.
import '../src/boot/main'
import type { PanelRoute } from '../../src/shared/editor-shortcuts'
import { installKeybindingShim, type ShimPlatform } from './keybinding-shim'

;(window as any).__installKeybindingShim = (
  commands: readonly string[],
  userKeys?: Readonly<Record<string, string>>,
): (() => void) => {
  const platform: ShimPlatform = navigator.platform
    .toLowerCase()
    .includes('mac')
    ? 'mac'
    : 'win-linux'
  return installKeybindingShim(window, {
    commands,
    userKeys,
    platform,
    dispatch: (route: PanelRoute) => window.postMessage(route, '*'),
  })
}
