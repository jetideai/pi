import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resetCapabilitiesCache, setCapabilities, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type {
	MessageRenderBoundaryContextV1,
	MessageRenderBoundaryDecoratorV2,
	ToolDefinition,
	ToolExecutionPresentationSelectorV1,
	ToolPresentationOverrideV1,
} from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { SectionedToolCallHeader } from "../src/core/tools/render-utils.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import {
	ToolExecutionComponent,
	type ToolExecutionOptions,
} from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createBaseToolDefinition(name = "custom_tool"): ToolDefinition {
	return {
		name,
		label: name,
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({
			content: [{ type: "text", text: "ok" }],
			details: {},
		}),
	};
}

function createFakeTui(): TUI {
	return {
		requestRender: () => {},
	} as unknown as TUI;
}

const admitCompactLiveToolCall: ToolExecutionPresentationSelectorV1 = () => ({
	liveToolCall: "compact-stock-header",
	liveToolGroup: "stock",
	header: "exact-one-row",
	settled: "canonical-initial-collapsed",
});

function liveToolOptions(
	selector: ToolExecutionPresentationSelectorV1 = admitCompactLiveToolCall,
): ToolExecutionOptions {
	return {
		ownerEntryId: "assistant-entry-live",
		producerSessionId: "session-live",
		renderScopeId: "scope-live",
		semanticSelectorsV3: [
			() => () => ({
				begin: "\x1b]777;live-begin\x07",
				body: "\x1b]777;live-body\x07",
				end: "\x1b]777;live-end\x07",
			}),
		],
		toolExecutionPresentationSelectorsV1: [selector],
	};
}

describe("ToolExecutionComponent parity", () => {
	test("keeps admitted cumulative running output behind one stock header row", () => {
		let resultRenders = 0;
		const latestPartial = Array.from({ length: 200 }, (_, index) => `partial-${index + 1}`).join("\n");
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			getRenderCallHeaderRow: () => 0,
			getRenderCallBodyRow: () => 1,
			renderCall: () => {
				const header = new SectionedToolCallHeader("", 0, 0);
				header.setSectionedContent(() => "stock running header", "stock running header");
				return header;
			},
			renderResult: (result) => {
				resultRenders += 1;
				const text = result.content[0]?.type === "text" ? result.content[0].text : "";
				return new Text(text, 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-live-cumulative",
			{},
			liveToolOptions(),
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		for (const lineCount of [50, 125, 200]) {
			const cumulative = latestPartial.split("\n").slice(0, lineCount).join("\n");
			component.updateResult({ content: [{ type: "text", text: cumulative }], isError: false }, true);
			expect(component.render(80)).toHaveLength(1);
		}
		const wide = component.render(80).map((line) => stripAnsi(line));
		const narrow = component.render(12).map((line) => stripAnsi(line));

		expect(wide.map((line) => line.trimEnd())).toEqual(["stock running header"]);
		expect(narrow).toHaveLength(1);
		expect(narrow.join("\n")).not.toContain("partial-");
		expect(component.render(80).join("\n")).not.toMatch(/begin|body|end/);
		expect(resultRenders).toBe(0);

		component.updateResult({ content: [{ type: "text", text: latestPartial }], isError: false }, false);
		const settled = component.render(80).join("\n");
		const positions = ["begin", "body", "partial-1", "partial-200", "end"].map((value) => settled.indexOf(value));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((left, right) => left - right));
		expect(resultRenders).toBe(1);
	});

	test("keeps stock streaming rows when compact live presentation is disabled", () => {
		let resultRenders = 0;
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			getRenderCallHeaderRow: () => 0,
			getRenderCallBodyRow: () => 1,
			renderCall: () => new Text("stock header", 0, 0),
			renderResult: () => {
				resultRenders += 1;
				return new Text("stock partial body", 0, 0);
			},
		};
		const options = liveToolOptions();
		options.toolExecutionPresentationSelectorsV1 = [];
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-live-disabled",
			{},
			options,
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		component.updateResult({ content: [{ type: "text", text: "stock partial body" }], isError: false }, true);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("stock partial body");
		expect(resultRenders).toBe(1);
	});

	test("keeps stock streaming rows without an exact compact header seam", () => {
		let resultRenders = 0;
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("unsupported header", 0, 0),
			renderResult: () => {
				resultRenders += 1;
				return new Text("unsupported partial body", 0, 0);
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-live-unsupported",
			{},
			liveToolOptions(),
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		component.updateResult({ content: [{ type: "text", text: "unsupported partial body" }], isError: false }, true);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("unsupported partial body");
		expect(resultRenders).toBe(1);
	});

	test.each([
		[
			"throws",
			(() => {
				throw new Error("selector failure");
			}) as ToolExecutionPresentationSelectorV1,
		],
		[
			"returns an invalid response",
			(() => ({ liveToolCall: "stock" })) as unknown as ToolExecutionPresentationSelectorV1,
		],
	])("keeps stock streaming rows when the selector %s", (_caseName, selector) => {
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			getRenderCallHeaderRow: () => 0,
			getRenderCallBodyRow: () => 1,
			renderCall: () => new Text("stock header", 0, 0),
			renderResult: () => new Text("selector fallback body", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-live-selector-fallback",
			{},
			liveToolOptions(selector),
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();

		component.updateResult({ content: [{ type: "text", text: "selector fallback body" }], isError: false }, true);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("selector fallback body");
	});

	test.each([
		["completion", false, "complete result"],
		["tool error", true, "tool error result"],
		["normal cancellation", true, "Operation aborted"],
	])("materializes canonical stock content and boundaries on %s", (_outcome, isError, resultText) => {
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			getRenderCallHeaderRow: () => 0,
			getRenderCallBodyRow: () => 1,
			renderCall: () => new Text("stock header", 0, 0),
			renderResult: (result) => new Text(result.content[0]?.type === "text" ? result.content[0].text : "", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			`tool-live-${_outcome}`,
			{},
			liveToolOptions(),
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial result" }], isError: false }, true);

		component.updateResult({ content: [{ type: "text", text: resultText }], isError }, false);
		const first = component.render(80);
		component.updateResult({ content: [{ type: "text", text: resultText }], isError }, false);
		const duplicate = component.render(80);

		expect(stripAnsi(first.join("\n"))).toContain(resultText);
		expect(first.join("\n")).toMatch(/begin.*body.*end/s);
		expect(duplicate).toEqual(first);
	});

	test("keeps historical Tool Calls canonical without entering live compact state", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-live-history",
			{ command: "printf historical" },
			liveToolOptions(),
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		component.updateResult({ content: [{ type: "text", text: "historical body" }], isError: false }, false);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("historical body");
	});

	test("updates the admitted Bash status without adding a row", () => {
		vi.useFakeTimers();
		try {
			const requestRender = vi.fn();
			const component = new ToolExecutionComponent(
				"bash",
				"tool-live-status",
				{ command: "printf running" },
				liveToolOptions(),
				createBashToolDefinition(process.cwd()),
				{ requestRender } as unknown as TUI,
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
			requestRender.mockClear();

			const before = component.render(40);
			vi.advanceTimersByTime(1000);
			const after = component.render(40);

			expect(before).toHaveLength(1);
			expect(after).toHaveLength(1);
			expect(requestRender).toHaveBeenCalledTimes(1);
			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});
	beforeAll(() => {
		initTheme("dark");
	});

	test("B16 keeps a singleton Tool Call as one Fold without a Tool Group", () => {
		const select = vi.fn(() => () => ({ begin: "\x1b]7799;begin\x1b\\", body: "", end: "\x1b]7799;end\x1b\\" }));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-v3",
			{},
			{
				ownerEntryId: "assistant-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [select],
			},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);

		expect(select).toHaveBeenCalledWith({
			producerSessionId: "session-v3",
			renderScopeId: "scope-v3",
			entryId: "tool-v3",
			blockId: "tool-v3",
			role: "tool",
			state: "expanded",
			ownerEntryId: "assistant-v3",
		});
		expect(component.render(80).join("\n")).toContain("\x1b]7799;begin\x1b\\");
	});

	test("pins the selected V2 decorator when its selection condition changes", () => {
		const selectedControls = {
			begin: "\x1b]777;selected-begin\x07",
			body: "\x1b]777;selected-body\x07",
			end: "\x1b]777;selected-end\x07",
		};
		const rejectedControls = {
			begin: "\x1b]777;rejected-begin\x07",
			body: "\x1b]777;rejected-body\x07",
			end: "\x1b]777;rejected-end\x07",
		};
		let enabled = true;
		const select = vi.fn(() => (enabled ? () => selectedControls : () => rejectedControls));
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-pinned-sections",
			{},
			{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [select] },
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);

		enabled = false;
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		const rendered = component.render(80).join("\n");

		expect(select).toHaveBeenCalledOnce();
		expect(select).toHaveBeenCalledWith({
			entryId: "tool-pinned-sections",
			ownerEntryId: "assistant-entry-1",
			role: "tool",
			state: "expanded",
		});
		expect(rendered).toContain(selectedControls.begin);
		expect(rendered).not.toContain(rejectedControls.begin);
	});

	test.each([
		["returns no decorator", (): undefined => undefined],
		[
			"throws",
			(): never => {
				throw new Error("selector failed");
			},
		],
	] as const)("uses the legacy path when a V2 selector %s", (_name, select) => {
		let stockCallRenders = 0;
		let stockResultRenders = 0;
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-unselected-sections",
			{},
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [select],
				presentationOverrides: [() => ({ state: "collapsed", component: new Text("compact row", 0, 0) })],
			},
			{
				...createBaseToolDefinition(),
				renderCall: () => {
					stockCallRenders += 1;
					return new Text("full call", 0, 0);
				},
				renderResult: () => {
					stockResultRenders += 1;
					return new Text("full result", 0, 0);
				},
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		expect(component.render(80).map((line) => line.trimEnd())).toEqual(["compact row"]);
		expect({ stockCallRenders, stockResultRenders }).toEqual({ stockCallRenders: 0, stockResultRenders: 0 });
	});

	test.each([
		[
			"throws",
			() => {
				throw new Error("decorator failed");
			},
		],
		["returns invalid controls", () => ({ begin: "visible control" })],
	] as const)("keeps the canonical body when a selected V2 decorator %s", (_name, decorate) => {
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-failed-decoration",
			{},
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [() => decorate as MessageRenderBoundaryDecoratorV2],
				presentationOverrides: [() => ({ state: "collapsed", component: new Text("compact row", 0, 0) })],
			},
			{
				...createBaseToolDefinition(),
				renderCall: () => new Text("canonical call", 0, 0),
				renderResult: () => new Text("canonical result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const rendered = component.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("canonical call");
		expect(stripAnsi(rendered)).toContain("canonical result");
		expect(stripAnsi(rendered)).not.toContain("compact row");
		expect(stripAnsi(rendered)).not.toContain("visible control");
	});

	test("passes real ranges to a pinned V2 decorator once per render", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const select = vi.fn(() => (context: Readonly<MessageRenderBoundaryContextV1>) => {
			contexts.push(context);
			return { begin: "", body: "", end: "" };
		});
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-real-ranges",
			{},
			{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [select] },
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		component.invalidate();

		const wideRows = component.render(80).length;
		const narrowRows = component.render(20).length;

		expect(select).toHaveBeenCalledOnce();
		expect(contexts[0]).toMatchObject({
			entryId: "tool-real-ranges",
			ownerEntryId: "assistant-entry-1",
			role: "tool",
			state: "expanded",
		});
		expect(contexts.map((context) => [context.allocatedColumns.end, context.stockRows.end])).toEqual([
			[80, wideRows],
			[20, narrowRows],
		]);
	});

	test("composes selected V2 decorators in registration order", () => {
		const first = {
			begin: "\x1b]777;first-begin\x07",
			body: "\x1b]777;first-body\x07",
			end: "\x1b]777;first-end\x07",
		};
		const second = {
			begin: "\x1b]777;second-begin\x07",
			body: "\x1b]777;second-body\x07",
			end: "\x1b]777;second-end\x07",
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-composed-sections",
			{},
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [() => () => first, () => () => second],
			},
			createBaseToolDefinition(),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "body marker" }], isError: false }, false);

		const rendered = component.render(80).join("\n");
		const markers = [first.begin, second.begin, first.body, second.body, "body marker", second.end, first.end];
		const offsets = markers.map((marker) => rendered.indexOf(marker));
		expect(offsets.every((offset) => offset >= 0)).toBe(true);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});

	test("renders one completed read as one canonical header and its complete result body", () => {
		const controls = {
			begin: "\x1b]777;tool-begin\x07",
			body: "\x1b]777;tool-body\x07",
			end: "\x1b]777;tool-end\x07",
		};
		const decorate: MessageRenderBoundaryDecoratorV2 = () => controls;
		const stockDefinition = createReadToolDefinition(process.cwd());
		let callRenders = 0;
		let resultRenders = 0;
		const toolDefinition: typeof stockDefinition = {
			...stockDefinition,
			renderCall: (args, currentTheme, context) => {
				callRenders += 1;
				return stockDefinition.renderCall!(args, currentTheme, context);
			},
			renderResult: (result, options, currentTheme, context) => {
				resultRenders += 1;
				return stockDefinition.renderResult!(result, options, currentTheme, context);
			},
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-sections",
			{ path: "notes.txt" },
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [() => decorate],
			},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);

		const rendersBeforeUpdate = { callRenders, resultRenders };
		component.updateResult(
			{ content: [{ type: "text", text: "complete result marker" }], details: undefined, isError: false },
			false,
		);
		const rendersAfterUpdate = { callRenders, resultRenders };
		const rendered = component.render(80);

		expect({
			callRenders: rendersAfterUpdate.callRenders - rendersBeforeUpdate.callRenders,
			resultRenders: rendersAfterUpdate.resultRenders - rendersBeforeUpdate.resultRenders,
		}).toEqual({ callRenders: 1, resultRenders: 1 });
		expect({ callRenders, resultRenders }).toEqual(rendersAfterUpdate);
		expect(stripAnsi(rendered.join("\n"))).toContain("complete result marker");
		expect(rendered.join("\n")).toContain(`${controls.begin}`);
		expect(rendered.join("\n")).toContain(`${controls.body}`);
		expect(rendered.join("\n")).toContain(`${controls.end}`);
		const headerRow = rendered.findIndex((line) => stripAnsi(line).includes("read notes.txt"));
		const bodyRow = rendered.findIndex((line) => line.includes(controls.body));
		const resultRow = rendered.findIndex((line) => stripAnsi(line).includes("complete result marker"));
		expect(stripAnsi(rendered[0] ?? "")).toBe("");
		expect(rendered[0]).not.toContain(controls.begin);
		expect(rendered[headerRow]).toContain(controls.begin);
		expect(bodyRow).toBeGreaterThan(headerRow);
		expect(bodyRow).toBeLessThanOrEqual(resultRow);
		expect(rendered.filter((line) => stripAnsi(line).includes("read notes.txt"))).toHaveLength(1);
	});

	test.each([
		{
			toolName: "read",
			args: { path: "x" },
			definition: createReadToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "read result marker" }], isError: false },
		},
		{
			toolName: "bash",
			args: { command: "x" },
			definition: createBashToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "bash result marker" }], isError: false },
		},
	])(
		"puts the completed V3 $toolName header and BODY in the first two rows",
		({ toolName, args, definition, result }) => {
			const controls = {
				begin: "\x1b]777;v3-begin\x07",
				body: "\x1b]777;v3-body\x07",
				end: "\x1b]777;v3-end\x07",
			};
			for (const width of [80, 8]) {
				const component = new ToolExecutionComponent(
					toolName,
					`tool-v3-${toolName}-${width}`,
					args,
					{
						ownerEntryId: "assistant-entry-v3",
						producerSessionId: "session-v3",
						renderScopeId: "scope-v3",
						semanticSelectorsV3: [() => () => controls],
					},
					definition,
					createFakeTui(),
					process.cwd(),
				);
				component.updateResult(result, false);

				const rendered = component.render(width);
				const visible = rendered.map((line) => stripAnsi(line));

				expect(rendered[0]).toContain(controls.begin);
				expect(rendered[1]).toContain(controls.body);
				expect(rendered.at(-1)).toContain(controls.end);
				expect(visible[0]).toContain(toolName === "read" ? "read" : "$ ");
				expect(visible[1]?.trim()).toContain(toolName);
				expect(visible.slice(1).join(" ")).toContain(toolName);
				expect(visible.slice(1).join(" ")).toContain("result");
				expect(visible.slice(1).join(" ")).toContain("marker");
			}
		},
	);

	test.each([
		{
			toolName: "read",
			args: { path: "x" },
			definition: createReadToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: true },
		},
		{
			toolName: "bash",
			args: { command: "x" },
			definition: createBashToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: false },
		},
		{
			toolName: "write",
			args: { path: "notes.txt", content: "value" },
			definition: createWriteToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: true },
		},
		{
			toolName: "ls",
			args: { path: "." },
			definition: createLsToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: false },
		},
		{
			toolName: "find",
			args: { pattern: "*.ts", path: "." },
			definition: createFindToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: false },
		},
		{
			toolName: "grep",
			args: { pattern: "needle", path: "." },
			definition: createGrepToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "result" }], isError: false },
		},
	])(
		"omits the stock leading result separator for selected V3 $toolName",
		({ toolName, args, definition, result }) => {
			const controls = {
				begin: "\x1b]777;other-v3-begin\x07",
				body: "\x1b]777;other-v3-body\x07",
				end: "\x1b]777;other-v3-end\x07",
			};
			for (const width of [80, 8]) {
				const component = new ToolExecutionComponent(
					toolName,
					`tool-v3-other-${toolName}-${width}`,
					args,
					{
						ownerEntryId: "assistant-entry-v3",
						producerSessionId: "session-v3",
						renderScopeId: "scope-v3",
						semanticSelectorsV3: [() => () => controls],
					},
					definition,
					createFakeTui(),
					process.cwd(),
				);
				component.updateResult(result, false);

				const rendered = component.render(width);
				const visible = rendered.map((line) => stripAnsi(line));
				const stock = new ToolExecutionComponent(
					toolName,
					`tool-stock-other-${toolName}-${width}`,
					args,
					{},
					definition,
					createFakeTui(),
					process.cwd(),
				);
				stock.updateResult(result, false);
				const stockVisible = stock.render(width).map((line) => stripAnsi(line));
				const headerMarker = toolName === "bash" ? "$ " : toolName;
				const selectedHeaderRow = visible.findIndex((line) => line.includes(headerMarker));
				const stockHeaderRow = stockVisible.findIndex((line) => line.includes(headerMarker));
				const selectedResultRow = visible.findIndex((line) => line.trim() === "result");
				const stockResultRow = stockVisible.findIndex((line) => line.trim() === "result");

				expect(rendered[0]).toContain(controls.begin);
				expect(rendered[1]).toContain(controls.body);
				expect(selectedResultRow - selectedHeaderRow).toBe(stockResultRow - stockHeaderRow - 1);
				expect(selectedResultRow).toBeGreaterThanOrEqual(1);
				expect(stockVisible[stockResultRow - 1]?.trim()).toBe("");
				expect(rendered.at(-1)).toContain(controls.end);
			}
		},
	);

	test("uses the renderer-owned edit seam for the first two V3 rows", () => {
		const controls = {
			begin: "\x1b]777;edit-v3-begin\x07",
			body: "\x1b]777;edit-v3-body\x07",
			end: "\x1b]777;edit-v3-end\x07",
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-v3-edit",
			{ path: "a-very-long-file-name.txt", edits: [{ oldText: "before", newText: "after" }] },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced one block." }],
				details: { diff: "-before\n+after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		const rendered = component.render(8);
		const visible = rendered.map((line) => stripAnsi(line));
		const diffRow = visible.findIndex((line) => line.includes("after"));

		expect(rendered[0]).toContain(controls.begin);
		expect(rendered[1]).toContain(controls.body);
		expect(rendered.at(-1)).toContain(controls.end);
		expect(visible[0]).toContain("edit");
		expect(diffRow).toBeGreaterThan(1);
	});

	test.each([
		{
			toolName: "edit",
			args: { path: "x", edits: [{ oldText: "before", newText: "E" }] },
			definition: undefined,
			resultText: "ok",
			bodyMarker: "+E",
			resultDetails: { diff: "+E", patch: "", firstChangedLine: 1 },
		},
	])(
		"puts the first exact self-rendered V3 body row immediately after the header at widths 80 and 8",
		({ toolName, args, definition, resultText, bodyMarker, resultDetails }) => {
			const controls = {
				begin: "\x1b]777;rows-begin\x07",
				body: "\x1b]777;rows-body\x07",
				end: "\x1b]777;rows-end\x07",
			};
			for (const width of [80, 8]) {
				const component = new ToolExecutionComponent(
					toolName,
					`tool-v3-rows-${toolName}-${width}`,
					args,
					{
						ownerEntryId: "assistant-entry-v3",
						producerSessionId: "session-v3",
						renderScopeId: "scope-v3",
						semanticSelectorsV3: [() => () => controls],
					},
					definition,
					createFakeTui(),
					process.cwd(),
				);
				component.updateResult(
					{
						content: [{ type: "text", text: resultText }],
						details: resultDetails,
						isError: false,
					},
					false,
				);

				const rendered = component.render(width);
				expect(rendered[0]).toContain(controls.begin);
				expect(rendered[1]).toContain(controls.body);
				expect(stripAnsi(rendered[1] ?? "")).toContain(bodyMarker);
				expect(rendered.at(-1)).toContain(controls.end);
			}
		},
	);

	test("keeps a self renderer without exact locators byte-equivalent", () => {
		const controls = {
			begin: "\x1b]777;custom-begin\x07",
			body: "\x1b]777;custom-body\x07",
			end: "\x1b]777;custom-end\x07",
		};
		const definition: ToolDefinition = {
			...createBaseToolDefinition("custom_self"),
			renderShell: "self",
			renderCall: () => new Text("custom self header", 0, 0),
			renderResult: () => new Text("custom self body", 0, 0),
		};
		const selected = new ToolExecutionComponent(
			"custom_self",
			"tool-v3-custom-self-selected",
			{},
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const stock = new ToolExecutionComponent(
			"custom_self",
			"tool-v3-custom-self-stock",
			{},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const selectedRows = selected.render(80).map((line) => stripAnsi(line));
		const stockRows = stock.render(80).map((line) => stripAnsi(line));

		expect(selectedRows).toEqual(stockRows);
	});

	test("fails open when a self header locator leaves nonblank call rows", () => {
		const controls = {
			begin: "\x1b]777;custom-self-header-only-begin\x07",
			body: "\x1b]777;custom-self-header-only-body\x07",
			end: "\x1b]777;custom-self-header-only-end\x07",
		};
		const definition: ToolDefinition = {
			...createBaseToolDefinition("custom_self_header_only"),
			renderShell: "self",
			getRenderCallHeaderRow: () => 0,
			renderCall: () => new Text("custom self header\ncustom self preview", 0, 0),
			renderResult: () => new Text("custom self body", 0, 0),
		};
		const selected = new ToolExecutionComponent(
			"custom_self_header_only",
			"tool-v3-custom-self-header-only-selected",
			{},
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const stock = new ToolExecutionComponent(
			"custom_self_header_only",
			"tool-v3-custom-self-header-only-stock",
			{},
			{},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		const selectedRows = selected.render(80).map((line) => stripAnsi(line));
		const stockRows = stock.render(80).map((line) => stripAnsi(line));

		expect(selectedRows).toEqual(stockRows);
		expect(selected.hasSelectedNormalizedSections()).toBe(false);
		expect(selectedRows.some((line) => line.includes("custom self preview"))).toBe(true);
	});

	test("preserves a custom default renderer's leading blank body row", () => {
		const controls = {
			begin: "\x1b]777;custom-default-blank-begin\x07",
			body: "\x1b]777;custom-default-blank-body\x07",
			end: "\x1b]777;custom-default-blank-end\x07",
		};
		const definition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("custom default header", 0, 0),
			renderResult: () => new Text("\ncustom default body", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-v3-custom-read-default-blank",
			{},
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "ignored" }], isError: false }, false);

		const rawRendered = component.render(80);
		const rendered = rawRendered.map((line) => stripAnsi(line));
		const bodyMarkerRow = rendered.findIndex((line) => line.includes("custom default body"));

		expect(rawRendered[0]).toContain(controls.begin);
		expect(rendered[1]?.trim()).toBe("");
		expect(bodyMarkerRow).toBe(2);
		expect(rawRendered.at(-1)).toContain(controls.end);
	});

	test("keeps an empty exact self call as one valid header section", () => {
		const controls = {
			begin: "\x1b]777;empty-self-begin\x07",
			body: "\x1b]777;empty-self-body\x07",
			end: "\x1b]777;empty-self-end\x07",
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-v3-empty-edit",
			{ path: "x", edits: [{ oldText: "before", newText: "after" }] },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const rendered = component.render(80);

		expect(rendered).toHaveLength(1);
		expect(rendered[0]).toContain(controls.begin);
		expect(rendered[0]).toContain(controls.end);
		expect(rendered[0]).not.toContain(controls.body);
	});

	test("keeps the unaware stock read output byte-equivalent", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		const component = new ToolExecutionComponent(
			"read",
			"tool-stock-read",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "complete result marker" }], isError: false }, false);

		try {
			expect(component.render(80)).toEqual([
				"",
				"\x1b[48;2;40;50;40m                                                                                \x1b[49m",
				"\x1b[48;2;40;50;40m \x1b[38;2;212;212;212mread\x1b[39m \x1b[38;2;138;190;183mnotes.txt\x1b[39m                                                                 \x1b[49m",
				"\x1b[48;2;40;50;40m                                                                                \x1b[49m",
			]);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test.each([80, 8])("places the settled edit BODY control before its diff at width %i", (width) => {
		const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-sections",
			{ path: "notes.txt", edits: [{ oldText: "before marker", newText: "after marker" }] },
			{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [() => () => controls] },
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced one block." }],
				details: { diff: "-before marker\n+after marker", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		const rendered = component.render(width).join("\n");
		const positions = [controls.begin, "edit", controls.body, "after", controls.end].map((value) =>
			rendered.indexOf(value),
		);
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	test("retains one edit call component and does not invoke its renderer during layout", () => {
		const stockDefinition = createEditToolDefinition(process.cwd());
		const callComponents = new Set<unknown>();
		let callRenders = 0;
		const toolDefinition: typeof stockDefinition = {
			...stockDefinition,
			renderCall: (args, currentTheme, context) => {
				callRenders += 1;
				const rendered = stockDefinition.renderCall!(args, currentTheme, context);
				callComponents.add(rendered);
				return rendered;
			},
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-identity",
			{ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] },
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [() => () => ({ begin: "", body: "", end: "" })],
			},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const rendersBeforeUpdate = callRenders;
		component.updateResult(
			{ content: [], details: { diff: "-before\n+after", patch: "", firstChangedLine: 1 }, isError: false },
			false,
		);
		const rendersAfterUpdate = callRenders;

		component.render(80);
		component.render(8);

		expect(rendersAfterUpdate - rendersBeforeUpdate).toBe(1);
		expect(callRenders).toBe(rendersAfterUpdate);
		expect(callComponents.size).toBe(1);
	});

	test("does not apply the built-in edit locator to a custom renderer", () => {
		const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
		const toolDefinition = {
			...createEditToolDefinition(process.cwd()),
			renderCall: () => new Text("custom edit header\ncustom header middle\ncustom header tail", 0, 0),
			renderResult: () => new Text("custom edit result", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-custom-renderer",
			{},
			{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [() => () => controls] },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], isError: false }, false);

		const rendered = component.render(80).join("\n");
		const positions = [
			controls.begin,
			"custom edit header",
			"custom header tail",
			controls.body,
			"custom edit result",
			controls.end,
		].map((value) => rendered.indexOf(value));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	test("does not apply the built-in edit locator to a custom V3 renderer", () => {
		const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
		const toolDefinition = {
			...createEditToolDefinition(process.cwd()),
			renderCall: () => new Text("custom edit header\ncustom header middle\ncustom header tail", 0, 0),
			renderResult: () => new Text("custom edit result", 0, 0),
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-custom-renderer-v3",
			{},
			{
				ownerEntryId: "assistant-entry-1",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], isError: false }, false);

		const rendered = component.render(80).join("\n");
		const positions = [
			controls.begin,
			"custom edit header",
			"custom header tail",
			controls.body,
			"custom edit result",
			controls.end,
		].map((value) => rendered.indexOf(value));
		expect(positions.every((position) => position >= 0)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	test("retains renderer state and components from a partial result through the final result", () => {
		type RenderState = { updates?: number };
		const states: RenderState[] = [];
		const callComponents: Text[] = [];
		const resultComponents: Text[] = [];
		const requestRender = vi.fn();
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				states.push(context.state);
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText("retained header");
				callComponents.push(text);
				return text;
			},
			renderResult: (result, _options, _theme, context) => {
				states.push(context.state);
				context.state.updates = (context.state.updates ?? 0) + 1;
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(result.content[0]?.type === "text" ? result.content[0].text : "");
				resultComponents.push(text);
				return text;
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-retained-sections",
			{},
			{
				ownerEntryId: "assistant-entry-1",
				semanticSelectorsV2: [() => () => ({ begin: "\x1b[1m", body: "\x1b[2m", end: "\x1b[3m" })],
			},
			toolDefinition,
			{ requestRender } as unknown as TUI,
			process.cwd(),
		);

		component.updateResult({ content: [{ type: "text", text: "partial body" }], isError: false }, true);
		const partial = stripAnsi(component.render(80).join("\n"));
		component.updateResult({ content: [{ type: "text", text: "final body" }], isError: false }, false);
		const final = stripAnsi(component.render(80).join("\n"));

		expect(partial).toContain("partial body");
		expect(final).toContain("final body");
		expect(new Set(states)).toHaveProperty("size", 1);
		expect(new Set(callComponents)).toHaveProperty("size", 1);
		expect(new Set(resultComponents)).toHaveProperty("size", 1);
		expect(states[0]?.updates).toBe(2);
		expect(requestRender).not.toHaveBeenCalled();
	});

	test("keeps one bash interval through partial section updates and clears it on the final result", () => {
		vi.useFakeTimers();
		const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
		try {
			const component = new ToolExecutionComponent(
				"bash",
				"tool-bash-sections",
				{ command: "printf done" },
				{
					ownerEntryId: "assistant-entry-1",
					semanticSelectorsV2: [() => () => ({ begin: "\x1b[1m", body: "\x1b[2m", end: "\x1b[3m" })],
				},
				createBashToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted();

			component.updateResult({ content: [{ type: "text", text: "first" }], isError: false }, true);
			component.updateResult({ content: [{ type: "text", text: "second" }], isError: false }, true);
			expect(setIntervalSpy).toHaveBeenCalledTimes(1);

			component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.restoreAllMocks();
			vi.useRealTimers();
		}
	});

	test("keeps generic error, image, and malformed custom output in one canonical body", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const controls = { begin: "\x1b[1m", body: "\x1b[2m", end: "\x1b[3m" };
			const component = new ToolExecutionComponent(
				"unknown_tool",
				"tool-error-sections",
				{ target: "notes.txt" },
				{
					ownerEntryId: "assistant-entry-1",
					semanticSelectorsV2: [() => () => controls],
				},
				undefined,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{
					content: [
						{ type: "text", text: "bounded error marker" },
						{ type: "image", data: "AA==", mimeType: "image/png" },
					],
					isError: true,
				},
				false,
			);

			const rendered = component.render(80);
			const headerRows = rendered.filter((line) => stripAnsi(line).includes("unknown_tool"));
			const bodyRow = rendered.findIndex((line) => line.includes(controls.body));
			const errorRow = rendered.findIndex((line) => stripAnsi(line).includes("bounded error marker"));

			expect(headerRows).toHaveLength(1);
			expect(bodyRow).toBeGreaterThanOrEqual(0);
			expect(bodyRow).toBeLessThanOrEqual(errorRow);
			expect(rendered.join("\n")).toContain(controls.begin);
			expect(rendered.join("\n")).toContain(controls.end);
			expect(stripAnsi(rendered.join("\n"))).toContain("[Image: [image/png]]");

			const malformed = new ToolExecutionComponent(
				"custom_tool",
				"tool-malformed-header",
				{},
				{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [() => () => controls] },
				{
					...createBaseToolDefinition(),
					renderCall: () => {
						throw new Error("malformed header");
					},
					renderResult: () => new Text("custom body marker", 0, 0),
				},
				createFakeTui(),
				process.cwd(),
			);
			malformed.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			const malformedRender = stripAnsi(malformed.render(80).join("\n"));
			expect(malformedRender).toContain("custom_tool");
			expect(malformedRender).toContain("custom body marker");
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("places BODY before an image-only Tool Call result", () => {
		setCapabilities({ images: "kitty", trueColor: false, hyperlinks: false });
		try {
			const controls = {
				begin: "\x1b]777;image-begin\x07",
				body: "\x1b]777;image-body\x07",
				end: "\x1b]777;image-end\x07",
			};
			const component = new ToolExecutionComponent(
				"image_tool",
				"tool-image-sections",
				{},
				{ ownerEntryId: "assistant-entry-1", semanticSelectorsV2: [() => () => controls] },
				createBaseToolDefinition("image_tool"),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{
					content: [
						{
							type: "image",
							data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==",
							mimeType: "image/png",
						},
					],
					isError: false,
				},
				false,
			);

			const rendered = component.render(80).join("\n");
			const positions = [controls.begin, controls.body, "\x1b_G", controls.end].map((value) =>
				rendered.indexOf(value),
			);
			expect(positions.every((position) => position >= 0)).toBe(true);
			expect(positions).toEqual([...positions].sort((a, b) => a - b));
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("renders one compact completed edit row without calling stock renderers while collapsed", () => {
		let stockCallRenders = 0;
		let stockResultRenders = 0;
		const stockDefinition: ToolDefinition = {
			...createEditToolDefinition(process.cwd()),
			renderCall: () => {
				stockCallRenders += 1;
				return new Text("full edit call", 0, 0);
			},
			renderResult: () => {
				stockResultRenders += 1;
				return new Text("full edit result", 0, 0);
			},
		};
		const presentation: ToolPresentationOverrideV1 = () => ({
			state: "collapsed",
			component: new Text("edit notes.txt complete", 0, 0),
		});
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-1",
			{ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] },
			{ presentationOverrides: [presentation] },
			stockDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
				details: { diff: "-before\n+after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		const rendered = component.render(80);

		expect(rendered).toHaveLength(1);
		expect(rendered[0]?.trimEnd()).toBe("edit notes.txt complete");
		expect({ stockCallRenders, stockResultRenders }).toEqual({ stockCallRenders: 0, stockResultRenders: 0 });
	});

	test("delegates an expanded edit to its retained stock renderers after targeted invalidation", () => {
		let stockCallRenders = 0;
		let stockResultRenders = 0;
		let expanded = false;
		let invalidate: (() => void) | undefined;
		const stockDefinition: ToolDefinition = {
			...createEditToolDefinition(process.cwd()),
			renderCall: () => {
				stockCallRenders += 1;
				return new Text("full edit call", 0, 0);
			},
			renderResult: () => {
				stockResultRenders += 1;
				return new Text("full edit result", 0, 0);
			},
		};
		const presentation: ToolPresentationOverrideV1 = (context) => {
			invalidate = context.invalidate;
			return expanded
				? { state: "expanded" }
				: { state: "collapsed", component: new Text("edit notes.txt complete", 0, 0) };
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-1",
			{ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] },
			{ presentationOverrides: [presentation] },
			stockDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
				details: { diff: "-before\n+after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		expanded = true;
		invalidate?.();
		const rendered = component.render(80).map((line) => line.trimEnd());

		expect(rendered).toEqual(["", "full edit call", "full edit result"]);
		expect({ stockCallRenders, stockResultRenders }).toEqual({ stockCallRenders: 1, stockResultRenders: 1 });
	});

	test("gives a targeted expanded read its full stock result", () => {
		let expanded = false;
		let invalidate: (() => void) | undefined;
		const presentation: ToolPresentationOverrideV1 = (context) => {
			invalidate = context.invalidate;
			return expanded
				? { state: "expanded" }
				: { state: "collapsed", component: new Text("read notes.txt complete", 0, 0) };
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-1",
			{ path: "notes.txt" },
			{ presentationOverrides: [presentation] },
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		expanded = true;
		invalidate?.();

		expect(stripAnsi(component.render(120).join("\n"))).toContain("hidden content");
	});

	test("uses the same compact and expanded seam for a registered custom tool", () => {
		let stockCallRenders = 0;
		let stockResultRenders = 0;
		let expanded = false;
		let invalidate: (() => void) | undefined;
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => {
				stockCallRenders += 1;
				return new Text("custom call", 0, 0);
			},
			renderResult: () => {
				stockResultRenders += 1;
				return new Text("custom result", 0, 0);
			},
		};
		const presentation: ToolPresentationOverrideV1 = (context) => {
			invalidate = context.invalidate;
			return expanded
				? { state: "expanded" }
				: { state: "collapsed", component: new Text("custom_tool complete", 0, 0) };
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-custom-1",
			{},
			{ presentationOverrides: [presentation] },
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);

		expect(component.render(80).map((line) => line.trimEnd())).toEqual(["custom_tool complete"]);
		expect({ stockCallRenders, stockResultRenders }).toEqual({ stockCallRenders: 0, stockResultRenders: 0 });

		expanded = true;
		invalidate?.();

		const expandedRows = stripAnsi(component.render(80).join("\n"));
		expect(expandedRows).toContain("custom call");
		expect(expandedRows).toContain("custom result");
		expect({ stockCallRenders, stockResultRenders }).toEqual({ stockCallRenders: 1, stockResultRenders: 1 });
	});

	test("gives presentation overrides the current completion and result facts", () => {
		const observed: Array<{ isPartial?: boolean; resultText?: string }> = [];
		const presentation: ToolPresentationOverrideV1 = (context) => {
			observed.push({
				isPartial: context.isPartial,
				resultText: context.result?.content.find((content) => content.type === "text")?.text,
			});
			return { state: "expanded" };
		};
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-1",
			{ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] },
			{ presentationOverrides: [presentation] },
			createEditToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "Successfully replaced 1 block(s) in notes.txt." }],
				details: { diff: "-before\n+after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		expect(observed.at(-1)).toEqual({
			isPartial: false,
			resultText: "Successfully replaced 1 block(s) in notes.txt.",
		});
	});

	test("stacks custom call and result renderers like the old implementation", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("custom call", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(stripAnsi(component.render(120).join("\n"))).toContain("custom call");

		component.updateResult(
			{
				content: [{ type: "text", text: "done" }],
				details: {},
				isError: false,
			},
			false,
		);

		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call");
		expect(rendered).toContain("custom result");
	});

	test("self-rendered empty tool rows take no layout space", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("", 0, 0),
			renderResult: () => new Text("", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-empty-self-render",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		expect(component.render(120)).toEqual([]);

		component.updateResult(
			{
				content: [],
				details: {},
				isError: false,
			},
			false,
		);

		expect(component.render(120)).toEqual([]);
	});

	test("uses built-in rendering for built-in overrides without custom renderers", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("edit"),
		};

		const component = new ToolExecutionComponent(
			"edit",
			"tool-2",
			{ path: "README.md", oldText: "before", newText: "after" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [], details: { diff: "+1 after", firstChangedLine: 1 }, isError: false });
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("edit");
		expect(rendered).toContain("README.md");
		expect(rendered).not.toContain(":1");
	});

	test("preserves legacy file_path rendering compatibility for built-in tools", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-3",
			{ file_path: "README.md" },
			{},
			undefined,
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
	});

	test("bash execute emits an initial empty partial update before output arrives", async () => {
		const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
		const operations: BashOperations = {
			exec: async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const promise = tool.execute(
			"tool-bash-1",
			{ command: "sleep 10" },
			undefined,
			(update) => updates.push(update as { content: Array<{ type: string; text?: string }>; details?: unknown }),
			{} as never,
		);
		expect(updates).toEqual([{ content: [], details: undefined }]);
		await promise;
	});

	test("bash renderer does not duplicate final full output truncation details", async () => {
		const operations: BashOperations = {
			exec: async (_command, _cwd, { onData }) => {
				for (let i = 1; i <= 4000; i++) {
					onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`));
				}
				return { exitCode: 0 };
			},
		};
		const tool = createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
		const result = await tool.execute(
			"tool-bash-1b",
			{ command: "generate output" },
			undefined,
			undefined,
			{} as never,
		);
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash-1b",
			{ command: "generate output" },
			{},
			tool,
			createFakeTui(),
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ ...result, isError: false }, false);

		const rendered = stripAnsi(component.render(200).join("\n"));
		expect(rendered.match(/Full output:/g)?.length ?? 0).toBe(1);
		expect(rendered).toMatch(/line-4000[^\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).not.toMatch(/line-4000[^\n]*\n[^\S\n]*\n[^\S\n]*\n \[Full output:/);
		expect(rendered).toContain("Truncated: showing 2000 of 4000 lines");
		expect(rendered).not.toContain("[Showing lines 2001-4000 of 4000. Full output:");
	});

	test("does not duplicate built-in headers when passed the active built-in definition", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-4",
			{ path: "README.md" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered.match(/\bread\b/g)?.length ?? 0).toBe(1);
	});

	test("inherits missing built-in result renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("override call", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4b",
			{ path: "notes.txt" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("hello");
	});

	test("inherits missing built-in call renderer slot from the built-in tool", () => {
		const overrideDefinition: ToolDefinition = {
			...createBaseToolDefinition("read"),
			renderResult: () => new Text("override result", 0, 0),
		};

		const component = new ToolExecutionComponent(
			"read",
			"tool-4c",
			{ path: "README.md" },
			{},
			overrideDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("read");
		expect(rendered).toContain("README.md");
		expect(rendered).toContain("override result");
	});

	test("uses custom renderers for built-in overrides that reuse built-in definition parameters", () => {
		const builtInDefinition = createReadToolDefinition(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4d",
			{ path: "README.md" },
			{},
			{
				...builtInDefinition,
				renderCall: () => new Text("override call", 0, 0),
				renderResult: () => new Text("override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("override call");
		expect(rendered).toContain("override result");
		expect(rendered).not.toContain("read README.md");
	});

	test("uses custom renderers for built-in overrides that reuse wrapped built-in tool parameters", () => {
		const builtInTool = createReadTool(process.cwd());
		const component = new ToolExecutionComponent(
			"read",
			"tool-4e",
			{ path: "README.md" },
			{},
			{
				...createBaseToolDefinition("read"),
				parameters: builtInTool.parameters,
				renderCall: () => new Text("wrapped override call", 0, 0),
				renderResult: () => new Text("wrapped override result", 0, 0),
			},
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("wrapped override call");
		expect(rendered).toContain("wrapped override result");
	});

	test("shares renderer state across custom call and result slots", () => {
		type RenderState = { token?: string };
		const toolDefinition: ToolDefinition<any, unknown, RenderState> = {
			...createBaseToolDefinition(),
			renderCall: (_args, _theme, context) => {
				context.state.token ??= "shared-token";
				return new Text(`custom call ${context.state.token}`, 0, 0);
			},
			renderResult: (_result, _options, _theme, context) => {
				return new Text(`custom result ${context.state.token}`, 0, 0);
			},
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5",
			{},
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("custom call shared-token");
		expect(rendered).toContain("custom result shared-token");
	});

	test("exposes args in render result context", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("call", 0, 0),
			renderResult: (_result, _options, _theme, context) =>
				new Text(`arg:${String((context.args as { foo: string }).foo)}`, 0, 0),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-5b",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], details: {}, isError: false }, false);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("arg:bar");
	});

	test("collapses fallback results until expanded", () => {
		const toolDefinition: ToolDefinition = {
			...createBaseToolDefinition(),
		};

		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-6",
			{ foo: "bar" },
			{},
			toolDefinition,
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 15 }, (_, index) => `line-${index + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], details: {}, isError: false }, false);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("custom_tool");
		expect(collapsed).toContain("line-10");
		expect(collapsed).not.toContain("line-11");
		expect(collapsed).toContain("5 more lines");
		expect(collapsed).toContain("to expand");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("line-15");
		expect(expanded).not.toContain("more lines");
	});

	test("trims trailing blank display lines from write previews", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-7",
			{ path: "README.md", content: "one\ntwo\n" },
			{},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("trims trailing blank display lines from read results", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-8",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "one\ntwo\n" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);
		const rendered = stripAnsi(component.render(120).join("\n"));
		expect(rendered).toContain("one");
		expect(rendered).toContain("two");
		expect(rendered).not.toContain("two\n\n");
	});

	test("does not syntax-highlight read errors based on the requested file path", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-read-error-highlighting",
			{ path: "config.exs", offset: 120, limit: 130 },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const error = "Offset 120 is beyond end of file (96 lines total)";
		component.updateResult({ content: [{ type: "text", text: error }], details: undefined, isError: true }, false);

		const rendered = component.render(120).join("\n");
		expect(stripAnsi(rendered)).toContain(error);
		expect(rendered).toContain(theme.fg("toolOutput", error));
	});

	test("collapses ordinary read results until expanded", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-ordinary-read-collapsed",
			{ path: "notes.txt" },
			{},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "hidden content" }], details: undefined, isError: false },
			false,
		);

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("read");
		expect(collapsed).toContain("notes.txt");
		expect(collapsed).not.toContain("hidden content");

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain("hidden content");
	});

	test("reports exact expanded Tool Call rows with persisted identity", () => {
		const observed: MessageRenderBoundaryContextV1[] = [];
		const component = new ToolExecutionComponent(
			"read",
			"tool-expanded-1",
			{ path: "notes.txt" },
			{
				ownerEntryId: "assistant-entry-1",
				semanticDecorators: [(context) => void observed.push(context)],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "first\nsecond" }], details: undefined, isError: false },
			false,
		);
		component.setExpanded(true);

		const rendered = component.render(80);

		expect(observed).toEqual([
			{
				entryId: "tool-expanded-1",
				ownerEntryId: "assistant-entry-1",
				role: "tool",
				state: "expanded",
				outputPad: 0,
				allocatedColumns: { start: 0, end: 80 },
				stockRows: { start: 0, end: rendered.length },
			},
		]);
	});

	test("reports exact collapsed Tool Call rows with persisted identity", () => {
		const observed: MessageRenderBoundaryContextV1[] = [];
		const component = new ToolExecutionComponent(
			"read",
			"tool-collapsed-1",
			{ path: "notes.txt" },
			{
				ownerEntryId: "assistant-entry-1",
				semanticDecorators: [(context) => void observed.push(context)],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult(
			{ content: [{ type: "text", text: "first\nsecond" }], details: undefined, isError: false },
			false,
		);

		const rendered = component.render(80);

		expect(observed).toEqual([
			{
				entryId: "tool-collapsed-1",
				ownerEntryId: "assistant-entry-1",
				role: "tool",
				state: "collapsed",
				outputPad: 0,
				allocatedColumns: { start: 0, end: 80 },
				stockRows: { start: 0, end: rendered.length },
			},
		]);
	});

	for (const scenario of [
		{
			title: "SKILL.md",
			path: join(process.cwd(), "attio", "SKILL.md"),
			content: "---\nname: attio\ndescription: CRM helper\n---\n\n# Hidden skill instructions",
			compact: "[skill] attio",
			hidden: "Hidden skill instructions",
			absent: "read skill attio",
		},
		{
			title: "AGENTS.md",
			path: join(process.cwd(), ".pi", "AGENTS.md"),
			content: "Hidden resource instructions",
			compact: "read resource .pi/AGENTS.md",
			hidden: "Hidden resource instructions",
			absent: undefined,
		},
		{
			title: "AGENTS.override.md",
			path: join(process.cwd(), ".pi", "AGENTS.override.md"),
			content: "Hidden override instructions",
			compact: "read resource .pi/AGENTS.override.md",
			hidden: "Hidden override instructions",
			absent: undefined,
		},
		{
			title: "outside AGENTS.md",
			path: resolve(process.cwd(), "..", "AGENTS.md"),
			content: "Hidden outside resource instructions",
			compact: `read resource ${resolve(process.cwd(), "..", "AGENTS.md").replace(/\\/g, "/")}`,
			hidden: "Hidden outside resource instructions",
			absent: undefined,
		},
		{
			title: "Pi documentation",
			path: getReadmePath(),
			content: "Hidden docs content",
			compact: "read docs README.md",
			hidden: "Hidden docs content",
			absent: undefined,
		},
	] as const) {
		test(`renders ${scenario.title} read results compactly until expanded`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-${scenario.title}`,
				{ path: scenario.path },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult(
				{ content: [{ type: "text", text: scenario.content }], details: undefined, isError: false },
				false,
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed).not.toContain(scenario.hidden);
			if (scenario.absent) {
				expect(collapsed).not.toContain(scenario.absent);
			}

			component.setExpanded(true);
			const expanded = stripAnsi(component.render(120).join("\n"));
			expect(expanded).toContain(scenario.hidden);
		});
	}

	for (const scenario of [
		{ title: "SKILL.md", path: join(process.cwd(), "attio", "SKILL.md"), compact: "[skill] attio:120-329" },
		{ title: "Pi documentation", path: getReadmePath(), compact: "read docs README.md:120-329" },
	] as const) {
		test(`shows the read line range in compact ${scenario.title} reads before the expand hint`, () => {
			const component = new ToolExecutionComponent(
				"read",
				`tool-compact-range-${scenario.title}`,
				{ path: scenario.path, offset: 120, limit: 210 },
				{},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const collapsed = stripAnsi(component.render(120).join("\n"));
			expect(collapsed).toContain(scenario.compact);
			expect(collapsed.indexOf(":120-329")).toBeLessThan(collapsed.indexOf("to expand"));
		});
	}

	test("keeps a selected V3 read summary on one row while retaining the canonical path", () => {
		const controls = {
			begin: "\x1b]777;summary-begin\x07",
			body: "\x1b]777;summary-body\x07",
			end: "\x1b]777;summary-end\x07",
		};
		const path = "/workspace/project/reports/quarterly/summary-report.json";
		const component = new ToolExecutionComponent(
			"read",
			"tool-v3-summary-read",
			{ path },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "result" }], isError: false }, false);

		const rendered = component.render(32);
		const visible = rendered.map((line) => stripAnsi(line));

		expect(visible[0]).toContain("read .../summary-report.json");
		expect(visible[0]).toBeDefined();
		expect(visible[0] ? visibleWidth(visible[0]) : 0).toBeLessThanOrEqual(32);
		expect(rendered[0]).toContain(controls.begin);
		expect(rendered[1]).toContain(controls.body);
		const canonicalRows = visible.slice(1).join(" ");
		expect(canonicalRows.replace(/\s+/g, "")).toContain(path);
		expect(rendered.at(-1)).toContain(controls.end);
	});

	test.each([
		{
			toolName: "edit",
			args: {
				path: "/workspace/project/reports/quarterly/summary-report.json",
				edits: [{ oldText: "before", newText: "after" }],
			},
			definition: createEditToolDefinition(process.cwd()),
			result: {
				content: [{ type: "text", text: "done" }],
				details: { diff: "+after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			expected: "edit .../summary-report.json",
		},
		{
			toolName: "write",
			args: { path: "/workspace/project/reports/quarterly/summary-report.json", content: "value" },
			definition: createWriteToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "done" }], details: undefined, isError: true },
			expected: "write .../summary-report.json",
		},
		{
			toolName: "ls",
			args: { path: "/workspace/project/reports/quarterly" },
			definition: createLsToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "done" }], details: undefined, isError: false },
			expected: "ls .../quarterly",
		},
		{
			toolName: "bash",
			args: { command: "git status --short" },
			definition: createBashToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "done" }], details: undefined, isError: false },
			expected: "$ git status --short",
		},
		{
			toolName: "find",
			args: { pattern: "**/*.ts", path: "/workspace/project/src" },
			definition: createFindToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "done" }], details: undefined, isError: false },
			expected: "find **/*.ts",
		},
		{
			toolName: "grep",
			args: { pattern: "needle", path: "/workspace/project/src" },
			definition: createGrepToolDefinition(process.cwd()),
			result: { content: [{ type: "text", text: "done" }], details: undefined, isError: false },
			expected: "grep /needle/",
		},
	] as const)(
		"summarizes selected V3 $toolName calls in one row",
		({ toolName, args, definition, result, expected }) => {
			const controls = {
				begin: "\x1b]777;call-begin\x07",
				body: "\x1b]777;call-body\x07",
				end: "\x1b]777;call-end\x07",
			};
			const component = new ToolExecutionComponent(
				toolName,
				`tool-v3-summary-${toolName}`,
				args,
				{
					ownerEntryId: "assistant-entry-v3",
					producerSessionId: "session-v3",
					renderScopeId: "scope-v3",
					semanticSelectorsV3: [() => () => controls],
				},
				definition,
				createFakeTui(),
				process.cwd(),
			);
			component.updateResult({ ...result, content: result.content.map((content) => ({ ...content })) }, false);

			const rendered = component.render(40);
			const visible = rendered.map((line) => stripAnsi(line));

			expect(visible[0]).toContain(expected);
			expect(visible[0] ? visibleWidth(visible[0]) : 0).toBeLessThanOrEqual(40);
			expect(rendered[0]).toContain(controls.begin);
			expect(rendered[1]).toContain(controls.body);
			expect(rendered.at(-1)).toContain(controls.end);
		},
	);

	test("uses terminal width for a Unicode selected V3 path summary", () => {
		const controls = {
			begin: "\x1b]777;unicode-begin\x07",
			body: "\x1b]777;unicode-body\x07",
			end: "\x1b]777;unicode-end\x07",
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-v3-summary-unicode",
			{ path: "/workspace/文档/季度/报告-最终版.md" },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const rendered = component.render(24);
		const firstRow = rendered[0] ?? "";
		expect(visibleWidth(firstRow)).toBeLessThanOrEqual(24);
		expect(stripAnsi(firstRow)).toContain("最终版.md");
		expect(rendered[0]).toContain(controls.begin);
		expect(rendered[1]).toContain(controls.body);
	});

	test("keeps the original path as the selected V3 summary hyperlink target", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const path = "/workspace/project/reports/quarterly/summary-report.json";
			const component = new ToolExecutionComponent(
				"read",
				"tool-v3-summary-link",
				{ path },
				{
					ownerEntryId: "assistant-entry-v3",
					producerSessionId: "session-v3",
					renderScopeId: "scope-v3",
					semanticSelectorsV3: [() => () => ({ begin: "", body: "", end: "" })],
				},
				createReadToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);

			const row = component.render(32)[0] ?? "";
			expect(stripAnsi(row)).toContain(".../summary-report.json");
			expect(row).toContain(`\x1b]8;;${pathToFileURL(path).href}\x1b\\`);
		} finally {
			resetCapabilitiesCache();
		}
	});

	test("keeps a read range out of the summary when the path uses its width", () => {
		const controls = {
			begin: "\x1b]777;range-begin\x07",
			body: "\x1b]777;range-body\x07",
			end: "\x1b]777;range-end\x07",
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-v3-summary-range",
			{ path: "/workspace/project/reports/quarterly/summary-report.json", offset: 120, limit: 210 },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);

		const rendered = component.render(32);
		const firstRow = stripAnsi(rendered[0] ?? "");
		expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(32);
		expect(firstRow).toContain(".../summary-report.json");
		expect(firstRow).not.toContain(":120-329");
		expect(rendered[1]).toContain(controls.body);
	});

	test("updates a partial V3 path placeholder to the final summary", () => {
		const controls = {
			begin: "\x1b]777;partial-begin\x07",
			body: "\x1b]777;partial-body\x07",
			end: "\x1b]777;partial-end\x07",
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-v3-summary-partial",
			{},
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			createReadToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		expect(stripAnsi(component.render(32)[0] ?? "")).toContain("read ...");
		component.updateArgs({ path: "/workspace/project/reports/quarterly/summary-report.json" });
		expect(stripAnsi(component.render(32)[0] ?? "")).toContain("read .../summary-report.json");
	});

	test("pins the bash action-only boundary before a command token fits", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"tool-v3-summary-bash-boundary",
			{ command: "git status" },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => ({ begin: "", body: "", end: "" })],
			},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const width3 = stripAnsi(component.render(3)[0] ?? "").trim();
		const width4 = stripAnsi(component.render(4)[0] ?? "").trim();
		const width5 = stripAnsi(component.render(5)[0] ?? "").trim();
		expect(width3).toBe("$");
		expect(width4).toBe("$");
		expect(width5).toBe("$ g");
	});

	test("prioritizes a narrow find pattern over its search path", () => {
		const component = new ToolExecutionComponent(
			"find",
			"tool-v3-summary-find-priority",
			{ pattern: "**/very-long-pattern.ts", path: "/workspace/project/src" },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => ({ begin: "", body: "", end: "" })],
			},
			createFindToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const row = stripAnsi(component.render(20)[0] ?? "").trim();
		expect(row.startsWith("find **/very-long")).toBe(true);
		expect(row).not.toContain("/workspace/project");
	});

	test("preserves an overlong path basename extension", () => {
		const component = new ToolExecutionComponent(
			"write",
			"tool-v3-summary-extension",
			{ path: "/workspace/project/extremely-long-report-name.ts", content: "value" },
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => ({ begin: "", body: "", end: "" })],
			},
			createWriteToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);

		const row = stripAnsi(component.render(18)[0] ?? "");
		expect(visibleWidth(row)).toBeLessThanOrEqual(18);
		expect(row).toContain(".ts");
	});
});
