# Tool Group Collapse Rendering

Type: behavioral

- [x] collapsing a visible expanded region clears its removed tail with one bounded terminal erase
  - Test: [tui-render.test.ts](../../packages/tui/test/tui-render.test.ts)
- [x] the bounded erase preserves the final viewport and cursor position
  - Test: [tui-render.test.ts](../../packages/tui/test/tui-render.test.ts)
- [x] shrinkage outside the visible working area keeps the full-redraw fallback
  - Test: [tui-render.test.ts](../../packages/tui/test/tui-render.test.ts)
- [x] Tool Group collapse keeps the product viewport, frame stability, and execution state
  - Test: [FullStripFeasibilityUiTest.kt](../../../jetbrains-terminal/src/uiTest/kotlin/com/jetideai/terminal/features/semantics/FullStripFeasibilityUiTest.kt)
