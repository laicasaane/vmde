# Wrap hints in tables

| File | Change |
| --- | --- |
| `../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs` | `TestFlowContext` gains `public Option<IPageOwnershipTracker> OwnershipTracker { get; set; }` after `FlowScopeCollectionApplier` (default none) |

A table with no long word:

| Name | Value |
| --- | --- |
| alpha | beta |
| gamma | delta words in a short cell |

| Identifier | Note |
| --- | --- |
| GetTableListViewModelFactoryProvider | a camel-case identifier |
| 日本語のテキストと絵文字 👨‍👩‍👧‍👦 🎉 | CJK and emoji |

| Build path | Link |
| --- | --- |
| `Shaders/URP17Compat/LitPass2D.hlsl` | [../EncosyTower.Tests.EditorMode/EncosyTower.PageFlows/PageFlowTestDoubles.cs](https://example.com/page-flow-test-doubles) |
