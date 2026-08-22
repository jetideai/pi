# Tool Groups

Type: behavioral

- [x] thinking followed by five Tool Calls renders one Tool Group
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] Tool Calls separated by non-empty text keep display order and form separate groups
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] tool results and empty text do not split a group; independent visual content does
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] live append and complete rebuild produce identical stable group IDs and membership
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] displayed custom entries stay transparent to an open Tool Group in live append and restore; non-empty assistant text remains a boundary
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] replacement rebuild removes groups that are absent from the selected branch
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] stock rendering stays unchanged; registered overrides can collapse or expand unchanged independent Tool Calls
  - Test: [tool-group-component.test.ts](../../packages/coding-agent/test/tool-group-component.test.ts)
- [x] extensions receive typed Tool Group facts and can select presentation with one invalidator
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] active-run composition has deterministic component, Tool Call, override, and invalidator counts
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
