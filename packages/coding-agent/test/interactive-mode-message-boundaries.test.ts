import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { MessageRenderBoundaryContextV1 } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import type { ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("InteractiveMode message boundaries", () => {
	it("uses stable live user and assistant entry IDs", async () => {
		initTheme("dark");
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const chatContainer = new Container();
		const mode = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			chatContainer,
			pendingTools: new Map(),
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			streamingComponent: undefined,
			streamingMessage: undefined,
			session: { retryAttempt: 0 },
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
			getMessageRenderBoundaryDecoratorsV1: () => [
				(context: Readonly<MessageRenderBoundaryContextV1>) => {
					contexts.push(context);
					return {};
				},
			],
			addMessageToChat: (
				InteractiveMode.prototype as unknown as {
					addMessageToChat: (message: AgentMessage, options?: { entryId?: string }) => void;
				}
			).addMessageToChat,
			updatePendingMessagesDisplay: vi.fn(),
			maybeShowAssistantDiagnostics: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof mode, event: AgentSessionEvent): Promise<void>;
			}
		).handleEvent;
		const user = { role: "user", content: "hello", timestamp: 1 } as const;
		const assistant = assistantMessage("answer");

		await handleEvent.call(mode, { type: "message_start", message: user, entryId: "user-live" });
		chatContainer.render(40);
		await handleEvent.call(mode, { type: "message_start", message: assistant, entryId: "assistant-live" });
		chatContainer.render(40);
		await handleEvent.call(mode, { type: "message_end", message: assistant, entryId: "assistant-live" });
		chatContainer.render(40);

		expect(contexts.map(({ entryId, role, state }) => [entryId, role, state])).toEqual([
			["user-live", "user", "final"],
			["user-live", "user", "final"],
			["assistant-live", "assistant", "streaming"],
			["user-live", "user", "final"],
			["assistant-live", "assistant", "final"],
		]);
	});

	it("uses persisted entry IDs for restored ordinary messages", () => {
		initTheme("dark");
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
		const assistantId = sessionManager.appendMessage(assistantMessage("answer"));
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const chatContainer = new Container();
		const mode = {
			pendingTools: new Map(),
			settingsManager: { getShowCacheMissNotices: () => false },
			sessionManager,
			session: { modelRuntime: undefined, retryAttempt: 0 },
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			chatContainer,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
			getMessageRenderBoundaryDecoratorsV1: () => [
				(context: Readonly<MessageRenderBoundaryContextV1>) => {
					contexts.push(context);
					return {};
				},
			],
			updateEditorBorderColor: vi.fn(),
			maybeShowAssistantDiagnostics: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
			addMessageToChat: (
				InteractiveMode.prototype as unknown as { addMessageToChat: (message: unknown, options?: unknown) => void }
			).addMessageToChat,
			renderSessionItems: (
				InteractiveMode.prototype as unknown as {
					renderSessionItems: (items: unknown[], options?: unknown) => void;
				}
			).renderSessionItems,
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as {
				renderSessionEntries(this: typeof mode, entries: ReturnType<SessionManager["getBranch"]>): void;
			}
		).renderSessionEntries;

		renderSessionEntries.call(mode, sessionManager.getBranch());
		chatContainer.render(40);

		expect(contexts.map(({ entryId, role, state }) => [entryId, role, state])).toEqual([
			[userId, "user", "final"],
			[assistantId, "assistant", "final"],
		]);
	});

	it.each([
		["tool only", undefined],
		["text and tool", "Before tool"],
	])("keeps %s stock output inside one assistant parent with a short tool point", (_name, text) => {
		initTheme("dark");
		const toolCall = { type: "toolCall" as const, id: "tool-a", name: "bash", arguments: { command: "echo ok" } };
		const message: AssistantMessage = {
			...assistantMessage(text ?? "unused"),
			content: [...(text ? [{ type: "text" as const, text }] : []), toolCall],
			stopReason: "toolUse",
		};
		const result = {
			role: "toolResult" as const,
			toolCallId: "tool-a",
			toolName: "bash",
			content: [{ type: "text" as const, text: "ok" }],
			isError: false,
			timestamp: 2,
		};
		const definition = withBuiltInRenderers(
			"bash",
			createBashToolDefinition(process.cwd()) as unknown as ToolRenderers,
		);
		const expectedAssistant = new AssistantMessageComponent(message).render(80);
		const expectedTool = new ToolExecutionComponent(
			"bash",
			"tool-a",
			toolCall.arguments,
			{},
			definition,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		expectedTool.setExpanded(true);
		expectedTool.updateResult(result);
		const expectedVisible = stripTerminalSequences([...expectedAssistant, ...expectedTool.render(80)].join("\n"));
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const points: Array<{ entryId: string; sourceOffset: number }> = [];
		const chatContainer = new Container();
		const mode = {
			pendingTools: new Map(),
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 80,
			},
			sessionManager: { getSessionId: () => "session-a", getCwd: () => process.cwd() },
			session: { modelRuntime: undefined, retryAttempt: 0 },
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			chatContainer,
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			toolOutputExpanded: true,
			messageRenderScopeId: "scope-a",
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
			getMessageRenderProjectionObserversV1: () => [],
			getMessageRenderBoundarySelectorsV3: () => [],
			getToolExecutionPresentationSelectorsV1: () => [],
			getMessageRenderBoundaryDecoratorsV1: () => [
				(context: Readonly<MessageRenderBoundaryContextV1>) => {
					contexts.push(context);
					return { prefix: "\x1b]777;parent-begin\x07", suffix: "\x1b]777;parent-end\x07" };
				},
			],
			getMessageRenderSourcePointDecoratorsV1: () => [
				(point: { entryId: string; sourceOffset: number }) => {
					points.push(point);
					return "\x1b]777;point\x07";
				},
			],
			getRegisteredToolDefinition: () => definition,
			updateEditorBorderColor: vi.fn(),
			maybeShowAssistantDiagnostics: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
			addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
			renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		mode.renderSessionItems.call(mode, [
			{ message, entryId: "assistant-a" },
			{ message: result, entryId: "tool-result-a" },
		]);
		const rendered = chatContainer.render(80);
		const tools = chatContainer.children.flatMap((child) =>
			child instanceof Container ? child.children.filter((nested) => nested instanceof ToolExecutionComponent) : [],
		);

		expect(stripTerminalSequences(rendered.join("\n"))).toBe(expectedVisible);
		expect(chatContainer.children).toHaveLength(1);
		expect(tools).toHaveLength(1);
		expect(contexts).toEqual([
			expect.objectContaining({
				entryId: "assistant-a",
				role: "assistant",
				stockRows: { start: 0, end: rendered.length },
			}),
		]);
		expect(points).toEqual([expect.objectContaining({ entryId: "tool-a", sourceOffset: 0 })]);
	});

	it("keeps a live stock tool inside its assistant parent", async () => {
		initTheme("dark");
		const message: AssistantMessage = {
			...assistantMessage("unused"),
			content: [{ type: "toolCall", id: "tool-live", name: "bash", arguments: { command: "echo ok" } }],
			stopReason: "toolUse",
		};
		const definition = withBuiltInRenderers(
			"bash",
			createBashToolDefinition(process.cwd()) as unknown as ToolRenderers,
		);
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const points: Array<{ entryId: string; sourceOffset: number }> = [];
		const chatContainer = new Container();
		const mode = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			chatContainer,
			pendingTools: new Map(),
			hideThinkingBlock: false,
			hiddenThinkingLabel: "Thinking...",
			outputPad: 1,
			toolOutputExpanded: true,
			messageRenderScopeId: "scope-a",
			streamingComponent: undefined,
			streamingMessage: undefined,
			semanticStreamingContainer: undefined,
			messageRenderMembers: undefined,
			semanticStreamingBaseMemberCount: 0,
			session: { retryAttempt: 0 },
			sessionManager: { getSessionId: () => "session-a", getCwd: () => process.cwd() },
			settingsManager: {
				getShowImages: () => false,
				getImageWidthCells: () => 80,
			},
			getMarkdownThemeWithSettings: () => getMarkdownTheme(),
			getMarkdownTransformers: () => [],
			getMessageRenderProjectionObserversV1: () => [],
			getMessageRenderBoundarySelectorsV3: () => [],
			getToolExecutionPresentationSelectorsV1: () => [],
			getMessageRenderBoundaryDecoratorsV1: () => [
				(context: Readonly<MessageRenderBoundaryContextV1>) => {
					contexts.push(context);
					return {};
				},
			],
			getMessageRenderSourcePointDecoratorsV1: () => [
				(point: { entryId: string; sourceOffset: number }) => {
					points.push(point);
					return "\x1b]777;point\x07";
				},
			],
			getRegisteredToolDefinition: () => definition,
			updatePendingMessagesDisplay: vi.fn(),
			maybeShowAssistantDiagnostics: vi.fn(),
			maybeShowCacheMissNotice: vi.fn(),
		};
		Object.setPrototypeOf(mode, InteractiveMode.prototype);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;

		await handleEvent.call(mode, {
			type: "message_start",
			message: { ...message, content: [] },
			entryId: "assistant-live",
		});
		await handleEvent.call(mode, {
			type: "message_update",
			message,
			assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
			entryId: "assistant-live",
		});
		await handleEvent.call(mode, {
			type: "tool_execution_end",
			toolCallId: "tool-live",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }], details: undefined },
			isError: false,
		});
		await handleEvent.call(mode, { type: "message_end", message, entryId: "assistant-live" });
		const rendered = chatContainer.render(80);

		expect(chatContainer.children).toHaveLength(1);
		expect(
			(chatContainer.children[0] as Container).children.filter((child) => child instanceof ToolExecutionComponent),
		).toHaveLength(1);
		expect(contexts.at(-1)).toEqual(
			expect.objectContaining({ entryId: "assistant-live", stockRows: { start: 0, end: rendered.length } }),
		);
		expect(points).toEqual([expect.objectContaining({ entryId: "tool-live", sourceOffset: 0 })]);
	});
});
