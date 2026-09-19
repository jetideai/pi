import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type {
	MessageRenderBoundariesV1,
	MessageRenderBoundaryCandidateV3,
	MessageRenderBoundaryContextV1,
	MessageRenderProjectionV1,
	ToolDefinition,
} from "../src/core/extensions/types.ts";
import type { CustomMessage } from "../src/core/messages.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
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
	const messageDecorator = vi.fn(
		(_context: Readonly<MessageRenderBoundaryContextV1>): MessageRenderBoundariesV1 | undefined => undefined,
	);
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
		expect(projections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
		sessionManager.appendSemanticTurnSettlements();
		await handleEvent.call(mode, { type: "agent_settled" });
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

	it("completes one live turn at settlement with the last terminal assistant", async () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const firstAssistant = assistant([{ type: "text", text: "First answer" }], "stop");
		const finalAssistant = assistant([{ type: "text", text: "Final answer" }], "stop");
		const firstAssistantId = sessionManager.appendMessage(firstAssistant);
		const finalAssistantId = sessionManager.appendMessage(finalAssistant);
		const { mode, projections } = modeHarness(sessionManager);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;

		await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
		for (const [entryId, message] of [
			[firstAssistantId, firstAssistant],
			[finalAssistantId, finalAssistant],
		] as const) {
			await handleEvent.call(mode, {
				type: "message_start",
				message: assistant([], "pending"),
				entryId,
			});
			await handleEvent.call(mode, { type: "message_end", message, entryId });
		}
		expect(projections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
		const { mode: unsettledRestoredMode, projections: unsettledRestoredProjections } = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof unsettledRestoredMode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(unsettledRestoredMode, sessionManager.buildTranscriptEntries());
		expect(unsettledRestoredProjections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");

		sessionManager.appendSemanticTurnSettlements();
		await handleEvent.call(mode, { type: "agent_settled" });

		expect(projections.at(-1)?.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: finalAssistantId,
				userPreview: "Question",
				assistantPreview: "Final answer",
			},
		});
	});

	it("keeps a blank row after a completed-turn footer before a later assistant", async () => {
		const sessionManager = SessionManager.inMemory();
		const firstUser = { ...user, content: "Gamma" };
		const firstAssistant = assistant([{ type: "text", text: "First answer" }], "stop");
		const laterAssistant = assistant([{ type: "text", text: "Later async answer" }], "stop");
		const hiddenCustom = {
			role: "custom",
			customType: "hub-message",
			content: "hidden delivery metadata",
			display: false,
			timestamp: 1,
		} satisfies CustomMessage;
		const laterUser = { ...user, content: "Beta" };
		const firstUserId = sessionManager.appendMessage(firstUser);
		const firstAssistantId = sessionManager.appendMessage(firstAssistant);
		const { mode, projections, chatContainer, messageDecorator } = modeHarness(sessionManager);
		const terminal = new VirtualTerminal(80, 24);
		const tui: TUI = new TuiMainScreen(terminal);
		mode.ui = tui;
		tui.addChild(chatContainer);
		messageDecorator.mockImplementation((context) => {
			if (context.role !== "assistant") return undefined;
			const completedAssistantId = projections
				.at(-1)
				?.members.flatMap((member) =>
					member.role === "user" && member.completedTurn ? [member.completedTurn.assistantEntryId] : [],
				)[0];
			return {
				prefix: `\x1b]777;begin-${context.entryId}\x07`,
				suffix: `\x1b]777;end-${context.entryId}\x07`,
				...(context.entryId === completedAssistantId ? { reservedRows: 1 } : {}),
			};
		});
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;

		tui.start();
		await handleEvent.call(mode, { type: "message_start", message: firstUser, entryId: firstUserId });
		await handleEvent.call(mode, {
			type: "message_start",
			message: assistant([], "pending"),
			entryId: firstAssistantId,
		});
		await handleEvent.call(mode, {
			type: "message_end",
			message: firstAssistant,
			entryId: firstAssistantId,
		});
		sessionManager.appendSemanticTurnSettlements();
		await handleEvent.call(mode, { type: "agent_settled" });
		await terminal.waitForRender();

		const hiddenCustomId = sessionManager.appendCustomMessageEntry("hub-message", "hidden delivery metadata", false);
		const laterAssistantId = sessionManager.appendMessage(laterAssistant);
		await handleEvent.call(mode, {
			type: "message_start",
			message: hiddenCustom,
			entryId: hiddenCustomId,
		});
		await handleEvent.call(mode, {
			type: "message_end",
			message: hiddenCustom,
			entryId: hiddenCustomId,
		});
		await handleEvent.call(mode, {
			type: "message_start",
			message: assistant([], "pending"),
			entryId: laterAssistantId,
		});
		await handleEvent.call(mode, {
			type: "message_update",
			message: laterAssistant,
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta: "Later async answer",
				partial: laterAssistant,
			},
			entryId: laterAssistantId,
		});
		await handleEvent.call(mode, {
			type: "message_end",
			message: laterAssistant,
			entryId: laterAssistantId,
		});
		expect(sessionManager.appendSemanticTurnSettlements()).toContainEqual({
			userEntryId: firstUserId,
			assistantEntryId: firstAssistantId,
		});
		await handleEvent.call(mode, { type: "agent_settled" });
		await terminal.waitForRender();

		const renderedTranscript = chatContainer.render(80);
		const firstFooterRow = renderedTranscript.findIndex((line) => line.includes(`end-${firstAssistantId}`));
		const laterBoundaryRow = renderedTranscript.findIndex((line) => line.includes(`begin-${laterAssistantId}`));
		expect(projections.at(-1)?.members[0]).toMatchObject({
			completedTurn: { assistantEntryId: firstAssistantId },
		});
		expect(renderedTranscript.slice(firstFooterRow + 1, laterBoundaryRow)).toEqual([""]);

		let transcript = terminal.getScrollBuffer();
		const firstAnswerRow = transcript.findIndex((line) => line.includes("First answer"));
		const laterAnswerRow = transcript.findIndex((line) => line.includes("Later async answer"));
		expect(transcript.slice(firstAnswerRow + 1, laterAnswerRow).map((line) => line.trim())).toEqual(["", "", ""]);

		const laterUserId = sessionManager.appendMessage(laterUser);
		await handleEvent.call(mode, { type: "message_start", message: laterUser, entryId: laterUserId });
		await terminal.waitForRender();
		transcript = terminal.getScrollBuffer();
		const delayedUserRow = transcript.findIndex((line) => line.includes("Beta"));
		expect(transcript.slice(laterAnswerRow + 1, delayedUserRow).map((line) => line.trim())).toEqual(["", ""]);

		const { mode: restoredMode, projections: restoredProjections } = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof restoredMode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(restoredMode, sessionManager.buildTranscriptEntries());
		expect(restoredProjections.at(-1)?.members[0]).toEqual(projections.at(-1)?.members[0]);
		expect(restoredProjections.at(-1)?.members[0]).toMatchObject({
			completedTurn: { assistantEntryId: firstAssistantId },
		});
		tui.stop();
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
			expect(observed.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
			sessionManager.appendSemanticTurnSettlements();
			await handleEvent.call(mode, { type: "agent_settled" });

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

	it("keeps custom progress and expanded tool content inside the canonical restored turn region", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-turn-region-"));
		const extensionPath = path.join(tempDir, "progress-renderer.ts");
		try {
			fs.writeFileSync(
				extensionPath,
				`import { Text } from "@earendil-works/pi-tui";
export default function (pi) {
	pi.registerEntryRenderer("ad-process:update", () => new Text("[ad-process:update] working", 0, 0));
}`,
			);
			const loaded = await loadExtensions([extensionPath], tempDir);
			expect(loaded.errors).toEqual([]);
			const sessionManager = SessionManager.inMemory();
			sessionManager.appendMessage(user);
			const toolOwner = assistant(
				[{ type: "toolCall", id: "tool-a", name: "read", arguments: { path: "a" } }],
				"toolUse",
			);
			sessionManager.appendMessage(toolOwner);
			sessionManager.appendMessage({
				role: "toolResult",
				toolCallId: "tool-a",
				toolName: "read",
				content: [{ type: "text", text: "expanded result" }],
				isError: false,
				timestamp: 2,
			});
			sessionManager.appendCustomEntry("ad-process:update", { state: "working" });
			const terminalAssistant = assistant([{ type: "text", text: "Final answer" }], "stop");
			const terminalAssistantId = sessionManager.appendMessage(terminalAssistant);
			sessionManager.appendSemanticTurnSettlements();
			const runner = new ExtensionRunner(
				loaded.extensions,
				loaded.runtime,
				tempDir,
				sessionManager,
				await createInMemoryModelRegistry(AuthStorage.inMemory()),
			);
			const { mode, chatContainer, projections } = modeHarness(sessionManager, runner);
			Object.assign(mode, {
				getMessageRenderProjectionObserversV1: () => [
					(projection: Readonly<MessageRenderProjectionV1>) => projections.push(projection),
				],
			});
			mode.toolOutputExpanded = true;
			const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
				this: typeof mode,
				entries: ReturnType<SessionManager["getBranch"]>,
			) => void;

			renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());

			const rows = chatContainer.render(100).map(stripAnsi);
			const begin = rows.findIndex((row) => row.includes("Question"));
			const end = rows.findIndex((row) => row.includes("Final answer"));
			const progress = rows.findIndex((row) => row.includes("[ad-process:update] working"));
			const expandedTool = rows.findIndex((row) => row.includes("stock result"));
			expect(projections.at(-1)?.members[0]).toMatchObject({
				completedTurn: { assistantEntryId: terminalAssistantId },
			});
			expect(begin).toBeGreaterThanOrEqual(0);
			expect(progress).toBeGreaterThan(begin);
			expect(expandedTool).toBeGreaterThan(begin);
			expect(progress).toBeLessThan(end);
			expect(expandedTool).toBeLessThan(end);
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("restores the same projection identity and order as the live path", async () => {
		const sessionManager = SessionManager.inMemory();
		const originUser = {
			...user,
			initiator: { namespace: "agent-hub", agentId: "agent-a", registrationGeneration: 5 },
		};
		const userId = sessionManager.appendMessage(originUser);
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
		await handleEvent.call(liveMode, { type: "message_start", message: originUser, entryId: userId });
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
		sessionManager.appendSemanticTurnSettlements();
		await handleEvent.call(liveMode, { type: "agent_settled" });

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
		expect(restoredProjections[0]?.members[0]).toEqual(liveProjections.at(-1)?.members[0]);
		expect(restoredProjections[0]?.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: assistantId,
				initiator: { namespace: "agent-hub", agentId: "agent-a", registrationGeneration: 5 },
			},
		});
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
