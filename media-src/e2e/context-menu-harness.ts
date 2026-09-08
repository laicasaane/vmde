import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installWebviewContext } from '../src/chrome/webview-context'
import { setupCustomRenderer } from '../src/links/custom-renderer'
import { patchLuteSerialize } from '../src/links/wiki-serialize'

const value = `# Context menu

Plain prose with [[Home]].

![pixel](data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==)

\`\`\`ts
const source = true
\`\`\`

\`\`\`mermaid
graph TD
  A --> B
\`\`\`
`

const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value,
  toolbar: ['preview'],
  after() {
    setupCustomRenderer(editor, {
      enabled: true,
      knownPages: new Set(['home']),
    })
    patchLuteSerialize(editor)
    installWebviewContext(document.getElementById('app'))
    editor.setValue(value)
    ;(window as unknown as { __contextMenu: unknown }).__contextMenu = {
      editor,
      value,
      rebuild: () => editor.setValue(value),
    }
  },
})
