import type { Component, Terminal, TUI } from "@earendil-works/pi-tui";
import { Container, CURSOR_MARKER } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type {
	MessageRenderBoundaryDecoratorV1,
	MessageRenderBoundarySelectorV3,
	MessageRenderProjectionV1,
	ToolExecutionPresentationSelectorV1,
} from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent, ToolGroupMemberComponent } from "../src/modes/interactive/components/tool-group.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import {
	createSyntheticLongTranscript,
	SYNTHETIC_ENTRY_COUNT,
	SYNTHETIC_GROUP_COUNT,
	SYNTHETIC_SINGLETON_COUNT,
	SYNTHETIC_TOOL_CALL_COUNT,
	SYNTHETIC_TOOL_RESULT_COUNT,
	SYNTHETIC_TURN_COUNT,
} from "./helpers/synthetic-long-transcript.ts";

const rendererFactoryCounts = vi.hoisted(() => ({ shell: 0 }));

vi.mock("../src/core/tools/renderers/bash.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/core/tools/renderers/bash.ts")>();
	return {
		...actual,
		createShellRenderers: (prompt: string) => {
			rendererFactoryCounts.shell += 1;
			return actual.createShellRenderers(prompt);
		},
	};
});

class RecordingTerminal extends VirtualTerminal implements Terminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class LogicalCursorProbe implements Component {
	readonly text = `INPUT ${"logical cursor content ".repeat(8)}`;
	readonly cursorOffset = 95;

	render(width: number): string[] {
		const lines: string[] = [];
		for (let offset = 0; offset < this.text.length; offset += width) {
			const line = this.text.slice(offset, offset + width);
			if (this.cursorOffset >= offset && this.cursorOffset < offset + width) {
				const column = this.cursorOffset - offset;
				lines.push(line.slice(0, column) + CURSOR_MARKER + line.slice(column));
			} else {
				lines.push(line);
			}
		}
		return lines;
	}

	invalidate(): void {}

	expectedPosition(width: number, height: number): { x: number; y: number } {
		const rowCount = Math.ceil(this.text.length / width);
		const cursorRow = Math.floor(this.cursorOffset / width);
		return { x: this.cursorOffset % width, y: height - rowCount + cursorRow };
	}
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function descendants(root: Component): Component[] {
	const result = [root];
	if (root instanceof ToolGroupMemberComponent) result.push(...descendants(root.component));
	if (root instanceof Container) {
		for (const child of root.children) result.push(...descendants(child));
	}
	return result;
}

function createHarness(ui: TUI, sessionManager: SessionManager) {
	const projections: Readonly<MessageRenderProjectionV1>[] = [];
	const counts = {
		presentationSelections: 0,
		boundarySelections: 0,
		v1Decorations: 0,
		v3Decorations: 0,
	};
	let v1BoundaryIndex = 0;
	let v3BoundaryIndex = 0;
	const v1BoundaryIndexes = new Map<string, number>();
	const renderedV1Indexes: number[] = [];
	const renderedV3Indexes: number[] = [];
	const v1Decorator: MessageRenderBoundaryDecoratorV1 = (context) => {
		counts.v1Decorations += 1;
		let index = v1BoundaryIndexes.get(context.entryId);
		if (index === undefined) {
			index = v1BoundaryIndex++;
			v1BoundaryIndexes.set(context.entryId, index);
		}
		renderedV1Indexes.push(index);
		return {
			prefix: `\x1b]777;message-begin-${index}\x07`,
			suffix: `\x1b]777;message-end-${index}\x07`,
		};
	};
	const v3Selector: MessageRenderBoundarySelectorV3 = () => {
		counts.boundarySelections += 1;
		const index = v3BoundaryIndex++;
		return () => {
			counts.v3Decorations += 1;
			renderedV3Indexes.push(index);
			return {
				begin: `\x1b]777;object-begin-${index}\x07`,
				body: `\x1b]777;object-body-${index}\x07`,
				end: `\x1b]777;object-end-${index}\x07`,
			};
		};
	};
	const presentationSelector: ToolExecutionPresentationSelectorV1 = () => {
		counts.presentationSelections += 1;
		return {
			liveToolCall: "compact-stock-header",
			liveToolGroup: "compact-stock-header",
			header: "exact-one-row",
			settled: "canonical-initial-collapsed",
		};
	};
	const mode = {
		isInitialized: true,
		footer: { invalidate: vi.fn() },
		ui,
		chatContainer: new Container(),
		pendingTools: new Map(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "synthetic-render-scope",
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
		getMessageRenderBoundaryDecoratorsV1: () => [v1Decorator],
		getMessageRenderBoundarySelectorsV3: () => [v3Selector],
		getMessageRenderProjectionObserversV1: () => [
			(projection: Readonly<MessageRenderProjectionV1>) => projections.push(projection),
		],
		getToolExecutionPresentationSelectorsV1: () => [presentationSelector],
		updatePendingMessagesDisplay: vi.fn(),
		updateEditorBorderColor: vi.fn(),
		maybeShowAssistantDiagnostics: vi.fn(),
		maybeShowCacheMissNotice: vi.fn(),
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	return { mode, projections, counts, renderedV1Indexes, renderedV3Indexes };
}

describe("synthetic long-transcript rendering", () => {
	beforeAll(() => initTheme("dark"));

	it("restores and width-renders the 422-Tool-Call transcript with bounded work", async () => {
		const fixture = createSyntheticLongTranscript();
		const toolResults = fixture.messages.filter(({ message }) => message.role === "toolResult");
		expect(fixture.messages).toHaveLength(SYNTHETIC_ENTRY_COUNT);
		expect(fixture.toolCallIds).toHaveLength(SYNTHETIC_TOOL_CALL_COUNT);
		expect(toolResults).toHaveLength(SYNTHETIC_TOOL_RESULT_COUNT);
		expect(fixture.assistantEntryIds).toHaveLength(SYNTHETIC_TURN_COUNT);

		const sessionManager = SessionManager.inMemory();
		for (const { message } of fixture.messages) {
			const entryId = sessionManager.reserveEntryId();
			sessionManager.appendMessage(message, entryId);
		}
		const terminal = new RecordingTerminal(77, 35);
		const tui = new TuiMainScreen(terminal);
		const { mode, projections, counts, renderedV1Indexes, renderedV3Indexes } = createHarness(tui, sessionManager);
		const factoriesBefore = rendererFactoryCounts.shell;
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof mode,
			entries: ReturnType<SessionManager["buildTranscriptEntries"]>,
		) => void;
		renderSessionEntries.call(mode, sessionManager.buildTranscriptEntries());
		const cursor = new LogicalCursorProbe();
		const root = new Container();
		root.addChild(mode.chatContainer);
		root.addChild(cursor);
		tui.addChild(root);

		const components = descendants(mode.chatContainer);
		expect(components.filter((component) => component instanceof ToolExecutionComponent)).toHaveLength(
			SYNTHETIC_TOOL_CALL_COUNT,
		);
		expect(components.filter((component) => component instanceof ToolGroupComponent)).toHaveLength(
			SYNTHETIC_GROUP_COUNT,
		);
		expect(projections).toHaveLength(1);
		expect(projections[0]?.mode).toBe("replace");
		expect(projections[0]?.members).toHaveLength(1_056);
		expect(counts.presentationSelections).toBe(SYNTHETIC_TOOL_CALL_COUNT);
		expect(counts.boundarySelections).toBe(SYNTHETIC_TOOL_CALL_COUNT + SYNTHETIC_GROUP_COUNT);
		expect(rendererFactoryCounts.shell - factoriesBefore).toBe(2);

		tui.renderNow();
		await terminal.flush();
		const narrowState = tui.captureRenderState();
		const narrowRows = narrowState.previousLines.length;
		expect(terminal.getCursorPosition()).toEqual(cursor.expectedPosition(77, 35));

		const toolRender = vi.spyOn(ToolExecutionComponent.prototype, "render");
		const groupRender = vi.spyOn(ToolGroupComponent.prototype, "render");
		counts.v1Decorations = 0;
		counts.v3Decorations = 0;
		renderedV1Indexes.length = 0;
		renderedV3Indexes.length = 0;
		const selectionsBeforeResize = {
			presentation: counts.presentationSelections,
			boundary: counts.boundarySelections,
		};
		const projectionCountBeforeResize = projections.length;
		const factoriesBeforeResize = rendererFactoryCounts.shell;
		const redrawsBeforeResize = tui.fullRedraws;
		terminal.writes.length = 0;

		terminal.resize(118, 35);
		tui.renderNow();
		await terminal.flush();

		const resizeOutput = terminal.writes.join("");
		const visibleOutput = stripAnsi(resizeOutput);
		const wideState = tui.captureRenderState();
		expect(wideState.previousLines.length).toBeLessThan(narrowRows);
		expect(tui.fullRedraws - redrawsBeforeResize).toBe(1);
		expect(toolRender).toHaveBeenCalledTimes(SYNTHETIC_TOOL_CALL_COUNT);
		expect(groupRender).toHaveBeenCalledTimes(SYNTHETIC_GROUP_COUNT);
		expect(counts.presentationSelections).toBe(selectionsBeforeResize.presentation);
		expect(counts.boundarySelections).toBe(selectionsBeforeResize.boundary);
		expect(counts.v1Decorations).toBe(SYNTHETIC_TURN_COUNT * 2);
		expect(counts.v3Decorations).toBe(SYNTHETIC_GROUP_COUNT + SYNTHETIC_SINGLETON_COUNT);
		expect(projections).toHaveLength(projectionCountBeforeResize);
		expect(rendererFactoryCounts.shell).toBe(factoriesBeforeResize);
		expect(occurrences(resizeOutput, "\x1b[2J")).toBe(1);
		expect(occurrences(resizeOutput, "\x1b[3J")).toBe(1);
		expect(resizeOutput.startsWith("\x1b[?2026h")).toBe(true);
		expect(occurrences(resizeOutput, "\x1b[?2026h")).toBe(1);
		expect(occurrences(resizeOutput, "\x1b[?2026l")).toBe(1);
		expect(resizeOutput.indexOf("\x1b[?2026l")).toBeLessThan(resizeOutput.lastIndexOf("\x1b["));
		expect(terminal.getCursorPosition()).toEqual(cursor.expectedPosition(118, 35));
		expect(wideState.cursorRow).toBe(wideState.previousLines.length - 1);
		expect(wideState.hardwareCursorRow).toBe(
			wideState.previousLines.length - Math.ceil(cursor.text.length / 118) + Math.floor(cursor.cursorOffset / 118),
		);

		let previousMarkerIndex = -1;
		for (const marker of fixture.orderedMarkers) {
			expect(occurrences(visibleOutput, marker), marker).toBe(1);
			const markerIndex = visibleOutput.indexOf(marker);
			expect(markerIndex, marker).toBeGreaterThan(previousMarkerIndex);
			previousMarkerIndex = markerIndex;
		}
		expect(new Set(renderedV1Indexes).size).toBe(SYNTHETIC_TURN_COUNT * 2);
		for (const index of renderedV1Indexes) {
			expect(occurrences(resizeOutput, `\x1b]777;message-begin-${index}\x07`)).toBe(1);
			expect(occurrences(resizeOutput, `\x1b]777;message-end-${index}\x07`)).toBe(1);
		}
		expect(new Set(renderedV3Indexes).size).toBe(SYNTHETIC_GROUP_COUNT + SYNTHETIC_SINGLETON_COUNT);
		for (const index of renderedV3Indexes) {
			expect(occurrences(resizeOutput, `\x1b]777;object-begin-${index}\x07`)).toBe(1);
			expect(occurrences(resizeOutput, `\x1b]777;object-body-${index}\x07`)).toBe(1);
			expect(occurrences(resizeOutput, `\x1b]777;object-end-${index}\x07`)).toBe(1);
		}

		toolRender.mockRestore();
		groupRender.mockRestore();
	});
});
