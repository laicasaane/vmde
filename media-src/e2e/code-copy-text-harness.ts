import '../src/boot/preload'
import Vditor from 'vditor/src/index'
import { installCodeCopy } from '../src/clipboard/code-copy'
import { codeRender } from 'vditor/src/ts/markdown/codeRender'

const input = (window as any).__vmdeCodeCopyMarkdown as string
const editor = new Vditor('app', {
  cache: { enable: false },
  mode: 'ir',
  cdn: `${location.origin}/vditor`,
  value: input,
  toolbar: ['edit-mode', 'preview'],
  preview: { delay: 0, hljs: { lineNumber: true } },
  customWysiwygToolbar: () => {
    /* required by Vditor 3.11 while constructing WYSIWYG controls */
  },
  after() {
    ;(window as any).vditor = editor
    const inner = editor.vditor
    const copyMessages: string[] = []
    installCodeCopy(window, (message) => copyMessages.push(message.content))
    ;(window as any).__vmdeCodeCopyMessages = copyMessages
    ;(window as any).__vmdeCodeCopyValue = () => editor.getValue()
    ;(window as any).__vmdeCodeCopyMode = () => inner.currentMode
    ;(window as any).__vmdeSourceCodeCount = () =>
      inner[inner.currentMode].element.querySelectorAll('pre > code').length
    ;(window as any).__vmdePreviewVisible = () =>
      inner.preview.element.style.display === 'block'
    ;(window as any).__vmdeSwitchCodeCopyMode = (
      next: 'ir' | 'wysiwyg' | 'sv',
    ) => {
      if (inner.currentMode === next) return
      inner.toolbar.elements['edit-mode']?.children[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
      const button = document.querySelector(`button[data-mode="${next}"]`)
      if (!button) throw new Error('code-copy mode button missing')
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    }
    ;(window as any).__vmdeToggleCodeCopyPreview = () => {
      const button = inner.toolbar.elements.preview?.children[0]
      if (!button) throw new Error('code-copy Preview button missing')
      button.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      )
    }
    ;(window as any).__vmdeRenderCopyProbe = (
      ordinaryText: string,
      highlightedLines: string[],
    ) => {
      document.getElementById('code-copy-probe')?.remove()
      const root = document.createElement('div')
      root.id = 'code-copy-probe'
      root.className = 'vditor-preview vditor-reset'

      const ordinaryPre = document.createElement('pre')
      const ordinaryCode = document.createElement('code')
      ordinaryCode.textContent = ordinaryText
      ordinaryPre.append(ordinaryCode)
      root.append(ordinaryPre)

      const highlightedPre = document.createElement('pre')
      const highlightedCode = document.createElement('code')
      highlightedCode.className = 'highlight-chroma'
      highlightedLines.forEach((line, index) => {
        const lineNumber = document.createElement('span')
        lineNumber.className = 'highlight-ln'
        lineNumber.textContent = String(index + 1)
        const token = document.createElement('span')
        token.className = 'highlight-token'
        token.textContent = line
        highlightedCode.append(lineNumber, token)
        highlightedCode.append(
          document.createTextNode(index === 0 ? '\n\n' : '\n'),
        )
      })
      highlightedPre.append(highlightedCode)
      root.append(highlightedPre)
      document.body.append(root)
      codeRender(root, inner.options.preview.hljs)
      return root.querySelectorAll('.vditor-copy [data-vmde-copy-code]').length
    }
    ;(window as any).__vmdeCodeCopyReady = true
  },
})
