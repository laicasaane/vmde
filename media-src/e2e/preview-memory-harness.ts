import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { createToolbar } from '../src/chrome/toolbar'
import { installPreviewMemory, openInPreview } from '../src/chrome/open-preview'
import { innerVditor } from '../src/util/inner-vditor'

// Task 651: real Vditor with the Preview toolbar button and the Preview memory listener wired as
// boot/finish-init.ts does. `?previewOn=1` plays the host's `openInPreview` init option (the
// webview opens Preview right after mount, as boot/vditor-init.ts does), `?mode=` picks the stored
// edit mode, and `__previewPosts` records what the listener posts to the host.
const params = new URLSearchParams(location.search)
const mode = (params.get('mode') ?? 'ir') as 'ir' | 'wysiwyg' | 'sv'
const previewPosts: unknown[] = []
const inputs: string[] = []
;(window as any).__previewPosts = previewPosts
;(window as any).__inputs = inputs
;(window as any).__openInPreview = openInPreview

const editor = new Vditor('app', {
  cache: { enable: false },
  mode,
  cdn: `${location.origin}/vditor`,
  value: 'first paragraph\n\nsecond paragraph',
  toolbar: createToolbar({ wikiEnabled: false }),
  toolbarConfig: { pin: true },
  input: (value: string) => void inputs.push(value),
  after() {
    ;(window as any).vditor = editor
    const button = innerVditor()?.toolbar?.elements?.preview?.children[0]
    if (button instanceof HTMLElement) {
      installPreviewMemory(button, {
        postMessage: (message) => void previewPosts.push(message),
      })
    }
    if (params.get('previewOn') === '1') openInPreview()
    ;(window as any).__ready = true
  },
})
