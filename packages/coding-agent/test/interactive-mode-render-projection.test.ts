import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	MessageRenderBoundaryCandidateV3,
	MessageRenderProjectionV1,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

const user = { role: "user", content: "Question", timestamp: 1 } as const;

function assistant(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
		stopReason,
		timestamp: 1,
	};
}

const finalAssistant = assistant(
	[
		{ type: "text", text: "Answer" },
		{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a" } },
		{ type: "toolCall", id: "tool-b", name: "bash", arguments: { command: "true" } },
	],
	"stop",
);

function definition(): ToolDefinition {
	return {
		name: "tool",
		label: "tool",
		description: "tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		renderShell: "self",
		renderCall: () => new Text("stock header\nstock preview", 0, 0),
		getRenderCallHeaderRow: () => 0,
		getRenderCallBodyRow: () => 1,
		renderResult: () => new Text("stock result", 0, 0),
	};
}

function modeHarness(sessionManager: SessionManager, extensionRunner?: ExtensionRunner) {
	const projections: Readonly<MessageRenderProjectionV1>[] = [];
	const candidates: MessageRenderBoundaryCandidateV3[] = [];
	const chatContainer = new Container();
	const messageDecorator = vi.fn(() => undefined);
	const mode = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		chatContainer,
		pendingTools: new Map(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "scope-a",
		semanticStreamingBaseMemberCount: 0,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		semanticStreamingContainer: undefined,
		sessionManager,
		session: { retryAttempt: 0, modelRuntime: undefined, extensionRunner },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getShowCacheMissNotices: () => false,
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getMessageRenderBoundaryDecoratorsV1: () => [messageDecorator],
		...(extensionRunner
			? {}
			: {
					getMessageRenderBoundarySelectorsV3: () => [
						(candidate: Readonly<MessageRenderBoundaryCandidateV3>) => {
							candidates.push(candidate);
							return () => ({ begin: "<begin>", body: "<body>", end: "<end>" });
						},
					],
					getMessageRenderProjectionObserversV1: () => [
						(projection: Readonly<MessageRenderProjectionV1>) => projections.push(projection),
					],
				}),
		getToolExecutionPresentationSelectorsV1: () => [
			() => ({
				liveToolCall: "compact-stock-header" as const,
				liveToolGroup: "compact-stock-header" as const,
				header: "exact-one-row" as const,
				settled: "canonical-initial-collapsed" as const,
			}),
		],
		getRegisteredToolDefinition: () => definition(),
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
		addMessageToChat: Reflect.get(InteractiveMode.prototype, "addMessageToChat"),
		createSemanticToolComponent: Reflect.get(InteractiveMode.prototype, "createSemanticToolComponent"),
		renderSemanticAssistantResponse: Reflect.get(InteractiveMode.prototype, "renderSemanticAssistantResponse"),
		publishMessageRenderProjectionV1: Reflect.get(InteractiveMode.prototype, "publishMessageRenderProjectionV1"),
		renderSessionItems: Reflect.get(InteractiveMode.prototype, "renderSessionItems"),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, projections, candidates, chatContainer, messageDecorator };
}

describe("InteractiveMode response projection", () => {
	beforeAll(() => initTheme("dark"));

	it("publishes the completed live turn once before rendering response-local Tool Group boundaries", async () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const assistantId = sessionManager.appendMessage(finalAssistant);
		const { mode, projections, candidates, chatContainer, messageDecorator } = modeHarness(sessionManager);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		const startAssistant = assistant([], "pending");

		await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
		await handleEvent.call(mode, { type: "message_start", message: startAssistant, entryId: assistantId });
		await handleEvent.call(mode, {
			type: "message_update",
			message: finalAssistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Answer", partial: finalAssistant },
			entryId: assistantId,
		});
		await handleEvent.call(mode, { type: "message_end", message: finalAssistant, entryId: assistantId });
		const rendered = chatContainer.render(80).join("\n");

		const completed = projections.flatMap((projection) =>
			projection.members.flatMap((member) =>
				member.role === "user" && member.completedTurn ? [member.completedTurn] : [],
			),
		);
		expect(completed).toEqual([
			{ assistantEntryId: assistantId, userPreview: "Question", assistantPreview: "Answer" },
		]);
		expect(projections.at(-1)?.members).toEqual([
			{ entryId: userId, blockId: userId, role: "user", completedTurn: completed[0] },
			{ entryId: assistantId, blockId: assistantId, role: "assistant" },
			{
				entryId: `tool-group:${assistantId}:tool-a`,
				blockId: `tool-group:${assistantId}:tool-a`,
				role: "tool-group",
				ownerEntryId: assistantId,
				groupId: `tool-group:${assistantId}:tool-a`,
				groupClosed: true,
			},
			{
				entryId: "tool-a",
				blockId: "tool-a",
				role: "tool",
				ownerEntryId: assistantId,
				groupId: `tool-group:${assistantId}:tool-a`,
				groupOrder: 0,
			},
			{
				entryId: "tool-b",
				blockId: "tool-b",
				role: "tool",
				ownerEntryId: assistantId,
				groupId: `tool-group:${assistantId}:tool-a`,
				groupOrder: 1,
			},
		]);
		expect(candidates.map(({ role, entryId }) => [role, entryId])).toEqual([
			["tool", "tool-a"],
			["tool", "tool-b"],
			["tool-group", `tool-group:${assistantId}:tool-a`],
		]);
		expect(messageDecorator).toHaveBeenCalledWith(
			expect.objectContaining({ entryId: assistantId, role: "assistant", state: "final" }),
		);
		expect(rendered).toContain("$ Read files, Ran commands");
	});

	it("delivers a completed projection through an extension-loaded runner", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-i4-projection-"));
		const extensionPath = path.join(tempDir, "projection-observer.ts");
		const observed: Readonly<MessageRenderProjectionV1>[] = [];
		const testGlobal = globalThis as typeof globalThis & {
			__piI4ProjectionObserver?: (projection: Readonly<MessageRenderProjectionV1>) => void;
		};
		testGlobal.__piI4ProjectionObserver = (projection) => observed.push(projection);
		try {
			fs.writeFileSync(
				extensionPath,
				`export default function (pi) {
	pi.registerMessageRenderProjectionObserverV1((projection) => globalThis.__piI4ProjectionObserver(projection));
}`,
			);
			const sessionManager = SessionManager.inMemory();
			const userId = sessionManager.appendMessage(user);
			const terminalAssistant = assistant([{ type: "text", text: "Done" }], "stop");
			const assistantId = sessionManager.appendMessage(terminalAssistant);
			const loaded = await loadExtensions([extensionPath], tempDir);
			expect(loaded.errors).toEqual([]);
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				await createInMemoryModelRegistry(AuthStorage.inMemory()),
			);
			const { mode } = modeHarness(sessionManager, runner);
			const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof mode,
				event: AgentSessionEvent,
			) => Promise<void>;

			await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
			await handleEvent.call(mode, {
				type: "message_start",
				message: assistant([], "pending"),
				entryId: assistantId,
			});
			await handleEvent.call(mode, {
				type: "message_end",
				message: terminalAssistant,
				entryId: assistantId,
			});

			expect(observed.at(-1)?.members[0]).toMatchObject({
				entryId: userId,
				completedTurn: { assistantEntryId: assistantId, userPreview: "Question", assistantPreview: "Done" },
			});
		} finally {
			delete testGlobal.__piI4ProjectionObserver;
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an immediate post-compaction message behind the transcript rebuild", async () => {
		let listener: ((event: { type: string }) => void) | undefined;
		let releaseFirst: () => void = () => {};
		const firstBarrier = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const order: string[] = [];
		const mode = {
			renderEventTail: Promise.resolve(),
			session: {
				subscribe: (candidate: (event: { type: string }) => void) => {
					listener = candidate;
					return vi.fn();
				},
			},
			handleEvent: async (event: { type: string }) => {
				order.push(`start:${event.type}`);
				if (event.type === "compaction_end") await firstBarrier;
				order.push(`end:${event.type}`);
			},
			handleRenderEventFailure: vi.fn(),
		};
		const subscribeToAgent = Reflect.get(InteractiveMode.prototype, "subscribeToAgent") as (
			this: typeof mode,
		) => void;

		subscribeToAgent.call(mode);
		listener?.({ type: "compaction_end" });
		listener?.({ type: "message_start" });
		await Promise.resolve();

		expect(order).toEqual(["start:compaction_end"]);
		releaseFirst();
		await vi.waitFor(() =>
			expect(order).toEqual([
				"start:compaction_end",
				"end:compaction_end",
				"start:message_start",
				"end:message_start",
			]),
		);
	});

	it("restores the same projection identity and order as the live path", async () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const assistantId = sessionManager.appendMessage(finalAssistant);
		const toolResult = (toolCallId: string): ToolResultMessage => ({
			role: "toolResult",
			toolCallId,
			toolName: toolCallId === "tool-a" ? "read" : "bash",
			content: [{ type: "text", text: `${toolCallId} result` }],
			isError: false,
			timestamp: 2,
		});
		const toolResultA = toolResult("tool-a");
		const toolResultB = toolResult("tool-b");
		sessionManager.appendMessage(toolResultA);
		sessionManager.appendMessage(toolResultB);
		const { mode: liveMode, projections: liveProjections, chatContainer: liveChat } = modeHarness(sessionManager);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof liveMode,
			event: AgentSessionEvent,
		) => Promise<void>;
		await handleEvent.call(liveMode, { type: "message_start", message: user, entryId: userId });
		await handleEvent.call(liveMode, {
			type: "message_start",
			message: assistant([], "pending"),
			entryId: assistantId,
		});
		await handleEvent.call(liveMode, { type: "message_end", message: finalAssistant, entryId: assistantId });
		await handleEvent.call(liveMode, {
			type: "tool_execution_end",
			toolCallId: "tool-a",
			toolName: "read",
			result: toolResultA,
			isError: false,
		});
		await handleEvent.call(liveMode, {
			type: "tool_execution_end",
			toolCallId: "tool-b",
			toolName: "bash",
			result: toolResultB,
			isError: false,
		});

		const {
			mode: restoredMode,
			projections: restoredProjections,
			chatContainer: restoredChat,
		} = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof restoredMode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(restoredMode, sessionManager.buildTranscriptEntries());

		const memberIdentity = (projection: Readonly<MessageRenderProjectionV1> | undefined) =>
			projection?.members.map(({ entryId, blockId, role }) => [entryId, blockId, role]);
		expect(restoredProjections).toHaveLength(1);
		expect(restoredProjections[0]?.mode).toBe("replace");
		expect(memberIdentity(restoredProjections[0])).toEqual(memberIdentity(liveProjections.at(-1)));
		expect(restoredChat.render(100)).toEqual(liveChat.render(100));
		expect(memberIdentity(restoredProjections[0])).toEqual([
			[userId, userId, "user"],
			[assistantId, assistantId, "assistant"],
			[`tool-group:${assistantId}:tool-a`, `tool-group:${assistantId}:tool-a`, "tool-group"],
			["tool-a", "tool-a", "tool"],
			["tool-b", "tool-b", "tool"],
		]);
	});
});
