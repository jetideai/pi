import { join, resolve } from "node:path";
import { Container, Image, Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, test } from "vitest";
import { getReadmePath } from "../src/config.ts";
import type { ToolDefinition, ToolExecutionPresentationSelectorV1 } from "../src/core/extensions/types.ts";
import { type BashOperations, createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createReadTool, createReadToolDefinition } from "../src/core/tools/read.ts";
import { createAllToolRenderers, withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
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

describe("ToolExecutionComponent parity", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("createAllToolRenderers returns one stable registry", () => {
		expect(createAllToolRenderers()).toBe(createAllToolRenderers());
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
			withBuiltInRenderers("edit", overrideDefinition),
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

	test("bash keeps the exact five-row tail and skipped count across novel widths and a revisit", () => {
		const output = Array.from({ length: 14 }, (_, index) => `row-${index} ${"wrapped output words ".repeat(6)}`).join(
			"\n",
		);
		const component = new ToolExecutionComponent(
			"bash",
			"bash-tail",
			{ command: "echo output" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
		const styled = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		for (const width of [77, 40, 53, 91, 77]) {
			const all = new Text(styled, 0, 0).render(width - 2);
			const rendered = component.render(width).map((line) => stripAnsi(line).trim());
			const hintRow = rendered.findIndex((line) => line.includes("earlier lines"));
			expect(rendered[hintRow]).toContain(`${all.length - 5} earlier lines`);
			expect(rendered.slice(hintRow + 1, hintRow + 6)).toEqual(all.slice(-5).map((line) => stripAnsi(line).trim()));
		}
	});

	test("expands the retained bash preview through the mouse route after resize", () => {
		const component = new ToolExecutionComponent(
			"bash",
			"bash-click-tail",
			{ command: "echo output" },
			{},
			createBashToolDefinition(process.cwd()),
			createFakeTui(),
			process.cwd(),
		);
		const output = Array.from({ length: 12 }, (_, index) => `output-row-${index}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], isError: false }, false);
		component.render(77);
		const lines = component.render(53);
		expect(stripAnsi(lines.join("\n"))).not.toContain("output-row-0");
		const row = lines.findIndex((line) => stripAnsi(line).includes("output-row-11"));
		expect(row).toBeGreaterThan(0);
		expect(
			component.handleMouse({
				type: "click",
				button: "left",
				x: 2,
				y: row,
				screenX: 2,
				screenY: row,
				width: 53,
				height: lines.length,
				shift: false,
				alt: false,
				ctrl: false,
				clickCount: 1,
			})?.handled,
		).toBe(true);
		expect(stripAnsi(component.render(53).join("\n"))).toContain("output-row-0");
	});

	test("bash replaces preview state for partial/final errors, expansion and theme invalidation", () => {
		const create = () =>
			new ToolExecutionComponent(
				"bash",
				"bash-lifecycle",
				{ command: "echo output" },
				{},
				createBashToolDefinition(process.cwd()),
				createFakeTui(),
				process.cwd(),
			);
		const component = create();
		for (const phase of [
			{ text: "partial words ".repeat(60), isError: false, partial: true },
			{ text: "final failed words ".repeat(70), isError: true, partial: false },
			{ text: "replacement successful words ".repeat(80), isError: false, partial: false },
		]) {
			const result = { content: [{ type: "text", text: phase.text }], isError: phase.isError };
			component.updateResult(result, phase.partial);
			for (const expanded of [true, false, true, false]) {
				component.setExpanded(expanded);
				for (const width of [77, 53, 91]) {
					const fresh = create();
					fresh.updateResult(result, phase.partial);
					fresh.setExpanded(expanded);
					expect(component.render(width)).toEqual(fresh.render(width));
				}
			}
		}
		initTheme("light");
		try {
			component.invalidate();
			const fresh = create();
			fresh.updateResult(
				{ content: [{ type: "text", text: "replacement successful words ".repeat(80) }], isError: false },
				false,
			);
			expect(component.render(77)).toEqual(fresh.render(77));
		} finally {
			initTheme("dark");
		}
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
			withBuiltInRenderers("read", overrideDefinition),
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
			withBuiltInRenderers("read", overrideDefinition),
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

	test("expands a collapsed tool result when clicked", () => {
		const component = new ToolExecutionComponent(
			"read",
			"tool-click-expand",
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
		const width = 120;
		const lines = component.render(width);
		const resultRow = lines.findIndex((line) => stripAnsi(line).includes("notes.txt"));
		expect(resultRow).toBeGreaterThanOrEqual(0);
		const event: TuiMouseEvent = {
			type: "click",
			button: "left",
			x: 2,
			y: resultRow,
			screenX: 2,
			screenY: resultRow,
			width,
			height: lines.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		};
		expect(component.handleMouse(event)?.handled).toBe(true);
		expect(stripAnsi(component.render(width).join("\n"))).toContain("hidden content");
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

	const admitCompactLiveToolCall: ToolExecutionPresentationSelectorV1 = () => ({
		liveToolCall: "compact-stock-header",
		liveToolGroup: "compact-stock-header",
		header: "exact-one-row",
		settled: "canonical-initial-collapsed",
	});

	test("keeps admitted partial output behind one renderer-owned header row", () => {
		let resultRenders = 0;
		const readDefinition = createReadToolDefinition(process.cwd());
		const countedRenderResult: NonNullable<typeof readDefinition.renderResult> = (
			result,
			options,
			currentTheme,
			context,
		) => {
			resultRenders += 1;
			return readDefinition.renderResult!(result, options, currentTheme, context);
		};
		const component = new ToolExecutionComponent(
			"read",
			"tool-live-read",
			{ path: "a-very-long-file-name-that-wraps-at-narrow-width.txt" },
			{
				hasInitialCollapsedBoundaries: true,
				toolExecutionPresentationSelectorsV1: [admitCompactLiveToolCall],
			},
			{ ...readDefinition, renderResult: countedRenderResult },
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial output" }], isError: false }, true);

		expect(component.render(12)).toHaveLength(1);
		expect(stripAnsi(component.render(12).join("\n"))).not.toContain("partial output");
		expect(resultRenders).toBe(0);

		component.updateResult({ content: [{ type: "text", text: "final output" }], isError: false }, false);
		expect(stripAnsi(component.render(80).join("\n"))).not.toContain("final output");
		expect(resultRenders).toBe(1);
		component.setExpanded(true);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("final output");
	});

	test("does not inherit built-in locators with a custom call renderer", () => {
		const definition = withBuiltInRenderers("read", {
			...createBaseToolDefinition("read"),
			renderCall: () => new Text("custom header\ncustom preview", 0, 0),
		});
		const component = new ToolExecutionComponent(
			"read",
			"tool-custom-read",
			{ path: "notes.txt" },
			{
				hasInitialCollapsedBoundaries: true,
				toolExecutionPresentationSelectorsV1: [admitCompactLiveToolCall],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial body" }], isError: false }, true);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("custom preview");
		expect(rendered).not.toHaveLength(1);
	});

	test("does no locator work unless a selector admits the presentation", () => {
		let headerLocations = 0;
		let bodyLocations = 0;
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("stock header", 0, 0),
			renderResult: () => new Text("stock partial body", 0, 0),
			getRenderCallHeaderRow: () => {
				headerLocations += 1;
				return 0;
			},
			getRenderCallBodyRow: () => {
				bodyLocations += 1;
				return 1;
			},
		};
		for (const selectors of [
			[],
			[() => undefined],
			[
				() => {
					throw new Error("selector failed");
				},
			],
		]) {
			const component = new ToolExecutionComponent(
				"custom_tool",
				`tool-stock-${selectors.length}`,
				{},
				{
					hasInitialCollapsedBoundaries: true,
					toolExecutionPresentationSelectorsV1: selectors,
				},
				definition,
				createFakeTui(),
				process.cwd(),
			);
			component.markExecutionStarted();
			component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
			expect(stripAnsi(component.render(80).join("\n"))).toContain("stock partial body");
		}
		expect({ headerLocations, bodyLocations }).toEqual({ headerLocations: 0, bodyLocations: 0 });
	});

	test("selects once at construction and locates once per admitted render", () => {
		let selections = 0;
		let headerLocations = 0;
		let bodyLocations = 0;
		const selector: ToolExecutionPresentationSelectorV1 = (candidate) => {
			selections += 1;
			return admitCompactLiveToolCall(candidate);
		};
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderCall: () => new Text("stock header", 0, 0),
			renderResult: () => new Text("stock body", 0, 0),
			getRenderCallHeaderRow: () => {
				headerLocations += 1;
				return 0;
			},
			getRenderCallBodyRow: () => {
				bodyLocations += 1;
				return 1;
			},
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-counts",
			{},
			{ hasInitialCollapsedBoundaries: true, toolExecutionPresentationSelectorsV1: [selector] },
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);

		expect(component.render(80)).toHaveLength(1);
		expect({ selections, headerLocations, bodyLocations }).toEqual({
			selections: 1,
			headerLocations: 1,
			bodyLocations: 1,
		});
		component.render(40);
		expect({ selections, headerLocations, bodyLocations }).toEqual({
			selections: 1,
			headerLocations: 2,
			bodyLocations: 2,
		});
	});

	test("fails open when an admitted locator does not identify one exact header", () => {
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("stock header\nstock preview", 0, 0),
			renderResult: () => new Text("stock partial body", 0, 0),
			getRenderCallHeaderRow: () => 4,
			getRenderCallBodyRow: () => 5,
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-invalid-locator",
			{},
			{
				hasInitialCollapsedBoundaries: true,
				toolExecutionPresentationSelectorsV1: [admitCompactLiveToolCall],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);

		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("stock preview");
		expect(rendered).toContain("stock partial body");
	});

	test("materializes self-shell errors and images only after the compact partial settles", () => {
		let imageRenders = 0;
		class CountingImage extends Image {
			override render(width: number): string[] {
				imageRenders += 1;
				return super.render(width);
			}
		}
		const definition: ToolDefinition = {
			...createBaseToolDefinition(),
			renderShell: "self",
			renderCall: () => new Text("self header", 0, 0),
			renderResult: (_result, _options, currentTheme, context) => {
				const container = new Container();
				container.addChild(
					new Text(currentTheme.fg(context.isError ? "error" : "toolOutput", "settled body"), 0, 0),
				);
				if (!context.isPartial) {
					container.addChild(
						new CountingImage("AA==", "image/png", { fallbackColor: (text) => text }, { maxWidthCells: 1 }),
					);
				}
				return container;
			},
			getRenderCallHeaderRow: () => 0,
			getRenderCallBodyRow: () => 1,
		};
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-self-image",
			{},
			{
				hasInitialCollapsedBoundaries: true,
				toolExecutionPresentationSelectorsV1: [admitCompactLiveToolCall],
			},
			definition,
			createFakeTui(),
			process.cwd(),
		);
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		expect(component.render(80)).toHaveLength(1);
		expect(imageRenders).toBe(0);

		component.updateResult({ content: [{ type: "text", text: "failed" }], isError: true }, false);
		expect(stripAnsi(component.render(80).join("\n"))).toContain("settled body");
		expect(imageRenders).toBe(1);
	});
});
