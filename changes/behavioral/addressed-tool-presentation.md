# Addressed Tool Call presentation

Type: behavioral

- [x] a completed edit renders one compact row without calling the stock renderer while collapsed
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
- [x] an expanded edit delegates to the retained stock renderer without executing again
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
- [x] extensions register one Tool Call presentation override
  - Test: [extensions-discovery.test.ts](../../packages/coding-agent/test/extensions-discovery.test.ts)
- [x] the runner exposes Tool Call presentation overrides in extension load order
  - Test: [extensions-runner.test.ts](../../packages/coding-agent/test/extensions-runner.test.ts)
- [x] interactive Tool Call components receive registered presentation overrides
  - Test: [interactive-mode-render-projection.test.ts](../../packages/coding-agent/test/interactive-mode-render-projection.test.ts)
- [x] presentation overrides receive current completion and result facts
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
- [x] a registered custom tool uses the same compact and expanded presentation seam
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
- [x] a targeted expanded non-edit tool receives expanded stock render context
  - Test: [tool-execution-component.test.ts](../../packages/coding-agent/test/tool-execution-component.test.ts)
- [ ] one desired-state request invalidates only the exact live Tool Call
- [ ] duplicate and stale requests return typed outcomes without invalidation
- [ ] complete projection replacement and shutdown prune absent Tool Call presentation state
