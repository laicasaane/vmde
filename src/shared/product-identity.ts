// Product identity is dependency-free because both the extension platform layer and wiki layer
// consume the custom-editor contract. Keep manifest/runtime identifiers centralized here so a
// repository rebrand cannot leave those consumers on different namespaces.
export const Publisher = 'Laicasaane'
export const ExtensionId = `${Publisher}.vmde`
export const ProductDisplayName = 'VMDE'
export const ConfigurationRoot = 'vmde'
export const MarkdownEditorViewType = 'vmde.editor'
export const OutlineViewId = 'vmde.outline'
