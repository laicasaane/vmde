import type { Disposables } from '../util/disposables'
import { installToolbarCollapse } from '../chrome/toolbar-collapse'
import { ensureToolbarRows } from '../chrome/toolbar-layout'
import { installToolbarOverflow } from '../chrome/toolbar-overflow'
import { guardToolbarScroll } from '../chrome/toolbar-scroll-guard'
import {
  installEscapeToolbar,
  refreshToolbarRoving,
} from '../editing/escape-toolbar'
import { innerVditor } from '../util/inner-vditor'

// Task 661: toolbars that already have their rows and flow, so a second caller (a streamed open
// calls this at mount and `runFinishInit` calls it again at the end of the stream) does nothing.
const installed = new WeakSet<HTMLElement>()

/**
 * Build the stable two-row toolbar, apply the stored collapse state and start the overflow flow.
 * It runs in the same task as the toolbar's construction on every open path, so the first painted
 * frame of the live toolbar is already flowed (a streamed document removes its overlay at the first
 * chunk, long before `runFinishInit`). With no toolbar only the Escape-to-toolbar handler is set.
 */
export function installToolbarFlow(observers: Disposables): void {
  const toolbarEl = innerVditor()?.toolbar?.element
  if (!toolbarEl) {
    observers.set('escape-toolbar', installEscapeToolbar())
    return
  }
  if (installed.has(toolbarEl)) return
  installed.add(toolbarEl)
  ensureToolbarRows(toolbarEl)
  guardToolbarScroll(window.vditor, toolbarEl)
  observers.set('escape-toolbar', installEscapeToolbar())
  // The roving list and overflow controller both inspect direct row children; the two-row DOM
  // above is built before either attaches, so an initial paint cannot expose a flat toolbar.
  refreshToolbarRoving(toolbarEl)
  // Task 631: the collapse toggle applies the stored state before the overflow controller measures.
  observers.set('toolbar-collapse', installToolbarCollapse(toolbarEl))
  observers.set(
    'toolbar-overflow',
    installToolbarOverflow(toolbarEl, refreshToolbarRoving),
  )
}
