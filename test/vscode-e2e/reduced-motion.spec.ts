import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

test('real webview honors reduced motion for CSS and scripted navigation', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  await workbox.emulateMedia({ reducedMotion: 'reduce' })
  const docPath = path.join(baseDir, 'reduced-motion.md')
  writeFileSync(docPath, '# Start\n\n[Jump](#target)\n\n## Target\n\nBody.\n')
  await evaluateInVSCode(
    async (vscode, args: [string]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [docPath] as [string],
  )
  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  await waitForE2EReadiness(
    frame,
    (state) =>
      state.routerReady && state.editorEpoch > 0 && state.mode === 'ir',
  )

  const reduced = await frame.locator('body').evaluate(() => {
    const heading = document.querySelector<HTMLElement>('h2')!
    heading.classList.add('heading-flash')
    const vendor = document.createElement('div')
    vendor.style.animation = 'slideInDown 1s ease'
    vendor.style.transition = 'opacity 2s ease'
    document.body.append(vendor)
    ;(window as any).__reducedMotionScrolls = []
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = function (
      options?: ScrollIntoViewOptions,
    ) {
      ;(window as any).__reducedMotionScrolls.push(options ?? {})
      return original.call(this, options)
    }
    return {
      preference: matchMedia('(prefers-reduced-motion: reduce)').matches,
      marker: heading.classList.contains('heading-flash'),
      animation: getComputedStyle(heading).animationName,
      vendorAnimation: getComputedStyle(vendor).animationName,
      transition: getComputedStyle(vendor).transitionDuration,
    }
  })
  expect(reduced).toEqual({
    preference: true,
    marker: true,
    animation: 'none',
    vendorAnimation: 'none',
    transition: '0s',
  })

  await frame.locator('body').evaluate(() => {
    const inner = (window as any).vditor.vditor
    inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    )
    document
      .querySelector('button[data-mode="wysiwyg"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(() => (window as any).vditor.vditor.currentMode),
    )
    .toBe('wysiwyg')
  await frame
    .locator('.vditor-wysiwyg a[href="#target"]')
    .click({ modifiers: ['Control'] })
  await expect
    .poll(() =>
      frame
        .locator('body')
        .evaluate(
          () => (window as any).__reducedMotionScrolls.at(-1)?.behavior,
        ),
    )
    .toBe('auto')
})
