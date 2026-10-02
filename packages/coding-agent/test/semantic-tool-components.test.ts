import {
	type Component,
	resetCapabilitiesCache,
	setCapabilities,
	Text,
	type TUI,
	type TuiMouseEvent,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
	MessageRenderBoundaryCandidateV3,
	MessageRenderBoundaryContextV1,
	MessageRenderBoundarySelectorV3,
	MessageRenderSourcePointV1,
	ToolDefinition,
	ToolExecutionPresentationSelectorV1,
} from "../src/core/extensions/types.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { createReadToolDefinition } from "../src/core/tools/read.ts";
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";
import {
	decorateMessageRenderV2,
	SourcePointRevisions,
} from "../src/modes/interactive/components/message-render-boundaries.ts";
import type { ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent, ToolGroupMemberComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
/** The presentation that an extension selects for a call without the exact header seam. */
const settledCanonicalOnly: ToolExecutionPresentationSelectorV1 = () => ({
	liveToolCall: "stock",
	liveToolGroup: "stock",
	header: "stock",
	settled: "canonical-initial-collapsed",
});
const admitCompact: ToolExecutionPresentationSelectorV1 = () => ({
	liveToolCall: "compact-stock-header",
	liveToolGroup: "compact-stock-header",
	header: "exact-one-row",
	settled: "canonical-initial-collapsed",
});

function definition(): ToolDefinition {
	return {
		name: "custom_tool",
		label: "custom tool",
		description: "custom tool",
		parameters: Type.Any(),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		renderShell: "self",
		renderCall: () => new Text("stock header\nstock preview", 0, 0),
		getRenderCallHeaderRow: () => 0,
		getRenderCallBodyRow: () => 1,
		renderResult: () => new Text("stock result", 0, 0),
	};
}

function tool(
	id: string,
	selectors: MessageRenderBoundarySelectorV3[] = [() => () => controls],
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"custom_tool",
		id,
		{},
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: selectors,
			toolExecutionPresentationSelectorsV1: [admitCompact],
		},
		definition(),
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	return component;
}

const EDIT_POINT = "\x1b]777;point\x07";
/** A valid one-pixel PNG. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const EDIT_SUCCESS = "Successfully replaced 1 block(s) in src/long.ts.";

function editDiff(lines: number, name: string) {
	const oldText = Array.from({ length: lines }, (_, index) => `const before${index} = ${index};`).join("\n");
	const newText = Array.from({ length: lines }, (_, index) => `const ${name}${index} = ${index * 2};`).join("\n");
	return generateDiffString(oldText, newText);
}

function editRenderersFor(): ToolRenderers {
	return withBuiltInRenderers("edit", createEditToolDefinition(process.cwd()) as unknown as ToolRenderers)!;
}

function editComponent(
	definition: ToolRenderers,
	points: MessageRenderSourcePointV1[] | undefined,
	sourcePointRevisions?: SourcePointRevisions,
): ToolExecutionComponent {
	const component = new ToolExecutionComponent(
		"edit",
		"tool-edit",
		{ path: "src/long.ts", edits: [{ oldText: "a", newText: "b" }] },
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			sourcePointRevisions,
			sourcePointDecoratorsV1: points
				? [
						(source: Readonly<MessageRenderSourcePointV1>) => {
							points.push({ ...source });
							return EDIT_POINT;
						},
					]
				: [],
		},
		definition,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.setExpanded(true);
	return component;
}

function renderEdit(diff: ReturnType<typeof editDiff>, width: number, decorate: boolean) {
	const points: MessageRenderSourcePointV1[] = [];
	const component = editComponent(editRenderersFor(), decorate ? points : undefined);
	component.updateResult({ content: [{ type: "text", text: EDIT_SUCCESS }], details: diff, isError: false });
	return { rows: component.render(width), points };
}

function bashComponent(
	command: string,
	points: MessageRenderSourcePointV1[],
	id = "tool-bash",
	withCallSource = true,
): ToolExecutionComponent {
	const renderers = withBuiltInRenderers("bash", createBashToolDefinition(process.cwd()) as unknown as ToolRenderers)!;
	const component = new ToolExecutionComponent(
		"bash",
		id,
		{ command },
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			sourcePointDecoratorsV1: [
				(source: Readonly<MessageRenderSourcePointV1>) => {
					points.push({ ...source });
					return EDIT_POINT;
				},
			],
		},
		withCallSource ? renderers : { ...renderers, getRenderCallSourceText: undefined },
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.setExpanded(true);
	return component;
}

function renderBashSources(command: string, result: string, width: number, withCallSource = true) {
	const points: MessageRenderSourcePointV1[] = [];
	const component = bashComponent(command, points, "tool-bash", withCallSource);
	component.updateResult({ content: [{ type: "text", text: result }], isError: false });
	component.render(width);
	return {
		call: points.filter((point) => point.sourcePart === "call"),
		result: points.filter((point) => point.sourcePart === undefined),
	};
}

const numbered = (prefix: string, count: number) =>
	Array.from({ length: count }, (_, index) => `${prefix}-${index}`).join("\n");

/** A saved call of a tool whose renderers come from [renderers]; undefined is a tool without a definition. */
function savedCall(
	renderers: ToolRenderers | undefined,
	points: MessageRenderSourcePointV1[] = [],
	selectors: MessageRenderBoundarySelectorV3[] = [() => () => controls],
) {
	const component = new ToolExecutionComponent(
		"process",
		"call-process",
		{ action: "list" },
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: selectors,
			sourcePointDecoratorsV1: [
				(source: Readonly<MessageRenderSourcePointV1>) => {
					points.push({ ...source });
					return EDIT_POINT;
				},
			],
		},
		renderers,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: "process output" }], isError: false });
	return component;
}

/** A selector that records each decorator context and answers with the fixed controls. */
function recording(contexts: MessageRenderBoundaryContextV1[]): MessageRenderBoundarySelectorV3[] {
	return [
		() => (context) => {
			contexts.push(context);
			return controls;
		},
	];
}

/** The rows of each boundary control and the rows without controls. */
function boundaryRows(rows: string[]) {
	const at = (control: string) => rows.flatMap((row, index) => (row.includes(control) ? [index] : []));
	const count = (control: string) => rows.reduce((total, row) => total + row.split(control).length - 1, 0);
	return {
		begin: at(controls.begin),
		body: at(controls.body),
		end: at(controls.end),
		counts: [count(controls.begin), count(controls.body), count(controls.end)],
		visible: rows.map((row) => stripAnsi(row.replaceAll(EDIT_POINT, "")).trimEnd()),
	};
}

/** The visible text of each rendered row that has a source point control. */
function pointRows(rows: string[]) {
	return rows.flatMap((row) =>
		row.includes(EDIT_POINT) ? [stripAnsi(row.replaceAll(EDIT_POINT, "")).trimEnd()] : [],
	);
}

/** The stock rows of a padded shell without its top padding row, which a semantic shell omits. */
function withoutShellTopPadding(rows: string[]) {
	return [rows[0]!, ...rows.slice(2)];
}

function plainRows(renderers: ToolRenderers | undefined, width: number) {
	const component = new ToolExecutionComponent(
		"process",
		"call-process",
		{ action: "list" },
		{},
		renderers,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: "process output" }], isError: false });
	return component.render(width).map((row) => stripAnsi(row).trimEnd());
}

describe("semantic Tool Call and Tool Group presentation", () => {
	beforeAll(() => initTheme("dark"));

	it("passes exact Tool Call identity and isolates selector and decorator failures", () => {
		const candidates: MessageRenderBoundaryCandidateV3[] = [];
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = tool("tool-a", [
			() => {
				throw new Error("selector failure");
			},
			(candidate) => {
				candidates.push(candidate);
				return (context) => {
					contexts.push(context);
					throw new Error("decorator failure");
				};
			},
			() => () => controls,
		]);
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });

		const rendered = component.render(80).join("\n");
		expect(candidates).toEqual([
			{
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				entryId: "tool-a",
				blockId: "tool-a",
				role: "tool",
				state: "expanded",
				ownerEntryId: "assistant-a",
			},
		]);
		expect(contexts[0]).toMatchObject({ entryId: "tool-a", ownerEntryId: "assistant-a", role: "tool" });
		expect(rendered).toContain(controls.begin);
		expect(rendered).toContain(controls.body);
		expect(rendered).toContain(controls.end);
	});

	it("keeps a compact live Tool Call on one stock header row without rendering its result", () => {
		const component = tool("tool-live");
		component.markExecutionStarted();
		component.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);

		expect(component.render(80).map((line) => stripAnsi(line).trimEnd())).toEqual(["stock header"]);
	});

	it("renders one presentation-only group around two existing children once", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:tool-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		const first = tool("tool-a");
		const second = tool("tool-b");
		first.updateResult({ content: [{ type: "text", text: "first" }], isError: false });
		second.updateResult({ content: [{ type: "text", text: "second" }], isError: false });
		group.addTool(first, { toolName: "read", toolCallId: "tool-a" });
		group.addTool(second, { toolName: "bash", toolCallId: "tool-b" });
		const firstRender = vi.spyOn(first, "render");
		const secondRender = vi.spyOn(second, "render");

		const rendered = group.render(80).join("\n");
		expect(firstRender).toHaveBeenCalledOnce();
		expect(secondRender).toHaveBeenCalledOnce();
		expect(stripAnsi(rendered)).toContain("$ Read files, Ran commands");
		expect(rendered.indexOf("stock header")).toBeLessThan(rendered.lastIndexOf("stock header"));
		// The group range and the range of each member.
		expect(rendered.split(controls.begin)).toHaveLength(4);
		expect(rendered.split(controls.body)).toHaveLength(4);
		expect(rendered.split(controls.end)).toHaveLength(4);
	});

	it("keeps expanded stock tool points stable and gives each grouped call its own fold", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const sourcePointDecoratorsV1 = [
			(point: Readonly<MessageRenderSourcePointV1>) => {
				points.push({ ...point });
				return "\x1b]777;point\x07";
			},
		];
		const makeBash = (id: string, text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n")) => {
			const component = new ToolExecutionComponent(
				"bash",
				id,
				{ command: "printf lines" },
				{
					ownerEntryId: "assistant-a",
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					sourcePointDecoratorsV1,
				},
				withBuiltInRenderers("bash", createBashToolDefinition(process.cwd()) as unknown as ToolRenderers),
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			component.setExpanded(true);
			component.updateResult({
				content: [{ type: "text", text }],
				isError: false,
			});
			return component;
		};
		makeBash("tool-short", "ok").render(80);
		expect(
			points
				.splice(0)
				.filter((point) => point.sourcePart === undefined)
				.map(({ entryId, pointKind, sourceOffset }) => ({ entryId, pointKind, sourceOffset })),
		).toEqual([{ entryId: "tool-short", pointKind: "line", sourceOffset: 0 }]);
		makeBash("tool-a").render(80);
		const singleton80 = points.splice(0);
		makeBash("tool-a").render(120);
		const singleton120 = points.splice(0);
		expect(singleton80).toEqual(singleton120);
		expect(singleton80[0]).toMatchObject({
			entryId: "tool-a",
			ownerEntryId: "assistant-a",
			role: "tool",
			state: "expanded",
			blockId: "tool-a",
			foldRole: "tool",
		});

		const first = makeBash("tool-a");
		const second = makeBash("tool-b");
		const group = new ToolGroupComponent({ groupId: "tool-group:assistant-a:tool-a", closed: true });
		group.addTool(first, { toolName: "bash", toolCallId: "tool-a" });
		group.addTool(second, { toolName: "bash", toolCallId: "tool-b" });
		group.render(80);
		expect(points.length).toBeGreaterThan(0);
		expect(points).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ entryId: "tool-a", blockId: "tool-a", foldRole: "tool" }),
				expect.objectContaining({ entryId: "tool-b", blockId: "tool-b", foldRole: "tool" }),
			]),
		);
		expect(points.some((point) => point.foldRole === "tool-group")).toBe(false);
	});

	it("marks stable source points inside a settled expanded edit diff", () => {
		const long = editDiff(40, "after");
		const at80 = renderEdit(long, 80, true);
		const at120 = renderEdit(long, 120, true);
		expect(stripAnsi(at80.rows.join("\n"))).toContain("const after39 = 78;");
		const interior = at80.points.filter((source) => source.entryId === "tool-edit" && source.sourceOffset > 0);
		expect(interior.length).toBeGreaterThan(0);
		expect(interior[0]).toMatchObject({ role: "tool", state: "expanded", blockId: "tool-edit", foldRole: "tool" });
		expect(at80.points).toEqual(at120.points);
	});

	it.each([80, 120])("keeps decorated edit diff rows visually equal to the undecorated rows at width %i", (width) => {
		const long = editDiff(40, "after");
		const decorated = renderEdit(long, width, true).rows.map((row) => row.split(EDIT_POINT).join(""));
		expect(decorated).toEqual(renderEdit(long, width, false).rows);
	});

	it("revises edit diff points when only the diff changes", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = editComponent(editRenderersFor(), points, new SourcePointRevisions());
		const settle = (diff: ReturnType<typeof editDiff>) =>
			component.updateResult({ content: [{ type: "text", text: EDIT_SUCCESS }], details: diff, isError: false });
		settle(editDiff(20, "first"));
		component.render(80);
		const before = points.splice(0);

		settle(editDiff(20, "second"));
		component.render(80);
		const after = points.splice(0);

		expect(before[0]?.sourcePointRevision).toBe(1);
		expect(after[0]?.sourcePointRevision).toBe(2);
		expect(after[0]?.contentDigest).not.toBe(before[0]?.contentDigest);
	});

	it("keeps the same call-body diff points when the settled edit collapses", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = editComponent(editRenderersFor(), points);
		component.updateResult({
			content: [{ type: "text", text: EDIT_SUCCESS }],
			details: editDiff(20, "after"),
			isError: false,
		});
		component.render(80);
		const expanded = points.splice(0).map(({ sourceOffset, contentDigest }) => ({ sourceOffset, contentDigest }));

		component.setExpanded(false);
		component.render(80);

		expect(points.map(({ sourceOffset, contentDigest }) => ({ sourceOffset, contentDigest }))).toEqual(expanded);
	});

	it("clears result source points when a settled bash result collapses", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = new ToolExecutionComponent(
			"bash",
			"tool-bash",
			{ command: "printf lines" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				sourcePointDecoratorsV1: [
					(source: Readonly<MessageRenderSourcePointV1>) => {
						points.push({ ...source });
						return EDIT_POINT;
					},
				],
			},
			withBuiltInRenderers("bash", createBashToolDefinition(process.cwd()) as unknown as ToolRenderers),
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({
			content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") }],
			isError: false,
		});
		component.render(80);
		expect(points.some((point) => point.sourcePart === undefined)).toBe(true);
		points.splice(0);

		component.setExpanded(false);
		component.render(80);

		expect(points.filter((point) => point.sourcePart === undefined)).toEqual([]);
	});

	it("marks call-body diff source points of a settled edit whose tool output is not expanded", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = editComponent(editRenderersFor(), points);
		component.setExpanded(false);
		component.updateResult({
			content: [{ type: "text", text: EDIT_SUCCESS }],
			details: editDiff(20, "after"),
			isError: false,
		});

		component.render(80);

		expect(
			points.filter((source) => source.entryId === "tool-edit" && source.sourceOffset > 0).length,
		).toBeGreaterThan(0);
	});

	it("does not give a custom edit call renderer the built-in call source text", () => {
		const custom = withBuiltInRenderers("edit", {
			...createEditToolDefinition(process.cwd()),
			renderCall: () => new Text("custom edit call", 0, 0),
		} as unknown as ToolRenderers);

		expect(custom?.getRenderCallSourceText).toBeUndefined();
	});

	it("keeps capability-off group bytes on the direct-child path", () => {
		const first = tool("tool-a", []);
		const second = tool("tool-b", []);
		first.updateResult({ content: [{ type: "text", text: "first" }], isError: false });
		second.updateResult({ content: [{ type: "text", text: "second" }], isError: true });
		const expected = [...first.render(80), ...second.render(80)];
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:tool-a",
			closed: true,
			semanticSelectorsV3: [],
		});
		group.addTool(first, { toolName: "read", toolCallId: "tool-a" });
		group.addTool(second, { toolName: "bash", toolCallId: "tool-b" });

		expect(group.children).toEqual([first, second]);
		expect(group.render(80)).toEqual(expected);
	});

	it("maps the group separator, header and member-separator mouse rows to each child", () => {
		const makeChild = (rows: string[]) => ({
			render: vi.fn(() => rows),
			invalidate: vi.fn(),
			handleMouse: vi.fn(() => ({ handled: true as const })),
			rendersLeadingSeparator: false,
		});
		const first = makeChild(["first-0", "first-1"]);
		const second = makeChild(["second-0"]);
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:tool-a",
			ownerEntryId: "assistant-a",
			closed: true,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		group.addTool(first as unknown as ToolExecutionComponent, { toolName: "read", toolCallId: "tool-a" });
		group.addTool(second as unknown as ToolExecutionComponent, { toolName: "bash", toolCallId: "tool-b" });
		const rows = group.render(80);
		const event = (y: number): TuiMouseEvent => ({
			type: "click",
			button: "left",
			x: 0,
			y,
			screenX: 0,
			screenY: y,
			width: 80,
			height: rows.length,
			shift: false,
			alt: false,
			ctrl: false,
			clickCount: 1,
		});

		expect(group.handleMouse(event(0))).toBeUndefined();
		expect(group.handleMouse(event(1))).toBeUndefined();
		expect(group.handleMouse(event(2))).toBeUndefined();
		expect(group.handleMouse(event(3))).toMatchObject({ handled: true });
		expect(first.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 2 }));
		expect(group.handleMouse(event(6))).toMatchObject({ handled: true });
		expect(second.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 1 }));
	});

	it.each([
		["a settled call with its own separator", true, ["", "header", "body"], ["", "header", "body"]],
		["a compact live header", false, ["stock header"], ["", "stock header"]],
		["an empty member", false, [], []],
	] as const)(
		"adds one separator row only before a member without its own: %s",
		(_name, separated, childRows, rows) => {
			const component = {
				render: vi.fn(() => [...childRows]),
				invalidate: vi.fn(),
				handleMouse: vi.fn(),
				rendersLeadingSeparator: separated,
			} as unknown as ToolExecutionComponent;
			const member = new ToolGroupMemberComponent(component);

			expect(member.render(80)).toEqual(rows);
			expect(component.render).toHaveBeenCalledOnce();
		},
	);

	it("marks call source points inside a long bash command and keeps its result points", () => {
		const sources = renderBashSources(numbered("echo command", 40), "done", 80);

		expect(sources.call.filter((point) => point.sourceOffset > 0).length).toBeGreaterThan(0);
		expect(sources.result.length).toBeGreaterThan(0);
	});

	it("keeps the result points of a long bash result equal to the points without a call source", () => {
		const output = numbered("out", 40);

		const both = renderBashSources("echo short", output, 80);
		const resultOnly = renderBashSources("echo short", output, 80, false);

		expect(both.call.length).toBeGreaterThan(0);
		expect(resultOnly.call).toEqual([]);
		expect(both.result.length).toBeGreaterThan(1);
		expect(both.result).toEqual(resultOnly.result);
	});

	it("distinguishes identical call and result source text only by the call source part", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const call = new Text("same text", 0, 0);
		const renderResult = () => new Text("same text", 0, 0);
		const component = new ToolExecutionComponent(
			"custom_tool",
			"tool-same",
			{},
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				sourcePointDecoratorsV1: [
					(source: Readonly<MessageRenderSourcePointV1>) => {
						points.push({ ...source });
						return EDIT_POINT;
					},
				],
			},
			{
				renderCall: () => call,
				getRenderCallSourceText: () => call,
				renderResult,
				semanticSourceTextRenderer: renderResult,
			},
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: "same text" }], isError: false });
		component.render(80);
		const identity = ({ sourcePart: _, ...point }: MessageRenderSourcePointV1) => point;
		const callPoints = points.filter((point) => point.sourcePart === "call");
		const resultPoints = points.filter((point) => point.sourcePart === undefined);

		expect(callPoints.length).toBeGreaterThan(0);
		expect(callPoints.map(identity)).toEqual(resultPoints.map(identity));
	});

	it("keeps bash call and result source points equal across widths", () => {
		const command = numbered("echo command", 40);
		const output = numbered("out", 40);

		expect(renderBashSources(command, output, 80)).toEqual(renderBashSources(command, output, 120));
	});

	it("keeps bash call source points when the settled result collapses", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = bashComponent(numbered("echo command", 40), points);
		component.updateResult({ content: [{ type: "text", text: numbered("out", 40) }], isError: false });
		component.render(80);
		points.splice(0);

		component.setExpanded(false);
		component.render(80);

		expect(points.some((point) => point.sourcePart === "call")).toBe(true);
		expect(points.some((point) => point.sourcePart === undefined)).toBe(false);
	});

	it("gives the bash call and result source points of a grouped call its own fold", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const first = bashComponent("echo first", points, "tool-a");
		const second = bashComponent("echo second", points, "tool-b");
		for (const member of [first, second])
			member.updateResult({ content: [{ type: "text", text: "out" }], isError: false });
		const group = new ToolGroupComponent({ groupId: "tool-group:assistant-a:tool-a", closed: true });
		group.addTool(first, { toolName: "bash", toolCallId: "tool-a" });
		group.addTool(second, { toolName: "bash", toolCallId: "tool-b" });

		group.render(80);

		for (const sourcePart of ["call", undefined]) {
			expect(points.filter((point) => point.sourcePart === sourcePart)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ entryId: "tool-a", blockId: "tool-a", foldRole: "tool" }),
					expect.objectContaining({ entryId: "tool-b", blockId: "tool-b", foldRole: "tool" }),
				]),
			);
		}
	});

	it("marks settled edit call body points as call source points", () => {
		const { points } = renderEdit(editDiff(40, "after"), 80, true);

		expect(points.filter((point) => point.sourceOffset > 0).length).toBeGreaterThan(0);
		expect(points.filter((point) => point.sourceOffset > 0).every((point) => point.sourcePart === "call")).toBe(true);
	});

	it("gives a saved call of a tool without a definition one whole-call range below its title", () => {
		const rows = boundaryRows(savedCall(undefined).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe(" process");
		expect(rows.body).toEqual([rows.begin[0]! + 1]);
		expect(rows.end).toEqual([rows.visible.length - 1]);
		expect(rows.visible).toEqual(withoutShellTopPadding(plainRows(undefined, 80)));
	});

	it("gives a call without a call renderer its title as the header and its result as the body", () => {
		const renderers: ToolRenderers = {};
		const rows = boundaryRows(savedCall(renderers).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe(" process");
		expect(rows.visible[rows.body[0]!]).toBe(" process output");
		expect(rows.visible).toEqual(withoutShellTopPadding(plainRows(renderers, 80)));
	});

	it("keeps the whole-call range of a call whose renderer throws on its fallback title", () => {
		const renderers: ToolRenderers = {
			renderCall: () => {
				throw new Error("renderer failure");
			},
		};
		const rows = boundaryRows(savedCall(renderers).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe(" process");
		expect(rows.visible[rows.body[0]!]).toBe(" process output");
	});

	it("gives a custom self renderer without row locators its first call row as the header", () => {
		const renderers: ToolRenderers = {
			renderShell: "self",
			renderCall: () => new Text("custom call\ncustom arguments", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};
		const rows = boundaryRows(savedCall(renderers).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe("custom call");
		expect(rows.visible[rows.body[0]!]).toBe("custom arguments");
		expect(rows.visible).toEqual(plainRows(renderers, 80));
	});

	it("gives a completed self-rendered call with an empty result one plain whole-call range", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderShell: "self", renderCall: () => new Text("custom call", 0, 0) },
			[],
			recording(contexts),
		);
		component.updateResult({ content: [], isError: false });
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", "custom call"]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [1]]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("does not make the bottom padding of a call without a result the body of its range", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall({}, [], recording(contexts));
		component.updateResult({ content: [], isError: false });
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " process", ""]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [2]]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("gives a call whose result renderer draws no rows a plain range", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderCall: () => new Text("custom call", 0, 0), renderResult: () => new Text("", 0, 0) },
			[],
			recording(contexts),
		);
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " custom call", ""]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("starts the body of a call whose result is only an image at the first image row", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const shells: [ToolRenderers, number, number][] = [
				// The default semantic shell: Spacer, title, padding, image spacer, image.
				[{}, 1, 4],
				// The self shell: leading row, call, image spacer, image.
				[{ renderShell: "self", renderCall: () => new Text("custom call", 0, 0) }, 1, 3],
			];
			for (const [renderers, begin, body] of shells) {
				const contexts: MessageRenderBoundaryContextV1[] = [];
				const component = savedCall(renderers, [], recording(contexts));
				component.updateResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false });
				const rendered = component.render(80);
				const rows = boundaryRows(rendered);

				expect([rows.begin, rows.body]).toEqual([[begin], [body]]);
				expect(rendered[body - 1]).toBe("");
				expect(rendered[body]).toContain("\x1b_G");
				expect(contexts.at(-1)?.bodyRow).toBe(body);
			}
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("gives a call whose call renderer draws no rows one plain range over its result", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderCall: () => new Text("", 0, 0), renderResult: () => new Text("custom result", 0, 0) },
			[],
			recording(contexts),
		);
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " custom result", ""]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [2]]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("gives the context of a call with a result the row of its foldable body", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const rows = boundaryRows(savedCall({}, [], recording(contexts)).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(contexts.at(-1)?.bodyRow).toBe(rows.body[0]);
	});

	it("gives a decorator context a body row only when the helper places the body", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const decorators = [
			(context: Readonly<MessageRenderBoundaryContextV1>) => {
				contexts.push(context);
				return controls;
			},
		];
		const options = { entryId: "tool-a", beginRow: 1, decorators };

		const folded = decorateMessageRenderV2(["a", "b", "c"], 2, 80, "tool", 0, options);
		const outside = decorateMessageRenderV2(["a", "b"], 2, 80, "tool", 0, options);
		const atBegin = decorateMessageRenderV2(["a", "b"], 1, 80, "tool", 0, options);
		const absent = decorateMessageRenderV2(["a", "b"], undefined, 80, "tool", 0, options);

		expect(contexts.map((context) => context.bodyRow)).toEqual([2, undefined, undefined, undefined]);
		expect(folded).toEqual(["a", `${controls.begin}b`, `${controls.body}c${controls.end}`]);
		for (const plain of [outside, atBegin, absent]) expect(plain).toEqual(["a", `${controls.begin}b${controls.end}`]);
	});

	it("keeps the located rows of a renderer that has row locators", () => {
		const rows = boundaryRows(tool("tool-located").render(80));
		const component = tool("tool-located");
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const settled = boundaryRows(component.render(80));

		expect(rows.counts).toEqual([0, 0, 0]);
		expect(settled.counts).toEqual([1, 1, 1]);
		expect(settled.visible[settled.begin[0]!]).toBe("stock header");
		expect(settled.visible[settled.body[0]!]).toBe("stock preview");
	});

	it("marks rendered source points in the body of the generic text of a tool without a definition", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = savedCall(undefined, points);
		component.updateResult({ content: [{ type: "text", text: numbered("line", 30) }], isError: false });
		points.length = 0;

		const rows = pointRows(component.render(80));

		// The generic text is the title, a blank line, three argument lines and the output: every 8th line has a point.
		expect(rows).toEqual([" process", " line-3", " line-11", " line-19", " line-27"]);
		expect(points.map((point) => [point.pointKind, point.contentIndex, point.sourcePart])).toEqual(
			Array.from({ length: 5 }, () => ["line", 0, undefined]),
		);
		expect(points[0]!.sourceOffset).toBe(0);
		expect(new Set(points.map((point) => point.sourceOffset)).size).toBe(5);
		expect(new Set(points.map((point) => point.contentDigest)).size).toBe(1);
		expect(points.every((point) => point.entryId === "call-process" && point.ownerEntryId === "assistant-a")).toBe(
			true,
		);
	});

	it("marks rendered source points in the expanded fallback result of a call without a result renderer", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = savedCall({}, points);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: numbered("line", 30) }], isError: false });
		points.length = 0;

		expect(pointRows(component.render(80))).toEqual([" line-0", " line-8", " line-16", " line-24"]);
		expect(points.every((point) => point.entryId === "call-process" && point.sourcePart === undefined)).toBe(true);
	});

	it("marks rendered source points in the expanded fallback result of a result renderer that throws", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = savedCall(
			{
				renderResult: () => {
					throw new Error("result renderer failure");
				},
			},
			points,
		);
		component.setExpanded(true);
		component.updateResult({ content: [{ type: "text", text: numbered("line", 30) }], isError: false });
		points.length = 0;

		expect(pointRows(component.render(80))).toEqual([" line-0", " line-8", " line-16", " line-24"]);
	});

	it("keeps a collapsed fallback result preview without source points", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const component = savedCall({}, points);
		component.updateResult({ content: [{ type: "text", text: numbered("line", 30) }], isError: false });
		points.length = 0;

		expect(pointRows(component.render(80))).toEqual([]);
	});

	it("leaves a singleton on its existing Tool Call path", () => {
		const child = tool("tool-only");
		const group = new ToolGroupComponent({ groupId: "tool-group:assistant-a:tool-only", closed: true });
		group.addTool(child, { toolName: "read", toolCallId: "tool-only" });

		expect(group.render(80)).toEqual(child.render(80));
	});
});

/** A completed call of a tool without a definition, with a result. */
function unknownCall(id: string, selectors: MessageRenderBoundarySelectorV3[] = [() => () => controls]) {
	const component = new ToolExecutionComponent(
		"process",
		id,
		{ action: "list" },
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: selectors,
		},
		undefined,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: `${id} output` }], isError: false });
	return component;
}

/** A completed built-in call with native folding and its presentation, with Pi tool output collapsed. */
function foldedBuiltIn(name: string, renderers: ToolRenderers, args: object, output: string) {
	const component = new ToolExecutionComponent(
		name,
		`call-${name}`,
		args,
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
			toolExecutionPresentationSelectorsV1: [admitCompact],
		},
		renderers,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.updateResult({ content: [{ type: "text", text: output }], isError: false });
	return component;
}

const readCall = () =>
	foldedBuiltIn(
		"read",
		withBuiltInRenderers("read", createReadToolDefinition(process.cwd()) as unknown as ToolRenderers)!,
		{ path: "a.md" },
		"line 1\nline 2",
	);

/** The rows that native shows when each Fold that [collapsed] selects hides its body through its end row. */
function foldedRows(rows: string[], collapsed: (depth: number) => boolean): string[] {
	const open: { body?: number; depth: number }[] = [];
	const hidden = new Set<number>();
	rows.forEach((row, index) => {
		const controlsInRow = [...row.matchAll(/\x1b\]777;(begin|body|end)\x07/g)].map((match) => match[1]);
		for (const control of controlsInRow) {
			if (control === "begin") open.push({ depth: open.length });
			else if (control === "body") {
				const fold = [...open].reverse().find((candidate) => candidate.body === undefined);
				if (fold) fold.body = index;
			} else {
				const fold = open.pop();
				if (fold?.body === undefined || !collapsed(fold.depth)) continue;
				for (let hiddenRow = fold.body; hiddenRow <= index; hiddenRow++) hidden.add(hiddenRow);
			}
		}
	});
	return rows.flatMap((row, index) => {
		if (hidden.has(index)) return [];
		const text = stripAnsi(row.replaceAll(EDIT_POINT, "")).trim();
		return [/\x1b\[48;/.test(row) && text === "" ? "<shaded blank>" : text];
	});
}

describe("collapsed Tool Call and Tool Group layout", () => {
	beforeAll(() => initTheme("dark"));

	it("shows a collapsed tool call as one separator row and its header row", () => {
		expect(foldedRows(unknownCall("call-a").render(80), () => true)).toEqual(["", "process"]);
	});

	it("shows a collapsed built-in tool call as one separator row and its header row", () => {
		expect(foldedRows(readCall().render(80), () => true)).toEqual(["", "read a.md"]);
	});

	it("opens the Fold of a saved read with collapsed Pi output to its saved result", () => {
		const rows = foldedRows(readCall().render(80), () => false);

		expect(rows).toEqual(expect.arrayContaining(["line 1", "line 2"]));
	});

	it("gives a located call whose result draws no rows no fold body", () => {
		const rows = foldedBuiltIn(
			"custom_tool",
			{
				renderCall: () => new Text("custom header", 0, 0),
				getRenderCallHeaderRow: () => 0,
				getRenderCallBodyRow: () => 1,
				renderResult: () => new Text("", 0, 0),
			},
			{},
			"ignored",
		).render(80);

		expect(boundaryRows(rows).counts).toEqual([1, 0, 1]);
	});

	it("keeps a long bash command on one collapsed row and its complete command and output in the body", () => {
		const command = numbered("echo command", 40);
		const rows = foldedBuiltIn(
			"bash",
			withBuiltInRenderers("bash", createBashToolDefinition(process.cwd()) as unknown as ToolRenderers)!,
			{ command },
			numbered("out", 40),
		).render(80);

		expect(foldedRows(rows, () => true)).toHaveLength(2);
		expect(foldedRows(rows, () => false)).toEqual(
			expect.arrayContaining([expect.stringContaining("echo command-39"), "out-39"]),
		);
	});

	it("keeps a long write call on one collapsed row and its complete content in the body", () => {
		const rows = foldedBuiltIn(
			"write",
			withBuiltInRenderers("write", createWriteToolDefinition(process.cwd()) as unknown as ToolRenderers)!,
			{ path: "notes.txt", content: numbered("note", 40) },
			"Wrote notes.txt",
		).render(80);

		expect(foldedRows(rows, () => true)).toHaveLength(2);
		expect(foldedRows(rows, () => false)).toEqual(expect.arrayContaining([expect.stringContaining("note-39")]));
	});

	it("shows a collapsed custom call with a multirow call renderer as one row and all its content when open", () => {
		const rows = savedCall({
			renderShell: "self",
			renderCall: () => new Text("custom call\ncustom arguments", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		}).render(80);

		expect(foldedRows(rows, () => true)).toEqual(["", "custom call"]);
		expect(foldedRows(rows, () => false)).toEqual(["", "custom call", "custom arguments", "custom result"]);
	});

	it("shows a collapsed call of a tool without a definition and a wrapped long name as one row", () => {
		const component = new ToolExecutionComponent(
			"a_tool_name_that_wraps_at_a_narrow_width",
			"call-long-name",
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [() => () => controls],
			},
			undefined,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "long name output" }], isError: false });
		const rows = component.render(24);

		expect(foldedRows(rows, () => true)).toHaveLength(2);
		expect(foldedRows(rows, () => false).join("")).toContain("long name output");
	});

	it("shows a collapsed built-in edit with a long path as one row that ends with an ellipsis", () => {
		const path = `../jetbrains-terminal_worktrees/semantic-resize-r0/src/uiTest/kotlin/${"segment/".repeat(4)}Long.kt`;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const rows = component.render(60);

		expect(foldedRows(rows, () => true)).toEqual(["", expect.stringMatching(/^edit .*…$/)]);
	});

	it("keeps the complete long path of a built-in edit in its open Fold", () => {
		const path = `../jetbrains-terminal_worktrees/semantic-resize-r0/src/uiTest/kotlin/${"segment/".repeat(4)}Long.kt`;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);

		expect(foldedRows(component.render(60), () => false).join("")).toContain("Long.kt");
	});

	it("shows a collapsed built-in edit whose header fits as its one header row without a repeated header", () => {
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const rows = component.render(80);

		expect(foldedRows(rows, () => true)).toEqual(["", "edit a.ts"]);
		expect(foldedRows(rows, () => false).filter((row) => row.startsWith("edit "))).toHaveLength(1);
	});

	it("recomputes the collapsed summary of a built-in edit from narrow to wide to narrow", () => {
		const path = `src/${"目录/".repeat(6)}${"segment/".repeat(4)}Long.kt`;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const summary = (width: number) => {
			const rows = component.render(width);
			const begin = boundaryRows(rows).begin[0]!;
			return { row: rows[begin]!, body: boundaryRows(rows).body[0], begin, collapsed: foldedRows(rows, () => true) };
		};

		const narrow = summary(40);
		const wide = summary(200);
		const again = summary(40);

		expect(narrow.collapsed).toEqual(["", expect.stringMatching(/^edit .*…$/)]);
		expect(visibleWidth(narrow.row.replaceAll(controls.begin, ""))).toBeLessThanOrEqual(40);
		expect(narrow.row).toContain("\x1b[");
		expect(narrow.body).toBe(narrow.begin + 1);
		expect(wide.collapsed).toEqual(["", expect.stringMatching(/^edit .*Long\.kt$/)]);
		expect(again).toEqual(narrow);
	});

	it("keeps the stock layout of a built-in edit with a long path when folding is off", () => {
		const path = `../jetbrains-terminal_worktrees/semantic-resize-r0/src/uiTest/kotlin/${"segment/".repeat(4)}Long.kt`;
		const component = new ToolExecutionComponent(
			"edit",
			"call-edit",
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			{},
			editRenderersFor(),
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const rows = foldedRows(component.render(60), () => true);

		expect(rows.slice(0, 3)).toEqual(["", "<shaded blank>", "edit"]);
		expect(rows.some((row) => row.includes("…"))).toBe(false);
	});

	it.each([
		["default", undefined],
		["self", "self"],
	] as const)(
		"shows a collapsed %s shell call renderer without row locators and a long first line as one row with an ellipsis",
		(_name, renderShell) => {
			const rows = savedCall({
				...(renderShell ? { renderShell } : {}),
				renderCall: () => new Text("a long logical custom call title that wraps at a narrow width\nargs", 0, 0),
				renderResult: () => new Text("custom result", 0, 0),
			}).render(30);
			const open = foldedRows(rows, () => false).join(" ");

			expect(foldedRows(rows, () => true)).toEqual(["", expect.stringMatching(/^a long .*…$/)]);
			expect(open).toContain("narrow width");
			expect(open).toContain("args");
			expect(open).toContain("custom result");
		},
	);

	it.each([
		["a short", "opaque_tool", 80, /^opaque_tool$/],
		["a long", "an_opaque_tool_name_that_does_not_fit", 24, /^an_opaque.*…$/],
	] as const)(
		"shows a collapsed opaque call renderer without row locators as one tool title row for %s name",
		(_name, toolName, width, title) => {
			const opaque = (): Component => ({
				render: () => ["opaque first row that may continue", "opaque second row"],
				invalidate: () => {},
			});
			const component = new ToolExecutionComponent(
				toolName,
				"call-opaque",
				{},
				{
					ownerEntryId: "assistant-a",
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					semanticSelectorsV3: [() => () => controls],
				},
				{ renderCall: opaque, renderResult: () => new Text("opaque result", 0, 0) },
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
			const rows = component.render(width);
			const open = foldedRows(rows, () => false);

			expect(foldedRows(rows, () => true)).toEqual(["", expect.stringMatching(title)]);
			expect(open).toEqual(
				expect.arrayContaining(["opaque first row that may continue", "opaque second row", "opaque result"]),
			);
		},
	);

	it("keeps the stock rows of an opaque call renderer when folding is off", () => {
		const component = new ToolExecutionComponent(
			"opaque_tool",
			"call-opaque",
			{},
			{},
			{ renderCall: () => ({ render: () => ["opaque row"], invalidate: () => {} }) },
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });

		expect(foldedRows(component.render(80), () => true).filter((row) => row.includes("opaque_tool"))).toEqual([]);
	});

	it("shows a collapsed call of a tool without a definition and a long name as one row that ends with an ellipsis", () => {
		const component = new ToolExecutionComponent(
			"a_tool_name_that_wraps_at_a_narrow_width",
			"call-long-title",
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [() => () => controls],
			},
			undefined,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "output" }], isError: false });

		expect(foldedRows(component.render(24), () => true)).toEqual(["", expect.stringMatching(/…$/)]);
	});

	it.each([
		[
			"a call without a result renderer under native folding",
			true,
			{ renderCall: () => new Text("call", 0, 0) },
			true,
		],
		["a call without a result renderer with folding off", false, { renderCall: () => new Text("call", 0, 0) }, false],
		["a call of a tool without a definition under native folding", true, undefined, true],
	] as const)(
		"opens %s to its complete saved output only when the Fold owns it",
		(_name, folded, renderers, complete) => {
			const component = new ToolExecutionComponent(
				"process",
				"call-fallback",
				{ action: "list" },
				folded
					? {
							ownerEntryId: "assistant-a",
							producerSessionId: "session-a",
							renderScopeId: "scope-a",
							semanticSelectorsV3: [() => () => controls],
							toolExecutionPresentationSelectorsV1: [settledCanonicalOnly],
						}
					: {},
				renderers,
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: numbered("out", 15) }], isError: false });
			const text = foldedRows(component.render(80), () => false).join("\n");

			expect(text.includes("out-14")).toBe(complete);
		},
	);

	it("keeps one Fold for each child of a closed Tool Group", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:call-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		group.addTool(unknownCall("call-a"), { toolName: "process", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "process", toolCallId: "call-b" });

		expect(boundaryRows(group.render(80)).counts).toEqual([3, 3, 3]);
	});

	it("shows an expanded Tool Group with collapsed children as its header and one separator before each child", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:call-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		group.addTool(unknownCall("call-a"), { toolName: "process", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "process", toolCallId: "call-b" });

		expect(foldedRows(group.render(80), (depth) => depth > 0)).toEqual([
			"",
			"$ Used tools",
			"",
			"process",
			"",
			"process",
		]);
	});
});
