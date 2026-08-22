# Assistant render projection V1

Type: behavioral

- [x] extensions register assistant projection observers in load order
  - Test: [extensions-runner.test.ts](../../packages/coding-agent/test/extensions-runner.test.ts)
- [x] one complete interactive render publishes all assistant entry IDs once in render order
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] stock transcript rendering survives projection observer failure
  - Code: [interactive-mode.ts](../../packages/coding-agent/src/modes/interactive/interactive-mode.ts)
