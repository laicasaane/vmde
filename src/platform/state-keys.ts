// Task 405 — the globalState keys shared between EditorSession, MarkdownEditorProvider,
// and activate() (setKeysForSync). Pulled into their own tiny module so editor-session.ts and
// markdown-editor-provider.ts don't need to import each other (or extension.ts) just for two
// string constants.
export const KeyVditorOptions = 'vmde.options'
export const KeyOutlineWidth = 'vmde.outlineWidth'
// Profile-local picker history is intentionally excluded from Settings Sync in extension.ts.
export const KeyEmojiRecents = 'vmde.emojiRecents'
// Task 631 F2 — the one user-level toolbar collapsed flag shared by every editor and file. Profile-local
// on purpose: it is not added to the settings-sync key list in extension.ts.
export const KeyToolbarCollapsed = 'vmde.toolbarCollapsed'

/** The stored toolbar collapsed flag; absent or any non-`true` value means expanded. */
export function readToolbarCollapsed(store: {
  get(key: string): unknown
}): boolean {
  return store.get(KeyToolbarCollapsed) === true
}

// Task 651 — whether the Preview toggle was left on. Profile-local like the toolbar flag (not in the
// settings-sync key list in extension.ts); read once at editor open, never pushed to open editors.
export const KeyPreviewOn = 'vmde.previewOn'

/** The stored Preview flag; absent or any non-`true` value means off. */
export function readPreviewOn(store: { get(key: string): unknown }): boolean {
  return store.get(KeyPreviewOn) === true
}

// Task 650 — whether the Outline panel was left open. Profile-local like the toolbar flag (not in the
// settings-sync key list in extension.ts); read once at editor open, never pushed to open editors.
// Cleared when `vmde.outline.defaultOpen` changes, so a new setting value wins over the old choice.
export const KeyOutlineOpen = 'vmde.outlineOpen'

/** The stored Outline open flag; only a strict boolean counts, anything else is "no choice yet". */
export function readOutlineOpen(store: {
  get(key: string): unknown
}): boolean | undefined {
  const value = store.get(KeyOutlineOpen)
  return typeof value === 'boolean' ? value : undefined
}
