/**
 * ir 模式下支持 table 编辑
 */
import { t } from '../util/lang'
import { isMac } from '../util/platform'
import { dispatchTableHotkey, type TableAction } from './table-hotkey'
import { guardComposition } from '../util/caret-gesture'
import { runTableMove } from './table-actions'
import { runTablePanelRectangleAction } from './table-cell-selection'
import type { TableMove } from './table-operations'

const tablePanelId = 'fix-table-ir-wrapper'
let disableVscodeHotkeys = false

function formatHotkeyTip(hotkey: string) {
  if (isMac()) {
    return hotkey
  }

  return hotkey
    .replace(/⌘/g, 'Ctrl+')
    .replace(/⇧/g, 'Shift+')
    .replace(/⌥/g, 'Alt+')
    .replace(/\+/g, '+')
}

// The table-alignment/row/column popover markup (task 470 — extracted out of
// insertTablePanel's body for readability; byte-identical to the previous
// inline template literal, including the hard-coded "left" `--current` class
// that markAlignCurrent below immediately corrects for the actual cell).
function buildTablePanelHtml(): string {
  return `<div
    class="vditor-panel vditor-panel--none vditor-panel-ir"
    data-top="73"
    style="left: 35px; top: 73px;display:none"
  >
   <button
      type="button"
    aria-label="${t('alignLeft')}<${formatHotkeyTip('⇧⌘L')}>"
      data-type="left"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n vditor-icon--current"
    >
      <svg><use xlink:href="#vditor-icon-align-left"></use></svg></button
    ><button
      type="button"
      aria-label="${t('alignCenter')}<${formatHotkeyTip('⇧⌘C')}>"
      data-type="center"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-align-center"></use></svg></button
    ><button
      type="button"
      aria-label="${t('alignRight')}<${formatHotkeyTip('⇧⌘R')}>"
      data-type="right"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-align-right"></use></svg></button
    ><button
      type="button"
      aria-label="${t('insertRowAbove')}<${formatHotkeyTip('⇧⌘F')}>"
      data-type="insertRowA"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-insert-rowb"></use></svg></button
    ><button
      type="button"
      aria-label="${t('insertRowBelow')}<${formatHotkeyTip('⌘=')}>"
      data-type="insertRowB"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-insert-row"></use></svg></button
    ><button
      type="button"
      aria-label="${t('insertColumnLeft')}<${formatHotkeyTip('⇧⌘G')}>"
      data-type="insertColumnL"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-insert-columnb"></use></svg></button
    ><button
      type="button"
      aria-label="${t('insertColumnRight')}<${formatHotkeyTip('⇧⌘=')}>"
      data-type="insertColumnR"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-insert-column"></use></svg></button
    ><button
      type="button"
      aria-label="${t('deleteRow')}<${formatHotkeyTip('⌘-')}>"
      data-type="deleteRow"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-delete-row"></use></svg></button
    ><button
      type="button"
      aria-label="${t('deleteColumn')}<${formatHotkeyTip('⇧⌘-')}>"
      data-type="deleteColumn"
      class="vditor-icon vditor-tooltipped vditor-tooltipped__n"
    >
      <svg><use xlink:href="#vditor-icon-delete-column"></use></svg></button
    ><button type="button" aria-label="Move column left" data-type="moveColumnLeft" class="vditor-icon vditor-tooltipped vditor-tooltipped__n">←</button
    ><button type="button" aria-label="Move column right" data-type="moveColumnRight" class="vditor-icon vditor-tooltipped vditor-tooltipped__n">→</button
    ><button type="button" aria-label="Move row up" data-type="moveRowUp" class="vditor-icon vditor-tooltipped vditor-tooltipped__n">↑</button
    ><button type="button" aria-label="Move row down" data-type="moveRowDown" class="vditor-icon vditor-tooltipped vditor-tooltipped__n">↓</button
    >
  </div>
  `
}

// Move the alignment `--current` highlight onto the left/center/right button that
// matches `align` (the cell's column alignment, stored by Vditor as the `align`
// attribute — absent/"left" = default). The HTML template hard-codes left as
// current; without this the highlight never tracks the actual cell.
function markAlignCurrent(root: HTMLElement, align: string | null) {
  const want = align === 'center' || align === 'right' ? align : 'left'
  for (const btn of root.querySelectorAll<HTMLElement>(
    '[data-type="left"],[data-type="center"],[data-type="right"]',
  )) {
    btn.classList.toggle(
      'vditor-icon--current',
      btn.getAttribute('data-type') === want,
    )
  }
}

export function fixTableIr() {
  // Called once from finish-init.ts, strictly after the Vditor constructor returns — Vditor builds
  // all three mode DOM trees (wysiwyg/ir/sv) up front regardless of which is initially active, so
  // `.ir.element` always exists by then. Fail loud rather than silently no-op'ing the table panel
  // if that invariant is ever broken.
  const irElement = vditor.vditor.ir?.element
  if (!irElement)
    throw new Error('fixTableIr: IR editor element not initialized')
  // Re-bind to a plainly-`HTMLElement`-typed const: the guard above only narrows `irElement` in
  // THIS scope — it doesn't propagate into the nested `function` declarations below (insertTablePanel
  // etc.), which TS type-checks as their own scope. Giving `eventRoot` a non-union type at its own
  // declaration (rather than relying on carried-over narrowing) is what those nested functions see.
  const eventRoot: HTMLElement = irElement

  function insertTablePanel() {
    let tablePanel = eventRoot.querySelector<HTMLDivElement>(`#${tablePanelId}`)
    if (!tablePanel) {
      tablePanel = document.createElement('div')
      tablePanel.id = tablePanelId
      // Exclude the panel subtree from the editable IR region — it is appended
      // into the contenteditable element, so without this its markup is
      // editable/selectable. Complementary to the mousedown preventDefault.
      tablePanel.contentEditable = 'false'
      tablePanel.style.userSelect = 'none'
      // Keep the wrapper OUT of the editable content flow. It is appended into
      // the contenteditable IR element; as a static block it reserves a line+
      // margin box (~58px) that shows up as an empty gap under the text whenever
      // you click/edit (the click handler creates it on first click). Anchor it
      // as a zero-size absolute box at the IR origin: it then reserves no flow
      // space, and the whitespace text nodes in its template can't form a stray
      // line box over the top content. The inner panel is itself
      // position:absolute (overflowing this 0×0 box, so still visible) and is
      // positioned via JS relative to eventRoot — landing on the clicked cell
      // exactly as before.
      tablePanel.style.position = 'absolute'
      tablePanel.style.top = '0'
      tablePanel.style.left = '0'
      tablePanel.style.width = '0'
      tablePanel.style.height = '0'
      eventRoot.appendChild(tablePanel)
      tablePanel.innerHTML = buildTablePanelHtml()
      // Stable `const` for the closures below — `tablePanel` itself is reassigned to
      // `.children[0]` right after this if-block (every call, see below), and a closure reading a
      // mutated `let` sees its value AT INVOCATION time, not at closure-creation time. `wrapper`
      // stays the outer 0×0 anchor forever; containment/query results are identical either way
      // (wrapper ⊇ innerPanel ⊇ the buttons), so this only fixes strictNullChecks' inability to
      // narrow a captured `let` — it does not change which elements match.
      const wrapper = tablePanel
      // Keep the editor selection when an icon is clicked, otherwise the
      // button steals the caret and the table hotkey has no cell context.
      wrapper.addEventListener('mousedown', (e) => e.preventDefault())
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: combines native table routing, range interception, and panel state so the retained selection cannot be lost between handlers.
      wrapper.addEventListener('click', (e) => {
        const icon = (e.target as HTMLElement).closest<HTMLElement>(
          '.vditor-icon',
        )
        if (!icon || !wrapper.contains(icon)) return
        const type = icon.getAttribute('data-type') as
          | TableAction
          | 'moveColumnLeft'
          | 'moveColumnRight'
          | 'moveRowUp'
          | 'moveRowDown'
        disableVscodeHotkeys = true
        try {
          if (type.startsWith('move')) runTableMove(type as TableMove)
          else {
            const rangeAction =
              type === 'insertRowA' ||
              type === 'insertRowB' ||
              type === 'insertColumnL' ||
              type === 'insertColumnR' ||
              type === 'deleteRow' ||
              type === 'deleteColumn'
                ? type
                : null
            const node = document.getSelection()?.anchorNode
            const cell = (
              node instanceof Element ? node : node?.parentElement
            )?.closest('td,th')
            // A panel click is non-editable and can leave Vditor's native Range at a marker
            // rather than a TD. The painted cells are the authoritative transient rectangle, so
            // use their table first and fall back to the ordinary one-cell Range for native edits.
            const table =
              eventRoot.querySelector('table:has(.vmde-cell-selected)') ??
              cell?.closest('table')
            const appliedRange =
              table instanceof HTMLTableElement &&
              rangeAction !== null &&
              runTablePanelRectangleAction(table, rangeAction)
            if (!appliedRange)
              dispatchTableHotkey(eventRoot, type as TableAction, isMac())
          }
        } finally {
          disableVscodeHotkeys = false
        }
        // reflect a left/center/right click on the highlight immediately
        if (type === 'left' || type === 'center' || type === 'right') {
          markAlignCurrent(wrapper, type)
        }
        e.stopPropagation()
      })
    }
    tablePanel = tablePanel.children[0] as HTMLDivElement
    return tablePanel
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: click routing across the table-IR-wrapper splice-boundary DOM shapes; pre-existing (task 469 baseline)
  eventRoot.addEventListener('click', (_e) => {
    if (vditor.getCurrentMode() !== 'ir') return
    const tablePanel = insertTablePanel()
    const anchorNode = window.getSelection()?.anchorNode
    const anchorEl =
      anchorNode instanceof HTMLElement
        ? anchorNode
        : (anchorNode?.parentElement ?? null)
    // Walk up to the enclosing cell — the caret may sit inside inline content
    // (e.g. a <code> span when the cell is only inline code), so
    // anchorNode.parentElement is not always the TD/TH/TR itself.
    const cell = anchorEl?.closest<HTMLElement>('td, th, tr') ?? null
    if (cell) {
      if (tablePanel.style.display !== 'block') {
        tablePanel.style.display = 'block'
      }
      // Task 416: measure BOTH boxes once, up front, then write — the previous version read
      // `cell`/`eventRoot` rects again after assigning `style.top`, and a geometry read after a
      // style write forces a fresh synchronous layout (2 extra reflows per selection change
      // inside a table, which is a per-caret-move path). The values are identical; only the
      // number of forced layouts changes. The reads stay AFTER the `display = 'block'` write
      // above, as before, so nothing about the measured state moves.
      const cellRect = cell.getBoundingClientRect()
      const rootRect = eventRoot.getBoundingClientRect()
      tablePanel.style.top = `${cellRect.top - rootRect.top + eventRoot.scrollTop - 25}px`
      // track the clicked cell horizontally too, so the panel stays visible
      // regardless of the editor's left margin / full-width layout
      tablePanel.style.left = `${cellRect.left - rootRect.left + eventRoot.scrollLeft}px`
      // highlight the alignment button that matches THIS cell's column alignment
      const td = anchorEl?.closest<HTMLElement>('td, th')
      markAlignCurrent(tablePanel, td?.getAttribute('align') ?? null)
    } else {
      if (tablePanel.style.display !== 'none') {
        tablePanel.style.display = 'none'
      }
    }
  })
  // don't bubble keyboardEvent to vscode when trigger vditor table hot keys, prevent hotkey conflicts with vscode
  const stopEvent = (e: KeyboardEvent) => {
    if (guardComposition(e)) return
    if (disableVscodeHotkeys) {
      e.preventDefault()
      e.stopPropagation()
    }
  }
  eventRoot.addEventListener('keydown', stopEvent)
  eventRoot.addEventListener('keyup', stopEvent)
}
