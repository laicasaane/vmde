import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from 'vscode-test-playwright'
import { waitForE2EReadiness, wf } from './webview-helpers'

/** A previous case may leave its editor open; close everything so the frame locator addresses only this case's webview. */
async function closeAllEditors(
  evaluateInVSCode: (
    fn: (vscode: typeof import('vscode')) => Promise<void>,
  ) => Promise<unknown>,
): Promise<void> {
  await evaluateInVSCode(async (vscode) => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors')
  })
}

// Task 644 — same-document `#value` links reach HTML `id` targets (on `<a>` and on other
// elements), keep reaching legacy `<a name>` targets, and follow document order between a heading
// and an `id` target, in IR, WYSIWYG, Split (SV) and Preview.

const FILLER = Array.from(
  { length: 45 },
  (_, i) => `filler paragraph ${i}`,
).join('\n\n')

const DOC = [
  '# Start',
  '',
  '[go-alpha](#alpha-id)',
  '',
  '[go-span](#span-id)',
  '',
  '[go-legacy](#legacy-name)',
  '',
  '[go-first](#first-wins)',
  '',
  '[go-second](#second-wins)',
  '',
  FILLER,
  '',
  '<a id="alpha-id"></a>ALPHA_TARGET text',
  '',
  FILLER,
  '',
  '<span id="span-id">SPAN_TARGET</span> text',
  '',
  FILLER,
  '',
  '<a name="legacy-name"></a>LEGACY_TARGET text',
  '',
  FILLER,
  '',
  '<a id="first-wins"></a>FIRSTWINS_ID_TARGET text',
  '',
  FILLER,
  '',
  '# First Wins',
  '',
  FILLER,
  '',
  '# Second Wins',
  '',
  FILLER,
  '',
  '<span id="second-wins">SECONDWINS_ID_TARGET</span> text',
  '',
  FILLER,
  '',
].join('\n')

type Mode = 'ir' | 'wysiwyg' | 'sv' | 'preview'

async function enterMode(
  frame: ReturnType<typeof wf>,
  mode: Mode,
): Promise<void> {
  await frame.locator('body').evaluate((_body, next) => {
    const inner = (window as any).vditor.vditor
    const click = (el: Element | null | undefined) =>
      el?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    const previewOpen = () =>
      inner.toolbar.elements.preview?.children[0]?.classList.contains(
        'vditor-menu--current',
      )
    if (next === 'preview') {
      if (!previewOpen()) click(inner.toolbar.elements.preview?.children[0])
      return
    }
    if (previewOpen()) click(inner.toolbar.elements.preview?.children[0])
    if (inner.currentMode === next) return
    click(inner.toolbar.elements['edit-mode']?.children[0])
    click(document.querySelector(`button[data-mode="${next}"]`))
  }, mode)
  if (mode === 'sv' || mode === 'preview') {
    // The rendered pane fills asynchronously on a large document; wait for its links.
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () =>
              (window as any).vditor.vditor.preview.element.querySelectorAll(
                'a[href]',
              ).length,
          ),
      )
      .toBeGreaterThan(3)
  }
  if (mode === 'preview') {
    await expect
      .poll(() =>
        frame
          .locator('body')
          .evaluate(
            () => (window as any).vditor.vditor.preview.element.style.display,
          ),
      )
      .toBe('block')
    return
  }
  await expect
    .poll(() =>
      frame.locator('body').evaluate(() => {
        const inner = (window as any).vditor.vditor
        return `${inner.currentMode}:${inner.preview?.element?.style.display === 'block' && inner.currentMode !== 'sv'}`
      }),
    )
    .toBe(`${mode}:false`)
}

/** The surface the user looks at: the shown preview element (Preview, Split), else the edit root. */
async function inView(
  frame: ReturnType<typeof wf>,
  needle: string,
  mode: Mode,
): Promise<boolean> {
  return frame.locator('body').evaluate(
    (_body, [text, shown]) => {
      const inner = (window as any).vditor.vditor
      // Split (sv) and Preview show the rendered preview element; IR and WYSIWYG show their own.
      const root: HTMLElement =
        shown === 'sv' || shown === 'preview'
          ? inner.preview.element
          : inner[inner.currentMode].element
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!(node.textContent ?? '').includes(text as string)) continue
        const range = document.createRange()
        range.selectNodeContents(node)
        const rect = range.getBoundingClientRect()
        if (rect.height > 0 && rect.top >= 0 && rect.top < window.innerHeight)
          return true
      }
      return false
    },
    [needle, mode] as const,
  )
}

async function resetScroll(frame: ReturnType<typeof wf>): Promise<void> {
  await frame.locator('body').evaluate(() => {
    window.scrollTo(0, 0)
    for (const el of Array.from(document.querySelectorAll('*'))) {
      const e = el as HTMLElement
      if (e.scrollHeight > e.clientHeight) e.scrollTop = 0
    }
  })
}

async function ctrlClickLink(
  frame: ReturnType<typeof wf>,
  href: string,
  mode: Mode,
): Promise<void> {
  await frame.locator('body').evaluate(
    (_body, [needle, shown]) => {
      const inner = (window as any).vditor.vditor
      const root: ParentNode =
        shown === 'sv' || shown === 'preview'
          ? inner.preview.element
          : inner[inner.currentMode].element
      // WYSIWYG, Split and Preview render a real `a[href]`; IR renders a flat `data-type="a"` node
      // whose display text (`.vditor-ir__link`) sits beside a marker holding the raw URL.
      const real = Array.from(
        root.querySelectorAll<HTMLAnchorElement>('a[href]'),
      ).find((el) => el.getAttribute('href') === needle)
      const irNode = Array.from(
        root.querySelectorAll<HTMLElement>('[data-type="a"]'),
      ).find(
        (el) =>
          el.querySelector('.vditor-ir__marker--link')?.textContent === needle,
      )
      const target =
        real ?? irNode?.querySelector<HTMLElement>('.vditor-ir__link')
      if (!target) {
        const found = Array.from(
          root.querySelectorAll('a[href], [data-type="a"]'),
        ).map((el) => el.getAttribute('href') ?? el.textContent)
        throw new Error(
          `link ${needle} not found in ${shown} (mode ${inner.currentMode}); found ${JSON.stringify(found)}`,
        )
      }
      target.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
        }),
      )
    },
    [href, mode] as const,
  )
}

const CASES: ReadonlyArray<{
  label: string
  href: string
  reaches: string
  notNear?: string
}> = [
  { label: 'a id', href: '#alpha-id', reaches: 'ALPHA_TARGET' },
  { label: 'id on span', href: '#span-id', reaches: 'SPAN_TARGET' },
  { label: 'legacy name', href: '#legacy-name', reaches: 'LEGACY_TARGET' },
  {
    label: 'id before a same-name heading',
    href: '#first-wins',
    reaches: 'FIRSTWINS_ID_TARGET',
    notNear: 'First Wins',
  },
  {
    label: 'heading before a same-name id',
    href: '#second-wins',
    reaches: 'Second Wins',
    notNear: 'SECONDWINS_ID_TARGET',
  },
]

test('same-document links reach id and name targets in IR, WYSIWYG, Split and Preview', async ({
  workbox,
  evaluateInVSCode,
  baseDir,
}) => {
  test.setTimeout(420_000)
  await closeAllEditors(evaluateInVSCode)
  const docPath = path.join(baseDir, 'id-target-navigation.md')
  writeFileSync(docPath, DOC)
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
    { message: 'id-target navigation fixture readiness' },
  )

  for (const mode of ['ir', 'wysiwyg', 'sv', 'preview'] as const) {
    await enterMode(frame, mode)
    for (const item of CASES) {
      await resetScroll(frame)
      expect(
        await inView(frame, item.reaches, mode),
        `${mode}: ${item.label} target is not in view before the click`,
      ).toBe(false)
      await ctrlClickLink(frame, item.href, mode)
      await expect
        .poll(() => inView(frame, item.reaches, mode), {
          message: `${mode}: ${item.label} (${item.href})`,
          timeout: 15_000,
        })
        .toBe(true)
      if (item.notNear)
        expect(
          await inView(frame, item.notNear, mode),
          `${mode}: ${item.label} went to the wrong target`,
        ).toBe(false)
    }
  }
})
