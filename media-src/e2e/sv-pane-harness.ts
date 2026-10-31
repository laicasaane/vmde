import '../src/boot/preload'
import Vditor from 'vditor'
import { applyBodyOptions } from '../src/boot/live-config'

// Task 645 harness: Vditor in Split View (or IR with ?mode=ir) with the real `applyBodyOptions`
// exposed, so the Split source pane settings reach the page through the same function the
// extension's `config-changed` message uses. The spec measures the resulting computed styles.
const params = new URLSearchParams(location.search)
const mode = params.get('mode') === 'ir' ? 'ir' : 'sv'

const sections: string[] = ['# Document title', '']
for (let i = 1; i <= 6; i++) {
  sections.push(
    `## Section ${i}`,
    '',
    `Paragraph under section ${i}. `.repeat(8),
    '',
  )
}

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn: `${location.origin}/vditor`,
  value: sections.join('\n'),
  preview: { mode: 'both' },
  height: '100%',
  after() {
    ;(window as any).vditor = editor
    ;(window as any).__applyBodyOptions = (options: unknown) =>
      applyBodyOptions(options as Parameters<typeof applyBodyOptions>[0])
    ;(window as any).__setDoc = (markdown: string) => editor.setValue(markdown)
    ;(window as any).__ready = true
  },
})
