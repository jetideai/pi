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
import { SEMANTIC_TURN_SETTLEMENT_CUSTOM_TYPE, SessionManager } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { toolCallOutcome, UncommittedToolResults } from "../src/modes/interactive/uncommitted-tool-results.ts";
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
		uncommittedToolResults: new UncommittedToolResults(),
		entriesRenderedByBoundaryCompaction: new Set<string>(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "scope-a",
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: false,
		streamingComponent: undefined,
		streamingMessage: undefined,
		semanticStreamingContainer: undefined,
		sessionManager,
		session: {
			retryAttempt: 0,
			modelRuntime: undefined,
			extensionRunner,
			state: { pendingToolCalls: new Set<string>() },
		},
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getShowCacheMissNotices: () => false,
			getShowTerminalProgress: () => false,
		},
		clearStatusIndicator: vi.fn(),
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

	it("publishes the completed live turn once before rendering the Tool Group boundaries of its response", async () => {
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
		await handleEvent.call(mode, { type: "agent_end", messages: [], willRetry: false });
		expect(projections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
		sessionManager.appendSemanticTurnSettlements(null);
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
				entryId: `tool-group:tool-a`,
				blockId: `tool-group:tool-a`,
				role: "tool-group",
				groupId: `tool-group:tool-a`,
				groupClosed: true,
			},
			{
				entryId: "tool-a",
				blockId: "tool-a",
				role: "tool",
				ownerEntryId: assistantId,
				groupId: `tool-group:tool-a`,
				groupOrder: 0,
			},
			{
				entryId: "tool-b",
				blockId: "tool-b",
				role: "tool",
				ownerEntryId: assistantId,
				groupId: `tool-group:tool-a`,
				groupOrder: 1,
			},
		]);
		expect(candidates.map(({ role, entryId }) => [role, entryId])).toEqual([
			["tool", "tool-a"],
			["tool", "tool-b"],
			["tool-group", `tool-group:tool-a`],
		]);
		expect(messageDecorator).toHaveBeenCalledWith(
			expect.objectContaining({ entryId: assistantId, role: "assistant", state: "final" }),
		);
		expect(rendered).toContain("$ Read files, Ran commands");
	});

	it("keeps a live turn open and infers the saved turn on restore", async () => {
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
			options?: { inferMissingTurns?: boolean },
		) => void;
		renderSessionEntries.call(unsettledRestoredMode, sessionManager.buildTranscriptEntries(), {
			inferMissingTurns: true,
		});
		expect(unsettledRestoredProjections.at(-1)?.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: finalAssistantId,
				userPreview: "Question",
				assistantPreview: "Final answer",
			},
		});
		expect(sessionManager.getSemanticTurnSettlements()).toEqual([]);

		sessionManager.appendSemanticTurnSettlements(null);
		await handleEvent.call(mode, { type: "agent_settled" });

		expect(projections.at(-1)?.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: finalAssistantId,
				userPreview: "Question",
				assistantPreview: "Final answer",
			},
		});
	});

	it("restores an unmarked disk session without changing its file", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-unmarked-turn-"));
		try {
			const original = SessionManager.create(tempDir, tempDir);
			const userId = original.appendMessage(user);
			const firstAssistantId = original.appendMessage(assistant([{ type: "text", text: "First answer" }], "stop"));
			const terminalAssistantId = original.appendMessage(
				assistant([{ type: "text", text: "Terminal answer" }], "length"),
			);
			const sessionFile = original.getSessionFile();
			expect(sessionFile).toBeDefined();
			const before = fs.readFileSync(sessionFile!, "utf8");

			for (let activation = 0; activation < 2; activation++) {
				const restored = SessionManager.open(sessionFile!);
				const { mode, projections } = modeHarness(restored);
				const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
					this: typeof mode,
					entries: ReturnType<SessionManager["getBranch"]>,
					options?: { inferMissingTurns?: boolean },
				) => void;

				renderSessionEntries.call(mode, restored.buildTranscriptEntries(), { inferMissingTurns: true });

				expect(projections.at(-1)?.members[0]).toMatchObject({
					entryId: userId,
					completedTurn: {
						assistantEntryId: terminalAssistantId,
						assistantPreview: "Terminal answer",
					},
				});
				expect(projections.at(-1)?.members[1]).toMatchObject({ entryId: firstAssistantId });
				expect(restored.getSemanticTurnSettlements()).toEqual([]);
				expect(fs.readFileSync(sessionFile!, "utf8")).toBe(before);
			}
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("keeps an unmarked active turn open during a live transcript rebuild", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant([{ type: "text", text: "Retryable answer" }], "length"));
		const { mode, projections } = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;

		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());

		expect(projections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
	});

	it("keeps conflicting persisted settlements closed during restore", () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const firstAssistantId = sessionManager.appendMessage(
			assistant([{ type: "text", text: "First answer" }], "stop"),
		);
		const laterAssistantId = sessionManager.appendMessage(
			assistant([{ type: "text", text: "Later answer" }], "stop"),
		);
		sessionManager.appendCustomEntry(SEMANTIC_TURN_SETTLEMENT_CUSTOM_TYPE, {
			userEntryId: userId,
			assistantEntryId: firstAssistantId,
		});
		sessionManager.appendCustomEntry(SEMANTIC_TURN_SETTLEMENT_CUSTOM_TYPE, {
			userEntryId: userId,
			assistantEntryId: laterAssistantId,
		});
		const { mode, projections } = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
			options?: { inferMissingTurns?: boolean },
		) => void;

		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries(), { inferMissingTurns: true });

		expect(sessionManager.getSemanticTurnSettlements()).toEqual([
			{ userEntryId: userId, assistantEntryId: firstAssistantId },
			{ userEntryId: userId, assistantEntryId: laterAssistantId },
		]);
		expect(projections.at(-1)?.members[0]).not.toHaveProperty("completedTurn");
	});

	it("infers only from the selected branch", () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const otherBranchAssistantId = sessionManager.appendMessage(
			assistant([{ type: "text", text: "Other branch answer" }], "stop"),
		);
		sessionManager.appendCustomEntry(SEMANTIC_TURN_SETTLEMENT_CUSTOM_TYPE, {
			userEntryId: userId,
			assistantEntryId: otherBranchAssistantId,
		});
		sessionManager.branch(userId);
		const selectedAssistantId = sessionManager.appendMessage(
			assistant([{ type: "text", text: "Selected branch answer" }], "stop"),
		);
		const { mode, projections } = modeHarness(sessionManager);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
			options?: { inferMissingTurns?: boolean },
		) => void;

		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries(), { inferMissingTurns: true });

		expect(sessionManager.getSemanticTurnSettlements()).toEqual([]);
		expect(projections.at(-1)?.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: selectedAssistantId,
				assistantPreview: "Selected branch answer",
			},
		});
	});

	it("persists exact settlements only for roots created by the current run", () => {
		const sessionManager = SessionManager.inMemory();
		const legacyUserId = sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant([{ type: "text", text: "Legacy answer" }], "stop"));
		const runBaseEntryId = sessionManager.getLeafId();
		const currentUserId = sessionManager.appendMessage({ ...user, content: "Current question" });
		const currentAssistantId = sessionManager.appendMessage(
			assistant([{ type: "text", text: "Current answer" }], "stop"),
		);

		sessionManager.appendSemanticTurnSettlements(runBaseEntryId);

		expect(sessionManager.getSemanticTurnSettlements()).toEqual([
			{ userEntryId: currentUserId, assistantEntryId: currentAssistantId },
		]);
		expect(sessionManager.getSemanticTurnSettlements()).not.toContainEqual(
			expect.objectContaining({ userEntryId: legacyUserId }),
		);
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
		sessionManager.appendSemanticTurnSettlements(null);
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
		expect(sessionManager.appendSemanticTurnSettlements(null)).toContainEqual({
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
			sessionManager.appendSemanticTurnSettlements(null);
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
			sessionManager.appendSemanticTurnSettlements(null);
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

	it("restores a saved call of a tool without a loaded extension as one whole-call block", () => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(user);
		const ownerId = sessionManager.appendMessage(
			assistant(
				[{ type: "toolCall", id: "call-process", name: "process", arguments: { action: "list" } }],
				"toolUse",
			),
		);
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-process",
			toolName: "process",
			content: [{ type: "text", text: "process output" }],
			isError: false,
			timestamp: 2,
		});
		const { mode, chatContainer } = modeHarness(sessionManager);
		const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
		const candidates: MessageRenderBoundaryCandidateV3[] = [];
		Object.assign(mode, {
			session: { ...mode.session, getToolDefinition: () => undefined },
			getRegisteredToolDefinition: Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition"),
			getMessageRenderBoundarySelectorsV3: () => [
				(candidate: Readonly<MessageRenderBoundaryCandidateV3>) => {
					candidates.push(candidate);
					return () => controls;
				},
			],
		});
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;

		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());

		const rows = chatContainer.render(100);
		const count = (marker: string) => rows.reduce((total, row) => total + row.split(marker).length - 1, 0);
		const begin = rows.findIndex((row) => row.includes(controls.begin));
		expect(candidates).toContainEqual(
			expect.objectContaining({
				entryId: "call-process",
				blockId: "call-process",
				role: "tool",
				ownerEntryId: ownerId,
			}),
		);
		expect([count(controls.begin), count(controls.body), count(controls.end)]).toEqual([1, 1, 1]);
		expect(stripAnsi(rows[begin]!).trim()).toBe("process");
		expect(rows.findIndex((row) => row.includes(controls.body))).toBe(begin + 1);
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
		await handleEvent.call(liveMode, { type: "agent_end", messages: [], willRetry: false });
		sessionManager.appendSemanticTurnSettlements(null);
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
			[`tool-group:tool-a`, `tool-group:tool-a`, "tool-group"],
			["tool-a", "tool-a", "tool"],
			["tool-b", "tool-b", "tool"],
		]);
	});
});

const foldControls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };

function savedToolResult(toolCallId: string, toolName: string, text: string): ToolResultMessage {
	return { role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 2 };
}

/** A restored transcript: the user question, the given assistant tool responses with results, and a final answer. */
function restoredTranscript(responses: AssistantMessage["content"][], hideThinkingBlock: boolean) {
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage(user);
	for (const content of responses) {
		sessionManager.appendMessage(assistant(content, "toolUse"));
		for (const call of content) {
			if (call.type === "toolCall")
				sessionManager.appendMessage(savedToolResult(call.id, call.name, `${call.id} output`));
		}
	}
	sessionManager.appendMessage(assistant([{ type: "text", text: "Done." }], "stop"));
	const { mode, chatContainer, projections } = modeHarness(sessionManager);
	Object.assign(mode, {
		hideThinkingBlock,
		session: { ...mode.session, getToolDefinition: () => undefined },
		getRegisteredToolDefinition: Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition"),
		getMessageRenderBoundarySelectorsV3: () => [() => () => foldControls],
	});
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: ReturnType<SessionManager["getBranch"]>,
	) => void;
	renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
	return { rows: chatContainer.render(100), members: projections.at(-1)?.members ?? [] };
}

/** The visible text of the rows that native shows when every Fold is collapsed. */
function collapsedRows(rows: string[]): string[] {
	const hidden = new Set<number>();
	// The body row of each open range, innermost last.
	const bodies: (number | undefined)[] = [];
	rows.forEach((row, index) => {
		for (const match of row.matchAll(/\x1b\]777;(begin|body|end)\x07/g)) {
			if (match[1] === "begin") bodies.push(undefined);
			else if (match[1] === "body") bodies[bodies.length - 1] ??= index;
			else {
				const body = bodies.pop();
				for (let hiddenRow = body ?? index + 1; hiddenRow <= index; hiddenRow++) hidden.add(hiddenRow);
			}
		}
	});
	return rows.flatMap((row, index) => {
		if (hidden.has(index)) return [];
		const text = stripAnsi(row).trim();
		return [/\x1b\[48;/.test(row) && text === "" ? "<shaded blank>" : text];
	});
}

const thinking = (text: string) => ({ type: "thinking" as const, thinking: text });
const toolCall = (id: string) => ({ type: "toolCall" as const, id, name: "process", arguments: { action: "list" } });

describe("restored Tool Group composition and separators", () => {
	beforeAll(() => initTheme("dark"));

	it("restores one response that calls read and an unknown tool as a group range around two call ranges", () => {
		const { rows } = restoredTranscript(
			[
				[
					{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "notes.md" } },
					toolCall("call-process"),
				],
			],
			true,
		);
		const rendered = rows.join("\n");

		expect(rendered.split(foldControls.begin)).toHaveLength(4);
		expect(rendered.split(foldControls.body)).toHaveLength(4);
		expect(stripAnsi(rendered)).toContain("call-read output");
	});

	it("groups consecutive restored tool-only responses whose thinking is hidden into one group without an owner", () => {
		const { rows, members } = restoredTranscript(
			[
				[thinking("Inspecting A"), toolCall("call-a")],
				[thinking("Inspecting B"), toolCall("call-b")],
			],
			true,
		);
		const tools = members.filter((member) => member.role === "tool");

		expect(members.find((member) => member.role === "tool-group")).toEqual({
			entryId: "tool-group:call-a",
			blockId: "tool-group:call-a",
			role: "tool-group",
			groupId: "tool-group:call-a",
			groupClosed: true,
		});
		expect(tools.map((member) => [member.entryId, member.groupId, member.groupOrder])).toEqual([
			["call-a", "tool-group:call-a", 0],
			["call-b", "tool-group:call-a", 1],
		]);
		expect(new Set(tools.map((member) => member.ownerEntryId)).size).toBe(2);
		expect(rows.join("\n").split(foldControls.begin)).toHaveLength(4);
	});

	it.each([
		["a displayed custom entry stops", true, ["tool-group:call-a", "tool-group:call-b"]],
		["a custom entry that renders nothing does not stop", false, ["tool-group:call-a", "tool-group:call-a"]],
	] as const)("%s a restored run of tool-only responses", (_name, displayed, groups) => {
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage(user);
		sessionManager.appendMessage(assistant([toolCall("call-a")], "toolUse"));
		sessionManager.appendMessage(savedToolResult("call-a", "process", "call-a output"));
		sessionManager.appendCustomEntry("progress", { text: "[progress]" });
		sessionManager.appendMessage(assistant([toolCall("call-b")], "toolUse"));
		sessionManager.appendMessage(savedToolResult("call-b", "process", "call-b output"));
		const { mode, projections } = modeHarness(sessionManager);
		Object.assign(mode, {
			session: {
				...mode.session,
				getToolDefinition: () => undefined,
				extensionRunner: { getEntryRenderer: () => (displayed ? () => new Text("[progress]", 0, 0) : undefined) },
			},
			getRegisteredToolDefinition: Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition"),
		});
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());

		expect(
			projections
				.at(-1)!
				.members.filter((member) => member.role === "tool")
				.map((member) => ("groupId" in member ? member.groupId : undefined)),
		).toEqual(groups);
	});

	it.each([
		["a section cut", { sections: [0, 0, 0, 1, 1] }],
		["the start of the loaded window", { window: { start: 3, end: 5, liveTail: true }, sections: [0, 0, 0, 0, 0] }],
	] as const)("stops a restored run of tool-only responses at %s", (_name, options) => {
		const sessionManager = SessionManager.inMemory();
		const items = [
			user,
			assistant([toolCall("call-a")], "toolUse"),
			savedToolResult("call-a", "process", "call-a output"),
			assistant([toolCall("call-b")], "toolUse"),
			savedToolResult("call-b", "process", "call-b output"),
		].map((message) => ({ message, entryId: sessionManager.appendMessage(message) }));
		const { mode, projections } = modeHarness(sessionManager);
		const renderSessionItems = Reflect.get(InteractiveMode.prototype, "renderSessionItems") as (
			this: typeof mode,
			items: readonly { message: unknown; entryId: string }[],
			options: object,
		) => void;
		renderSessionItems.call(mode, items, options);

		expect(
			projections
				.at(-1)!
				.members.filter((member) => member.role === "tool")
				.map((member) => ("groupId" in member ? member.groupId : undefined)),
		).toEqual(["tool-group:call-a", "tool-group:call-b"]);
	});

	it("keeps visible thinking between tool-only responses as a group boundary", () => {
		const { members } = restoredTranscript(
			[
				[thinking("Inspecting A"), toolCall("call-a")],
				[thinking("Inspecting B"), toolCall("call-b")],
			],
			false,
		);

		expect(members.filter((member) => member.role === "tool").map((member) => member.groupId)).toEqual([
			"tool-group:call-a",
			"tool-group:call-b",
		]);
	});

	it("keeps visible assistant prose between tool calls as a group boundary", () => {
		const { members } = restoredTranscript(
			[[toolCall("call-a")], [{ type: "text", text: "Visible prose." }, toolCall("call-b")]],
			true,
		);

		expect(members.filter((member) => member.role === "tool").map((member) => member.groupId)).toEqual([
			"tool-group:call-a",
			"tool-group:call-b",
		]);
	});

	it("restores settled thinking without rows when thinking is hidden", () => {
		const { rows } = restoredTranscript([[thinking("Inspecting A"), toolCall("call-a")]], true);

		expect(rows.some((row) => stripAnsi(row).includes("Inspecting A"))).toBe(false);
	});

	it("separates collapsed tool calls and visible thinking by one blank row", () => {
		const { rows } = restoredTranscript(
			[
				[thinking("Inspecting A"), toolCall("call-a")],
				[thinking("Inspecting B"), toolCall("call-b")],
			],
			false,
		);

		expect(collapsedRows(rows).slice(3, -2)).toEqual([
			"",
			"Inspecting A",
			"",
			"process",
			"",
			"Inspecting B",
			"",
			"process",
		]);
	});

	it("separates a collapsed Tool Group header from the previous block by one blank row", () => {
		const { rows } = restoredTranscript([[toolCall("call-a"), toolCall("call-b")]], true);

		expect(collapsedRows(rows).slice(3, -2)).toEqual(["", "$ Used tools"]);
	});
});

describe("live Tool Group composition across assistant responses", () => {
	beforeAll(() => initTheme("dark"));

	const markers = foldControls;
	/** The live harness with valid zero-column fold controls for every Tool Call and Tool Group. */
	const foldingHarness = (sessionManager: SessionManager) => {
		const harness = modeHarness(sessionManager);
		Object.assign(harness.mode, { getMessageRenderBoundarySelectorsV3: () => [() => () => foldControls] });
		return harness;
	};
	const count = (rows: string[], marker: string) =>
		rows.reduce((total, row) => total + row.split(marker).length - 1, 0);

	/** A live run: each response streams, ends, and its calls execute with one partial update before they end. */
	async function liveRun(responses: AssistantMessage["content"][], hideThinkingBlock: boolean) {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const { mode, projections, chatContainer } = foldingHarness(sessionManager);
		Object.assign(mode, { hideThinkingBlock });
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
		for (const content of responses) {
			const message = assistant(content, "toolUse");
			const entryId = sessionManager.appendMessage(message);
			await handleEvent.call(mode, { type: "message_start", message: assistant([], "pending"), entryId });
			await handleEvent.call(mode, { type: "message_end", message, entryId });
			for (const call of content) {
				if (call.type !== "toolCall") continue;
				await handleEvent.call(mode, {
					type: "tool_execution_start",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
				});
				await handleEvent.call(mode, {
					type: "tool_execution_update",
					toolCallId: call.id,
					toolName: call.name,
					args: call.arguments,
					partialResult: { content: [{ type: "text", text: `${call.id} partial` }] },
				});
				await handleEvent.call(mode, {
					type: "tool_execution_end",
					toolCallId: call.id,
					toolName: call.name,
					result: { content: [{ type: "text", text: `${call.id} done` }] },
					isError: false,
				});
			}
		}
		return { mode, handleEvent, projections, chatContainer };
	}

	it("keeps live visible prose between tool calls as a group boundary", async () => {
		const { projections } = await liveRun(
			[[toolCall("call-a")], [{ type: "text", text: "Visible prose." }, toolCall("call-b")]],
			true,
		);
		const tools = projections.at(-1)!.members.filter((member) => member.role === "tool");

		expect(tools.map((member) => ("groupId" in member ? member.groupId : undefined))).toEqual([
			"tool-group:call-a",
			"tool-group:call-b",
		]);
	});

	it("keeps a streamed Tool Group open at message_end and closes it at the end of the run as an append", async () => {
		const sessionManager = SessionManager.inMemory();
		const userId = sessionManager.appendMessage(user);
		const { mode, projections } = foldingHarness(sessionManager);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		await handleEvent.call(mode, { type: "agent_start" });
		await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
		const calls = [toolCall("call-a")];
		const message = assistant(calls, "toolUse");
		const entryId = sessionManager.appendMessage(message);
		await handleEvent.call(mode, { type: "message_start", message: assistant([], "pending"), entryId });
		await handleEvent.call(mode, {
			type: "message_update",
			message: assistant(calls, "pending"),
			entryId,
		} as AgentSessionEvent);
		const open = projections.length;
		await handleEvent.call(mode, { type: "message_end", message, entryId });
		await handleEvent.call(mode, { type: "agent_end", messages: [], willRetry: false });
		const groupClosed = projections
			.slice(open)
			.map((projection) => projection.members.find((member) => member.role === "tool-group"))
			.map((group) => (group && "groupClosed" in group ? group.groupClosed : undefined));

		expect({ modes: projections.slice(open).map((projection) => projection.mode), groupClosed }).toEqual({
			modes: ["append", "append"],
			groupClosed: [false, true],
		});
	});

	it("renders an active call in its own range and keeps that range when the call ends", async () => {
		const sessionManager = SessionManager.inMemory();
		const { mode, chatContainer } = foldingHarness(sessionManager);
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		const message = assistant([toolCall("call-a")], "toolUse");
		const entryId = sessionManager.appendMessage(message);
		await handleEvent.call(mode, { type: "message_start", message: assistant([], "pending"), entryId });
		await handleEvent.call(mode, { type: "message_end", message, entryId });
		await handleEvent.call(mode, {
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "process",
			args: {},
		});
		await handleEvent.call(mode, {
			type: "tool_execution_update",
			toolCallId: "call-a",
			toolName: "process",
			args: {},
			partialResult: { content: [{ type: "text", text: "partial line" }] },
		});
		const active = chatContainer.render(100);
		await handleEvent.call(mode, {
			type: "tool_execution_end",
			toolCallId: "call-a",
			toolName: "process",
			result: { content: [{ type: "text", text: "final line" }] },
			isError: false,
		});
		const settled = chatContainer.render(100);

		expect([count(active, markers.begin), count(settled, markers.begin)]).toEqual([1, 1]);
	});
});

describe("Tool Call execution results across a rebuild", () => {
	beforeAll(() => initTheme("dark"));

	/** A live run of one call: the response ends, then the call executes; the harness plays the agent state. */
	async function executingCall() {
		const sessionManager = SessionManager.inMemory();
		const harness = modeHarness(sessionManager);
		const { mode, chatContainer } = harness;
		// A tool without a definition in the stock presentation renders the text of its partial and final results.
		Object.assign(mode, {
			getToolExecutionPresentationSelectorsV1: () => [],
			getRegisteredToolDefinition: () => undefined,
			settingsManager: { ...mode.settingsManager, getShowTerminalProgress: () => false },
			clearStatusIndicator: vi.fn(),
		});
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		const userId = sessionManager.appendMessage(user);
		await handleEvent.call(mode, { type: "message_start", message: user, entryId: userId });
		const message = assistant([toolCall("call-a")], "toolUse");
		const entryId = sessionManager.appendMessage(message);
		await handleEvent.call(mode, { type: "message_start", message: assistant([], "pending"), entryId });
		await handleEvent.call(mode, { type: "message_end", message, entryId });
		mode.session.state.pendingToolCalls.add("call-a");
		await handleEvent.call(mode, {
			type: "tool_execution_start",
			toolCallId: "call-a",
			toolName: "process",
			args: {},
		});
		const update = (text: string) =>
			handleEvent.call(mode, {
				type: "tool_execution_update",
				toolCallId: "call-a",
				toolName: "process",
				args: {},
				partialResult: { content: [{ type: "text", text }] },
			});
		const end = async (text: string, isError: boolean) => {
			mode.session.state.pendingToolCalls.delete("call-a");
			await handleEvent.call(mode, {
				type: "tool_execution_end",
				toolCallId: "call-a",
				toolName: "process",
				result: { content: [{ type: "text", text }] },
				isError,
			});
		};
		/** The agent session persists the result before the event reaches the interactive mode. */
		const commit = async (text: string, isError: boolean) => {
			const result: ToolResultMessage = { ...savedToolResult("call-a", "process", text), isError };
			const resultId = sessionManager.appendMessage(result);
			await handleEvent.call(mode, { type: "message_start", message: result, entryId: resultId });
			await handleEvent.call(mode, { type: "message_end", message: result, entryId: resultId });
		};
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		/** Rebuild the chat from the history, as a window change does, and give its text. */
		const rebuild = () => {
			chatContainer.clear();
			renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
			return stripAnsi(chatContainer.render(100).join("\n"));
		};
		const text = () => stripAnsi(chatContainer.render(100).join("\n"));
		return { mode, handleEvent, update, end, commit, rebuild, text };
	}

	it("rebuilds an active call with its latest partial output and keeps later updates", async () => {
		const run = await executingCall();
		await run.update("partial one");

		const rebuilt = run.rebuild();
		await run.update("partial two");

		expect([rebuilt.includes("partial one"), run.text().includes("partial two")]).toEqual([true, true]);
	});

	it("rebuilds an ended call with its final result before the history commits it", async () => {
		const run = await executingCall();
		await run.update("partial one");
		await run.end("final result", false);

		expect(run.rebuild()).toContain("final result");
	});

	it("does not bring back the partial output of a call that never ended after the end of the run", async () => {
		const run = await executingCall();
		await run.update("partial one");
		run.mode.session.state.pendingToolCalls.delete("call-a");
		await run.handleEvent.call(run.mode, { type: "agent_end", messages: [], willRetry: false });

		expect(run.rebuild()).not.toContain("partial one");
	});

	it("gives an off-window call its committed error after the end of the run", async () => {
		const run = await executingCall();
		await run.update("partial one");
		// The window no longer shows the call: no component receives its end.
		run.mode.chatContainer.clear();
		run.mode.pendingTools.clear();
		await run.end("tool failed", true);
		await run.commit("tool failed", true);
		const afterCommit = run.mode.uncommittedToolResults.get("call-a");
		await run.handleEvent.call(run.mode, { type: "agent_end", messages: [], willRetry: false });

		expect([afterCommit, run.rebuild().includes("tool failed")]).toEqual([undefined, true]);
	});
});

describe("live Tool Group runs across responses", () => {
	beforeAll(() => initTheme("dark"));

	/** The harness with valid zero-column fold controls for every Tool Call and Tool Group. */
	const foldingHarness = (sessionManager: SessionManager) => {
		const harness = modeHarness(sessionManager);
		Object.assign(harness.mode, { getMessageRenderBoundarySelectorsV3: () => [() => () => foldControls] });
		return harness;
	};

	type Member = Readonly<MessageRenderProjectionV1>["members"][number];
	const groupOf = (member: Member) => ("groupId" in member ? member.groupId : undefined);
	const closedOf = (member: Member) => ("groupClosed" in member ? member.groupClosed : undefined);
	const orderOf = (member: Member) => ("groupOrder" in member ? member.groupOrder : undefined);
	const ownerOf = (member: Member) => ("ownerEntryId" in member ? member.ownerEntryId : undefined);
	const identity = (members: readonly Member[]) =>
		members.map((member) => [
			member.entryId,
			member.role,
			groupOf(member),
			orderOf(member),
			ownerOf(member),
			closedOf(member),
		]);

	/** One agent run on the production event path: each response streams, ends, and its calls execute and commit. */
	function liveAgentRun(hideThinkingBlock: boolean) {
		const sessionManager = SessionManager.inMemory();
		const harness = foldingHarness(sessionManager);
		const { mode } = harness;
		Object.assign(mode, { hideThinkingBlock, getRegisteredToolDefinition: () => undefined });
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof mode,
			event: AgentSessionEvent,
		) => Promise<void>;
		const emit = (event: unknown) => handleEvent.call(mode, event as AgentSessionEvent);
		const ids: string[] = [];
		return {
			...harness,
			sessionManager,
			emit,
			async start() {
				await emit({ type: "agent_start" });
				const userId = sessionManager.appendMessage(user);
				await emit({ type: "message_start", message: user, entryId: userId });
			},
			/** A response streams its content; with [end] it ends and is persisted. */
			async stream(content: AssistantMessage["content"], end = true) {
				const message = assistant(content, "toolUse");
				const entryId = end ? sessionManager.appendMessage(message) : `streaming-${ids.length}`;
				ids.push(entryId);
				await emit({ type: "message_start", message: assistant([], "pending"), entryId });
				await emit({ type: "message_update", message: assistant(content, "pending"), entryId });
				if (end) await emit({ type: "message_end", message, entryId });
				return { message, entryId };
			},
			async execute(id: string) {
				await emit({ type: "tool_execution_start", toolCallId: id, toolName: "process", args: {} });
				await emit({
					type: "tool_execution_update",
					toolCallId: id,
					toolName: "process",
					args: {},
					partialResult: { content: [{ type: "text", text: `${id} partial` }] },
				});
				const result = savedToolResult(id, "process", `${id} done`);
				await emit({ type: "tool_execution_end", toolCallId: id, toolName: "process", result, isError: false });
				const resultId = sessionManager.appendMessage(result);
				await emit({ type: "message_start", message: result, entryId: resultId });
				await emit({ type: "message_end", message: result, entryId: resultId });
			},
			end: () => emit({ type: "agent_end", messages: [], willRetry: false }),
		};
	}

	/** The members that a restore of the same history publishes. */
	function restoredMembers(sessionManager: SessionManager, hideThinkingBlock: boolean, extensionRunner?: unknown) {
		const { mode, projections } = foldingHarness(sessionManager);
		Object.assign(mode, { hideThinkingBlock, getRegisteredToolDefinition: () => undefined });
		if (extensionRunner) Object.assign(mode.session, { extensionRunner });
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
		return projections.at(-1)!.members;
	}

	it("grows one open group across tool-only responses with hidden thinking and closes it once at the end of the run", async () => {
		const run = liveAgentRun(true);
		await run.start();
		const first = run.projections.length;
		await run.stream([thinking("plan a"), toolCall("call-a")]);
		await run.execute("call-a");
		await run.stream([thinking("plan b"), toolCall("call-b")]);
		await run.execute("call-b");
		await run.end();
		const published = run.projections.slice(first);
		const groupStates = published.flatMap((projection) =>
			projection.members.filter((member) => member.role === "tool-group").map(closedOf),
		);
		const final = published.at(-1)!.members;

		expect({
			modes: [...new Set(published.map((projection) => projection.mode))],
			groupStates: [...new Set(groupStates)],
			lastGroupState: groupStates.at(-1),
			calls: final
				.filter((member) => member.role === "tool")
				.map((member) => [member.entryId, groupOf(member), orderOf(member)]),
			owners: new Set(final.filter((member) => member.role === "tool").map(ownerOf)).size,
		}).toEqual({
			modes: ["append"],
			groupStates: [false, true],
			lastGroupState: true,
			calls: [
				["call-a", "tool-group:call-a", 0],
				["call-b", "tool-group:call-a", 1],
			],
			owners: 2,
		});
		expect(identity(final)).toEqual(identity(restoredMembers(run.sessionManager, true)));
	});

	it("ends a run at intermediate assistant prose, which is not thinking", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		await run.stream([{ type: "text", text: "Профиль сохранён." }, toolCall("call-b")]);
		const groups = run.projections.at(-1)!.members.filter((member) => member.role === "tool-group");

		expect(groups.map((group) => [group.entryId, closedOf(group)])).toEqual([
			["tool-group:call-a", true],
			["tool-group:call-b", false],
		]);
	});

	it.each([
		["hidden thinking continues the run", true, ["tool-group:call-a", "tool-group:call-a"]],
		["visible thinking ends the run", false, ["tool-group:call-a", "tool-group:call-b"]],
	] as const)("%s", async (_name, hideThinkingBlock, groups) => {
		const run = liveAgentRun(hideThinkingBlock);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		await run.stream([thinking("checking b"), toolCall("call-b")]);

		expect(
			run.projections
				.at(-1)!
				.members.filter((member) => member.role === "tool")
				.map(groupOf),
		).toEqual(groups);
	});

	it.each([
		["a custom entry that renders content ends the run", true, ["tool-group:call-a", "tool-group:call-b"]],
		["a custom entry that renders nothing does not end the run", false, ["tool-group:call-a", "tool-group:call-a"]],
	] as const)("%s, live as on restore", async (_name, displayed, groups) => {
		const run = liveAgentRun(true);
		const extensionRunner = { getEntryRenderer: () => (displayed ? () => new Text("[progress]", 0, 0) : undefined) };
		Object.assign(run.mode.session, { extensionRunner });
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		const entryId = run.sessionManager.appendCustomEntry("progress", { text: "[progress]" });
		await run.emit({ type: "entry_appended", entry: run.sessionManager.getEntry(entryId) });
		await run.stream([toolCall("call-b")]);
		await run.execute("call-b");
		await run.end();
		const live = run.projections.at(-1)!.members;

		expect(live.filter((member) => member.role === "tool").map(groupOf)).toEqual(groups);
		expect(identity(live)).toEqual(identity(restoredMembers(run.sessionManager, true, extensionRunner)));
	});

	it.each([
		["a shown cache miss notice", "maybeShowCacheMissNotice"],
		["a shown thinking dropped notice", "maybeShowThinkingDropNotice"],
	] as const)("ends the live run at %s after a response", async (_name, notice) => {
		const run = liveAgentRun(true);
		let shown = true;
		Object.assign(run.mode, { [notice]: () => shown });
		await run.start();
		await run.stream([toolCall("call-a")]);
		shown = false;
		await run.execute("call-a");
		await run.stream([toolCall("call-b")]);

		expect(
			run.projections
				.at(-1)!
				.members.filter((member) => member.role === "tool")
				.map(groupOf),
		).toEqual(["tool-group:call-a", "tool-group:call-b"]);
	});

	it("joins a call once at its response commit after a visible entry that arrived while its arguments streamed", async () => {
		const run = liveAgentRun(true);
		const extensionRunner = { getEntryRenderer: () => () => new Text("[progress]", 0, 0) };
		Object.assign(run.mode.session, { extensionRunner });
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		const content: AssistantMessage["content"] = [thinking("plan b"), toolCall("call-b")];
		const message = assistant(content, "toolUse");
		// The agent session reserves the entry ID of a response that starts before its persistence.
		const entryId = run.sessionManager.reserveEntryId();
		const published = run.projections.length;
		await run.emit({ type: "message_start", message: assistant([], "pending"), entryId });
		await run.emit({ type: "message_update", message: assistant(content, "pending"), entryId });
		const progress = run.sessionManager.appendCustomEntry("progress", { text: "[progress]" });
		await run.emit({ type: "entry_appended", entry: run.sessionManager.getEntry(progress) });
		// The agent session persists the response at its end, after the entry, before the event reaches the mode.
		run.sessionManager.appendMessage(message, entryId);
		await run.emit({ type: "message_end", message, entryId });
		await run.execute("call-b");
		await run.end();
		const text = stripAnsi(run.chatContainer.render(100).join("\n"));
		const final = run.projections.at(-1)!.members;
		const calls = (members: readonly Member[]) => members.filter((member) => member.role === "tool").map(groupOf);

		expect({
			modes: [...new Set(run.projections.slice(published).map((projection) => projection.mode))],
			live: calls(final),
			restored: calls(restoredMembers(run.sessionManager, true, extensionRunner)),
			shownCalls: text.split("process").length - 1,
			progressBeforeB: text.indexOf("[progress]") < text.lastIndexOf("process"),
		}).toEqual({
			modes: ["append"],
			live: ["tool-group:call-a", "tool-group:call-b"],
			restored: ["tool-group:call-a", "tool-group:call-b"],
			shownCalls: 2,
			progressBeforeB: true,
		});
	});

	it("shows no draft call while its arguments stream and keeps the visible prose of the response", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		await run.stream([{ type: "text", text: "Checking the profile." }, toolCall("call-b")], false);
		const text = stripAnsi(run.chatContainer.render(100).join("\n"));
		const members = run.projections.at(-1)!.members;

		expect({
			prose: text.includes("Checking the profile."),
			shownCalls: text.split("process").length - 1,
			draft: members.filter((member) => member.entryId === "call-b" || member.entryId === "tool-group:call-b"),
		}).toEqual({ prose: true, shownCalls: 1, draft: [] });
	});

	it("appends a committed call to the open group of a singleton without a change to the published members", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		const before = run.projections.at(-1)!.members;
		const published = run.projections.length;
		await run.stream([thinking("plan b"), toolCall("call-b")]);
		const after = run.projections.at(-1)!.members;

		expect({
			modes: [...new Set(run.projections.slice(published).map((projection) => projection.mode))],
			prefix: identity(after.slice(0, before.length)),
			joined: after
				.filter((member) => member.entryId === "call-b")
				.map((member) => [groupOf(member), orderOf(member)]),
		}).toEqual({ modes: ["append"], prefix: identity(before), joined: [["tool-group:call-a", 1]] });
	});

	it("does not show a draft call after a rebuild while its arguments stream", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		await run.stream([thinking("plan b"), toolCall("call-b")], false);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof run.mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		run.chatContainer.clear();
		renderSessionEntries.call(run.mode, run.sessionManager.buildTranscriptEntries());
		const text = stripAnsi(run.chatContainer.render(100).join("\n"));

		expect({
			shownCalls: text.split("process").length - 1,
			draft: run.projections.at(-1)!.members.filter((member) => member.entryId === "call-b"),
		}).toEqual({ shownCalls: 1, draft: [] });
	});

	it("gives a call of an aborted response a cancelled outcome and no uncommitted failure result", async () => {
		const run = liveAgentRun(true);
		await run.start();
		const message = assistant([toolCall("call-a")], "aborted");
		const entryId = run.sessionManager.appendMessage(message);
		await run.emit({ type: "message_start", message: assistant([], "pending"), entryId });
		await run.emit({ type: "message_end", message, entryId });

		expect([toolCallOutcome(message, undefined), run.mode.uncommittedToolResults.get("call-a")]).toEqual([
			"cancelled",
			undefined,
		]);
	});

	it.each([
		// The new group header goes above A: when A has left the screen, that one change is a full redraw.
		["above the screen", 40, 1],
		["on the screen", 1, 0],
	] as const)(
		"forms a group with its first call %s and draws later partial output without a full redraw",
		async (_name, lines, formation) => {
			const run = liveAgentRun(true);
			const terminal = new VirtualTerminal(80, 8);
			const tui = new TuiMainScreen(terminal);
			Object.assign(run.mode, { ui: tui });
			tui.addChild(run.chatContainer);
			tui.start();
			const settle = async () => {
				tui.requestRender();
				await terminal.waitForRender();
			};
			await run.start();
			await run.stream([toolCall("call-a")]);
			const longOutput = Array.from({ length: lines }, (_, line) => `a line ${line + 1}`).join("\n");
			await run.emit({ type: "tool_execution_start", toolCallId: "call-a", toolName: "process", args: {} });
			await run.emit({
				type: "tool_execution_end",
				toolCallId: "call-a",
				toolName: "process",
				result: { content: [{ type: "text", text: longOutput }] },
				isError: false,
			});
			await settle();
			const beforeGroup = tui.fullRedraws;
			await run.stream([thinking("plan b"), toolCall("call-b")]);
			await settle();
			const beforePartials = tui.fullRedraws;
			await run.emit({ type: "tool_execution_start", toolCallId: "call-b", toolName: "process", args: {} });
			let output = "";
			for (let line = 1; line <= 10; line++) {
				output += `${line > 1 ? "\n" : ""}b line ${line}`;
				await run.emit({
					type: "tool_execution_update",
					toolCallId: "call-b",
					toolName: "process",
					args: {},
					partialResult: { content: [{ type: "text", text: output }] },
				});
				await settle();
			}
			tui.stop();

			expect({ formation: beforePartials - beforeGroup, partials: tui.fullRedraws - beforePartials }).toEqual({
				formation,
				partials: 0,
			});
		},
	);

	it("keeps a live-only thinking dropped notice in its visible order, which a restore without it merges", async () => {
		const run = liveAgentRun(true);
		let shown = true;
		Object.assign(run.mode, { maybeShowThinkingDropNotice: () => shown });
		await run.start();
		await run.stream([toolCall("call-a")]);
		shown = false;
		await run.execute("call-a");
		await run.stream([toolCall("call-b")]);
		await run.execute("call-b");
		await run.end();
		const calls = (members: readonly Member[]) => members.filter((member) => member.role === "tool").map(groupOf);

		// The history does not keep the notice, so a reload composes one run: a replace with the default Fold state.
		expect([calls(run.projections.at(-1)!.members), calls(restoredMembers(run.sessionManager, true))]).toEqual([
			["tool-group:call-a", "tool-group:call-b"],
			["tool-group:call-a", "tool-group:call-a"],
		]);
	});

	it("shows no placeholder for hidden thinking while it streams", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([thinking("secret plan")], false);
		const text = stripAnsi(run.chatContainer.render(100).join("\n"));

		expect([text.includes("Thinking..."), text.includes("secret plan")]).toEqual([false, false]);
	});

	it("mounts the streaming response again after a rebuild and keeps its call in the open group", async () => {
		const run = liveAgentRun(true);
		await run.start();
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		const streamed = await run.stream([toolCall("call-b")], false);
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof run.mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		run.chatContainer.clear();
		renderSessionEntries.call(run.mode, run.sessionManager.buildTranscriptEntries());
		const rebuilt = run.projections.length;
		const message = assistant([toolCall("call-b")], "toolUse");
		await run.emit({ type: "message_end", message, entryId: streamed.entryId });
		const text = stripAnsi(run.chatContainer.render(100).join("\n"));

		expect({
			modes: run.projections.slice(rebuilt).map((projection) => projection.mode),
			callB: run.projections
				.at(-1)!
				.members.filter((member) => member.entryId === "call-b")
				.map((member) => [groupOf(member), orderOf(member)]),
			shownCalls: text.split("process").length - 1,
		}).toEqual({ modes: ["append"], callB: [["tool-group:call-a", 1]], shownCalls: 2 });
	});

	it("keeps an older loaded window unchanged while an unsolicited run works, and shows the run from history later", async () => {
		const run = liveAgentRun(true);
		Object.assign(run.mode, {
			loadedTranscript: {
				sessionId: run.sessionManager.getSessionId(),
				leafId: null,
				from: "older",
				to: "older",
				liveTail: false,
			},
		});
		const children = run.chatContainer.children.length;
		await run.start();
		const published = run.projections.length;
		await run.stream([toolCall("call-a")]);
		await run.execute("call-a");
		await run.end();
		const kept = {
			children: run.chatContainer.children.length,
			// The Timeline still gets every member of the run, as members that the loaded window does not render.
			runLoaded: [
				...new Set(
					run.projections.slice(published).flatMap((projection) => projection.members.map((m) => m.loaded)),
				),
			],
			pending: run.mode.pendingTools.size,
		};
		Object.assign(run.mode, { loadedTranscript: undefined });
		run.chatContainer.clear();
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof run.mode,
			entries: ReturnType<SessionManager["getBranch"]>,
		) => void;
		renderSessionEntries.call(run.mode, run.sessionManager.buildTranscriptEntries());

		expect({ kept, later: stripAnsi(run.chatContainer.render(100).join("\n")).includes("call-a done") }).toEqual({
			kept: { children, runLoaded: [false], pending: 0 },
			later: true,
		});
	});
});

describe("restored cache miss boundaries", () => {
	it.each([
		["a cache miss below the notice threshold does not cut", 100, [undefined, undefined, undefined]],
		["a shown cache miss notice cuts the run after its response", 50_000, [undefined, true, undefined]],
	] as const)("%s", (_name, missedTokens, cuts) => {
		const sessionManager = SessionManager.inMemory();
		const { mode } = modeHarness(sessionManager);
		const first = assistant([toolCall("call-a")], "toolUse");
		const items = [
			{ message: first, entryId: "assistant-a" },
			{ message: savedToolResult("call-a", "process", "a"), entryId: "result-a" },
			{ message: assistant([toolCall("call-b")], "toolUse"), entryId: "assistant-b" },
		];
		const miss = { missedTokens, missedCost: 0, modelChanged: false, idleMs: 0 };
		const toolGroupRunItems = Reflect.get(InteractiveMode.prototype, "toolGroupRunItems") as (
			this: typeof mode,
			...args: unknown[]
		) => { cutBefore?: boolean }[];

		const runItems = toolGroupRunItems.call(mode, items, new Map([[first, miss]]), undefined, undefined);

		expect(runItems.map((item) => item.cutBefore)).toEqual(cuts);
	});
});
