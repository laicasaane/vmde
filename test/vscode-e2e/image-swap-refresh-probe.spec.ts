import fs from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { wf } from './webview-helpers'

// @probe — MEASUREMENT, not a regression net (user report 2026-08-12: an image replaced on disk
// in place kept showing the OLD bytes in the open editor). It measures what the rendered <img>
// reports after the file behind an unchanged path is swapped, in three escalating states:
//   1. nothing done (does anything invalidate on its own?)
//   2. the document re-renders (an edit forces Vditor to rebuild the block)
//   3. the img element is re-created from scratch with the SAME src
// naturalWidth is the signal: the two source images have different intrinsic sizes, so a stale
// paint and a fresh one are distinguishable without reading bytes.
const WORK = path.join(__dirname, 'tmp', 'image-swap-probe')
const DOC = path.join(WORK, 'doc.md')
const IMG = path.join(WORK, 'shot.png')
const SMALL = path.join(__dirname, '..', '..', 'media', 'logo.png')
const LARGE = path.join(__dirname, '..', '..', 'media', 'vmde.png')

test('image swapped on disk under an unchanged path @probe', async ({
  workbox,
  evaluateInVSCode,
}) => {
  fs.mkdirSync(WORK, { recursive: true })
  fs.copyFileSync(SMALL, IMG)
  fs.writeFileSync(DOC, `# Image swap probe\n\n![shot](shot.png)\n\ntail\n`)

  await evaluateInVSCode(
    async (vscode: typeof import('vscode'), args: string[]) => {
      await vscode.extensions.getExtension('Laicasaane.vmde')?.activate()
      await vscode.commands.executeCommand(
        'vscode.openWith',
        vscode.Uri.file(args[0]),
        'vmde.editor',
      )
    },
    [DOC] as [string],
  )

  const frame = wf(workbox)
  await frame.locator('.vditor-ir').first().waitFor({ timeout: 60_000 })
  const img = frame.locator('img[src*="shot.png"]').first()
  await img.waitFor({ timeout: 60_000 })

  const measure = () =>
    img.evaluate((el: HTMLImageElement) => ({
      naturalWidth: el.naturalWidth,
      src: el.currentSrc || el.src,
    }))

  await expect
    .poll(async () => (await measure()).naturalWidth)
    .toBeGreaterThan(0)
  const before = await measure()

  // Swap the bytes behind the SAME path — exactly what "I replaced the png in place" does.
  fs.copyFileSync(LARGE, IMG)

  // 1. Passive: give any watcher/invalidation a generous window. Fixed wait on purpose — this is a
  //    negative observation ("does anything refresh by itself?"), there is no condition to poll for.
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 3000)))
  const afterIdle = await measure()

  // 2. Force the document to re-render the block (type into the trailing paragraph).
  await frame.locator('.vditor-ir .vditor-reset').first().click()
  await workbox.keyboard.press('End')
  await workbox.keyboard.type(' x')
  await frame
    .locator('body')
    .evaluate(() => new Promise((r) => setTimeout(r, 2000)))
  const afterEdit = await measure()

  // 3. Re-create the element with the SAME src (no cache-busting query).
  const afterRecreate = await img.evaluate(async (el: HTMLImageElement) => {
    const fresh = new Image()
    fresh.src = el.src
    await new Promise((r) => {
      fresh.onload = r
      fresh.onerror = r
    })
    return { naturalWidth: fresh.naturalWidth, src: fresh.src }
  })

  // 4. Same bytes, cache-busted URL — proves the file on disk really did change.
  const afterBust = await img.evaluate(async (el: HTMLImageElement) => {
    const fresh = new Image()
    fresh.src = `${el.src}${el.src.includes('?') ? '&' : '?'}probe=${Date.now()}`
    await new Promise((r) => {
      fresh.onload = r
      fresh.onerror = r
    })
    return { naturalWidth: fresh.naturalWidth, src: fresh.src }
  })

  // 5. Candidate fix WITHOUT touching the src attribute: revalidate through the HTTP cache with
  //    fetch(cache:'reload'), then load the SAME url again.
  const afterFetchReload = await img.evaluate(async (el: HTMLImageElement) => {
    let fetchError = ''
    try {
      await fetch(el.src, { cache: 'reload' })
    } catch (e) {
      fetchError = String(e)
    }
    const fresh = new Image()
    fresh.src = el.src
    await new Promise((r) => {
      fresh.onload = r
      fresh.onerror = r
    })
    return { naturalWidth: fresh.naturalWidth, fetchError }
  })

  // 6. Does the EXISTING element pick the refreshed bytes up if we make it re-fetch the same url
  //    (attribute value unchanged, so nothing can leak into the serialized markdown)?
  const afterForceReload = await img.evaluate(async (el: HTMLImageElement) => {
    const src = el.getAttribute('src') || ''
    el.removeAttribute('src')
    el.setAttribute('src', src)
    await new Promise((r) => {
      if (el.complete) return r(null)
      el.onload = r
      el.onerror = r
    })
    return { naturalWidth: el.naturalWidth, attr: el.getAttribute('src') }
  })

  console.log(
    'IMAGE SWAP PROBE ' +
      JSON.stringify(
        {
          before: before.naturalWidth,
          afterIdle: afterIdle.naturalWidth,
          afterEdit: afterEdit.naturalWidth,
          afterRecreate: afterRecreate.naturalWidth,
          afterBust: afterBust.naturalWidth,
          afterFetchReload: afterFetchReload.naturalWidth,
          fetchError: afterFetchReload.fetchError,
          afterForceReload: afterForceReload.naturalWidth,
          attrAfterForceReload: afterForceReload.attr,
          src: before.src,
        },
        null,
        2,
      ),
  )
})
