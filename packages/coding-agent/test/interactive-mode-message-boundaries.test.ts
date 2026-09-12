import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { MessageRenderBoundaryContextV1 } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
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
});
