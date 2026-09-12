import { Container, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { serializeTarget } from "../benchmark/long-transcript.ts";
import { deriveComponentCounts, deriveTranscriptCounts } from "../benchmark/long-transcript-structure.ts";
import type {
	MessageRenderBoundarySelectorV3,
	ToolExecutionPresentationSelectorV1,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import {
	createSyntheticLongTranscript,
	SYNTHETIC_ENTRY_COUNT,
	SYNTHETIC_GROUP_COUNT,
	SYNTHETIC_SINGLETON_COUNT,
	SYNTHETIC_TOOL_CALL_COUNT,
	SYNTHETIC_TOOL_RESULT_COUNT,
} from "./helpers/synthetic-long-transcript.ts";

function restoreComponentTree(semantic: boolean): Container {
	const fixture = createSyntheticLongTranscript();
	const sessionManager = SessionManager.inMemory();
	for (const { message } of fixture.messages) sessionManager.appendMessage(message);
	const selector: MessageRenderBoundarySelectorV3 = () => () => ({ begin: "", body: "", end: "" });
	const presentation: ToolExecutionPresentationSelectorV1 = () => ({
		liveToolCall: "compact-stock-header",
		liveToolGroup: "compact-stock-header",
		header: "exact-one-row",
		settled: "canonical-initial-collapsed",
	});
	const mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		ui: { requestRender() {} } as TUI,
		chatContainer: new Container(),
		pendingTools: new Map(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "benchmark-test-scope",
		semanticStreamingBaseMemberCount: 0,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: true,
		streamingComponent: undefined,
		streamingMessage: undefined,
		semanticStreamingContainer: undefined,
		sessionManager,
		session: {
			retryAttempt: 0,
			modelRuntime: undefined,
			getToolDefinition: () => undefined,
			extensionRunner: {},
		},
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getShowCacheMissNotices: () => false,
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getMessageRenderBoundaryDecoratorsV1: () => [],
		getMessageRenderBoundarySelectorsV3: () => (semantic ? [selector] : []),
		getMessageRenderProjectionObserversV1: () => [],
		getToolExecutionPresentationSelectorsV1: () => (semantic ? [presentation] : []),
		updatePendingMessagesDisplay() {},
		updateEditorBorderColor() {},
		maybeShowAssistantDiagnostics() {},
		maybeShowCacheMissNotice() {},
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: ReturnType<SessionManager["buildTranscriptEntries"]>,
	) => void;
	renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
	return mode.chatContainer;
}

describe("long-transcript benchmark evidence", () => {
	beforeAll(() => initTheme("dark"));

	it("removes filesystem roots from serialized target metadata", () => {
		const serialized = serializeTarget({
			label: "stock",
			root: "/Users/private/source/pi",
			expectedRevision: "expected",
			actualRevision: "actual",
			packageVersions: { codingAgent: "0.85.1", tui: "0.85.1" },
		});

		expect(serialized).toEqual({
			label: "stock",
			expectedRevision: "expected",
			actualRevision: "actual",
			packageVersions: { codingAgent: "0.85.1", tui: "0.85.1" },
		});
		expect(JSON.stringify(serialized)).not.toContain("/Users/private/source/pi");
	});

	it("derives run counts from restored transcript entries", () => {
		const fixture = createSyntheticLongTranscript();
		const entries = fixture.messages.map(({ message }, index) => ({
			type: "message",
			id: `observed-${index}`,
			message,
		}));

		expect(deriveTranscriptCounts(entries)).toEqual({
			entries: SYNTHETIC_ENTRY_COUNT,
			toolCalls: SYNTHETIC_TOOL_CALL_COUNT,
			toolResults: SYNTHETIC_TOOL_RESULT_COUNT,
			groupableRuns: SYNTHETIC_GROUP_COUNT,
			singletonRuns: SYNTHETIC_SINGLETON_COUNT,
		});
	});

	it("traverses real restored production component trees", () => {
		const observe = (root: Container) =>
			deriveComponentCounts(
				root,
				(component) => component instanceof ToolExecutionComponent,
				(component) => component instanceof ToolGroupComponent,
			);

		expect(observe(restoreComponentTree(false))).toEqual({
			toolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
			toolGroupComponents: 0,
			directToolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
		});
		expect(observe(restoreComponentTree(true))).toEqual({
			toolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
			toolGroupComponents: SYNTHETIC_GROUP_COUNT,
			directToolExecutionComponents: SYNTHETIC_SINGLETON_COUNT,
		});
	});
});
