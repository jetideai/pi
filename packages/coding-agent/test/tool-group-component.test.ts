import { Container, Text, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	MessageRenderBoundaryContextV1,
	ToolDefinition,
	ToolPresentationOverrideV1,
} from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("ToolGroupComponent", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("preserves stock Tool Call rows when no extension overrides the group", () => {
		const decorate = vi.fn(() => ({ prefix: "\x1b[0m", suffix: "\x1b[0m" }));
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			semanticDecorators: [decorate],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent);
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent);

		expect(group.render(20).map((line) => line.trimEnd())).toEqual(["first child", "second child"]);
		expect(decorate).not.toHaveBeenCalled();
	});

	it("selects a closed Tool Group decorator from retained local V3 facts", () => {
		const select = vi.fn(() => () => ({
			begin: "\x1b]7799;group-begin\x1b\\",
			body: "",
			end: "\x1b]7799;group-end\x1b\\",
		}));
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-v3",
			closed: true,
			producerSessionId: "session-v3",
			renderScopeId: "scope-v3",
			semanticSelectorsV3: [select],
		});
		group.addTool(new Text("first", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-v3",
		});
		group.addTool(new Text("second", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-v4",
		});

		expect(select).not.toHaveBeenCalled();
		const rows = group.render(80);
		expect(rows[0]).toBe("");
		expect(rows[1]).toContain("\x1b]7799;group-begin\x1b\\");
		expect(select).toHaveBeenCalledWith({
			producerSessionId: "session-v3",
			renderScopeId: "scope-v3",
			entryId: "tool-group:tool-v3",
			blockId: "tool-group:tool-v3",
			role: "tool-group",
			state: "expanded",
		});
	});

	it("preserves closed Tool Call rows when no V2 selector selects the group", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			semanticSelectorsV2: [() => undefined],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-2",
		});

		expect(group.render(20).map((line) => line.trimEnd())).toEqual(["first child", "second child"]);
	});

	it("selects and pins one Tool Group decorator before layout", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const decorate = vi.fn((context: Readonly<MessageRenderBoundaryContextV1>) => {
			contexts.push(context);
			return { begin: "", body: "", end: "" };
		});
		const select = vi.fn(() => decorate);
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			semanticSelectorsV2: [select],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-2",
		});

		const wideRows = group.render(20).length;
		const narrowRows = group.render(10).length;

		expect(select).toHaveBeenCalledOnce();
		expect(select).toHaveBeenCalledWith({
			entryId: "tool-group:tool-1",
			role: "tool-group",
			state: "expanded",
		});
		expect(contexts.map((context) => [context.allocatedColumns.end, context.stockRows.end])).toEqual([
			[20, wideRows],
			[10, narrowRows],
		]);
	});

	it("renders one canonical header and every stock row for a closed Tool Group", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			semanticSelectorsV2: [() => () => ({ begin: "\x1b[1m", body: "\x1b[2m", end: "\x1b[3m" })],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "ls",
			toolCallId: "tool-2",
		});

		expect(group.render(20).map((line) => line.trimEnd())).toEqual([
			`\x1b[1m ${theme.fg("muted", "$ Read files")}`,
			"\x1b[2m",
			"first child",
			"",
			"second child        \x1b[3m",
		]);
	});

	it("adds one row after the group header and between sibling Tool Calls", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:spaced",
			closed: true,
			semanticSelectorsV2: [() => () => ({ begin: "", body: "", end: "" })],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-2",
		});

		expect(group.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual([
			" $ Read files",
			"",
			"first child",
			"",
			"second child",
		]);
	});

	it.each([
		{ outputPad: 0, expectedHeader: "$ Read files, Ran commands" },
		{ outputPad: 1, expectedHeader: " $ Read files, Ran commands" },
	])("renders a padded muted action header at outputPad=$outputPad", ({ outputPad, expectedHeader }) => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			outputPad,
			semanticSelectorsV2: [() => () => ({ begin: "", body: "", end: "" })],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "bash",
			toolCallId: "tool-2",
		});

		const rows = group.render(80);

		expect(stripAnsi(rows[0]!)).toBe(expectedHeader);
		expect(rows[0]).toBe(`${" ".repeat(outputPad)}${theme.fg("muted", expectedHeader.trimStart())}`);
		expect(stripAnsi(rows[2]!).trimEnd()).toBe("first child");
	});

	it("keeps a styled action header to one row at narrow widths", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			outputPad: 1,
			semanticSelectorsV2: [() => () => ({ begin: "", body: "", end: "" })],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "bash",
			toolCallId: "tool-2",
		});

		for (const width of [1, 2, 3, 8]) {
			const rows = group.render(width);
			const header = rows[0]!;
			expect(header).not.toContain("\n");
			expect(visibleWidth(header)).toBeLessThanOrEqual(width);
			expect(rows[2]).toBeDefined();
		}
		expect(stripAnsi(group.render(8)[0]!)).toContain("…");
	});

	it("updates an existing header when output padding changes", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			outputPad: 0,
			semanticSelectorsV2: [() => () => ({ begin: "", body: "", end: "" })],
		});
		group.addTool(new Text("first child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});
		group.addTool(new Text("second child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "bash",
			toolCallId: "tool-2",
		});

		expect(stripAnsi(group.render(80)[0]!)).toBe("$ Read files, Ran commands");
		group.setOutputPad(1);
		expect(stripAnsi(group.render(80)[0]!)).toBe(" $ Read files, Ran commands");
	});

	it("keeps a closed singleton as one stock Tool Call", () => {
		const decorate = vi.fn(() => ({ begin: "\x1b[1m", body: "\x1b[2m", end: "\x1b[3m" }));
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			semanticSelectorsV2: [() => decorate],
		});
		group.addTool(new Text("only child", 0, 0) as unknown as ToolExecutionComponent, {
			toolName: "read",
			toolCallId: "tool-1",
		});

		expect(group.render(20).map((line) => line.trimEnd())).toEqual(["only child"]);
		expect(decorate).not.toHaveBeenCalled();
	});

	it("keeps an individual Tool Call presentation independent", () => {
		let childExpanded = false;
		let invalidateChild: (() => void) | undefined;
		const childPresentation: ToolPresentationOverrideV1 = (context) => {
			invalidateChild = context.invalidate;
			return childExpanded
				? { state: "expanded" }
				: { state: "collapsed", component: new Text("compact child", 0, 0) };
		};
		const toolDefinition: ToolDefinition = {
			name: "custom_tool",
			label: "custom tool",
			description: "custom tool",
			parameters: Type.Any(),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
			renderCall: () => new Text("full child", 0, 0),
		};
		const child = new ToolExecutionComponent(
			"custom_tool",
			"tool-1",
			{},
			{ presentationOverrides: [childPresentation] },
			toolDefinition,
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		const group = new ToolGroupComponent({ groupId: "tool-group:tool-1" });
		group.addTool(child, { toolName: "custom_tool", toolCallId: "tool-1" });

		expect(stripAnsi(group.render(40).join("\n"))).toContain("compact child");
		childExpanded = true;
		invalidateChild?.();
		expect(stripAnsi(group.render(40).join("\n"))).toContain("full child");
	});

	it("puts one external separator before a selected singleton Tool Call", () => {
		const controls = {
			begin: "\x1b]777;singleton-begin\x07",
			body: "\x1b]777;singleton-body\x07",
			end: "\x1b]777;singleton-end\x07",
		};
		const child = new ToolExecutionComponent(
			"custom_tool",
			"tool-singleton-v3",
			{},
			{
				ownerEntryId: "assistant-entry-v3",
				producerSessionId: "session-v3",
				renderScopeId: "scope-v3",
				semanticSelectorsV3: [() => () => controls],
			},
			{
				name: "custom_tool",
				label: "custom tool",
				description: "custom tool",
				parameters: Type.Any(),
				execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
				renderCall: () => new Text("singleton header", 0, 0),
				renderResult: () => new Text("singleton body", 0, 0),
			},
			{ requestRender: vi.fn() } as unknown as TUI,
			process.cwd(),
		);
		child.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
		const group = new ToolGroupComponent({
			groupId: "tool-group:singleton-v3",
			producerSessionId: "session-v3",
			renderScopeId: "scope-v3",
		});
		group.addTool(child, { toolName: "custom_tool", toolCallId: "tool-singleton-v3" });

		const rows = group.render(80);

		expect(rows[0]).toBe("");
		expect(rows[1]).toContain(controls.begin);
	});

	it("puts one external separator before a selected multi-tool Fold", () => {
		const groupControls = {
			begin: "\x1b]777;multi-group-begin\x07",
			body: "\x1b]777;multi-group-body\x07",
			end: "\x1b]777;multi-group-end\x07",
		};
		const createChild = (toolCallId: string) => {
			const controls = {
				begin: `\x1b]777;${toolCallId}-begin\x07`,
				body: `\x1b]777;${toolCallId}-body\x07`,
				end: `\x1b]777;${toolCallId}-end\x07`,
			};
			const child = new ToolExecutionComponent(
				"custom_tool",
				toolCallId,
				{},
				{
					ownerEntryId: "assistant-entry-v3",
					producerSessionId: "session-v3",
					renderScopeId: "scope-v3",
					semanticSelectorsV3: [() => () => controls],
				},
				{
					name: "custom_tool",
					label: "custom tool",
					description: "custom tool",
					parameters: Type.Any(),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					renderCall: () => new Text(`${toolCallId} header`, 0, 0),
					renderResult: () => new Text(`${toolCallId} body`, 0, 0),
				},
				{ requestRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			child.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			return child;
		};
		const group = new ToolGroupComponent({
			groupId: "tool-group:multi-v3",
			closed: true,
			producerSessionId: "session-v3",
			renderScopeId: "scope-v3",
			semanticSelectorsV3: [() => () => groupControls],
		});
		group.addTool(createChild("tool-multi-v3-1"), { toolName: "custom_tool", toolCallId: "tool-multi-v3-1" });
		group.addTool(createChild("tool-multi-v3-2"), { toolName: "custom_tool", toolCallId: "tool-multi-v3-2" });

		const rows = group.render(80);

		expect(rows[0]).toBe("");
		expect(rows[1]).toContain(groupControls.begin);
	});

	it("keeps exactly one separator between adjacent selected wrappers", () => {
		const createGroup = (suffix: string) => {
			const controls = {
				begin: `\x1b]777;adjacent-${suffix}-begin\x07`,
				body: `\x1b]777;adjacent-${suffix}-body\x07`,
				end: `\x1b]777;adjacent-${suffix}-end\x07`,
			};
			const child = new ToolExecutionComponent(
				"custom_tool",
				`tool-adjacent-${suffix}`,
				{},
				{
					ownerEntryId: "assistant-entry-v3",
					producerSessionId: "session-v3",
					renderScopeId: "scope-v3",
					semanticSelectorsV3: [() => () => controls],
				},
				{
					name: "custom_tool",
					label: "custom tool",
					description: "custom tool",
					parameters: Type.Any(),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					renderCall: () => new Text(`adjacent ${suffix} header`, 0, 0),
					renderResult: () => new Text(`adjacent ${suffix} body`, 0, 0),
				},
				{ requestRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			child.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			const group = new ToolGroupComponent({ groupId: `tool-group:adjacent-${suffix}` });
			group.addTool(child, { toolName: "custom_tool", toolCallId: `tool-adjacent-${suffix}` });
			return group;
		};
		const container = new Container();
		container.addChild(createGroup("one"));
		container.addChild(createGroup("two"));

		const rows = container.render(80);
		const firstBegin = rows.findIndex((line) => line.includes("adjacent-one-begin"));
		const firstEnd = rows.findIndex((line) => line.includes("adjacent-one-end"));
		const secondBegin = rows.findIndex((line) => line.includes("adjacent-two-begin"));

		expect(firstBegin).toBeGreaterThan(0);
		expect(firstEnd).toBeGreaterThan(firstBegin);
		expect(secondBegin).toBeGreaterThan(firstBegin);
		expect(rows[firstBegin - 1]).toBe("");
		expect(rows.slice(firstEnd + 1, secondBegin)).toEqual([""]);
	});

	it("nests complete Tool Call sections inside the canonical Tool Group body", () => {
		const groupControls = {
			begin: "\x1b]777;group-begin\x07",
			body: "\x1b]777;group-body\x07",
			end: "\x1b]777;group-end\x07",
		};
		const toolControls = (toolCallId: string) => ({
			begin: `\x1b]777;${toolCallId}-begin\x07`,
			body: `\x1b]777;${toolCallId}-body\x07`,
			end: `\x1b]777;${toolCallId}-end\x07`,
		});
		const createChild = (toolCallId: string) => {
			const child = new ToolExecutionComponent(
				"custom_tool",
				toolCallId,
				{},
				{
					ownerEntryId: "assistant-entry-1",
					semanticSelectorsV2: [() => () => toolControls(toolCallId)],
				},
				{
					name: "custom_tool",
					label: "custom tool",
					description: "custom tool",
					parameters: Type.Any(),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
					renderCall: () => new Text(`${toolCallId} header`, 0, 0),
					renderResult: () => new Text(`${toolCallId} complete body`, 0, 0),
				},
				{ requestRender: vi.fn() } as unknown as TUI,
				process.cwd(),
			);
			child.updateResult({ content: [{ type: "text", text: "done" }], isError: false }, false);
			return child;
		};
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-1",
			closed: true,
			semanticSelectorsV2: [() => () => groupControls],
		});
		group.addTool(createChild("tool-1"), { toolName: "read", toolCallId: "tool-1" });
		group.addTool(createChild("tool-2"), { toolName: "read", toolCallId: "tool-2" });

		const rendered = group.render(80).join("\n");
		const orderedMarkers = [
			groupControls.begin,
			groupControls.body,
			toolControls("tool-1").begin,
			toolControls("tool-1").body,
			"tool-1 complete body",
			toolControls("tool-1").end,
			toolControls("tool-2").begin,
			toolControls("tool-2").body,
			"tool-2 complete body",
			toolControls("tool-2").end,
			groupControls.end,
		];
		const markerOffsets = orderedMarkers.map((marker) => rendered.indexOf(marker));
		expect(markerOffsets.every((offset) => offset >= 0)).toBe(true);
		expect(markerOffsets).toEqual([...markerOffsets].sort((a, b) => a - b));
		expect(group.render(8).every((line) => visibleWidth(line) <= 8)).toBe(true);
	});
});
