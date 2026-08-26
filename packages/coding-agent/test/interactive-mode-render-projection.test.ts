import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type {
	MessageRenderBoundarySelectorV2,
	MessageRenderBoundarySelectorV3,
	ToolPresentationOverrideV1,
} from "../src/core/extensions/types.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import type { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type RenderItem = {
	message: ReturnType<typeof fauxAssistantMessage>;
	entryId: string;
};

type RenderSessionItems = (
	this: RenderProjectionContext,
	items: readonly RenderItem[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionItemsWithResults = (
	this: RenderProjectionContext,
	items: readonly ({ message: AgentMessage; entryId: string } | Extract<SessionEntry, { type: "custom" }>)[],
) => void;

type RenderMember = {
	entryId: string;
	role: "user" | "assistant" | "tool-group" | "tool";
	ownerEntryId?: string;
	groupId?: string;
	groupOrder?: number;
	groupClosed?: boolean;
};

type PublishMessageRenderProjection = (
	this: {
		session: {
			extensionRunner: {
				getMessageRenderProjectionObserversV1(): Array<(projection: { members: readonly RenderMember[] }) => void>;
			};
		};
	},
	members: readonly RenderMember[],
) => void;

type RenderProjectionContext = {
	messageRenderMembers: RenderMember[];
	hideThinkingBlock?: boolean;
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer?: { addChild(component: unknown): void; clear?(): void };
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowCacheMissNotices(): boolean;
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: {
		getEntries(): SessionEntry[];
		getCwd(): string;
		buildTranscriptEntries?(): SessionEntry[];
	};
	session: { modelRuntime: undefined };
	outputPad: number;
	toolOutputExpanded: boolean;
	updateEditorBorderColor(): void;
	addMessageToChat(message: RenderItem["message"], options: { entryId: string }): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	getMessageRenderBoundaryDecoratorsV1?(): [];
	getMessageRenderBoundarySelectorsV2?(): MessageRenderBoundarySelectorV2[];
	getMessageRenderBoundarySelectorsV3?(): MessageRenderBoundarySelectorV3[];
	getToolPresentationOverridesV1?(): ToolPresentationOverrideV1[];
	getToolExecutionPresentationSelectorsV1?(): [];
	renderAssistantAtoms: (...args: never[]) => unknown;
	publishMessageRenderProjectionV1(
		members: readonly RenderMember[],
		mode: "append" | "replace",
		finalized?: RenderItem,
	): void;
};

const renderAssistantAtoms = (
	InteractiveMode.prototype as unknown as { renderAssistantAtoms: (...args: never[]) => unknown }
).renderAssistantAtoms;

type FinalizeAssistantContext = {
	isInitialized: boolean;
	messageRenderMembers: RenderMember[];
	footer: { invalidate(): void };
	settingsManager: { getShowCacheMissNotices(): boolean };
	streamingComponent: { updateContent(message: RenderItem["message"], streaming: boolean): void } | undefined;
	streamingMessage: RenderItem["message"] | undefined;
	pendingTools: Map<string, ToolExecutionComponent>;
	session: { retryAttempt: number };
	ui: { requestRender(): void; renderNow(): void };
	maybeShowCacheMissNotice(message: RenderItem["message"]): void;
	publishMessageRenderProjectionV1(
		members: readonly RenderMember[],
		mode: "append" | "replace",
		finalized?: RenderItem,
	): void;
};

type HandleEvent = (
	this: FinalizeAssistantContext,
	event:
		| { type: "message_update"; message: RenderItem["message"]; entryId: string; assistantMessageEvent: unknown }
		| { type: "message_end"; message: RenderItem["message"]; entryId: string },
) => Promise<void>;

type StartUserContext = {
	isInitialized: boolean;
	messageRenderMembers: RenderMember[];
	footer: { invalidate(): void };
	ui: { requestRender(): void };
	addMessageToChat(message: AgentMessage, options: { entryId: string }): void;
	updatePendingMessagesDisplay(): void;
	publishMessageRenderProjectionV1(
		members: readonly RenderMember[],
		mode: "append" | "replace",
		finalized?: { entryId: string; message: AgentMessage },
	): void;
};

function createRenderUi() {
	return { requestRender: vi.fn(), renderNow: vi.fn() };
}

function createRenderProjectionContext(options: {
	onComponent?: (component: unknown) => void;
	onMessage?: () => void;
}): RenderProjectionContext {
	return {
		messageRenderMembers: [] as RenderMember[],
		hideThinkingBlock: false,
		pendingTools: new Map(),
		chatContainer: { addChild: (component) => options.onComponent?.(component) },
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn(), renderNow: vi.fn(), terminal: { setProgress: vi.fn() } } as unknown as TUI,
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 60,
		},
		sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
		session: { modelRuntime: undefined },
		outputPad: 1,
		toolOutputExpanded: false,
		updateEditorBorderColor: vi.fn(),
		addMessageToChat: () => options.onMessage?.(),
		getRegisteredToolDefinition: () => undefined,
		getMessageRenderBoundaryDecoratorsV1: () => [],
		getMessageRenderBoundarySelectorsV2: (): MessageRenderBoundarySelectorV2[] => [],
		getMessageRenderBoundarySelectorsV3: (): MessageRenderBoundarySelectorV3[] => [],
		getToolPresentationOverridesV1: () => [],
		getToolExecutionPresentationSelectorsV1: () => [],
		renderAssistantAtoms,
		publishMessageRenderProjectionV1: vi.fn(),
	};
}

function createLiveEventMode(chatContainer = new Container()) {
	const mode = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: createRenderUi() as unknown as TUI,
		chatContainer,
		streamingComponent: undefined,
		streamingMessage: undefined,
		liveRenderContainer: undefined,
		liveAssistantRenderEntries: [],
		liveToolComponents: new Map(),
		pendingTools: new Map(),
		messageRenderMembers: [] as RenderMember[],
		hideThinkingBlock: false,
		messageRenderOpenToolGroup: undefined as { groupId: string; nextOrder: number } | undefined,
		pendingInitialSemanticFoldCandidates: new Map(),
		publishMessageRenderProjectionV1: vi.fn(),
		session: { retryAttempt: 0, isStreaming: true },
		hiddenThinkingLabel: "",
		outputPad: 0,
		toolOutputExpanded: false,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowTerminalProgress: () => false,
			setOutputPad: vi.fn(),
		},
		sessionManager: { getCwd: () => process.cwd() },
		getMarkdownThemeWithSettings: vi.fn(),
		getMarkdownTransformers: () => [],
		getMessageRenderBoundaryDecoratorsV1: () => [],
		getMessageRenderBoundarySelectorsV2: (): MessageRenderBoundarySelectorV2[] => [],
		getToolPresentationOverridesV1: () => [],
		getToolExecutionPresentationSelectorsV1: () => [],
		getRegisteredToolDefinition: () => undefined,
		maybeShowCacheMissNotice: vi.fn(),
		retryEscapeHandler: undefined,
		workingVisible: false,
		clearStatusIndicator: vi.fn(),
		checkShutdownRequested: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return mode;
}

function representativeToolResponses() {
	const response = (entryId: string, toolCallId: string, toolName: "bash" | "edit" | "read", text?: string) => {
		const started = fauxAssistantMessage("");
		const toolCall = { type: "toolCall" as const, id: toolCallId, name: toolName, arguments: {} };
		return {
			entryId,
			started,
			message: { ...started, content: text ? [{ type: "text" as const, text }, toolCall] : [toolCall] },
			toolCall,
		};
	};
	return [
		response("assistant-edit-1", "edit-1", "edit", "Start edits"),
		response("assistant-read-1", "read-1", "read"),
		response("assistant-edit-2", "edit-2", "edit"),
		response("assistant-bash-1", "bash-1", "bash"),
		response("assistant-bash-2", "bash-2", "bash", "First separator"),
		response("assistant-bash-3", "bash-3", "bash", "Second separator"),
		response("assistant-bash-4", "bash-4", "bash", "Third separator"),
		response("assistant-bash-5", "bash-5", "bash"),
	];
}

function representativeToolResult(toolCallId: string, toolName: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text: `${toolCallId} complete` }],
		isError: false,
		timestamp: 1,
	};
}

function representativeGroupFacts(members: readonly RenderMember[]) {
	return members.filter((member) => member.role === "tool-group" || member.role === "tool");
}

function expectedRepresentativeGroupFacts(): RenderMember[] {
	return [
		{
			entryId: "tool-group:edit-1",
			role: "tool-group",
			groupId: "tool-group:edit-1",
			groupClosed: true,
		},
		...[
			["edit-1", "assistant-edit-1"],
			["read-1", "assistant-read-1"],
			["edit-2", "assistant-edit-2"],
			["bash-1", "assistant-bash-1"],
		].map(([entryId, ownerEntryId], groupOrder) => ({
			entryId: entryId!,
			ownerEntryId: ownerEntryId!,
			role: "tool" as const,
			groupId: "tool-group:edit-1",
			groupOrder,
		})),
		{ entryId: "bash-2", ownerEntryId: "assistant-bash-2", role: "tool" },
		{ entryId: "bash-3", ownerEntryId: "assistant-bash-3", role: "tool" },
		{
			entryId: "tool-group:bash-4",
			role: "tool-group",
			groupId: "tool-group:bash-4",
			groupClosed: true,
		},
		{
			entryId: "bash-4",
			ownerEntryId: "assistant-bash-4",
			role: "tool",
			groupId: "tool-group:bash-4",
			groupOrder: 0,
		},
		{
			entryId: "bash-5",
			ownerEntryId: "assistant-bash-5",
			role: "tool",
			groupId: "tool-group:bash-4",
			groupOrder: 1,
		},
	];
}

describe("InteractiveMode message render projection", () => {
	beforeAll(() => initTheme("dark"));

	it("rebuilds a compacted session from every original selected-branch message", async () => {
		const user = (id: string, parentId: string | null, text: string): SessionEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: { role: "user", content: text, timestamp: 1 },
		});
		const assistant = (id: string, parentId: string, text: string): SessionEntry => ({
			type: "message",
			id,
			parentId,
			timestamp: "2026-01-01T00:00:00.000Z",
			message: fauxAssistantMessage(text),
		});
		const transcript = [
			user("user-1", null, "one"),
			assistant("assistant-1", "user-1", "first"),
			user("user-2", "assistant-1", "two"),
			assistant("assistant-2", "user-2", "second"),
			user("user-3", "assistant-2", "three"),
			assistant("assistant-3", "user-3", "third"),
		];
		const compaction: SessionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: "assistant-3",
			timestamp: "2026-01-01T00:00:01.000Z",
			summary: "one first two second three third",
			firstKeptEntryId: "assistant-3",
			tokensBefore: 100,
		};
		const mode = createRenderProjectionContext({});
		const buildTranscriptEntries = vi.fn(() => transcript);
		mode.sessionManager = {
			getEntries: () => [...transcript, compaction],
			getCwd: () => process.cwd(),
			buildTranscriptEntries,
		};
		Object.assign(mode, {
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
		});
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		await InteractiveMode.prototype.renderInitialMessages.call(mode as never);

		expect(buildTranscriptEntries).toHaveBeenCalledOnce();
		expect(mode.publishMessageRenderProjectionV1).toHaveBeenLastCalledWith(
			transcript.map((entry) => ({
				entryId: entry.id,
				role: entry.type === "message" ? entry.message.role : undefined,
			})),
			"replace",
		);
	});

	it("keeps live identity order when rebuilding only the selected branch after rewind", async () => {
		const sessionManager = SessionManager.inMemory();
		const rootUser = sessionManager.appendMessage({ role: "user", content: "root", timestamp: 1 });
		const rootAssistant = sessionManager.appendMessage(fauxAssistantMessage("root answer"));
		const branchAUser = sessionManager.appendMessage({ role: "user", content: "branch A", timestamp: 2 });
		const branchAAssistant = sessionManager.appendMessage(fauxAssistantMessage("A answer"));
		sessionManager.branch(rootAssistant);
		const branchBUser = sessionManager.appendMessage({ role: "user", content: "branch B", timestamp: 3 });
		const branchBAssistant = sessionManager.appendMessage(fauxAssistantMessage("B answer"));
		const mode = createRenderProjectionContext({});
		mode.sessionManager = sessionManager;
		mode.chatContainer = new Container();
		Object.assign(mode, {
			renderProjectTrustWarningIfNeeded: vi.fn(),
			showStatus: vi.fn(),
		});
		Object.setPrototypeOf(mode, InteractiveMode.prototype);

		await InteractiveMode.prototype.renderInitialMessages.call(mode as never);
		const selectedBranchIds = [rootUser, rootAssistant, branchBUser, branchBAssistant];
		expect(mode.messageRenderMembers.map((member) => member.entryId)).toEqual(selectedBranchIds);

		const liveMode = createLiveEventMode();
		Object.assign(liveMode, {
			addMessageToChat: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		});
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		for (const entryId of selectedBranchIds) {
			const entry = sessionManager.getEntry(entryId);
			if (entry?.type !== "message") throw new Error(`Missing message ${entryId}`);
			await handleEvent.call(liveMode, { type: "message_start", message: entry.message, entryId });
			if (entry.message.role === "assistant") {
				await handleEvent.call(liveMode, { type: "message_end", message: entry.message, entryId });
			}
		}
		expect(liveMode.messageRenderMembers.map((member) => member.entryId)).toEqual(selectedBranchIds);

		sessionManager.branch(branchAAssistant);
		await (
			InteractiveMode.prototype as unknown as {
				rebuildChatFromMessages(this: RenderProjectionContext): Promise<void>;
			}
		).rebuildChatFromMessages.call(mode);

		expect(mode.messageRenderMembers.map((member) => member.entryId)).toEqual([
			rootUser,
			rootAssistant,
			branchAUser,
			branchAAssistant,
		]);
	});

	it("serializes asynchronous render events without blocking their producer", async () => {
		let listener: ((event: { type: string }) => void) | undefined;
		let releaseFirst: (() => void) | undefined;
		const firstBarrier = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const order: string[] = [];
		const fakeMode = {
			renderEventTail: Promise.resolve(),
			session: {
				subscribe: (candidate: (event: { type: string }) => void) => {
					listener = candidate;
					return vi.fn();
				},
			},
			handleEvent: async (event: { type: string }) => {
				order.push(`start:${event.type}`);
				if (event.type === "first") await firstBarrier;
				order.push(`end:${event.type}`);
			},
		};
		const subscribeToAgent = (
			InteractiveMode.prototype as unknown as {
				subscribeToAgent(this: typeof fakeMode): void;
			}
		).subscribeToAgent;

		subscribeToAgent.call(fakeMode);
		listener?.({ type: "first" });
		listener?.({ type: "second" });
		await Promise.resolve();

		expect(order).toEqual(["start:first"]);
		releaseFirst?.();
		await vi.waitFor(() => expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]));
	});

	it("continues the render event queue after one event fails", async () => {
		let listener: ((event: { type: string }) => void) | undefined;
		const handled: string[] = [];
		const failures: string[] = [];
		const fakeMode = {
			renderEventTail: Promise.resolve(),
			session: {
				subscribe: (candidate: (event: { type: string }) => void) => {
					listener = candidate;
					return vi.fn();
				},
			},
			handleEvent: async (event: { type: string }) => {
				if (event.type === "broken") throw new Error("render failed");
				handled.push(event.type);
			},
			handleRenderEventFailure: (event: { type: string }, error: unknown) => {
				failures.push(`${event.type}:${error instanceof Error ? error.message : String(error)}`);
			},
		};
		const subscribeToAgent = (
			InteractiveMode.prototype as unknown as {
				subscribeToAgent(this: typeof fakeMode): void;
			}
		).subscribeToAgent;

		subscribeToAgent.call(fakeMode);
		listener?.({ type: "broken" });
		listener?.({ type: "next" });

		await vi.waitFor(() => expect(handled).toEqual(["next"]));
		expect(failures).toEqual(["broken:render failed"]);
	});

	it("renders thinking followed by five Tool Calls as one Tool Group", () => {
		const added: unknown[] = [];
		const fakeMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "thinking" as const, thinking: "plan" },
				...Array.from({ length: 5 }, (_, index) => ({
					type: "toolCall" as const,
					id: `tool-${index + 1}`,
					name: "read",
					arguments: { path: `${index + 1}.txt` },
				})),
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(added.map((component) => (component as object).constructor.name)).toEqual(["ToolGroupComponent"]);
	});

	it("keeps Tool Calls around text in exact display order as two Tool Groups", () => {
		const displayOrder: string[] = [];
		const fakeMode = createRenderProjectionContext({
			onComponent: (component) => displayOrder.push((component as object).constructor.name),
			onMessage: () => displayOrder.push("assistant:text"),
		});
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-before", name: "read", arguments: { path: "one.txt" } },
				{ type: "text" as const, text: "separator" },
				{ type: "toolCall" as const, id: "tool-after", name: "read", arguments: { path: "two.txt" } },
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(displayOrder).toEqual(["ToolGroupComponent", "assistant:text", "ToolGroupComponent"]);
	});

	it("keeps streaming Tool Calls around text in exact display order as two Tool Groups", async () => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const streaming = {
			...started,
			content: [
				{ type: "toolCall" as const, id: "tool-before", name: "read", arguments: { path: "one.txt" } },
				{ type: "text" as const, text: "separator" },
				{ type: "toolCall" as const, id: "tool-after", name: "read", arguments: { path: "two.txt" } },
			],
		};

		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: streaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});

		const topLevel = chatContainer.children;
		const liveChildren = topLevel.length === 1 && topLevel[0] instanceof Container ? topLevel[0].children : topLevel;
		expect(liveChildren.map((component) => component.constructor.name)).toEqual([
			"ToolGroupComponent",
			"AssistantMessageComponent",
			"ToolGroupComponent",
		]);
	});

	it("publishes one live Tool Call as stock membership before its first render", async () => {
		const observed: RenderMember[][] = [];
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		fakeMode.session = {
			retryAttempt: 0,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: { members: readonly RenderMember[] }) => {
						const structure = projection.members.filter(
							(member) => member.role === "tool-group" || member.role === "tool",
						);
						if (structure.length > 0) {
							observed.push([...structure]);
						}
					},
				],
			},
		} as never;
		fakeMode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof fakeMode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const streaming = {
			...started,
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};

		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: streaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: {
				...streaming,
				content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "two.txt" } }],
			},
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		const group = (chatContainer.children[0] as Container).children[0] as ToolGroupComponent;
		group.render(80);

		expect(observed).toEqual([[{ entryId: "tool-1", ownerEntryId: "assistant-tools", role: "tool" }]]);
	});

	it("retains one streaming Tool Call child through execution updates", async () => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		fakeMode.getMessageRenderBoundarySelectorsV2 = () => [
			(candidate) =>
				candidate.role === "tool"
					? () => ({
							begin: "\x1b]777;tool-begin\x07",
							body: "\x1b]777;tool-body\x07",
							end: "\x1b]777;tool-end\x07",
						})
					: undefined,
		];
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const streaming = {
			...started,
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: streaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		const liveContainer = chatContainer.children[0] as Container;
		const group = liveContainer.children[0] as Container;
		const child = group.children[0] as ToolExecutionComponent;
		const updateResult = vi.spyOn(child, "updateResult");

		await handleEvent.call(fakeMode, {
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: {},
		});
		await handleEvent.call(fakeMode, {
			type: "tool_execution_update",
			toolCallId: "tool-1",
			partialResult: { content: [{ type: "text", text: "partial" }], details: undefined },
		});
		await handleEvent.call(fakeMode, {
			type: "tool_execution_end",
			toolCallId: "tool-1",
			result: { content: [{ type: "text", text: "complete" }], details: undefined },
			isError: false,
		});

		expect((liveContainer.children[0] as Container).children[0]).toBe(child);
		expect(updateResult).toHaveBeenNthCalledWith(
			1,
			{ content: [{ type: "text", text: "partial" }], details: undefined, isError: false },
			true,
		);
		expect(updateResult).toHaveBeenNthCalledWith(2, {
			content: [{ type: "text", text: "complete" }],
			details: undefined,
			isError: false,
		});
		const rendered = child.render(80).join("\n");
		expect(rendered).toContain("\x1b]777;tool-begin\x07");
		expect(rendered).toContain("\x1b]777;tool-body\x07");
		expect(stripAnsi(rendered)).toContain("complete");
	});

	it("marks the retained Tool Call failed when its assistant is aborted", async () => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const streaming = {
			...started,
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: streaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		const liveContainer = chatContainer.children[0] as Container;
		const group = liveContainer.children[0] as Container;
		const child = group.children[0] as ToolExecutionComponent;
		const updateResult = vi.spyOn(child, "updateResult");
		const aborted = { ...streaming, stopReason: "aborted" as const };

		await handleEvent.call(fakeMode, { type: "message_end", message: aborted, entryId: "assistant-tools" });

		expect((liveContainer.children[0] as Container).children).toEqual([child]);
		expect(updateResult).toHaveBeenCalledExactlyOnceWith({
			content: [{ type: "text", text: "Operation aborted" }],
			isError: true,
		});
	});

	it("retains the assistant error message on its failed Tool Call", async () => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const streaming = {
			...started,
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: streaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		const liveContainer = chatContainer.children[0] as Container;
		const group = liveContainer.children[0] as Container;
		const child = group.children[0] as ToolExecutionComponent;
		const updateResult = vi.spyOn(child, "updateResult");
		const failed = { ...streaming, stopReason: "error" as const, errorMessage: "Provider disconnected" };

		await handleEvent.call(fakeMode, { type: "message_end", message: failed, entryId: "assistant-tools" });

		expect((liveContainer.children[0] as Container).children).toEqual([child]);
		expect(updateResult).toHaveBeenCalledExactlyOnceWith({
			content: [{ type: "text", text: "Provider disconnected" }],
			isError: true,
		});
	});

	it("groups restored Tool Calls by visible separators across assistant responses", () => {
		const mode = createRenderProjectionContext({});
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		const items = representativeToolResponses().flatMap(({ entryId, message, toolCall }) => [
			{ entryId, message },
			{
				entryId: `result-${toolCall.id}`,
				message: representativeToolResult(toolCall.id, toolCall.name),
			},
		]);

		renderSessionItems.call(mode, items);

		expect(representativeGroupFacts(mode.messageRenderMembers)).toEqual(expectedRepresentativeGroupFacts());
	});

	it("keeps representative live and restored Tool Group projection and components identical", async () => {
		const responses = representativeToolResponses();
		const liveChat = new Container();
		const liveMode = createLiveEventMode(liveChat);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		for (const { entryId, started, message, toolCall } of responses) {
			await handleEvent.call(liveMode, { type: "message_start", message: started, entryId });
			await handleEvent.call(liveMode, {
				type: "message_update",
				message,
				entryId,
				assistantMessageEvent: {},
			});
			await handleEvent.call(liveMode, { type: "message_end", message, entryId });
			await handleEvent.call(liveMode, {
				type: "tool_execution_start",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				args: toolCall.arguments,
			});
			await handleEvent.call(liveMode, {
				type: "tool_execution_end",
				toolCallId: toolCall.id,
				result: representativeToolResult(toolCall.id, toolCall.name),
				isError: false,
			});
		}
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });

		const restoredChat = new Container();
		const restoredMode = createRenderProjectionContext({});
		restoredMode.chatContainer = restoredChat;
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		renderSessionItems.call(
			restoredMode,
			responses.flatMap(({ entryId, message, toolCall }) => [
				{ entryId, message },
				{
					entryId: `result-${toolCall.id}`,
					message: representativeToolResult(toolCall.id, toolCall.name),
				},
			]),
		);
		const componentGroupSizes = (container: Container) =>
			container.children
				.flatMap((component) =>
					component.constructor === Container ? (component as Container).children : [component],
				)
				.filter((component): component is ToolGroupComponent => component.constructor.name === "ToolGroupComponent")
				.map((component) => component.children.length);

		expect({
			live: representativeGroupFacts(liveMode.messageRenderMembers),
			restored: representativeGroupFacts(restoredMode.messageRenderMembers),
			liveComponentGroups: componentGroupSizes(liveChat),
			restoredComponentGroups: componentGroupSizes(restoredChat),
		}).toEqual({
			live: expectedRepresentativeGroupFacts(),
			restored: expectedRepresentativeGroupFacts(),
			liveComponentGroups: [4, 1, 1, 2],
			restoredComponentGroups: [4, 1, 1, 2],
		});
	});

	it("replaces a streaming singleton when the next response extends its stable Tool Group", async () => {
		const observed: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" }> = [];
		const mode = createLiveEventMode();
		mode.session = {
			retryAttempt: 0,
			isStreaming: true,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: (typeof observed)[number]) => observed.push(projection),
				],
			},
		} as never;
		mode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof mode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof mode, event: object): Promise<void>;
			}
		).handleEvent;
		const streamTool = async (entryId: string, toolCallId: string) => {
			const started = fauxAssistantMessage("");
			const message = {
				...started,
				content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
			};
			await handleEvent.call(mode, { type: "message_start", message: started, entryId });
			await handleEvent.call(mode, { type: "message_update", message, entryId, assistantMessageEvent: {} });
			await handleEvent.call(mode, { type: "message_end", message, entryId });
		};

		await streamTool("assistant-1", "tool-1");
		expect(observed.at(-1)?.members.filter((member) => member.role === "tool")).toEqual([
			{ entryId: "tool-1", ownerEntryId: "assistant-1", role: "tool" },
		]);

		await streamTool("assistant-2", "tool-2");

		const promoted = [...observed].reverse().find((projection) => projection.mode === "replace");
		expect(promoted).toEqual({
			mode: "replace",
			members: [
				{ entryId: "assistant-1", role: "assistant" },
				{
					entryId: "tool-group:tool-1",
					role: "tool-group",
					groupId: "tool-group:tool-1",
					groupClosed: false,
				},
				{
					entryId: "tool-1",
					ownerEntryId: "assistant-1",
					role: "tool",
					groupId: "tool-group:tool-1",
					groupOrder: 0,
				},
				{ entryId: "assistant-2", role: "assistant" },
				{
					entryId: "tool-2",
					ownerEntryId: "assistant-2",
					role: "tool",
					groupId: "tool-group:tool-1",
					groupOrder: 1,
				},
			],
		});
	});

	it("keeps one live and restored Tool Group across retry lifecycle events until settlement", async () => {
		const response = (entryId: string, toolCallId: string) => {
			const started = fauxAssistantMessage("");
			return {
				entryId,
				started,
				message: {
					...started,
					content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
				},
			};
		};
		const responses = [response("assistant-1", "tool-1"), response("assistant-2", "tool-2")];
		const liveChat = new Container();
		const liveMode = createLiveEventMode(liveChat);
		Object.assign(liveMode, { checkShutdownRequested: vi.fn() });
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const stream = async ({ entryId, started, message }: (typeof responses)[number]) => {
			await handleEvent.call(liveMode, { type: "message_start", message: started, entryId });
			await handleEvent.call(liveMode, { type: "message_update", message, entryId, assistantMessageEvent: {} });
			await handleEvent.call(liveMode, { type: "message_end", message, entryId });
		};

		await stream(responses[0]!);
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_start" });
		await stream(responses[1]!);
		await handleEvent.call(liveMode, { type: "agent_settled" });

		const restoredChat = new Container();
		const restoredMode = createRenderProjectionContext({});
		restoredMode.chatContainer = restoredChat;
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		renderSessionItems.call(
			restoredMode,
			responses.flatMap(({ entryId, message }, index) => [
				{ entryId, message },
				{
					entryId: `result-${index + 1}`,
					message: representativeToolResult(`tool-${index + 1}`, "read"),
				},
			]),
		);
		const componentGroupSizes = (container: Container) =>
			container.children
				.flatMap((component) =>
					component.constructor === Container ? (component as Container).children : [component],
				)
				.filter((component): component is ToolGroupComponent => component.constructor.name === "ToolGroupComponent")
				.map((component) => component.children.length);
		const expected = [
			{
				entryId: "tool-group:tool-1",
				role: "tool-group",
				groupId: "tool-group:tool-1",
				groupClosed: true,
			},
			{
				entryId: "tool-1",
				ownerEntryId: "assistant-1",
				role: "tool",
				groupId: "tool-group:tool-1",
				groupOrder: 0,
			},
			{
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:tool-1",
				groupOrder: 1,
			},
		];

		expect({
			live: representativeGroupFacts(liveMode.messageRenderMembers),
			restored: representativeGroupFacts(restoredMode.messageRenderMembers),
			liveComponents: componentGroupSizes(liveChat),
			restoredComponents: componentGroupSizes(restoredChat),
		}).toEqual({ live: expected, restored: expected, liveComponents: [2], restoredComponents: [2] });
	});

	it("uses a visible render failure as a terminal Tool Group separator", async () => {
		const mode = createLiveEventMode();
		Object.assign(mode, { checkShutdownRequested: vi.fn(), showError: vi.fn() });
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof mode, event: object): Promise<void>;
			}
		).handleEvent;
		const stream = async (entryId: string, toolCallId: string) => {
			const started = fauxAssistantMessage("");
			const message = {
				...started,
				content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
			};
			await handleEvent.call(mode, { type: "message_start", message: started, entryId });
			await handleEvent.call(mode, { type: "message_update", message, entryId, assistantMessageEvent: {} });
			await handleEvent.call(mode, { type: "message_end", message, entryId });
		};

		await stream("assistant-1", "tool-1");
		(
			InteractiveMode.prototype as unknown as {
				handleRenderEventFailure(this: typeof mode, event: object, error: unknown): void;
			}
		).handleRenderEventFailure.call(mode, { type: "message_update" }, new Error("render failed"));
		await stream("assistant-2", "tool-2");
		await handleEvent.call(mode, { type: "agent_settled" });

		expect(mode.messageRenderMembers.filter((member) => member.role === "tool")).toEqual([
			{ entryId: "tool-1", ownerEntryId: "assistant-1", role: "tool" },
			{ entryId: "tool-2", ownerEntryId: "assistant-2", role: "tool" },
		]);
		expect((mode as typeof mode & { showError: ReturnType<typeof vi.fn> }).showError).toHaveBeenCalledWith(
			"Failed to render message_update: render failed",
		);
	});

	it("publishes one closed Tool Call as stock membership in live and rebuilt projections", async () => {
		const liveMode = createLiveEventMode();
		const liveProjections: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" }> = [];
		const barrier = vi.fn();
		liveMode.session = {
			retryAttempt: 0,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: (typeof liveProjections)[number]) => liveProjections.push(projection),
				],
				getInitialSemanticFoldAdmissionV2: () => barrier,
			},
		} as never;
		liveMode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof liveMode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		(liveMode as typeof liveMode & { agentRunRenderAbortController: AbortController }).agentRunRenderAbortController =
			new AbortController();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const completed = {
			...started,
			content: [{ type: "toolCall" as const, id: "tool-only", name: "read", arguments: {} }],
		};
		await handleEvent.call(liveMode, { type: "message_start", message: started, entryId: "assistant-only" });
		await handleEvent.call(liveMode, {
			type: "message_update",
			message: completed,
			entryId: "assistant-only",
			assistantMessageEvent: {},
		});
		await handleEvent.call(liveMode, { type: "message_end", message: completed, entryId: "assistant-only" });
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });

		let rebuilt: readonly RenderMember[] = [];
		const rebuildMode = createRenderProjectionContext({});
		Object.setPrototypeOf(rebuildMode, InteractiveMode.prototype);
		rebuildMode.session = {
			modelRuntime: undefined,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: { members: readonly RenderMember[] }) => {
						rebuilt = projection.members;
					},
				],
			},
		} as never;
		rebuildMode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof rebuildMode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(rebuildMode, [{ message: completed, entryId: "assistant-only" }]);

		const expected = [
			{ entryId: "assistant-only", role: "assistant" },
			{ entryId: "tool-only", ownerEntryId: "assistant-only", role: "tool" },
		];
		expect({ live: liveProjections.at(-1)?.members, rebuilt }).toEqual({ live: expected, rebuilt: expected });
		expect(barrier).not.toHaveBeenCalled();
	});

	it("releases transient run state while retaining transcript grouping until settlement", async () => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const streamTool = async (entryId: string, toolCallId: string) => {
			const started = fauxAssistantMessage("");
			const streaming = {
				...started,
				content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
			};
			await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId });
			await handleEvent.call(fakeMode, {
				type: "message_update",
				message: streaming,
				entryId,
				assistantMessageEvent: {},
			});
			return streaming;
		};

		await handleEvent.call(fakeMode, { type: "agent_start" });
		const firstMessage = await streamTool("assistant-1", "tool-1");
		await handleEvent.call(fakeMode, { type: "message_end", message: firstMessage, entryId: "assistant-1" });
		const firstContainer = chatContainer.children[0] as Container;
		await handleEvent.call(fakeMode, { type: "agent_end" });

		expect({
			containerReleased: fakeMode.liveRenderContainer === undefined,
			entries: fakeMode.liveAssistantRenderEntries.length,
			tools: fakeMode.liveToolComponents.size,
			pending: fakeMode.pendingTools.size,
			retainedChildren: firstContainer.children.length,
		}).toEqual({ containerReleased: false, entries: 1, tools: 1, pending: 0, retainedChildren: 1 });

		await handleEvent.call(fakeMode, { type: "agent_start" });
		const secondMessage = await streamTool("assistant-2", "tool-2");
		const secondContainer = chatContainer.children[0] as Container;
		const publishedMembers = fakeMode.publishMessageRenderProjectionV1.mock.lastCall?.[0] as RenderMember[];
		expect({
			reusedContainer: secondContainer === firstContainer,
			childCount: (secondContainer.children[0] as Container).children.length,
			projectedTool: publishedMembers.find((member) => member.entryId === "tool-2"),
		}).toEqual({
			reusedContainer: true,
			childCount: 2,
			projectedTool: {
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:tool-1",
				groupOrder: 1,
			},
		});

		await handleEvent.call(fakeMode, { type: "message_end", message: secondMessage, entryId: "assistant-2" });
		await handleEvent.call(fakeMode, { type: "agent_settled" });
		expect({
			containerReleased: fakeMode.liveRenderContainer === undefined,
			entries: fakeMode.liveAssistantRenderEntries.length,
			tools: fakeMode.liveToolComponents.size,
			pending: fakeMode.pendingTools.size,
		}).toEqual({ containerReleased: true, entries: 0, tools: 0, pending: 0 });
	});

	it.each([
		{ label: "0 groups", groupCount: 0, toolCount: 0, componentCount: 1 },
		{ label: "1 group", groupCount: 1, toolCount: 32, componentCount: 1 },
		{ label: "32 groups", groupCount: 32, toolCount: 32, componentCount: 63 },
	])("bounds active-run composition work for $label", async ({ groupCount, toolCount, componentCount }) => {
		const chatContainer = new Container();
		const fakeMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const calls = Array.from({ length: toolCount }, (_, index) => ({
			type: "toolCall" as const,
			id: `tool-${index + 1}`,
			name: "read",
			arguments: {},
		}));
		const content: AssistantMessage["content"] =
			groupCount === 0
				? [{ type: "text", text: "streaming text" }]
				: groupCount === 1
					? calls
					: calls.flatMap((call, index) =>
							index === calls.length - 1 ? [call] : [call, { type: "text" as const, text: `split-${index}` }],
						);
		await handleEvent.call(fakeMode, { type: "agent_start" });
		await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(fakeMode, {
			type: "message_update",
			message: { ...started, content },
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});

		const liveContainer = chatContainer.children[0] as Container;
		const groups = liveContainer.children.filter((component) => component.constructor.name === "ToolGroupComponent");
		expect({
			components: liveContainer.children.length,
			groups: groups.length,
			retainedTools: fakeMode.liveToolComponents.size,
			pendingTools: fakeMode.pendingTools.size,
		}).toEqual({
			components: componentCount,
			groups: groupCount,
			retainedTools: toolCount,
			pendingTools: toolCount,
		});
	});

	it("keeps Tool Results transparent inside one cross-response Tool Group", () => {
		const added: unknown[] = [];
		const fakeMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		const first = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		const result = {
			role: "toolResult" as const,
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "one" }],
			isError: false,
			timestamp: 1,
		};
		const second = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-2", name: "read", arguments: { path: "two.txt" } }],
		};

		renderSessionItems.call(fakeMode, [
			{ message: first, entryId: "assistant-1" },
			{ message: result, entryId: "result-1" },
			{ message: second, entryId: "assistant-2" },
		]);

		expect(added.map((component) => (component as object).constructor.name)).toEqual(["ToolGroupComponent"]);
		expect((added[0] as ToolGroupComponent).children).toHaveLength(2);
	});

	it("uses a user message as a live and restored cross-response Tool Group separator", async () => {
		const added: unknown[] = [];
		const mode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		const tool = (id: string) => ({
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id, name: "read", arguments: {} }],
		});
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;

		renderSessionItems.call(mode, [
			{ message: tool("tool-1"), entryId: "assistant-1" },
			{ message: { role: "user", content: "continue", timestamp: 1 }, entryId: "user-2" },
			{ message: tool("tool-2"), entryId: "assistant-2" },
		]);

		expect(added.map((component) => (component as object).constructor.name)).toEqual([
			"ToolGroupComponent",
			"ToolGroupComponent",
		]);
		expect(mode.messageRenderMembers.filter((member) => member.role === "tool")).toEqual([
			{ entryId: "tool-1", ownerEntryId: "assistant-1", role: "tool" },
			{ entryId: "tool-2", ownerEntryId: "assistant-2", role: "tool" },
		]);

		const liveChat = new Container();
		const liveMode = createLiveEventMode(liveChat);
		Object.assign(liveMode, { addMessageToChat: vi.fn(), updatePendingMessagesDisplay: vi.fn() });
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const stream = async (entryId: string, message: ReturnType<typeof tool>) => {
			await handleEvent.call(liveMode, { type: "message_start", message, entryId });
			await handleEvent.call(liveMode, { type: "message_end", message, entryId });
		};
		await stream("assistant-1", tool("tool-1"));
		await handleEvent.call(liveMode, {
			type: "message_start",
			message: { role: "user", content: "continue", timestamp: 1 },
			entryId: "user-2",
		});
		await stream("assistant-2", tool("tool-2"));
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });

		expect(liveMode.messageRenderMembers).toEqual(mode.messageRenderMembers);
		expect(
			liveChat.children
				.flatMap((component) =>
					component.constructor === Container ? (component as Container).children : [component],
				)
				.filter((component) => component.constructor.name === "ToolGroupComponent"),
		).toHaveLength(2);
	});

	it("uses displayed custom entries as cross-response Tool Group separators", async () => {
		const first = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		const second = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-2", name: "read", arguments: { path: "two.txt" } }],
		};
		const result = (toolCallId: string, text: string) => ({
			role: "toolResult" as const,
			toolCallId,
			toolName: "read",
			content: [{ type: "text" as const, text }],
			isError: false,
			timestamp: 1,
		});
		const customEntry: Extract<SessionEntry, { type: "custom" }> = {
			type: "custom",
			id: "custom-progress",
			parentId: "assistant-1",
			timestamp: "2026-08-19T00:00:00.000Z",
			customType: "progress",
			data: { label: "working" },
		};
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: object, event: object): Promise<void>;
			}
		).handleEvent;
		const streamAssistant = async (
			mode: ReturnType<typeof createLiveEventMode>,
			entryId: string,
			message: typeof first,
		) => {
			const started = fauxAssistantMessage("");
			await handleEvent.call(mode, { type: "message_start", message: started, entryId });
			await handleEvent.call(mode, { type: "message_update", message, entryId, assistantMessageEvent: {} });
			await handleEvent.call(mode, { type: "message_end", message, entryId });
			await handleEvent.call(mode, {
				type: "tool_execution_start",
				toolCallId: message.content[0].id,
				toolName: "read",
				args: message.content[0].arguments,
			});
			await handleEvent.call(mode, {
				type: "tool_execution_end",
				toolCallId: message.content[0].id,
				result: result(message.content[0].id, message.content[0].id),
				isError: false,
			});
		};

		const liveChat = new Container();
		const liveMode = createLiveEventMode(liveChat);
		liveMode.session = {
			retryAttempt: 0,
			isStreaming: true,
			extensionRunner: { getEntryRenderer: () => () => new Text("progress", 0, 0) },
		} as never;
		await streamAssistant(liveMode, "assistant-1", first);
		await handleEvent.call(liveMode, { type: "entry_appended", entry: customEntry });
		await streamAssistant(liveMode, "assistant-2", second);
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });

		const livePresentation = liveChat.children.flatMap((component) =>
			component.constructor === Container ? (component as Container).children : [component],
		);
		const liveProjection = [...liveMode.messageRenderMembers];

		const restoredChat = new Container();
		const restoredMode = createRenderProjectionContext({});
		Object.setPrototypeOf(restoredMode, InteractiveMode.prototype);
		restoredMode.chatContainer = restoredChat;
		restoredMode.session = {
			modelRuntime: undefined,
			extensionRunner: { getEntryRenderer: () => () => new Text("progress", 0, 0) },
		} as never;
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		renderSessionItems.call(restoredMode, [
			{ message: first, entryId: "assistant-1" },
			{ message: result("tool-1", "one"), entryId: "result-1" },
			customEntry,
			{ message: second, entryId: "assistant-2" },
			{ message: result("tool-2", "two"), entryId: "result-2" },
		]);

		const groupFacts = (members: readonly RenderMember[]) =>
			members.filter((member) => member.role === "tool-group" || member.role === "tool");
		expect(groupFacts(liveProjection)).toEqual([
			{
				entryId: "tool-1",
				ownerEntryId: "assistant-1",
				role: "tool",
			},
			{
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
			},
		]);
		expect(restoredMode.messageRenderMembers).toEqual(liveProjection);
		expect(groupFacts(restoredMode.messageRenderMembers)).toEqual(groupFacts(liveProjection));
		expect(livePresentation.map((component) => component.constructor.name)).toEqual([
			"ToolGroupComponent",
			"CustomEntryComponent",
			"ToolGroupComponent",
		]);
		expect(restoredChat.children.map((component) => component.constructor.name)).toEqual(
			livePresentation.map((component) => component.constructor.name),
		);
	});

	it("keeps custom entries without renderers transparent across responses", () => {
		const added: unknown[] = [];
		const fakeMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		Object.setPrototypeOf(fakeMode, InteractiveMode.prototype);
		fakeMode.session = {
			modelRuntime: undefined,
			extensionRunner: { getEntryRenderer: () => undefined },
		} as never;
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		const tool = (id: string, path: string) => ({
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id, name: "read", arguments: { path } }],
		});

		renderSessionItems.call(fakeMode, [
			{ message: tool("tool-1", "one.txt"), entryId: "assistant-1" },
			{
				type: "custom",
				id: "custom-progress",
				parentId: "assistant-1",
				timestamp: "2026-08-19T00:00:00.000Z",
				customType: "progress",
			},
			{ message: tool("tool-2", "two.txt"), entryId: "assistant-2" },
		]);

		expect(added.map((component) => (component as object).constructor.name)).toEqual(["ToolGroupComponent"]);
		expect(fakeMode.messageRenderMembers.filter((member) => member.role === "tool")).toEqual([
			{
				entryId: "tool-1",
				ownerEntryId: "assistant-1",
				role: "tool",
				groupId: "tool-group:tool-1",
				groupOrder: 0,
			},
			{
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:tool-1",
				groupOrder: 1,
			},
		]);
	});

	it("rebuilds one completed Tool Call with its complete canonical body", () => {
		const added: unknown[] = [];
		const fakeMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		fakeMode.getMessageRenderBoundarySelectorsV2 = () => [
			(candidate) =>
				candidate.role === "tool"
					? () => ({
							begin: "\x1b]777;tool-begin\x07",
							body: "\x1b]777;tool-body\x07",
							end: "\x1b]777;tool-end\x07",
						})
					: undefined,
		];
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		const assistant = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } }],
		};
		const result = {
			role: "toolResult" as const,
			toolCallId: "tool-1",
			toolName: "read",
			content: [{ type: "text" as const, text: "rebuilt complete marker" }],
			isError: false,
			timestamp: 1,
		};

		renderSessionItems.call(fakeMode, [
			{ message: assistant, entryId: "assistant-1" },
			{ message: result, entryId: "result-1" },
		]);

		const group = added[0] as ToolGroupComponent;
		const rendered = group.render(80).join("\n");
		expect(rendered).toContain("\x1b]777;tool-begin\x07");
		expect(rendered).toContain("\x1b]777;tool-body\x07");
		expect(stripAnsi(rendered)).toContain("rebuilt complete marker");
	});

	it("keeps completed singleton V3 rows and membership equal in live and restored rendering", async () => {
		const controls = {
			begin: "\x1b]777;singleton-v3-begin\x07",
			body: "\x1b]777;singleton-v3-body\x07",
			end: "\x1b]777;singleton-v3-end\x07",
		};
		const selector: MessageRenderBoundarySelectorV3 = () => () => controls;
		const assistant = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-v3", name: "read", arguments: { path: "one.txt" } }],
		};
		const result = {
			role: "toolResult" as const,
			toolCallId: "tool-v3",
			toolName: "read",
			content: [{ type: "text" as const, text: "singleton V3 result" }],
			isError: false,
			timestamp: 1,
		};

		const liveChat = new Container();
		const liveMode = createLiveEventMode(liveChat) as ReturnType<typeof createLiveEventMode> & {
			messageRenderScopeId: string;
			getMessageRenderBoundarySelectorsV3(): MessageRenderBoundarySelectorV3[];
		};
		liveMode.messageRenderScopeId = "scope-v3";
		liveMode.getMessageRenderBoundarySelectorsV3 = () => [selector];
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(liveMode, {
			type: "message_start",
			message: fauxAssistantMessage(""),
			entryId: "assistant-v3",
		});
		await handleEvent.call(liveMode, {
			type: "message_update",
			message: assistant,
			entryId: "assistant-v3",
			assistantMessageEvent: {},
		});
		await handleEvent.call(liveMode, {
			type: "tool_execution_start",
			toolCallId: "tool-v3",
			toolName: "read",
			args: { path: "one.txt" },
		});
		await handleEvent.call(liveMode, {
			type: "tool_execution_end",
			toolCallId: "tool-v3",
			result,
			isError: false,
		});
		await handleEvent.call(liveMode, {
			type: "message_end",
			message: assistant,
			entryId: "assistant-v3",
		});
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });

		const liveContainer = liveChat.children[0] as Container;
		const liveGroup = liveContainer.children[0] as ToolGroupComponent;
		const liveTool = liveGroup.children[0] as ToolExecutionComponent;
		const liveRows = liveTool.render(8);
		const liveMembers = (
			liveMode.publishMessageRenderProjectionV1 as unknown as { mock: { lastCall?: [readonly RenderMember[]] } }
		).mock.lastCall?.[0];

		const added: unknown[] = [];
		const restoredMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		restoredMode.getMessageRenderBoundarySelectorsV3 = () => [selector];
		(restoredMode as RenderProjectionContext & { messageRenderScopeId: string }).messageRenderScopeId = "scope-v3";
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		renderSessionItems.call(restoredMode, [
			{ message: assistant, entryId: "assistant-v3" },
			{ message: result, entryId: "result-v3" },
		]);

		const restoredGroup = added[0] as ToolGroupComponent;
		const restoredTool = restoredGroup.children[0] as ToolExecutionComponent;
		const restoredRows = restoredTool.render(8);
		const restoredMembers = (
			restoredMode.publishMessageRenderProjectionV1 as unknown as {
				mock: { lastCall?: [readonly RenderMember[]] };
			}
		).mock.lastCall?.[0];

		expect(restoredRows).toEqual(liveRows);
		expect(restoredMembers).toEqual(liveMembers);
	});

	it("does not split a Tool Group at empty text", () => {
		const added: unknown[] = [];
		const fakeMode = createRenderProjectionContext({ onComponent: (component) => added.push(component) });
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-before", name: "read", arguments: { path: "one.txt" } },
				{ type: "text" as const, text: "  \n" },
				{ type: "toolCall" as const, id: "tool-after", name: "read", arguments: { path: "two.txt" } },
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(added.map((component) => (component as object).constructor.name)).toEqual(["ToolGroupComponent"]);
	});

	it("updates a closed live Tool Group after output padding changes and matches restore", async () => {
		const selector: MessageRenderBoundarySelectorV2 = (candidate) =>
			candidate.role === "tool-group" ? () => ({ begin: "", body: "", end: "" }) : undefined;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-first", name: "read", arguments: { path: "one.txt" } },
				{ type: "toolCall" as const, id: "tool-second", name: "bash", arguments: { command: "pwd" } },
				{ type: "text" as const, text: "done" },
			],
		};
		const chatContainer = new Container();
		const liveMode = createLiveEventMode(chatContainer);
		liveMode.getMessageRenderBoundarySelectorsV2 = () => [selector];
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const setOutputPad = (
			InteractiveMode.prototype as unknown as {
				setOutputPad(this: typeof liveMode, padding: 0 | 1): void;
			}
		).setOutputPad;

		await handleEvent.call(liveMode, {
			type: "message_start",
			message: fauxAssistantMessage(""),
			entryId: "assistant-tools",
		});
		await handleEvent.call(liveMode, {
			type: "message_update",
			message,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		await handleEvent.call(liveMode, {
			type: "message_end",
			message,
			entryId: "assistant-tools",
		});
		const liveHeader = () => {
			const liveContainer = chatContainer.children[0] as Container;
			return stripAnsi(liveContainer.children[0]!.render(80)[0]!);
		};
		expect(liveHeader()).toBe("$ Read files, Ran commands");

		setOutputPad.call(liveMode, 1);
		expect(liveHeader()).toBe(" $ Read files, Ran commands");

		const restored: unknown[] = [];
		const restoredMode = createRenderProjectionContext({ onComponent: (component) => restored.push(component) });
		restoredMode.outputPad = 1;
		restoredMode.getMessageRenderBoundarySelectorsV2 = () => [selector];
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(restoredMode, [{ message, entryId: "assistant-tools" }]);

		expect(stripAnsi((restored[0] as ToolGroupComponent).render(80)[0]!)).toBe(liveHeader());
	});

	it("does not split restored Tool Groups at hidden settled thinking", () => {
		const displayOrder: string[] = [];
		const fakeMode = createRenderProjectionContext({
			onComponent: (component) => displayOrder.push((component as object).constructor.name),
			onMessage: () => displayOrder.push("assistant:thinking"),
		});
		fakeMode.hideThinkingBlock = true;
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-before", name: "read", arguments: { path: "one.txt" } },
				{ type: "thinking" as const, thinking: "independent visual" },
				{ type: "toolCall" as const, id: "tool-after", name: "read", arguments: { path: "two.txt" } },
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(displayOrder).toEqual(["ToolGroupComponent"]);
	});

	it("splits restored Tool Groups at visible thinking", () => {
		const displayOrder: string[] = [];
		const fakeMode = createRenderProjectionContext({
			onComponent: (component) => displayOrder.push((component as object).constructor.name),
			onMessage: () => displayOrder.push("assistant:thinking"),
		});
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-before", name: "read", arguments: { path: "one.txt" } },
				{ type: "thinking" as const, thinking: "independent visual" },
				{ type: "toolCall" as const, id: "tool-after", name: "read", arguments: { path: "two.txt" } },
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(displayOrder).toEqual(["ToolGroupComponent", "assistant:thinking", "ToolGroupComponent"]);
	});

	it("replaces a transient hidden-thinking projection before final tool-group merge", async () => {
		const observed: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" }> = [];
		const chatContainer = new Container();
		const liveMode = createLiveEventMode(chatContainer);
		liveMode.hideThinkingBlock = true;
		liveMode.hiddenThinkingLabel = "Thinking...";
		liveMode.session = {
			retryAttempt: 0,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: (typeof observed)[number]) => observed.push(projection),
				],
			},
		} as never;
		liveMode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof liveMode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const started = fauxAssistantMessage("");
		const firstTool = { type: "toolCall" as const, id: "tool-first", name: "read", arguments: { path: "one.txt" } };
		const secondTool = { type: "toolCall" as const, id: "tool-second", name: "read", arguments: { path: "two.txt" } };
		const thinkingOnly = { ...started, content: [{ type: "thinking" as const, thinking: "private plan" }] };
		const firstToolStreaming = {
			...started,
			content: [{ type: "thinking" as const, thinking: "private plan" }, firstTool],
		};
		const finalized = {
			...started,
			content: [firstTool, { type: "thinking" as const, thinking: "settled plan" }, secondTool],
		};

		await handleEvent.call(liveMode, { type: "message_start", message: started, entryId: "assistant-tools" });
		await handleEvent.call(liveMode, {
			type: "message_update",
			message: thinkingOnly,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		const streamingContainer = chatContainer.children[0] as Container;
		expect(streamingContainer.children).toHaveLength(1);
		expect(streamingContainer.children[0]?.constructor.name).toBe("AssistantMessageComponent");
		expect(stripAnsi(streamingContainer.children[0]!.render(80).join("\n"))).toContain("Thinking...");
		expect(observed.at(-1)?.members).toEqual([{ entryId: "assistant-tools", role: "assistant" }]);

		await handleEvent.call(liveMode, {
			type: "message_update",
			message: firstToolStreaming,
			entryId: "assistant-tools",
			assistantMessageEvent: {},
		});
		await handleEvent.call(liveMode, { type: "message_end", message: finalized, entryId: "assistant-tools" });

		const finalProjection = observed.at(-1);
		expect(finalProjection?.mode).toBe("replace");
		expect(finalProjection?.members).toEqual([
			{ entryId: "assistant-tools", role: "assistant" },
			{
				entryId: "tool-group:tool-first",
				role: "tool-group",
				groupId: "tool-group:tool-first",
				groupClosed: false,
			},
			{
				entryId: "tool-first",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 0,
			},
			{
				entryId: "tool-second",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 1,
			},
		]);
		const liveFinalChildren = (liveMode.liveRenderContainer as unknown as Container).children;
		expect(liveFinalChildren.map((child) => child.constructor.name)).toEqual(["ToolGroupComponent"]);
		await handleEvent.call(liveMode, { type: "agent_end" });
		await handleEvent.call(liveMode, { type: "agent_settled" });
		const liveSettledProjection = observed.at(-1);
		expect(liveSettledProjection?.members).toEqual([
			{ entryId: "assistant-tools", role: "assistant" },
			{
				entryId: "tool-group:tool-first",
				role: "tool-group",
				groupId: "tool-group:tool-first",
				groupClosed: true,
			},
			{
				entryId: "tool-first",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 0,
			},
			{
				entryId: "tool-second",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 1,
			},
		]);

		const result = (toolCallId: string, text: string) => ({
			role: "toolResult" as const,
			toolCallId,
			toolName: "read",
			content: [{ type: "text" as const, text }],
			isError: false,
			timestamp: 1,
		});
		const restoredMode = createRenderProjectionContext({});
		restoredMode.hideThinkingBlock = true;
		const restoredProjections: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" }> = [];
		restoredMode.session = {
			modelRuntime: undefined,
			extensionRunner: {
				getMessageRenderProjectionObserversV1: () => [
					(projection: (typeof restoredProjections)[number]) => restoredProjections.push(projection),
				],
			},
		} as never;
		restoredMode.publishMessageRenderProjectionV1 = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: typeof restoredMode.publishMessageRenderProjectionV1;
			}
		).publishMessageRenderProjectionV1;
		const renderSessionItems = (
			InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItemsWithResults }
		).renderSessionItems;
		renderSessionItems.call(restoredMode, [
			{ message: finalized, entryId: "assistant-tools" },
			{ message: result("tool-first", "one"), entryId: "result-first" },
			{ message: result("tool-second", "two"), entryId: "result-second" },
		]);

		const restoredFinal = restoredProjections.at(-1);
		expect(restoredFinal?.members).toEqual(liveSettledProjection?.members);
		expect(restoredFinal?.members).toEqual([
			{ entryId: "assistant-tools", role: "assistant" },
			{
				entryId: "tool-group:tool-first",
				role: "tool-group",
				groupId: "tool-group:tool-first",
				groupClosed: true,
			},
			{
				entryId: "tool-first",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 0,
			},
			{
				entryId: "tool-second",
				ownerEntryId: "assistant-tools",
				role: "tool",
				groupId: "tool-group:tool-first",
				groupOrder: 1,
			},
		]);
	});

	it("B15 keeps identical ordered Tool Group members in live and restored rendering", async () => {
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "thinking" as const, thinking: "plan" },
				{ type: "toolCall" as const, id: "tool-first", name: "read", arguments: { path: "one.txt" } },
				{ type: "toolCall" as const, id: "tool-second", name: "read", arguments: { path: "two.txt" } },
			],
		};
		let rebuilt: readonly RenderMember[] = [];
		const rebuildMode = createRenderProjectionContext({});
		rebuildMode.publishMessageRenderProjectionV1 = (members) => {
			rebuilt = members;
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		renderSessionItems.call(rebuildMode, [{ message, entryId: "assistant-tools" }]);

		let live: readonly RenderMember[] = [];
		const liveMode: FinalizeAssistantContext = {
			isInitialized: true,
			messageRenderMembers: [],
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowCacheMissNotices: () => false },
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: message,
			pendingTools: new Map(),
			session: { retryAttempt: 0 },
			ui: createRenderUi(),
			maybeShowCacheMissNotice: vi.fn(),
			publishMessageRenderProjectionV1: (members) => {
				live = members;
			},
		};
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;
		await handleEvent.call(liveMode, { type: "message_end", message, entryId: "assistant-tools" });

		const groupFacts = (members: readonly RenderMember[]) =>
			members
				.filter((member) => member.role === "tool-group" || member.role === "tool")
				.map((member) => ({
					role: member.role,
					entryId: member.entryId,
					groupId: member.groupId,
					...(member.groupOrder === undefined ? {} : { groupOrder: member.groupOrder }),
				}));
		expect(groupFacts(rebuilt)).toEqual([
			{
				role: "tool-group",
				entryId: "tool-group:tool-first",
				groupId: "tool-group:tool-first",
			},
			{ role: "tool", entryId: "tool-first", groupId: "tool-group:tool-first", groupOrder: 0 },
			{ role: "tool", entryId: "tool-second", groupId: "tool-group:tool-first", groupOrder: 1 },
		]);
		expect(groupFacts(live)).toEqual(groupFacts(rebuilt));
	});

	it("removes stale Tool Groups from a complete replacement projection", () => {
		const projections: RenderMember[][] = [];
		const fakeMode = createRenderProjectionContext({});
		Object.setPrototypeOf(fakeMode, InteractiveMode.prototype);
		fakeMode.publishMessageRenderProjectionV1 = (members, mode) => {
			expect(mode).toBe("replace");
			projections.push([...members]);
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const assistantWithTool = (assistantId: string, toolCallId: string): RenderItem => ({
			entryId: assistantId,
			message: {
				...fauxAssistantMessage(""),
				content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
			},
		});

		renderSessionItems.call(fakeMode, [assistantWithTool("assistant-stale", "tool-stale")]);
		renderSessionItems.call(fakeMode, [assistantWithTool("assistant-current", "tool-current")]);

		expect(
			projections[1]?.filter((member) => member.role === "tool").map((member) => [member.groupId, member.entryId]),
		).toEqual([[undefined, "tool-current"]]);
	});

	it("publishes an ordinary user under its persisted identity before its first boundary", async () => {
		const order: string[] = [];
		const message = { role: "user", content: "ordinary prompt", timestamp: 1 } as const;
		const fakeMode: StartUserContext = {
			isInitialized: true,
			messageRenderMembers: [],
			footer: { invalidate: vi.fn() },
			ui: createRenderUi(),
			addMessageToChat: (_message, options) => {
				expect(options.entryId).toBe("user-a");
				order.push("boundary");
			},
			updatePendingMessagesDisplay: vi.fn(),
			publishMessageRenderProjectionV1: (members, mode, finalized) => {
				expect(members).toEqual([{ entryId: "user-a", role: "user" }]);
				expect(mode).toBe("append");
				expect(finalized).toEqual({ entryId: "user-a", message });
				order.push("membership");
			},
		};
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent: (this: StartUserContext, event: object) => Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(fakeMode, { type: "message_start", message, entryId: "user-a" });

		expect(order).toEqual(["membership", "boundary"]);
	});

	it("publishes an ordinary first finalized assistant before its final boundary", async () => {
		const order: string[] = [];
		const streamingUpdates: Array<{ message: RenderItem["message"]; streaming: boolean }> = [];
		const projections: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" | undefined }> = [];
		const message = fauxAssistantMessage("first");
		const fakeMode: FinalizeAssistantContext = {
			isInitialized: true,
			messageRenderMembers: [],
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowCacheMissNotices: () => false },
			streamingComponent: {
				updateContent: (renderedMessage, streaming) => {
					streamingUpdates.push({ message: renderedMessage, streaming });
					if (!streaming) order.push("boundary");
				},
			},
			streamingMessage: message,
			pendingTools: new Map(),
			session: { retryAttempt: 0 },
			ui: createRenderUi(),
			maybeShowCacheMissNotice: vi.fn(),
			publishMessageRenderProjectionV1: (members, mode, finalized) => {
				projections.push({ members, mode });
				expect(finalized?.entryId).toBe("assistant-a");
				expect(finalized?.message).toBe(message);
				order.push("membership");
			},
		};
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeMode, {
			type: "message_update",
			message,
			entryId: "assistant-a",
			assistantMessageEvent: {},
		});
		expect(streamingUpdates).toEqual([{ message, streaming: true }]);
		expect(projections).toEqual([]);

		await handleEvent.call(fakeMode, { type: "message_end", message, entryId: "assistant-a" });

		expect(order).toEqual(["membership", "boundary"]);
		expect(projections).toEqual([{ mode: "append", members: [{ entryId: "assistant-a", role: "assistant" }] }]);
		expect(streamingUpdates).toEqual([
			{ message, streaming: true },
			{ message, streaming: false },
		]);
	});

	it("publishes the complete projection when the next ordinary assistant finalizes", async () => {
		const projections: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" | undefined }> = [];
		const first = fauxAssistantMessage("first");
		const second = fauxAssistantMessage("second");
		const fakeMode: RenderProjectionContext & FinalizeAssistantContext = {
			isInitialized: true,
			messageRenderMembers: [],
			footer: { invalidate: vi.fn() },
			ui: createRenderUi() as unknown as TUI,
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: second,
			pendingTools: new Map(),
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
			session: { modelRuntime: undefined, retryAttempt: 0 },
			outputPad: 0,
			toolOutputExpanded: false,
			updateEditorBorderColor: vi.fn(),
			addMessageToChat: vi.fn(),
			getRegisteredToolDefinition: () => undefined,
			renderAssistantAtoms,
			maybeShowCacheMissNotice: vi.fn(),
			publishMessageRenderProjectionV1: (members, mode) => projections.push({ members, mode }),
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionItems.call(fakeMode, [{ message: first, entryId: "assistant-a" }]);
		projections.length = 0;
		await handleEvent.call(fakeMode, { type: "message_end", message: second, entryId: "assistant-b" });

		expect(projections).toEqual([
			{
				mode: "append",
				members: [
					{ entryId: "assistant-a", role: "assistant" },
					{ entryId: "assistant-b", role: "assistant" },
				],
			},
		]);
	});

	it("appends a finalized Tool Call after its persisted assistant owner", async () => {
		const projections: Array<{ members: readonly RenderMember[]; mode: "append" | "replace" | undefined }> = [];
		const message = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-final", name: "read", arguments: { path: "one.txt" } }],
		};
		const fakeMode: FinalizeAssistantContext = {
			isInitialized: true,
			messageRenderMembers: [],
			footer: { invalidate: vi.fn() },
			settingsManager: { getShowCacheMissNotices: () => false },
			streamingComponent: { updateContent: vi.fn() },
			streamingMessage: message,
			pendingTools: new Map(),
			session: { retryAttempt: 0 },
			ui: createRenderUi(),
			maybeShowCacheMissNotice: vi.fn(),
			publishMessageRenderProjectionV1: (members, mode) => projections.push({ members, mode }),
		};
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		await handleEvent.call(fakeMode, { type: "message_end", message, entryId: "assistant-final" });

		expect(projections).toEqual([
			{
				mode: "append",
				members: [
					{ entryId: "assistant-final", role: "assistant" },
					{
						entryId: "tool-group:tool-final",
						role: "tool-group",
						groupId: "tool-group:tool-final",
						groupClosed: false,
					},
					{
						entryId: "tool-final",
						ownerEntryId: "assistant-final",
						role: "tool",
						groupId: "tool-group:tool-final",
						groupOrder: 0,
					},
				],
			},
		]);
	});

	it("isolates a failing projection observer from stock rendering and later observers", () => {
		const observed: string[] = [];
		const fakeMode = {
			session: {
				extensionRunner: {
					getMessageRenderProjectionObserversV1: () => [
						() => {
							throw new Error("observer failed");
						},
						(projection: { members: readonly RenderMember[] }) =>
							observed.push(...projection.members.map((member) => member.entryId)),
					],
				},
			},
		};
		const publish = (
			InteractiveMode.prototype as unknown as {
				publishMessageRenderProjectionV1: PublishMessageRenderProjection;
			}
		).publishMessageRenderProjectionV1;

		publish.call(fakeMode, [{ entryId: "assistant-a", role: "assistant" }]);

		expect(observed).toEqual(["assistant-a"]);
	});

	it("publishes the complete assistant membership selected for one render", () => {
		const publishMessageRenderProjectionV1 = vi.fn();
		const fakeMode: RenderProjectionContext = {
			messageRenderMembers: [],
			pendingTools: new Map(),
			chatContainer: { addChild: vi.fn() },
			footer: { invalidate: vi.fn() },
			ui: createRenderUi() as unknown as TUI,
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
			session: { modelRuntime: undefined },
			outputPad: 0,
			toolOutputExpanded: false,
			updateEditorBorderColor: vi.fn(),
			addMessageToChat: vi.fn(),
			getRegisteredToolDefinition: () => undefined,
			getMessageRenderBoundaryDecoratorsV1: () => [],
			getToolPresentationOverridesV1: () => [],
			renderAssistantAtoms,
			publishMessageRenderProjectionV1,
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;

		renderSessionItems.call(fakeMode, [
			{ message: fauxAssistantMessage("shared"), entryId: "shared" },
			{ message: fauxAssistantMessage("branch"), entryId: "branch-a" },
		]);

		expect(publishMessageRenderProjectionV1).toHaveBeenCalledExactlyOnceWith(
			[
				{ entryId: "shared", role: "assistant" },
				{ entryId: "branch-a", role: "assistant" },
			],
			"replace",
		);
	});

	it("publishes persisted Tool Calls after their owning assistant", () => {
		const publishMessageRenderProjectionV1 = vi.fn();
		const fakeMode: RenderProjectionContext = {
			messageRenderMembers: [],
			pendingTools: new Map(),
			chatContainer: { addChild: vi.fn() },
			footer: { invalidate: vi.fn() },
			ui: createRenderUi() as unknown as TUI,
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
			session: { modelRuntime: undefined },
			outputPad: 0,
			toolOutputExpanded: false,
			updateEditorBorderColor: vi.fn(),
			addMessageToChat: vi.fn(),
			getRegisteredToolDefinition: () => undefined,
			getMessageRenderBoundaryDecoratorsV1: () => [],
			getToolPresentationOverridesV1: () => [],
			getToolExecutionPresentationSelectorsV1: () => [],
			renderAssistantAtoms,
			publishMessageRenderProjectionV1,
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [
				{ type: "toolCall" as const, id: "tool-1", name: "read", arguments: { path: "one.txt" } },
				{ type: "toolCall" as const, id: "tool-2", name: "read", arguments: { path: "two.txt" } },
			],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		expect(publishMessageRenderProjectionV1).toHaveBeenCalledExactlyOnceWith(
			[
				{ entryId: "assistant-tools", role: "assistant" },
				{
					entryId: "tool-group:tool-1",
					role: "tool-group",
					groupId: "tool-group:tool-1",
					groupClosed: true,
				},
				{
					entryId: "tool-1",
					ownerEntryId: "assistant-tools",
					role: "tool",
					groupId: "tool-group:tool-1",
					groupOrder: 0,
				},
				{
					entryId: "tool-2",
					ownerEntryId: "assistant-tools",
					role: "tool",
					groupId: "tool-group:tool-1",
					groupOrder: 1,
				},
			],
			"replace",
		);
	});

	it("gives restored Tool Calls the registered presentation overrides", () => {
		const added: unknown[] = [];
		const observedToolCallIds: string[] = [];
		const override: ToolPresentationOverrideV1 = (context) => {
			observedToolCallIds.push(context.toolCallId);
			return { state: "collapsed", component: new Text("compact read one.txt", 0, 0) };
		};
		const fakeMode: RenderProjectionContext = {
			messageRenderMembers: [],
			pendingTools: new Map(),
			chatContainer: { addChild: (component) => added.push(component) },
			footer: { invalidate: vi.fn() },
			ui: createRenderUi() as unknown as TUI,
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
			session: { modelRuntime: undefined },
			outputPad: 0,
			toolOutputExpanded: false,
			updateEditorBorderColor: vi.fn(),
			addMessageToChat: vi.fn(),
			getRegisteredToolDefinition: () => undefined,
			getMessageRenderBoundaryDecoratorsV1: () => [],
			getToolPresentationOverridesV1: () => [override],
			getToolExecutionPresentationSelectorsV1: () => [],
			renderAssistantAtoms,
			publishMessageRenderProjectionV1: vi.fn(),
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		const message = {
			...fauxAssistantMessage(""),
			content: [{ type: "toolCall" as const, id: "tool-read-1", name: "read", arguments: { path: "one.txt" } }],
		};

		renderSessionItems.call(fakeMode, [{ message, entryId: "assistant-tools" }]);

		const tool = added[0] as ToolExecutionComponent;
		expect(tool.render(80)[0]?.trimEnd()).toBe("compact read one.txt");
		expect(observedToolCallIds.length).toBeGreaterThan(0);
		expect(new Set(observedToolCallIds)).toEqual(new Set(["tool-read-1"]));
	});

	it("keeps Tool Group presentation outside the extension API", async () => {
		let hasGroupPresentationRegistration = true;
		const runtime = createExtensionRuntime();
		await loadExtensionFromFactory(
			(pi) => {
				hasGroupPresentationRegistration = "registerToolGroupPresentationOverrideV1" in pi;
			},
			process.cwd(),
			{ emit: vi.fn(), on: vi.fn() } as never,
			runtime,
		);

		expect(hasGroupPresentationRegistration).toBe(false);
	});

	it("publishes complete membership before rendering its assistant boundaries", () => {
		const order: string[] = [];
		const fakeMode: RenderProjectionContext = {
			messageRenderMembers: [],
			pendingTools: new Map(),
			footer: { invalidate: vi.fn() },
			ui: createRenderUi() as unknown as TUI,
			settingsManager: {
				getShowCacheMissNotices: () => false,
				getShowImages: () => false,
				getImageWidthCells: () => 60,
			},
			sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
			session: { modelRuntime: undefined },
			outputPad: 0,
			toolOutputExpanded: false,
			updateEditorBorderColor: vi.fn(),
			addMessageToChat: () => order.push("boundaries"),
			getRegisteredToolDefinition: () => undefined,
			renderAssistantAtoms,
			publishMessageRenderProjectionV1: () => order.push("membership"),
		};
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;

		renderSessionItems.call(fakeMode, [{ message: fauxAssistantMessage("shared"), entryId: "shared" }]);

		expect(order).toEqual(["membership", "boundaries"]);
	});
});
