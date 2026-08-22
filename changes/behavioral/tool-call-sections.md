# Tool Call sections

Type: behavioral

- [x] Render one completed read as one canonical header and its complete result body.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Reuse retained renderer state and components from partial output through the final result.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Preserve one bash timer and its existing cleanup lifecycle.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Keep error, image, custom, and malformed-header output in one ordered body tree.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Render the same complete child sections in singleton and multi-tool group paths.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
  - Test: [tool-group-component.test.ts](../../packages/coding-agent/test/tool-group-component.test.ts)

- [x] Nest Tool Group and Tool Call section controls in exact byte order.
  - Test: [tool-group-component.test.ts](../../packages/coding-agent/test/tool-group-component.test.ts)

- [x] Place the edit BODY control before its settled or rebuilt diff at narrow and standard widths.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Place the edit BODY control before an asynchronous live preview.
  - Test: [edit-tool-no-full-redraw.test.ts](../../packages/coding-agent/test/edit-tool-no-full-redraw.test.ts)

- [x] Preserve edit renderer identity and invocation counts with section controls.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Do not inherit a built-in BODY locator through a custom edit renderer override.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Place BODY before an image-only Tool Call result.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Preserve the legacy collapsed presentation when no V2 selector applies to a Tool Call.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Preserve the exact legacy Tool Call path when no V2 selector is registered or selected.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
  - Test: [tool-group-component.test.ts](../../packages/coding-agent/test/tool-group-component.test.ts)

- [x] Pin one selected V2 decorator for the full Tool Call lifetime.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Fail open at selector and decorator boundaries.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Pass real ranges to selected decorators once per render without reselection on resize.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
  - Test: [tool-group-component.test.ts](../../packages/coding-agent/test/tool-group-component.test.ts)

- [x] Compose selected decorators in nested registration order.
  - Test: [extensions-runner.test.ts](../../packages/coding-agent/test/extensions-runner.test.ts)
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)

- [x] Preserve live, rebuilt, singleton, grouped, image, and edit Tool Call sections.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
  - Test: [edit-tool-no-full-redraw.test.ts](../../packages/coding-agent/test/edit-tool-no-full-redraw.test.ts)
