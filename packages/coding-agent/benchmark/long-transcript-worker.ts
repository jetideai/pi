import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import {
	createSyntheticLongTranscript,
	SYNTHETIC_ENTRY_COUNT,
	SYNTHETIC_GROUP_COUNT,
	SYNTHETIC_SINGLETON_COUNT,
	SYNTHETIC_TOOL_CALL_COUNT,
	SYNTHETIC_TOOL_RESULT_COUNT,
} from "../test/helpers/synthetic-long-transcript.ts";
import { deriveComponentCounts, deriveTranscriptCounts } from "./long-transcript-structure.ts";

interface Measurement {
	wallMs: number;
	cpuUserMs: number;
	cpuSystemMs: number;
	cpuTotalMs: number;
}

interface Renderable {
	render(width: number): string[];
	invalidate?(): void;
}

interface ContainerLike extends Renderable {
	addChild(component: Renderable): void;
	children: Renderable[];
}

interface SessionManagerLike {
	appendMessage(message: unknown): string;
	buildContextEntries(): unknown[];
	buildTranscriptEntries?: () => unknown[];
}

interface TerminalLike {
	flush(): Promise<void>;
	resize(columns: number, rows: number): void;
	getCursorPosition(): { x: number; y: number };
}

interface TuiLike extends Renderable {
	addChild(component: Renderable): void;
	renderNow(): void;
	captureRenderState(): { previousLines: string[]; cursorRow: number };
}

type BenchmarkMode = "capability-off" | "semantic-on";

interface WorkerArguments {
	targetRoot: string;
	label: string;
	mode: BenchmarkMode;
	width: number;
	height: number;
	resizeWidth: number;
	resizeHeight: number;
}

function parseArguments(): WorkerArguments {
	const values = new Map<string, string>();
	for (let index = 2; index < process.argv.length; index += 2) {
		const key = process.argv[index];
		const value = process.argv[index + 1];
		if (!key?.startsWith("--") || value === undefined) throw new Error(`Invalid argument at ${index}`);
		values.set(key.slice(2), value);
	}
	const required = (key: string): string => {
		const value = values.get(key);
		if (!value) throw new Error(`Missing --${key}`);
		return value;
	};
	return {
		targetRoot: resolve(required("target-root")),
		label: required("label"),
		mode: required("mode") as BenchmarkMode,
		width: Number(required("width")),
		height: Number(required("height")),
		resizeWidth: Number(required("resize-width")),
		resizeHeight: Number(required("resize-height")),
	};
}

function registerTargetWorkspace(targetRoot: string): void {
	const packages = new Map([
		["@earendil-works/chord", "packages/chord/src/index.ts"],
		["@earendil-works/pi-agent-core", "packages/agent/src/index.ts"],
		["@earendil-works/pi-ai", "packages/ai/src/index.ts"],
		["@earendil-works/pi-client", "packages/client/src/index.ts"],
		["@earendil-works/pi-protocol", "packages/protocol/src/index.ts"],
		["@earendil-works/pi-telemetry", "packages/telemetry/src/index.ts"],
		["@earendil-works/pi-tui", "packages/tui/src/index.ts"],
	]);
	registerHooks({
		resolve(specifier, context, nextResolve) {
			const target = packages.get(specifier);
			if (target) return nextResolve(pathToFileURL(join(targetRoot, target)).href, context);
			try {
				return nextResolve(specifier, context);
			} catch (error) {
				if (!specifier.startsWith("@") && (specifier.startsWith(".") || specifier.startsWith("/") || specifier.includes(":"))) {
					throw error;
				}
				return nextResolve(specifier, { ...context, parentURL: import.meta.url });
			}
		},
	});
}

async function measure(operation: () => Promise<void> | void): Promise<Measurement> {
	const cpuStart = process.cpuUsage();
	const wallStart = performance.now();
	await operation();
	const wallMs = performance.now() - wallStart;
	const cpu = process.cpuUsage(cpuStart);
	const cpuUserMs = cpu.user / 1_000;
	const cpuSystemMs = cpu.system / 1_000;
	return { wallMs, cpuUserMs, cpuSystemMs, cpuTotalMs: cpuUserMs + cpuSystemMs };
}

function occurrences(value: string, needle: string): number {
	return value.split(needle).length - 1;
}

function packageVersion(root: string, packagePath: string): string {
	return (JSON.parse(readFileSync(join(root, packagePath), "utf8")) as { version: string }).version;
}

const args = parseArguments();
if (args.mode !== "capability-off" && args.mode !== "semantic-on") throw new Error(`Invalid mode: ${args.mode}`);
registerTargetWorkspace(args.targetRoot);

const codingRoot = join(args.targetRoot, "packages/coding-agent");
const [
	{ SessionManager },
	{ InteractiveMode },
	{ ToolExecutionComponent },
	{ initTheme, getMarkdownTheme },
	tuiModule,
	{ TuiMainScreen },
	virtualTerminalModule,
] = await Promise.all([
		import(pathToFileURL(join(codingRoot, "src/core/session-manager.ts")).href),
		import(pathToFileURL(join(codingRoot, "src/modes/interactive/interactive-mode.ts")).href),
		import(pathToFileURL(join(codingRoot, "src/modes/interactive/components/tool-execution.ts")).href),
		import(pathToFileURL(join(codingRoot, "src/modes/interactive/theme/theme.ts")).href),
		import(pathToFileURL(join(args.targetRoot, "packages/tui/src/tui.ts")).href),
		import(pathToFileURL(join(args.targetRoot, "packages/tui/src/tui-main-screen.ts")).href),
		import(pathToFileURL(join(args.targetRoot, "packages/tui/test/virtual-terminal.ts")).href),
	]);

const ToolGroupComponent =
	args.mode === "semantic-on"
		? (await import(pathToFileURL(join(codingRoot, "src/modes/interactive/components/tool-group.ts")).href))
				.ToolGroupComponent
		: undefined;

initTheme("dark");
const fixture = createSyntheticLongTranscript();
const fixtureHash = createHash("sha256").update(JSON.stringify(fixture.messages)).digest("hex");

class RecordingTerminal extends virtualTerminalModule.VirtualTerminal {
	readonly writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}
}

class LogicalCursorProbe implements Renderable {
	readonly text = `INPUT ${"logical cursor content ".repeat(8)}`;
	readonly cursorOffset = 95;

	render(width: number): string[] {
		const lines: string[] = [];
		for (let offset = 0; offset < this.text.length; offset += width) {
			const line = this.text.slice(offset, offset + width);
			const column = this.cursorOffset - offset;
			lines.push(column >= 0 && column < width ? line.slice(0, column) + tuiModule.CURSOR_MARKER + line.slice(column) : line);
		}
		return lines;
	}

	invalidate(): void {}

	expectedPosition(width: number, height: number): { x: number; y: number } {
		const rowCount = Math.ceil(this.text.length / width);
		return {
			x: this.cursorOffset % width,
			y: height - rowCount + Math.floor(this.cursorOffset / width),
		};
	}
}

let sessionManager: SessionManagerLike;
let terminal: RecordingTerminal & TerminalLike;
let tui: TuiLike;
let mode: { chatContainer: ContainerLike };
let root: ContainerLike;
let cursor: LogicalCursorProbe;
let restoredEntries: unknown[];
const construction = await measure(() => {
	sessionManager = SessionManager.inMemory() as SessionManagerLike;
	for (const { message } of fixture.messages) sessionManager.appendMessage(message);
	terminal = new RecordingTerminal(args.width, args.height) as RecordingTerminal & TerminalLike;
	tui = new TuiMainScreen(terminal) as TuiLike;
	mode = {
		isInitialized: true,
		footer: { invalidate() {} },
		ui: tui,
		chatContainer: new tuiModule.Container() as ContainerLike,
		pendingTools: new Map(),
		messageRenderMembers: [],
		publishedMessageRenderProjection: undefined,
		messageRenderScopeId: "benchmark-render-scope",
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
		getMessageRenderBoundaryDecoratorsV1: () => [],
		getMessageRenderBoundarySelectorsV3: () =>
			args.mode === "semantic-on" ? [() => () => ({ begin: "", body: "", end: "" })] : [],
		getMessageRenderProjectionObserversV1: () => [],
		getToolExecutionPresentationSelectorsV1: () =>
			args.mode === "semantic-on"
				? [
						() => ({
							liveToolCall: "compact-stock-header",
							liveToolGroup: "compact-stock-header",
							header: "exact-one-row",
							settled: "canonical-initial-collapsed",
						}),
					]
				: [],
		updatePendingMessagesDisplay() {},
		updateEditorBorderColor() {},
		maybeShowAssistantDiagnostics() {},
		maybeShowCacheMissNotice() {},
	};
	Object.setPrototypeOf(mode, InteractiveMode.prototype);
	restoredEntries = sessionManager.buildTranscriptEntries?.() ?? sessionManager.buildContextEntries();
	const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
		this: typeof mode,
		entries: unknown[],
	) => void;
	renderSessionEntries.call(mode, restoredEntries);
	cursor = new LogicalCursorProbe();
	root = new tuiModule.Container() as ContainerLike;
	root.addChild(mode.chatContainer);
	root.addChild(cursor);
	tui.addChild(root);
});

const observedTranscript = deriveTranscriptCounts(restoredEntries);
const observedComponents = deriveComponentCounts(
	root,
	(component) => component instanceof ToolExecutionComponent,
	(component) => ToolGroupComponent !== undefined && component instanceof ToolGroupComponent,
);
const expectedObservedCounts = {
	entries: SYNTHETIC_ENTRY_COUNT,
	toolCalls: SYNTHETIC_TOOL_CALL_COUNT,
	toolResults: SYNTHETIC_TOOL_RESULT_COUNT,
	groupableRuns: SYNTHETIC_GROUP_COUNT,
	singletonRuns: SYNTHETIC_SINGLETON_COUNT,
};
if (JSON.stringify(observedTranscript) !== JSON.stringify(expectedObservedCounts)) {
	throw new Error(`Observed transcript mismatch: ${JSON.stringify(observedTranscript)}`);
}
const expectedComponentCounts =
	args.mode === "semantic-on"
		? {
				toolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
				toolGroupComponents: SYNTHETIC_GROUP_COUNT,
				directToolExecutionComponents: SYNTHETIC_SINGLETON_COUNT,
			}
		: {
				toolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
				toolGroupComponents: 0,
				directToolExecutionComponents: SYNTHETIC_TOOL_CALL_COUNT,
			};
if (JSON.stringify(observedComponents) !== JSON.stringify(expectedComponentCounts)) {
	throw new Error(`Observed component tree mismatch: ${JSON.stringify(observedComponents)}`);
}

const firstRender = await measure(async () => {
	tui.renderNow();
	await terminal.flush();
});
const narrowRows = tui.captureRenderState().previousLines.length;
if (JSON.stringify(terminal.getCursorPosition()) !== JSON.stringify(cursor.expectedPosition(args.width, args.height))) {
	throw new Error("First-render cursor position is incorrect");
}

let resizeToolRenders = 0;
const originalToolRender = ToolExecutionComponent.prototype.render;
ToolExecutionComponent.prototype.render = function render(width: number): string[] {
	resizeToolRenders += 1;
	return originalToolRender.call(this, width);
};
terminal.writes.length = 0;
const resize = await measure(async () => {
	terminal.resize(args.resizeWidth, args.resizeHeight);
	tui.renderNow();
	await terminal.flush();
});
ToolExecutionComponent.prototype.render = originalToolRender;

const resizeOutput = terminal.writes.join("");
const wideState = tui.captureRenderState();
const expectedCursor = cursor.expectedPosition(args.resizeWidth, args.resizeHeight);
if (resizeToolRenders !== SYNTHETIC_TOOL_CALL_COUNT) {
	throw new Error(`Expected ${SYNTHETIC_TOOL_CALL_COUNT} resize renders, got ${resizeToolRenders}`);
}
if (occurrences(resizeOutput, "\x1b[2J") !== 1 || occurrences(resizeOutput, "\x1b[3J") !== 1) {
	throw new Error("Resize did not emit exactly one CSI 2J and CSI 3J");
}
if (JSON.stringify(terminal.getCursorPosition()) !== JSON.stringify(expectedCursor)) {
	throw new Error("Resize cursor position is incorrect");
}
const visibleMarkers = fixture.orderedMarkers.filter((marker) => !marker.startsWith("TC"));
for (const marker of visibleMarkers) {
	if (occurrences(resizeOutput, marker) !== 1) throw new Error(`Resize marker count is incorrect: ${marker}`);
}
for (let index = 1; index < visibleMarkers.length; index++) {
	if (
		resizeOutput.indexOf(visibleMarkers[index - 1] ?? "") >= resizeOutput.indexOf(visibleMarkers[index] ?? "")
	) {
		throw new Error(`Resize marker order is incorrect at ${index}`);
	}
}

process.stdout.write(
	`${JSON.stringify({
		label: args.label,
		mode: args.mode,
		geometry: {
			initial: { width: args.width, height: args.height },
			resize: { width: args.resizeWidth, height: args.resizeHeight },
		},
		observations: {
			transcript: observedTranscript,
			components: observedComponents,
			render: { resizeToolRenders, narrowRows, wideRows: wideState.previousLines.length },
		},
		fixtureHash,
		packageVersions: {
			codingAgent: packageVersion(args.targetRoot, "packages/coding-agent/package.json"),
			tui: packageVersion(args.targetRoot, "packages/tui/package.json"),
		},
		measurements: { construction, firstRender, resize },
		structuralCorrectness: true,
	})}\n`,
);
