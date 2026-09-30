import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, type Terminal } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type {
	MessageRenderBoundaryDecoratorV1,
	MessageRenderBoundarySelectorV3,
	MessageRenderSourcePointDecoratorV1,
	ToolExecutionPresentationSelectorV1,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { SourcePointRevisions } from "../src/modes/interactive/components/message-render-boundaries.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupMemberComponent } from "../src/modes/interactive/components/tool-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { createSyntheticLongTranscript } from "./helpers/synthetic-long-transcript.ts";

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];
	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

interface Marker {
	phase: string;
	key: string;
	revision: number;
	point?: string;
}

const MARKER = /\x1b\]777;(begin|body|end|mark);([^;]+);(?:([^;]+);)?(\d+)\x07/g;

function marker(phase: string, key: string, revision: number, point?: string): string {
	return `\x1b]777;${phase};${key};${point ? `${point};` : ""}${revision}\x07`;
}

function descendants(root: unknown): unknown[] {
	const result = [root];
	if (root instanceof ToolGroupMemberComponent) result.push(...descendants(root.component));
	if (root instanceof Container) for (const child of root.children) result.push(...descendants(child));
	return result;
}

function withText(message: AssistantMessage, text: string): AssistantMessage {
	return { ...message, content: message.content.map((block) => (block.type === "text" ? { ...block, text } : block)) };
}

function harness(options: { bashTools?: boolean; singleTools?: boolean; toolOutputExpanded?: boolean } = {}) {
	const boundary: MessageRenderBoundaryDecoratorV1 = (context) => {
		const key = `${context.role}:${context.entryId}`;
		return {
			prefix: marker("begin", key, context.sourcePointRevision),
			suffix: marker("end", key, context.sourcePointRevision),
		};
	};
	const fold: MessageRenderBoundarySelectorV3 = (candidate) => {
		const key = `${candidate.role}:${candidate.blockId}`;
		return (context) => ({
			begin: marker("begin", key, context.sourcePointRevision),
			body: marker("body", key, context.sourcePointRevision),
			end: marker("end", key, context.sourcePointRevision),
		});
	};
	const points: MessageRenderSourcePointDecoratorV1 = (point) => {
		const key = point.role === "tool" ? `${point.foldRole}:${point.blockId}` : `${point.role}:${point.entryId}`;
		return marker("mark", key, point.sourcePointRevision, `${point.contentIndex}-${point.sourceOffset}`);
	};
	const presentation: ToolExecutionPresentationSelectorV1 = () => ({
		liveToolCall: "compact-stock-header",
		liveToolGroup: "compact-stock-header",
		header: "exact-one-row",
		settled: "canonical-initial-collapsed",
	});
	const kept = new Set<string>();
	const sessionManager = SessionManager.inMemory();
	for (const { message } of createSyntheticLongTranscript().messages.slice(0, 9)) {
		if (options.singleTools && message.role === "assistant") {
			const first = message.content.find((block) => block.type === "toolCall");
			if (first?.type === "toolCall") kept.add(first.id);
		}
		if (options.singleTools && message.role === "toolResult" && !kept.has(message.toolCallId)) continue;
		const converted =
			options.bashTools && message.role === "assistant"
				? {
						...message,
						content: message.content
							.filter((block) => !options.singleTools || block.type !== "toolCall" || kept.has(block.id))
							.map((block) =>
								block.type === "toolCall"
									? { ...block, name: "bash", arguments: { command: `echo ${block.id}` } }
									: block,
							),
					}
				: options.bashTools && message.role === "toolResult"
					? {
							...message,
							toolName: "bash",
							content: [
								{
									type: "text" as const,
									text: Array.from({ length: 12 }, (_, i) => `${message.toolCallId} output line ${i}`).join(
										"\n",
									),
								},
							],
						}
					: message;
		sessionManager.appendMessage(converted as typeof message, sessionManager.reserveEntryId());
	}
	const terminal = new RecordingTerminal(80, 200);
	const tui = new TuiMainScreen(terminal);
	const mode = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui: tui,
		chatContainer: new Container(),
		pendingTools: new Map(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "revision-scope",
		sourcePointRevisions: new SourcePointRevisions(),
		semanticStreamingBaseMemberCount: 0,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 1,
		toolOutputExpanded: options.toolOutputExpanded ?? options.bashTools === true,
		loadedResourcesContainer: new Container(),
		showStatus: vi.fn(),
		streamingComponent: undefined,
		streamingMessage: undefined,
		semanticStreamingContainer: undefined,
		sessionManager,
		session: { retryAttempt: 0, modelRuntime: undefined, getToolDefinition: () => undefined, extensionRunner: {} },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getShowCacheMissNotices: () => false,
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getMarkdownTransformers: () => [],
		getMessageRenderBoundaryDecoratorsV1: () => [boundary],
		getMessageRenderBoundarySelectorsV3: () => [fold],
		getMessageRenderSourcePointDecoratorsV1: () => [points],
		getMessageRenderProjectionObserversV1: () => [],
		getToolExecutionPresentationSelectorsV1: () => [presentation],
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: ReturnType<SessionManager["buildTranscriptEntries"]>,
	) => void;
	const rebuild = () => {
		mode.chatContainer.clear();
		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
	};
	rebuild();
	tui.addChild(mode.chatContainer);
	const frame = async () => {
		terminal.writes.length = 0;
		tui.renderNow();
		await terminal.flush();
		const output = terminal.writes.join("");
		const markers: Marker[] = [...output.matchAll(MARKER)].map((match) => ({
			phase: match[1]!,
			key: match[2]!,
			revision: Number(match[4]),
			...(match[3] ? { point: match[3] } : {}),
		}));
		return { output, markers, rows: (output.match(/\x1b\[2K/g) ?? []).length };
	};
	const components = () => descendants(mode.chatContainer);
	const assistants = () =>
		components().filter((c): c is AssistantMessageComponent => c instanceof AssistantMessageComponent);
	const tools = () => components().filter((c): c is ToolExecutionComponent => c instanceof ToolExecutionComponent);
	const setToolsExpanded = Reflect.get(InteractiveMode.prototype, "setToolsExpanded") as (
		this: typeof mode,
		expanded: boolean,
	) => void;
	const expandTools = (expanded: boolean) => setToolsExpanded.call(mode, expanded);
	return { frame, rebuild, assistants, tools, expandTools };
}

function keyOf(component: AssistantMessageComponent): string {
	return `assistant:${(Reflect.get(component, "renderBoundaryOptions") as { entryId: string }).entryId}`;
}

function lastMessage(component: AssistantMessageComponent): AssistantMessage {
	return Reflect.get(component, "lastMessage") as AssistantMessage;
}

function revisionsByKey(markers: readonly Marker[]): Map<string, Set<number>> {
	const result = new Map<string, Set<number>>();
	for (const entry of markers) {
		const set = result.get(entry.key) ?? new Set<number>();
		set.add(entry.revision);
		result.set(entry.key, set);
	}
	return result;
}

describe("source point revisions", () => {
	beforeAll(() => initTheme("dark"));

	it("re-emits later ranges at their revision when an earlier final block grows", async () => {
		const h = harness();
		await h.frame();
		const first = h.assistants()[0]!;
		const base = lastMessage(first);
		first.updateContent(withText(base, `grown\n\n${"inserted paragraph\n\n".repeat(10)}`), false);
		const { markers } = await h.frame();

		const grown = markers.filter((entry) => entry.key === keyOf(first));
		expect(grown.map((entry) => entry.phase)).toEqual(expect.arrayContaining(["begin", "end"]));
		expect(new Set(grown.map((entry) => entry.revision))).toEqual(new Set([2]));
		const later = markers.filter((entry) => entry.key !== keyOf(first));
		expect(later.some((entry) => entry.phase === "begin")).toBe(true);
		expect(new Set(later.map((entry) => entry.revision))).toEqual(new Set([1]));
	});

	it("replaces a message whose only source point disappears with a complete new revision", async () => {
		const h = harness();
		await h.frame();
		const first = h.assistants()[0]!;
		const base = lastMessage(first);
		first.updateContent(withText(base, "a".repeat(530)), false);
		const withPoint = await h.frame();
		expect(withPoint.markers.some((entry) => entry.phase === "mark" && entry.key === keyOf(first))).toBe(true);

		first.updateContent(withText(base, "b".repeat(505)), false);
		const { markers } = await h.frame();

		const own = markers.filter((entry) => entry.key === keyOf(first));
		expect(own.map((entry) => entry.phase)).toEqual(["begin", "end"]);
		expect(own.every((entry) => entry.revision === 3)).toBe(true);
	});

	it("gives the owning tool group one new revision for each collapse and expansion", async () => {
		const h = harness({ bashTools: true });
		const initial = await h.frame();
		const groupKeys = [...new Set(initial.markers.filter((e) => e.key.startsWith("tool-group:")).map((e) => e.key))];
		expect(groupKeys.length).toBeGreaterThan(0);
		expect(initial.markers.some((e) => e.phase === "mark" && groupKeys.includes(e.key))).toBe(true);

		for (const tool of h.tools()) tool.setExpanded(false);
		const collapsed = await h.frame();
		for (const key of groupKeys) {
			const own = collapsed.markers.filter((e) => e.key === key);
			const initialMarks = initial.markers.filter((e) => e.key === key && e.phase === "mark").length;
			expect(own.filter((e) => e.phase !== "mark").map((e) => e.phase)).toEqual(["begin", "body", "end"]);
			expect(own.filter((e) => e.phase === "mark").length).toBeLessThan(initialMarks);
			expect(own.every((e) => e.revision === 2)).toBe(true);
		}

		for (const tool of h.tools()) tool.setExpanded(true);
		const expanded = await h.frame();
		for (const key of groupKeys) {
			const own = expanded.markers.filter((e) => e.key === key);
			expect(own.filter((e) => e.phase === "mark").length).toBeGreaterThan(0);
			expect(own.every((e) => e.revision === 3)).toBe(true);
		}
	});

	it("bumps once when a final message streams again and never for a streaming delta", async () => {
		const h = harness();
		await h.frame();
		const last = h.assistants().at(-1)!;
		const base = lastMessage(last);
		let text = "restarted stream";
		last.updateContent(withText(base, text), true);
		const restarted = await h.frame();
		expect(restarted.markers.filter((e) => e.key === keyOf(last)).every((e) => e.revision === 2)).toBe(true);

		for (let step = 0; step < 3; step++) {
			text += `\n${"streamed words ".repeat(8)}`;
			last.updateContent(withText(base, text), true);
			const delta = await h.frame();
			const own = delta.markers.filter((e) => e.key === keyOf(last));
			expect(own.some((e) => e.phase === "begin")).toBe(false);
			expect(own.every((e) => e.revision === 2)).toBe(true);
		}

		last.updateContent(withText(base, text), false);
		const settled = await h.frame();
		expect(settled.markers.filter((e) => e.key === keyOf(last)).every((e) => e.revision === 2)).toBe(true);
	});

	it("keeps an unchanged key at its revision and continues a changed key after reconstruction", async () => {
		const h = harness();
		await h.frame();
		h.rebuild();
		const unchanged = await h.frame();
		expect(unchanged.markers).toEqual([]);

		const first = h.assistants()[0]!;
		first.updateContent(withText(lastMessage(first), "edited final text"), false);
		await h.frame();
		h.rebuild();
		const rebuilt = await h.frame();
		const own = rebuilt.markers.filter((e) => e.key === keyOf(h.assistants()[0]!));
		expect(own.length).toBeGreaterThan(0);
		expect(own.every((e) => e.revision === 3)).toBe(true);
	});

	it("continues a shared tool group revision after its components are rebuilt", async () => {
		const h = harness({ bashTools: true });
		const initial = await h.frame();
		const groupKeys = [...new Set(initial.markers.filter((e) => e.key.startsWith("tool-group:")).map((e) => e.key))];
		for (const tool of h.tools()) tool.setExpanded(false);
		await h.frame();

		h.rebuild();
		const rebuilt = await h.frame();

		for (const key of groupKeys) {
			const own = rebuilt.markers.filter((e) => e.key === key);
			expect(own.map((e) => e.phase)).toEqual(expect.arrayContaining(["begin", "body", "end"]));
			expect(own.every((e) => e.revision === 3)).toBe(true);
		}
	});

	it("marks restored Tool Call result source points after tool output expands", async () => {
		const h = harness({ bashTools: true, toolOutputExpanded: false });
		await h.frame();

		h.expandTools(true);
		const { markers } = await h.frame();

		expect(markers.some((entry) => entry.phase === "mark" && entry.key.startsWith("tool"))).toBe(true);
	});

	it.each([
		["grouped", "tool-group", false],
		["single", "tool", true],
	] as const)(
		"follows expand, collapse, and expand of %s restored Tool Calls with new revisions",
		async (_name, kind, singleTools) => {
			const h = harness({ bashTools: true, singleTools, toolOutputExpanded: false });
			await h.frame();
			const revisions = (markers: readonly Marker[]) =>
				new Set(
					markers
						.filter((entry) => entry.phase === "mark" && entry.key.startsWith(`${kind}:`))
						.map((entry) => entry.revision),
				);

			h.expandTools(true);
			const expanded = revisions((await h.frame()).markers);
			h.expandTools(false);
			const collapsed = revisions((await h.frame()).markers);
			h.expandTools(true);
			const reexpanded = revisions((await h.frame()).markers);

			expect(expanded.size).toBeGreaterThan(0);
			expect(Math.min(...collapsed)).toBeGreaterThan(Math.max(...expanded));
			expect(Math.min(...reexpanded)).toBeGreaterThan(Math.max(...collapsed));
		},
	);

	it("uses one revision for every marker of a key in one render", async () => {
		const h = harness({ bashTools: true });
		const frames = [await h.frame()];
		for (const tool of h.tools()) tool.setExpanded(false);
		frames.push(await h.frame());
		for (const tool of h.tools()) tool.setExpanded(true);
		frames.push(await h.frame());
		for (const { markers } of frames) {
			for (const revisions of revisionsByKey(markers).values()) expect(revisions.size).toBe(1);
		}
	});
});
