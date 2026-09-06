import { describe, expect, it } from 'vitest'
import {
  ConfigurationRoot,
  ExtensionId,
  Publisher,
  ProductDisplayName,
  MarkdownEditorViewType,
  OutlineViewId,
} from '../../src/shared/product-identity'

describe('product identity', () => {
  it('exports the canonical extension contracts', () => {
    expect({
      ExtensionId,
      Publisher,
      ProductDisplayName,
      ConfigurationRoot,
      MarkdownEditorViewType,
      OutlineViewId,
    }).toEqual({
      ExtensionId: 'Laicasaane.vmde',
      Publisher: 'Laicasaane',
      ProductDisplayName: 'VMDE',
      ConfigurationRoot: 'vmde',
      MarkdownEditorViewType: 'vmde.editor',
      OutlineViewId: 'vmde.outline',
    })
  })
})
