# Native Tool Call folding

Type: behavioral

- [x] Prepare one completed or failed Tool Call for native initial collapse before its first final render.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)

- [x] Preserve ordered parent and child fold candidate types at the barrier.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)

- [x] Fail open with the full Tool Call body when the native barrier is unavailable.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)

- [x] Preserve live and rebuilt canonical Tool Call sections without Pi visibility state.
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)

- [x] Keep the visual Tool Call spacer outside the native fold header.
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
