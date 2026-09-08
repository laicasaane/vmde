// Task 405 — the two globalState keys shared between EditorSession, MarkdownEditorProvider,
// and activate() (setKeysForSync). Pulled into their own tiny module so editor-session.ts and
// markdown-editor-provider.ts don't need to import each other (or extension.ts) just for two
// string constants.
export const KeyVditorOptions = 'vmde.options'
export const KeyOutlineWidth = 'vmde.outlineWidth'
// Profile-local picker history is intentionally excluded from Settings Sync in extension.ts.
export const KeyEmojiRecents = 'vmde.emojiRecents'
