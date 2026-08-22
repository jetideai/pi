# Assistant render boundary V1

Type: behavioral

- [x] reserved entry IDs are unique, one-shot, and consumed by message persistence
  - Test: [save-entry.test.ts](../../packages/coding-agent/test/session-manager/save-entry.test.ts)
- [x] message lifecycle events and persistence share one entry ID, including duplicate and replaced assistants
  - Test: [assistant-entry-id.test.ts](../../packages/coding-agent/test/suite/assistant-entry-id.test.ts)
- [x] JSON message updates retain the entry ID while removing cumulative snapshots
  - Test: [assistant-entry-id.test.ts](../../packages/coding-agent/test/suite/assistant-entry-id.test.ts)
- [x] extension discovery and runner expose V1 decorators in load order
  - Test: [extensions-discovery.test.ts](../../packages/coding-agent/test/extensions-discovery.test.ts)
  - Test: [extensions-runner.test.ts](../../packages/coding-agent/test/extensions-runner.test.ts)
- [x] V1 decorators receive persisted identity, streaming state, allocated columns, and stock row extent
  - Test: [assistant-message.test.ts](../../packages/coding-agent/test/assistant-message.test.ts)
- [x] decorators preserve stock rows and visible text, reject visible or multiline controls, and isolate failures
  - Test: [assistant-message.test.ts](../../packages/coding-agent/test/assistant-message.test.ts)
- [x] zero-row assistant output does not add layout
  - Test: [assistant-message.test.ts](../../packages/coding-agent/test/assistant-message.test.ts)
- [x] live, resized, and restored assistant rendering keep the persisted entry ID
  - Test: [assistant-entry-id.test.ts](../../packages/coding-agent/test/suite/assistant-entry-id.test.ts)
  - Test: [interactive-mode-render-identity.test.ts](../../packages/coding-agent/test/interactive-mode-render-identity.test.ts)
