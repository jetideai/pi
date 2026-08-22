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
import type { SessionEntry } from "../src/core/session-manager.ts";
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
	chatContainer?: { addChild(component: unknown): void };
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowCacheMissNotices(): boolean;
		getShowImages(): boolean;
		getImageWidthCells(): number;
	};
	sessionManager: { getEntries(): SessionEntry[]; getCwd(): string };
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
		getRegisteredToolDefinition: () => undefined,
		maybeShowCacheMissNotice: vi.fn(),
		retryEscapeHandler: undefined,
		workingVisible: false,
		clearStatusIndicator: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return mode;
}

describe("InteractiveMode message render projection", () => {
	beforeAll(() => initTheme("dark"));

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

	it("keeps each finalized assistant response in independent Tool Groups for live and restore", async () => {
		const firstStart = fauxAssistantMessage("");
		const first = {
			...firstStart,
			content: [
				{ type: "text" as const, text: "First response" },
				...Array.from({ length: 3 }, (_, index) => ({
					type: "toolCall" as const,
					id: `first-tool-${index + 1}`,
					name: "read",
					arguments: { path: `first-${index + 1}.txt` },
				})),
			],
		};
		const secondStart = fauxAssistantMessage("");
		const second = {
			...secondStart,
			content: Array.from({ length: 2 }, (_, index) => ({
				type: "toolCall" as const,
				id: `second-tool-${index + 1}`,
				name: "read",
				arguments: { path: `second-${index + 1}.txt` },
			})),
		};
		const chatContainer = new Container();
		const liveMode = createLiveEventMode(chatContainer);
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof liveMode, event: object): Promise<void>;
			}
		).handleEvent;
		const stream = async (entryId: string, started: AssistantMessage, completed: AssistantMessage) => {
			await handleEvent.call(liveMode, { type: "message_start", message: started, entryId });
			await handleEvent.call(liveMode, {
				type: "message_update",
				message: completed,
				entryId,
				assistantMessageEvent: {},
			});
			await handleEvent.call(liveMode, { type: "message_end", message: completed, entryId });
		};

		await stream("assistant-1", firstStart, first);
		await stream("assistant-2", secondStart, second);

		const restoredMode = createRenderProjectionContext({});
		const renderSessionItems = (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems;
		await renderSessionItems.call(restoredMode, [
			{ message: first, entryId: "assistant-1" },
			{ message: second, entryId: "assistant-2" },
		]);
		const groupFacts = (members: readonly RenderMember[]) =>
			members.filter((member) => member.role === "tool-group" || member.role === "tool");
		const expected = [
			{
				entryId: "tool-group:first-tool-1",
				role: "tool-group",
				groupId: "tool-group:first-tool-1",
				groupClosed: true,
			},
			...Array.from({ length: 3 }, (_, index) => ({
				entryId: `first-tool-${index + 1}`,
				ownerEntryId: "assistant-1",
				role: "tool",
				groupId: "tool-group:first-tool-1",
				groupOrder: index,
			})),
			{
				entryId: "tool-group:second-tool-1",
				role: "tool-group",
				groupId: "tool-group:second-tool-1",
				groupClosed: true,
			},
			...Array.from({ length: 2 }, (_, index) => ({
				entryId: `second-tool-${index + 1}`,
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:second-tool-1",
				groupOrder: index,
			})),
		];
		const liveContainer = chatContainer.children[0] as Container;

		expect({
			liveComponents: liveContainer.children.map((component) => component.constructor.name),
			live: groupFacts(liveMode.messageRenderMembers),
			restored: groupFacts(restoredMode.messageRenderMembers),
		}).toEqual({
			liveComponents: ["AssistantMessageComponent", "ToolGroupComponent", "ToolGroupComponent"],
			live: expected,
			restored: expected,
		});
	});

	it("closes each response Tool Group before agent cleanup", async () => {
		const fakeMode = createLiveEventMode();
		const facts: Array<{
			groups: Array<{ groupId: string; groupClosed: boolean }>;
			mode: "append" | "replace";
		}> = [];
		fakeMode.publishMessageRenderProjectionV1 = vi.fn((members: readonly RenderMember[], mode) => {
			const groups = members.flatMap((member) =>
				member.role === "tool-group" && member.groupId && typeof member.groupClosed === "boolean"
					? [{ groupId: member.groupId, groupClosed: member.groupClosed }]
					: [],
			);
			if (groups.length > 0) facts.push({ groups, mode });
		});
		(
			fakeMode as typeof fakeMode & {
				awaitInitialSemanticFoldAdmission: ReturnType<typeof vi.fn>;
			}
		).awaitInitialSemanticFoldAdmission = vi.fn();
		const handleEvent = (
			InteractiveMode.prototype as unknown as {
				handleEvent(this: typeof fakeMode, event: object): Promise<void>;
			}
		).handleEvent;
		const streamTool = async (entryId: string, toolCallId: string) => {
			const started = fauxAssistantMessage("");
			const completed = {
				...started,
				content: [{ type: "toolCall" as const, id: toolCallId, name: "read", arguments: {} }],
			};
			await handleEvent.call(fakeMode, { type: "message_start", message: started, entryId });
			await handleEvent.call(fakeMode, {
				type: "message_update",
				message: completed,
				entryId,
				assistantMessageEvent: {},
			});
			await handleEvent.call(fakeMode, { type: "message_end", message: completed, entryId });
		};

		await streamTool("assistant-1", "tool-1");
		const firstFinal = facts.at(-1);
		await streamTool("assistant-2", "tool-2");
		const secondFinal = facts.at(-1);
		await handleEvent.call(fakeMode, { type: "agent_end" });

		expect({ firstFinal, secondFinal, afterCleanup: facts.at(-1) }).toEqual({
			firstFinal: {
				groups: [{ groupId: "tool-group:tool-1", groupClosed: true }],
				mode: "append",
			},
			secondFinal: {
				groups: [
					{ groupId: "tool-group:tool-1", groupClosed: true },
					{ groupId: "tool-group:tool-2", groupClosed: true },
				],
				mode: "append",
			},
			afterCleanup: secondFinal,
		});
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

	it("releases one completed run before the next Tool Group", async () => {
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
		}).toEqual({ containerReleased: true, entries: 0, tools: 0, pending: 0, retainedChildren: 1 });

		await handleEvent.call(fakeMode, { type: "agent_start" });
		await streamTool("assistant-2", "tool-2");
		const secondContainer = chatContainer.children[1] as Container;
		const publishedMembers = fakeMode.publishMessageRenderProjectionV1.mock.lastCall?.[0] as RenderMember[];
		expect({
			reusedContainer: secondContainer === firstContainer,
			childCount: (secondContainer.children[0] as Container).children.length,
			projectedTool: publishedMembers.find((member) => member.entryId === "tool-2"),
		}).toEqual({
			reusedContainer: false,
			childCount: 1,
			projectedTool: {
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:tool-2",
				groupOrder: 0,
			},
		});
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

	it("keeps Tool Results inside independent response Tool Groups", () => {
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

		expect(added.map((component) => (component as object).constructor.name)).toEqual([
			"ToolGroupComponent",
			"ToolGroupComponent",
		]);
	});

	it("keeps displayed custom entries between independent response Tool Groups during restore", async () => {
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
				entryId: "tool-group:tool-2",
				role: "tool-group",
				groupId: "tool-group:tool-2",
				groupClosed: true,
			},
			{
				entryId: "tool-2",
				ownerEntryId: "assistant-2",
				role: "tool",
				groupId: "tool-group:tool-2",
				groupOrder: 0,
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

	it("keeps custom entries without renderers invisible between restored response Tool Groups", () => {
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

		expect(added.map((component) => (component as object).constructor.name)).toEqual([
			"ToolGroupComponent",
			"ToolGroupComponent",
		]);
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
				groupId: "tool-group:tool-2",
				groupOrder: 0,
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
		const liveFinalChildren = (liveMode.liveRenderContainer as unknown as Container).children;
		expect(liveFinalChildren.map((child) => child.constructor.name)).toEqual(["ToolGroupComponent"]);
		await handleEvent.call(liveMode, { type: "agent_end" });
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
		).toEqual([["tool-group:tool-current", "tool-current"]]);
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
						groupClosed: true,
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
