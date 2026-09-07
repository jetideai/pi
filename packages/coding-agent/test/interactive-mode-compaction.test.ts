import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", async () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => Promise<void>;

		await renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				{
					message: expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
					entryId: undefined,
				},
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				{
					message: expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
					entryId: undefined,
				},
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("releases live rendering before rebuilding retained entries after compaction", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousMessage: SessionEntry = {
			type: "message",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			message: { role: "user", content: "original prompt", timestamp: 1 },
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			session: { isIdle: false },
			sessionManager: {
				buildContextEntries: vi.fn().mockReturnValue([latestCompaction]),
				buildTranscriptEntries: vi.fn().mockReturnValue([previousMessage]),
			},
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			startFreshMessageRenderScope: vi.fn(),
			releaseSettledMessageRendering: vi.fn(),
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			liveRenderContainer: undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			transcriptRebuildPending: false,
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.releaseSettledMessageRendering).toHaveBeenCalledTimes(1);
		expect(fakeThis.startFreshMessageRenderScope).toHaveBeenCalledTimes(1);
		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousMessage], { completeLastTurn: false });
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("defers a transcript rebuild until live assistant rendering settles", async () => {
		const liveRenderContainer = new Container();
		const fakeThis = {
			liveRenderContainer,
			streamingComponent: undefined,
			streamingMessage: undefined,
			transcriptRebuildPending: false,
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildTranscriptEntries: vi.fn().mockReturnValue([]) },
			renderSessionEntries: vi.fn(),
			startFreshMessageRenderScope: vi.fn(),
			session: { isIdle: false },
		};
		const rebuildChatFromMessages = Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages") as (
			this: typeof fakeThis,
		) => Promise<void>;

		await rebuildChatFromMessages.call(fakeThis);

		expect(fakeThis.transcriptRebuildPending).toBe(true);
		expect(fakeThis.liveRenderContainer).toBe(liveRenderContainer);
		expect(fakeThis.chatContainer.clear).not.toHaveBeenCalled();
		expect(fakeThis.renderSessionEntries).not.toHaveBeenCalled();
	});

	test("runs a deferred transcript rebuild after agent settlement", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			transcriptRebuildPending: true,
			liveRenderContainer: new Container() as Container | undefined,
			streamingComponent: undefined,
			streamingMessage: undefined,
			messageRenderMembers: [],
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildTranscriptEntries: vi.fn().mockReturnValue([]) },
			renderSessionEntries: vi.fn(),
			startFreshMessageRenderScope: vi.fn(),
			session: { isIdle: true },
			closeOpenMessageRenderGroup: vi.fn().mockReturnValue(true),
			releaseActiveAgentRunRendering: vi.fn(),
			releaseSettledMessageRendering: vi.fn(function (this: typeof fakeThis) {
				this.liveRenderContainer = undefined;
			}),
			rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
			checkShutdownRequested: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "agent_settled" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "agent_settled" });

		expect(fakeThis.releaseSettledMessageRendering).toHaveBeenCalledOnce();
		expect(fakeThis.chatContainer.clear).toHaveBeenCalledOnce();
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([], { completeLastTurn: true });
		expect(fakeThis.transcriptRebuildPending).toBe(false);
	});

	test("releases live rendering before replacing the current session transcript", async () => {
		const order: string[] = [];
		const fakeThis = {
			transcriptRebuildPending: true,
			startFreshMessageRenderScope: vi.fn(),
			loadedResourcesContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn(() => order.push("clear")) },
			pendingMessagesContainer: { clear: vi.fn() },
			compactionQueuedMessages: ["queued"],
			streamingComponent: {},
			streamingMessage: {},
			pendingTools: new Map([["tool", {}]]),
			releaseActiveAgentRunRendering: vi.fn(() => order.push("release-run")),
			releaseSettledMessageRendering: vi.fn(() => order.push("release-live")),
			renderInitialMessages: vi.fn(async () => order.push("render")),
		};
		const renderCurrentSessionState = Reflect.get(InteractiveMode.prototype, "renderCurrentSessionState") as (
			this: typeof fakeThis,
		) => Promise<void>;

		await renderCurrentSessionState.call(fakeThis);

		expect(order).toEqual(["release-run", "release-live", "clear", "render"]);
		expect(fakeThis.transcriptRebuildPending).toBe(false);
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn().mockResolvedValue(undefined),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("change direction", { streamingBehavior: "steer" });
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});
});
