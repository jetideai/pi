import {
	type Component,
	Container,
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
import { keepPathFileName, ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
const summaryBegin = "\x1b]777;begin-summary\x07";
/** The controls, with a distinct begin when the render gives the begin row as a one-row summary of the header. */
const summaryAware: MessageRenderBoundarySelectorV3 = () => (context) =>
	context.summaryRow === undefined ? controls : { ...controls, begin: summaryBegin };
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
	selectors: MessageRenderBoundarySelectorV3[] = [summaryAware],
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
function boundaryRows(rendered: string[]) {
	const rows = rendered.map((row) => row.replaceAll(summaryBegin, controls.begin));
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

/** The inner text of a card row of an open call, or the visible text of another row. */
function cardInner(visible: string): string {
	return /^\s*│(.*)│\s*$/.exec(visible)?.[1] ?? visible;
}

/** The visible text of each rendered row that has a source point control, inside the card of an open call. */
function pointRows(rows: string[]) {
	return rows.flatMap((row) =>
		row.includes(EDIT_POINT) ? [cardInner(stripAnsi(row.replaceAll(EDIT_POINT, ""))).trimEnd()] : [],
	);
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

/** A row without visible text: a separator, shell padding or an empty row. */
const blankRow = (row: string) =>
	row === "<shaded blank>" || stripAnsi(row.replace(/\x1b\]777;[^\x07]*\x07/g, "")).trim() === "";

/**
 * The rows that an open Fold shows of the stock rows of one call: the separator row, then the rows from the first through
 * the last visible row. An open Fold has no shell padding, so its header stays on the row of the collapsed summary.
 */
function unpadded(rows: string[]): string[] {
	const first = rows.findIndex((row, index) => index > 0 && !blankRow(row));
	if (first < 0) return rows.slice(0, 1);
	const last = rows.length - 1 - [...rows].reverse().findIndex((row) => !blankRow(row));
	return [rows[0]!, ...rows.slice(first, last + 1)];
}

/**
 * The visible rows that an open call shows after its summary: its header without a background, then its other stock rows
 * in a card frame. [stock] are the unpadded visible stock rows at the inner width of the card, separator row first.
 */
function openCard(stock: string[], width: number): string[] {
	const [, header, ...body] = stock;
	const inner = width - 2;
	const frame = "─".repeat(inner);
	const card = body.length === 0 ? [] : [`╭${frame}╮`, ...body.map((row) => `│${row.padEnd(inner)}│`), `╰${frame}╯`];
	return [header!.startsWith(" ") ? header! : ` ${header}`, ...card];
}

/**
 * The parts of the open rows of a call (summary and controls removed): the visible header text, and the raw rows inside
 * its card frame. A frame cell is the border color of the outcome of the call.
 */
function openCardParts(rows: string[], failed: boolean): { header: string; card: string[] } {
	const edge = theme.fg(failed ? "error" : "border", "│");
	return {
		header: withoutOutcomeCue(stripAnsi(rows[1] ?? "").trim()),
		card: rows.slice(3, -1).map((row) => row.slice(edge.length, -edge.length)),
	};
}

/**
 * The parts that the card of an open call shows of its unpadded stock rows at the [inner] width of the card: a short row
 * is padded to that width, so the right border of the card stays straight.
 */
function stockCardParts(stock: string[], inner: number): { header: string; card: string[] } {
	return {
		header: withoutOutcomeCue(stripAnsi(stock[1] ?? "").trim()),
		card: stock.slice(2).map((row) => `${row}${" ".repeat(Math.max(0, inner - visibleWidth(row)))}`),
	};
}

/** A header text without its outcome cue: the full or compact cue depends on the width of the row, not on the call. */
function withoutOutcomeCue(header: string): string {
	return header.replace(/ (?:Failed|Cancelled|✗|⊘)$/, "");
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

	/** A call of a tool without a definition, with native folding of its canonical body. */
	const activeCall = (id: string) =>
		new ToolExecutionComponent(
			"process",
			id,
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [() => () => controls],
				toolExecutionPresentationSelectorsV1: [settledCanonicalOnly],
			},
			undefined,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
	/** The text of the rows after the body control. */
	const bodyText = (rows: string[]) => {
		const body = rows.findIndex((row) => row.includes(controls.body));
		return body < 0 ? undefined : stripAnsi(rows.slice(body).join("\n"));
	};

	it.each([
		["a ready call", false, "Waiting to start"],
		["a running call without output", true, "Running"],
	] as const)("gives %s its own Fold with a truthful working row as its body", (_name, started, row) => {
		const component = activeCall("call-active");
		if (started) component.markExecutionStarted();
		const rows = component.render(80);

		expect({
			controls: [controls.begin, controls.body, controls.end].map(
				(control) => rows.join("").split(control).length - 1,
			),
			body: bodyText(rows)?.includes(row),
		}).toEqual({ controls: [1, 1, 1], body: true });
	});

	it.each([
		["the generic text of a tool without a definition", undefined],
		[
			"an owned result renderer",
			{
				...definition(),
				renderShell: "default",
				renderCall: () => new Text("owned header", 0, 0),
				getRenderCallHeaderRow: undefined,
				getRenderCallBodyRow: undefined,
				renderResult: (result: { content: Array<{ type: string; text?: string }> }) =>
					new Text(result.content.map((part) => part.text ?? "").join(""), 0, 0),
			} as ToolDefinition,
		],
	] as const)("keeps the Fold body of a running call through an empty partial result: %s", (_name, toolDefinition) => {
		const component = new ToolExecutionComponent(
			"process",
			"call-progress",
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [() => () => controls],
				toolExecutionPresentationSelectorsV1: [settledCanonicalOnly],
			},
			toolDefinition,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.markExecutionStarted();
		const bodies = () => component.render(80).join("").split(controls.body).length - 1;
		const states = [bodies()];
		component.updateResult({ content: [], isError: false }, true);
		states.push(bodies());
		component.updateResult({ content: [{ type: "text", text: "first output" }], isError: false }, true);
		states.push(bodies());

		expect(states).toEqual([1, 1, 1]);
	});

	it("gives a running call the complete current partial output in the body of its Fold", () => {
		const component = activeCall("call-running");
		component.markExecutionStarted();
		const output = Array.from({ length: 30 }, (_, line) => `partial line ${line + 1}`).join("\n");
		component.updateResult({ content: [{ type: "text", text: output }], isError: false }, true);
		const body = bodyText(component.render(80)) ?? "";

		expect([body.includes("partial line 1"), body.includes("partial line 30"), body.includes("more lines")]).toEqual([
			true,
			true,
			false,
		]);
	});

	it("gives a group of two committed calls its range while its run is open", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-a",
			closed: false,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		const first = tool("tool-a");
		const second = tool("tool-b");
		first.updateResult({ content: [{ type: "text", text: "first" }], isError: false });
		group.addTool(first, { toolName: "read", toolCallId: "tool-a" });
		group.addTool(second, { toolName: "bash", toolCallId: "tool-b" });

		expect(group.render(80).join("\n").split(controls.begin)).toHaveLength(4);
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

	it("maps the group separator, header and indent to no child and each indented member row to its child", () => {
		const makeChild = (rows: string[]) => ({
			render: vi.fn(() => rows),
			invalidate: vi.fn(),
			handleMouse: vi.fn(() => ({ handled: true as const })),
		});
		// Each call renders its separator row first; the group shows its calls without it.
		const first = makeChild(["", "first-0", "first-1"]);
		const second = makeChild(["", "second-0"]);
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
		const event = (y: number, x = 2): TuiMouseEvent => ({
			type: "click",
			button: "left",
			x,
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

		expect(rows.slice(2).map((row) => stripAnsi(row))).toEqual(["  first-0", "  first-1", "  second-0"]);
		expect(group.handleMouse(event(0))).toBeUndefined();
		expect(group.handleMouse(event(1))).toBeUndefined();
		expect(group.handleMouse(event(2, 1))).toBeUndefined();
		expect(group.handleMouse(event(2))).toMatchObject({ handled: true });
		expect(first.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 1, width: 78, height: 3 }));
		expect(group.handleMouse(event(4))).toMatchObject({ handled: true });
		expect(second.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ x: 0, y: 1, width: 78, height: 2 }));
	});

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
		expect(rows.visible).toEqual(["", " process", ...openCard(unpadded(plainRows(undefined, 78)), 80)]);
	});

	it("gives a call without a call renderer its title as the header and its result as the body", () => {
		const renderers: ToolRenderers = {};
		const rows = boundaryRows(savedCall(renderers).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe(" process");
		expect(rows.visible[rows.body[0]!]).toBe(" process");
		expect(rows.visible).toEqual(["", " process", ...openCard(unpadded(plainRows(renderers, 78)), 80)]);
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
		expect(rows.visible[rows.body[0]!]).toBe(" process");
	});

	it("gives a custom self renderer without row locators its first call row as the header", () => {
		const renderers: ToolRenderers = {
			renderShell: "self",
			renderCall: () => new Text("custom call\ncustom arguments", 0, 0),
			renderResult: () => new Text("custom result", 0, 0),
		};
		const rows = boundaryRows(savedCall(renderers).render(80));

		expect(rows.counts).toEqual([1, 1, 1]);
		expect(rows.visible[rows.begin[0]!]).toBe(" custom call");
		expect(rows.visible[rows.body[0]!]).toBe(" custom call");
		expect(rows.visible).toEqual(["", " custom call", ...openCard(plainRows(renderers, 78), 80)]);
	});

	it("gives a completed self-rendered call with an empty result only its collapsed row", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderShell: "self", renderCall: () => new Text("custom call", 0, 0) },
			[],
			recording(contexts),
		);
		component.updateResult({ content: [], isError: false });
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " custom call"]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [1]]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("gives a call without a result only its collapsed row", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall({}, [], recording(contexts));
		component.updateResult({ content: [], isError: false });
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " process"]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [1]]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("gives a call whose result renderer draws no rows only its collapsed row", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderCall: () => new Text("custom call", 0, 0), renderResult: () => new Text("", 0, 0) },
			[],
			recording(contexts),
		);
		const rows = boundaryRows(component.render(80));

		expect(rows.visible).toEqual(["", " custom call"]);
		expect(rows.counts).toEqual([1, 0, 1]);
		expect(contexts.at(-1)?.bodyRow).toBeUndefined();
	});

	it("keeps the image spacer and the image inside the fold body", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const shells: [ToolRenderers, number, number][] = [
				// The summary, the header without shell padding, the image spacer and the image.
				[{}, 1, 4],
				[{ renderShell: "self", renderCall: () => new Text("custom call", 0, 0) }, 1, 4],
			];
			for (const [renderers, begin, body] of shells) {
				const contexts: MessageRenderBoundaryContextV1[] = [];
				const component = savedCall(renderers, [], recording(contexts));
				component.updateResult({ content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false });
				const rendered = component.render(80);
				const rows = boundaryRows(rendered);

				expect([rows.begin, rows.body]).toEqual([[begin], [2]]);
				expect(rendered[body - 1]).toBe("");
				expect(rendered[body]).toContain("\x1b_G");
				expect(contexts.at(-1)?.bodyRow).toBe(2);
			}
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("uses the title summary when the call renderer draws no rows", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderCall: () => new Text("", 0, 0), renderResult: () => new Text("custom result", 0, 0) },
			[],
			recording(contexts),
		);
		const rows = boundaryRows(component.render(80));

		// A call without call rows opens to its card, without a header row.
		expect(rows.visible).toEqual(["", " process", ...openCard(["", "", " custom result"], 80).slice(1)]);
		expect(rows.counts).toEqual([1, 1, 1]);
		expect([rows.begin, rows.end]).toEqual([[1], [4]]);
		expect(contexts.at(-1)?.bodyRow).toBe(2);
		// The title has no stock row, so it stays as the header of the open Fold.
		expect(contexts.at(-1)?.summaryRow).toBeUndefined();
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

	it("gives a summary row only at the begin row before a body that starts on the next row", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const decorators = [
			(context: Readonly<MessageRenderBoundaryContextV1>) => {
				contexts.push(context);
				return controls;
			},
		];
		const lines = () => ["a", "b", "c", "d"];

		decorateMessageRenderV2(lines(), 2, 80, "tool", 0, { entryId: "t", beginRow: 1, summaryRow: 1, decorators });
		decorateMessageRenderV2(lines(), 3, 80, "tool", 0, { entryId: "t", beginRow: 1, summaryRow: 1, decorators });
		decorateMessageRenderV2(lines(), 2, 80, "tool", 0, { entryId: "t", beginRow: 1, summaryRow: 0, decorators });
		decorateMessageRenderV2(lines(), undefined, 80, "tool", 0, {
			entryId: "t",
			beginRow: 1,
			summaryRow: 1,
			decorators,
		});

		expect(contexts.map((context) => context.summaryRow)).toEqual([1, undefined, undefined, undefined]);
	});

	it("keeps the located rows of a renderer that has row locators while the call is ready and when it settles", () => {
		const ready = boundaryRows(tool("tool-located").render(80));
		const component = tool("tool-located");
		component.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
		const settled = boundaryRows(component.render(80));

		for (const rows of [ready, settled]) {
			expect(rows.counts).toEqual([1, 1, 1]);
			expect(rows.visible[rows.begin[0]!]).toBe(" stock header");
			expect(rows.visible[rows.body[0]!]).toBe(" stock header");
		}
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

	it("gives a closed one-call group the rows of its running call, with no group range or member separator", () => {
		const child = tool("tool-only");
		child.markExecutionStarted();
		child.updateResult({ content: [{ type: "text", text: "partial" }], isError: false }, true);
		const group = new ToolGroupComponent({
			groupId: "tool-group:tool-only",
			closed: true,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		group.addTool(child, { toolName: "custom_tool", toolCallId: "tool-only" });

		expect(group.render(80)).toEqual(child.render(80));
	});
});

/** A completed call of a tool without a definition, with a result. */
function unknownCall(id: string, selectors: MessageRenderBoundarySelectorV3[] = [summaryAware]) {
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
function foldedBuiltIn(
	name: string,
	renderers: ToolRenderers,
	args: object,
	output: string,
	selectors: MessageRenderBoundarySelectorV3[] = [summaryAware],
) {
	const component = new ToolExecutionComponent(
		name,
		`call-${name}`,
		args,
		{
			ownerEntryId: "assistant-a",
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: selectors,
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

/**
 * The rows that native shows when each Fold that [collapsed] selects hides its body through its end row. An open Fold
 * whose begin row is a summary of its header hides that summary row.
 */
function foldedRows(rows: string[], collapsed: (depth: number) => boolean): string[] {
	const open: { body?: number; depth: number; summary?: number }[] = [];
	const hidden = new Set<number>();
	rows.forEach((row, index) => {
		const controlsInRow = [...row.matchAll(/\x1b\]777;(begin-summary|begin|body|end)\x07/g)].map((match) => match[1]);
		for (const control of controlsInRow) {
			if (control === "begin") open.push({ depth: open.length });
			else if (control === "begin-summary") open.push({ depth: open.length, summary: index });
			else if (control === "body") {
				const fold = [...open].reverse().find((candidate) => candidate.body === undefined);
				if (fold) fold.body = index;
			} else {
				const fold = open.pop();
				if (fold?.body === undefined) continue;
				if (!collapsed(fold.depth)) {
					if (fold.summary !== undefined) hidden.add(fold.summary);
					continue;
				}
				for (let hiddenRow = fold.body; hiddenRow <= index; hiddenRow++) hidden.add(hiddenRow);
			}
		}
	});
	return rows.flatMap((row, index) => {
		if (hidden.has(index)) return [];
		// The card frame of an open call is no content: its border rows drop, and a card row shows its inner text.
		const visible = stripAnsi(row.replaceAll(EDIT_POINT, ""));
		if (/^\s*[╭╰]─*[╮╯]\s*$/.test(visible)) return [];
		const text = cardInner(visible).trim();
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

	it.each([false, true])("opens a saved read with stock result visibility at Pi expanded=%s", (expanded) => {
		const component = readCall();
		component.setExpanded(expanded);
		const rows = foldedRows(component.render(80), () => false);

		expect(rows).toContain("read a.md");
		expect(rows.includes("line 1")).toBe(expanded);
		expect(rows.includes("line 2")).toBe(expanded);
	});

	it("gives a located call whose result draws no rows no foldable body", () => {
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

	it.each([false, true])("keeps a long write call body at the stock Pi expanded=%s state", (expanded) => {
		const component = foldedBuiltIn(
			"write",
			withBuiltInRenderers("write", createWriteToolDefinition(process.cwd()) as unknown as ToolRenderers)!,
			{ path: "notes.txt", content: numbered("note", 40) },
			"Wrote notes.txt",
		);
		component.setExpanded(expanded);
		const rows = component.render(80);
		const open = foldedRows(rows, () => false).join("\n");

		expect(foldedRows(rows, () => true)).toHaveLength(2);
		expect(open).toContain("note-0");
		expect(open.includes("note-39")).toBe(expanded);
		expect(open.includes("30 more lines")).toBe(!expanded);
	});

	it.each([false, true])("opens a padded call to its stock rows without padding with result=%s", (hasResult) => {
		const renderers = { renderCall: () => new Text("Process: list", 0, 0) };
		const create = (folding: boolean) =>
			new ToolExecutionComponent(
				"process",
				"call-padding",
				{},
				folding
					? {
							producerSessionId: "session-a",
							renderScopeId: "scope-a",
							semanticSelectorsV3: [summaryAware],
						}
					: {},
				renderers,
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
		const stock = create(false);
		const folded = create(true);
		for (const component of [stock, folded]) {
			component.updateResult({ content: hasResult ? [{ type: "text", text: "result" }] : [], isError: false });
		}
		const rows = folded.render(40);
		const open = hasResult ? ["", "Process: list", "result"] : ["", "Process: list"];
		expect(unpadded(foldedRows(stock.render(40), () => false))).toEqual(open);
		expect(foldedRows(rows, () => false)).toEqual(open);
		expect(foldedRows(rows, () => true)).toEqual(["", "Process: list"]);
		expect(rows[1]!.includes(summaryBegin)).toBe(hasResult);
		expect(boundaryRows(rows).body).toEqual(hasResult ? [2] : []);
	});

	it("opens a long built-in header to the exact stock wrapping at the inner width of its card", () => {
		const path = `src/${"segment/".repeat(12)}Long.kt`;
		const stock = new ToolExecutionComponent(
			"edit",
			"call-edit",
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			{},
			editRenderersFor(),
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		stock.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
		const folded = foldedBuiltIn("edit", editRenderersFor(), { path, edits: [{ oldText: "a", newText: "b" }] }, "ok");
		for (const width of [40, 200, 40]) {
			expect(foldedRows(folded.render(width), () => false)).toEqual(
				unpadded(foldedRows(stock.render(width - 2), () => false)),
			);
		}
	});

	it.each([
		["without result", {}, [], false, false],
		["short result", {}, [{ type: "text", text: "short output" }], false, false],
		["long result", {}, [{ type: "text", text: numbered("output", 40) }], false, false],
		["error", {}, [{ type: "text", text: "failed output" }], true, false],
		["cancelled", {}, [], false, true],
		[
			"long built-in path",
			{ path: `src/${"directory/".repeat(12)}Long.kt`, edits: [{ oldText: "a", newText: "b" }] },
			[{ type: "text", text: "ok" }],
			false,
			false,
		],
		["short Edit diff", { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] }, [], false, false],
		["multi-hunk Edit diff", { path: "src/a.ts", edits: [{ oldText: "old", newText: "new" }] }, [], false, false],
		["pi-processes container shape", {}, [{ type: "text", text: "process output" }], false, false],
	] as const)(
		"opens %s to its header and byte-identical stock rows in its card",
		(name, args, content, isError, cancelled) => {
			const isEdit = "path" in args;
			const renderers: ToolRenderers = isEdit
				? editRenderersFor()
				: {
						renderCall: () => {
							if (name !== "pi-processes container shape")
								return new Text("Process: list arguments that wrap at a narrow width", 0, 0);
							const container = new Container();
							container.addChild(new Text(theme.fg("toolTitle", "Process: start render checks"), 0, 0));
							container.addChild(new Text(theme.fg("muted", "npm run check"), 0, 0));
							return container;
						},
					};
			const create = (folding: boolean) => {
				const component = new ToolExecutionComponent(
					isEdit ? "edit" : "process",
					"styled-parity",
					args,
					folding
						? { producerSessionId: "session-a", renderScopeId: "scope-a", semanticSelectorsV3: [summaryAware] }
						: {},
					renderers,
					{ requestRender() {} } as unknown as TUI,
					process.cwd(),
				);
				component.setExpanded(true);
				if (cancelled) component.markCancelled("Operation aborted");
				else
					component.updateResult({
						content: [...content],
						isError,
						details:
							name === "short Edit diff"
								? { diff: "-1 old\n+1 new" }
								: name === "multi-hunk Edit diff"
									? {
											diff: " 1 context\n-2 old\n+2 new\n 3 context\n...\n 20 context\n-21 other\n+21 changed",
										}
									: undefined,
					});
				return component;
			};
			const stock = create(false);
			const folded = create(true);
			for (const width of [24, 40, 80, 200]) {
				expect(foldedRows(folded.render(width), () => true)).toHaveLength(2);
				const rendered = folded.render(width);
				const rows = rendered
					.filter((row) => !row.includes(summaryBegin))
					.map((row) => Object.values(controls).reduce((text, control) => text.replaceAll(control, ""), row));
				// A call whose stock rows are only its header has no body to open.
				if (!rendered.some((row) => row.includes(controls.body))) {
					expect(unpadded(stock.render(width))).toHaveLength(2);
					continue;
				}
				// The card rows hold the stock rows at the inner width of the card, byte for byte, between the frame cells.
				expect(openCardParts(rows, folded.outcome === "failed")).toEqual(
					stockCardParts(unpadded(stock.render(width - 2)), width - 2),
				);
			}
		},
	);

	describe("stock output expansion inside an open Tool Call", () => {
		const openStyledRows = (rows: string[]) =>
			rows
				.filter((row) => !row.includes(summaryBegin))
				.map((row) =>
					[...Object.values(controls), EDIT_POINT].reduce((text, control) => text.replaceAll(control, ""), row),
				);

		for (const kind of ["bash", "fallback"] as const) {
			for (const partial of [false, true]) {
				it.each([false, true])(
					`opens the stock ${kind} ${partial ? "partial" : "settled"} output with Pi expanded=%s`,
					(expanded) => {
						const renderers =
							kind === "bash"
								? withBuiltInRenderers(
										"bash",
										createBashToolDefinition(process.cwd()) as unknown as ToolRenderers,
									)
								: { renderCall: () => new Text("fallback call", 0, 0) };
						const create = (folding: boolean) => {
							const component = new ToolExecutionComponent(
								kind,
								"call-preview",
								{ command: "printf output" },
								{
									ownerEntryId: "assistant-a",
									producerSessionId: "session-a",
									renderScopeId: "scope-a",
									semanticSelectorsV3: folding ? [summaryAware] : [],
									toolExecutionPresentationSelectorsV1: [settledCanonicalOnly],
								},
								renderers,
								{ requestRender() {} } as unknown as TUI,
								process.cwd(),
							);
							component.setExpanded(expanded);
							component.updateResult(
								{ content: [{ type: "text", text: numbered("output", 40) }], isError: false },
								partial,
							);
							return component;
						};
						const stock = create(false);
						const folded = create(true);
						for (const width of [24, 80, 160]) {
							const rows = folded.render(width);
							expect(rows[1]).toContain(summaryBegin);
							expect(openCardParts(openStyledRows(rows), false)).toEqual(
								stockCardParts(unpadded(stock.render(width - 2)), width - 2),
							);
						}
						const text = foldedRows(folded.render(80), () => false).join("\n");
						expect(text.includes("output-20")).toBe(expanded);
						if (kind === "bash") {
							expect(text.includes("output-0")).toBe(expanded);
							expect(text).toContain("output-39");
							expect(text.includes("35 earlier lines")).toBe(!expanded);
						} else {
							expect(text).toContain("output-0");
							expect(text).toContain("output-9");
							expect(text.includes("output-39")).toBe(expanded);
							expect(text.includes("30 more lines")).toBe(!expanded);
						}
					},
				);
			}
		}

		it("rebuilds stock preview, full output and preview with current semantic boundaries", () => {
			const candidates: MessageRenderBoundaryCandidateV3[] = [];
			const contexts: MessageRenderBoundaryContextV1[] = [];
			const points: MessageRenderSourcePointV1[] = [];
			const renderers = withBuiltInRenderers(
				"bash",
				createBashToolDefinition(process.cwd()) as unknown as ToolRenderers,
			);
			const create = (folding: boolean) => {
				const component = new ToolExecutionComponent(
					"bash",
					"call-expansion",
					{ command: "printf output" },
					{
						ownerEntryId: "assistant-a",
						producerSessionId: "session-a",
						renderScopeId: "scope-a",
						sourcePointRevisions: new SourcePointRevisions(),
						semanticSelectorsV3: folding
							? [
									(candidate) => {
										candidates.push(candidate);
										return (context) => {
											contexts.push(context);
											return { ...controls, begin: summaryBegin };
										};
									},
								]
							: [],
						sourcePointDecoratorsV1: folding
							? [
									(point) => {
										points.push(point);
										return EDIT_POINT;
									},
								]
							: [],
						toolExecutionPresentationSelectorsV1: [admitCompact],
					},
					renderers,
					{ requestRender() {} } as unknown as TUI,
					process.cwd(),
				);
				component.updateResult({ content: [{ type: "text", text: numbered("output", 40) }], isError: false });
				return component;
			};
			const stock = create(false);
			const folded = create(true);
			const renders = [false, true, false].map((expanded) => {
				stock.setExpanded(expanded);
				folded.setExpanded(expanded);
				points.length = 0;
				const rows = folded.render(80);
				expect(openCardParts(openStyledRows(rows), false)).toEqual(stockCardParts(unpadded(stock.render(78)), 78));
				const boundaries = boundaryRows(rows);
				expect(boundaries.counts).toEqual([1, 1, 1]);
				expect([boundaries.begin, boundaries.body, boundaries.end]).toEqual([[1], [2], [rows.length - 1]]);
				expect(contexts.at(-1)).toMatchObject({
					entryId: "call-expansion",
					ownerEntryId: "assistant-a",
					role: "tool",
					summaryRow: 1,
					bodyRow: 2,
					allocatedColumns: { start: 0, end: 80 },
					stockRows: { start: 0, end: rows.length },
				});
				expect(points.some((point) => point.sourcePart === undefined)).toBe(expanded);
				for (const point of points) {
					expect(point).toMatchObject({
						entryId: "call-expansion",
						ownerEntryId: "assistant-a",
						producerSessionId: "session-a",
						renderScopeId: "scope-a",
						blockId: "call-expansion",
						foldRole: "tool",
						sourcePointRevision: contexts.at(-1)!.sourcePointRevision,
					});
				}
				expect(foldedRows(rows, () => true)).toEqual(["", "$ printf output"]);
				const open = foldedRows(rows, () => false).join("\n");
				expect(open.includes("output-0")).toBe(expanded);
				expect(open.includes("35 earlier lines")).toBe(!expanded);
				expect(open).toContain("output-39");
				return rows;
			});
			expect(candidates).toEqual([
				{
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					entryId: "call-expansion",
					blockId: "call-expansion",
					ownerEntryId: "assistant-a",
					role: "tool",
					state: "expanded",
				},
			]);
			expect(contexts.map((context) => context.sourcePointRevision)).toEqual([1, 2, 3]);
			expect(renders[1]!.length).toBeGreaterThan(renders[0]!.length);
			expect(openStyledRows(renders[2]!)).toEqual(openStyledRows(renders[0]!));
		});
	});

	it("keeps source points on canonical content after the summary", () => {
		const rows = savedCall(undefined).render(80);
		expect(rows[1]).toContain(summaryBegin);
		expect(rows[1]).not.toContain(EDIT_POINT);
		expect(rows[2]).toContain(EDIT_POINT);
		expect(stripAnsi(rows[2]!)).toContain("process");
	});

	it("shows a container call name once in the open Fold", () => {
		const rows = savedCall({
			renderCall: () => {
				const container = new Container();
				container.addChild(new Text("Process: list", 0, 0));
				container.addChild(new Text("arguments", 0, 0));
				return container;
			},
		}).render(40);
		expect(foldedRows(rows, () => false)).toEqual(["", "Process: list", "arguments", "process output"]);
		expect(foldedRows(rows, () => true)).toEqual(["", "Process: list"]);
		expect(rows[1]).toContain(summaryBegin);
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

	it("shows a collapsed built-in edit with a long path as one row that keeps its file name", () => {
		const path = `../jetbrains-terminal_worktrees/semantic-resize-r0/src/uiTest/kotlin/${"segment/".repeat(4)}Long.kt`;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const rows = component.render(60);

		expect(foldedRows(rows, () => true)).toEqual(["", expect.stringMatching(/^edit .*…\/Long\.kt$/)]);
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

	it("opens a built-in edit with a long path to its stock header on the summary row", () => {
		const path = `../jetbrains-terminal_worktrees/semantic-resize-r0/src/uiTest/kotlin/${"segment/".repeat(4)}Long.kt`;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const open = foldedRows(component.render(60), () => false);

		expect(open.slice(0, 2)).toEqual(["", "edit"]);
		expect(open.filter((row) => row.endsWith("…"))).toEqual([]);
		expect(open.join("").split("Long.kt")).toHaveLength(2);
		expect(foldedRows(component.render(60), () => true)).toEqual(["", expect.stringMatching(/^edit .*…\/Long\.kt$/)]);
	});

	it("opens a call without a definition and a long first line to its complete call without the summary", () => {
		const component = new ToolExecutionComponent(
			"a_tool_name_that_wraps_at_a_narrow_width",
			"call-long-name",
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [summaryAware],
			},
			undefined,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "long name output" }], isError: false });
		const open = foldedRows(component.render(24), () => false);

		expect(open.filter((row) => row.endsWith("…"))).toEqual([]);
		expect(open.join("").split("a_tool_name_that_wraps")).toHaveLength(2);
	});

	it("marks the first row of an opaque call renderer as a summary hidden in the open Fold", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{
				renderShell: "self",
				renderCall: () => ({ render: () => ["opaque call row"], invalidate() {} }),
				renderResult: () => new Text("opaque result", 0, 0),
			},
			[],
			recording(contexts),
		);
		component.render(80);

		expect(contexts.map((context) => context.summaryRow)).toEqual([1]);
	});

	it("gives the decorator the summary row of a Text call part whose first line does not fit", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const component = savedCall(
			{ renderCall: () => new Text(`process ${"argument ".repeat(8)}`, 0, 0) },
			[],
			recording(contexts),
		);
		component.render(40);

		expect(contexts.map((context) => context.summaryRow)).toEqual([1]);
	});

	it("marks the compact row of a wrapped header as a summary and gives a fitting header without a body no Fold", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const fits = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		const long = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path: `src/${"segment/".repeat(12)}Long.kt`, edits: [{ oldText: "a", newText: "b" }] },
			"ok",
		);
		for (const component of [fits, long]) {
			(component as unknown as { semanticDecoratorsV2: unknown[] }).semanticDecoratorsV2 = [
				(context: MessageRenderBoundaryContextV1) => {
					contexts.push(context);
					return controls;
				},
			];
			component.render(60);
		}

		expect(contexts.map((context) => [context.summaryRow, context.bodyRow])).toEqual([
			[undefined, undefined],
			[1, 2],
		]);
	});

	it("summarizes a failed built-in edit with a long path in one row with its cue and opens it to one header", () => {
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path: `src/${"segment/".repeat(12)}Long.kt`, edits: [{ oldText: "a", newText: "b" }] },
			"no",
		);
		component.updateResult({ content: [{ type: "text", text: "no" }], isError: true });
		const rows = component.render(60);
		const open = foldedRows(rows, () => false);

		expect(foldedRows(rows, () => true)).toEqual(["", expect.stringMatching(/^edit src\/.*…\/Long\.kt Failed$/)]);
		expect([open.filter((row) => row.startsWith("edit")).length, open.join("").split("Long.kt").length]).toEqual([
			1, 2,
		]);
	});

	it("summarizes a failed built-in edit whose header fits only without its cue", () => {
		const path = "src/a.ts";
		const width = visibleWidth(`edit ${path}`) + 2;
		const component = foldedBuiltIn(
			"edit",
			editRenderersFor(),
			{ path, edits: [{ oldText: "a", newText: "b" }] },
			"no",
		);
		component.updateResult({ content: [{ type: "text", text: "no" }], isError: true });
		const rows = component.render(width);

		// The open header wraps at the inner width of the card, like the rest of the call, so no text repeats or is lost.
		expect([foldedRows(rows, () => true), foldedRows(rows, () => false).join(" ")]).toEqual([
			["", expect.stringMatching(/…/)],
			expect.stringMatching(new RegExp(`^ edit Failed ${path}`)),
		]);
	});

	describe("keeps summary outcome cues without changing stock outcome rows", () => {
		function openStyledRows(rows: string[]): string[] {
			return rows
				.filter((row) => !row.includes(summaryBegin))
				.map((row) => Object.values(controls).reduce((text, control) => text.replaceAll(control, ""), row));
		}
		const edit = (path: string) => (folding: boolean) => {
			const component = new ToolExecutionComponent(
				"edit",
				"call-edit",
				{ path, edits: [{ oldText: "a", newText: "b" }] },
				{
					ownerEntryId: "assistant-a",
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					semanticSelectorsV3: folding ? [summaryAware] : [],
					toolExecutionPresentationSelectorsV1: [admitCompact],
				},
				editRenderersFor(),
				{ requestRender() {} } as unknown as TUI,
				process.cwd(),
			);
			component.updateResult({ content: [{ type: "text", text: "no" }], isError: false });
			return component;
		};
		const shaded = (text: string) => `\x1b[48;5;236m${text}\x1b[49m`;
		const headers = [
			{
				name: "a long built-in edit",
				width: 60,
				label: "Long.kt",
				create: edit(`src/${"segment/".repeat(12)}Long.kt`),
			},
			{ name: "a built-in edit that fits only without its cue", width: 15, label: "a.ts", create: edit("src/a.ts") },
			{
				name: "a narrow built-in edit with CJK",
				width: 30,
				label: "長い.kt",
				create: edit(`src/${"文件夹/".repeat(6)}長い.kt`),
			},
			{
				name: "a self-rendered Text call part with its own colors",
				width: 40,
				label: "argument-end",
				create: (folding: boolean) =>
					savedCall(
						{
							renderShell: "self",
							renderCall: () => new Text(`process ${"argument ".repeat(6)}argument-end`, 0, 0, shaded),
						},
						[],
						folding ? [summaryAware] : [],
					),
			},
			{
				name: "a call without a definition",
				width: 24,
				label: "wraps_at_a_narrow",
				create: (folding: boolean) =>
					new ToolExecutionComponent(
						"a_tool_name_that_wraps_at_a_narrow_width",
						"call-long-name",
						{ action: "list" },
						{
							ownerEntryId: "assistant-a",
							producerSessionId: "session-a",
							renderScopeId: "scope-a",
							semanticSelectorsV3: folding ? [summaryAware] : [],
						},
						undefined,
						{ requestRender() {} } as unknown as TUI,
						process.cwd(),
					),
			},
		];
		const outcomes = [
			{
				cue: "Failed",
				settle: (component: ToolExecutionComponent) =>
					component.updateResult({ content: [{ type: "text", text: "no" }], isError: true }),
			},
			{ cue: "Cancelled", settle: (component: ToolExecutionComponent) => component.markCancelled("aborted") },
		];
		for (const header of headers) {
			for (const outcome of outcomes) {
				it(`${outcome.cue}: ${header.name}`, () => {
					const component = header.create(true);
					const stock = header.create(false);
					outcome.settle(component);
					outcome.settle(stock);
					const rows = component.render(header.width);
					// The cue ends the header row, so it can sit between the two rows of a wrapped label.
					const open = foldedRows(rows, () => false)
						.map(withoutOutcomeCue)
						.join("");
					const stockRows = stock.render(header.width);
					expect(stockRows.join("")).not.toContain(summaryBegin);
					expect(foldedRows(rows, () => true)[1]?.endsWith(outcome.cue)).toBe(true);
					// A call whose stock rows are only its header has no body to open.
					if (!rows.some((row) => row.includes(controls.body))) {
						expect(unpadded(stockRows)).toHaveLength(2);
						return;
					}
					expect({
						summaryHiddenWhenOpen: !open.includes("…"),
						canonical: open.split(header.label).length - 1,
					}).toEqual({ summaryHiddenWhenOpen: true, canonical: 1 });
					expect(openCardParts(openStyledRows(rows), outcome.cue === "Failed")).toEqual(
						stockCardParts(unpadded(stock.render(header.width - 2)), header.width - 2),
					);
				});
			}
		}
		for (const header of [headers[1]!, headers[3]!, headers[4]!]) {
			it(`keeps the stock outcome rows of ${header.name} from wide to narrow to wide`, () => {
				const component = header.create(true);
				const stock = header.create(false);
				outcomes[0]!.settle(component);
				outcomes[0]!.settle(stock);
				for (const width of [120, header.width, 120]) {
					const rows = component.render(width);
					expect(foldedRows(rows, () => true).join("")).toContain("Failed");
					const stockRows = stock.render(width - 2);
					expect(stockRows.join("")).not.toContain(summaryBegin);
					expect(openCardParts(openStyledRows(rows), true)).toEqual(
						stockCardParts(unpadded(stockRows), width - 2),
					);
				}
			});
		}
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
			const rows = component.render(width).map((row) => row.replaceAll(summaryBegin, controls.begin));
			const begin = boundaryRows(rows).begin[0]!;
			return { row: rows[begin]!, body: boundaryRows(rows).body[0], begin, collapsed: foldedRows(rows, () => true) };
		};

		const narrow = summary(40);
		const wide = summary(200);
		const again = summary(40);

		expect(narrow.collapsed).toEqual(["", expect.stringMatching(/^edit .*…\/Long\.kt$/)]);
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
		["a short", "opaque_tool", 80, /^opaque first row that may continue$/],
		["a long", "an_opaque_tool_name_that_does_not_fit", 24, /^opaque first row.*…$/],
	] as const)(
		"shows the first rendered row of an opaque call renderer for %s name",
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
			false,
		],
		["a call without a result renderer with folding off", false, { renderCall: () => new Text("call", 0, 0) }, false],
		["a call of a tool without a definition under native folding", true, undefined, true],
	] as const)("keeps the stock output of %s when Pi output is collapsed", (_name, folded, renderers, complete) => {
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
	});

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

	it("shows an expanded Tool Group with collapsed children as its header and its children right below it", () => {
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

		// The calls of an open group follow its header without separator rows, indented under it.
		const rows = group.render(80);
		expect(foldedRows(rows, (depth) => depth > 0)).toEqual(["", "$ Used tools", "process", "process"]);
		expect(boundaryRows(rows).visible[2]).toBe("   process");
	});
});

describe("Tool Call and Tool Group outcomes", () => {
	/** The opening sequence of a theme background, from the current theme. */
	const background = (token: "toolErrorBg" | "toolPendingBg") => theme.bg(token, "\0").split("\0")[0]!;
	/** The row that the range of the call begins on: the row that a collapsed Fold shows. */
	const headerRow = (rows: string[]) => rows.find((row) => row.includes(controls.begin)) ?? "";
	const call = (id: string, toolDefinition?: ToolDefinition) =>
		new ToolExecutionComponent(
			"process",
			id,
			{ action: "list" },
			{
				ownerEntryId: "assistant-a",
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				semanticSelectorsV3: [() => () => controls],
				toolExecutionPresentationSelectorsV1: [settledCanonicalOnly],
			},
			toolDefinition,
			{ requestRender() {} } as unknown as TUI,
			process.cwd(),
		);

	for (const themeName of ["dark", "light"] as const) {
		describe(`in the ${themeName} theme`, () => {
			beforeAll(() => initTheme(themeName));

			it.each([
				["a tool without a definition", undefined],
				["a self-rendered tool", definition()],
			] as const)(
				"shows the failure of a call of %s on its collapsed header row with the theme error cue",
				(_name, toolDefinition) => {
					const component = call("call-failed", toolDefinition);
					component.updateResult({ content: [{ type: "text", text: "no such file" }], isError: true });
					const header = headerRow(component.render(80));
					const errorText = theme.fg("error", "\0").split("\0")[0]!;

					expect({
						cue: stripAnsi(header).includes("Failed") && header.includes(errorText),
						// A collapsed call has no background; only its cue has the error color.
						background: header.includes("\x1b[48;"),
						outcome: component.outcome,
					}).toEqual({ cue: true, background: false, outcome: "failed" });
				},
			);

			it("marks a call cancelled before execution with a Cancelled cue and no error background", () => {
				const component = call("call-cancelled");
				component.markCancelled("Operation aborted");
				const rows = component.render(80);

				expect({
					cue: stripAnsi(headerRow(rows)).includes("Cancelled"),
					error: rows.some((row) => row.includes(background("toolErrorBg"))),
					outcome: component.outcome,
					reason: stripAnsi(rows.join("\n")).includes("Operation aborted"),
				}).toEqual({ cue: true, error: false, outcome: "cancelled", reason: true });
			});

			/** A self-rendered call whose call part is one Text: its first row is its canonical header. */
			const textCall = (id: string, callText: string, located = false) =>
				call(id, {
					...definition(),
					renderCall: () => new Text(callText, 0, 0),
					getRenderCallHeaderRow: located ? () => 0 : undefined,
					getRenderCallBodyRow: located ? () => 1 : undefined,
				} as ToolDefinition);
			const width = 40;
			const fitting = "/workspace/project/src/modules/a-file.ts".slice(0, width);

			it.each([
				["a plain path", () => fitting, false],
				// Four wide characters take eight columns, so the path takes exactly the width.
				["a path of wide characters", () => "路径目录".repeat(width / 8), false],
				["a styled path", () => theme.fg("accent", fitting), false],
				["a path that the renderer locates as its header row", () => `${fitting}\nstock preview`, true],
			] as const)(
				"keeps %s of a failed call that just fits and shows the cue within the width",
				(_name, text, located) => {
					const callText = text();
					const component = textCall("call-path", callText, located);
					component.updateResult({ content: [{ type: "text", text: "no such file" }], isError: true });
					const rows = component.render(width);
					const firstLine = stripAnsi(callText.split("\n")[0]!);

					// The open header and the card wrap at the inner width of the card: the line can continue in the card.
					const openText = rows
						.map((row) => stripAnsi(row.replace(/\x1b\]777;[^\x07]*\x07/g, "")))
						.filter((row) => !/^\s*[╭╰]─*[╮╯]\s*$/.test(row))
						.map((row) => withoutOutcomeCue(cardInner(row).trim()))
						.join("");
					expect({
						cue: stripAnsi(headerRow(rows)).includes("Failed"),
						kept: openText.includes(firstLine),
						widths: rows.every((row) => visibleWidth(row) <= width),
					}).toEqual({ cue: true, kept: true, widths: true });
				},
			);

			it("adds the cue to a located header row that has room, without a new row", () => {
				const plain = textCall("call-room", "stock header\nstock preview", true);
				plain.updateResult({ content: [{ type: "text", text: "done" }], isError: false });
				const failed = textCall("call-room", "stock header\nstock preview", true);
				failed.updateResult({ content: [{ type: "text", text: "done" }], isError: true });
				const header = stripAnsi(headerRow(failed.render(width)));

				expect([header.includes("stock header"), header.includes("Failed"), failed.render(width).length]).toEqual([
					true,
					true,
					plain.render(width).length,
				]);
			});

			// The compact cue needs two columns after one column of content. The frame of every collapsed call uses two more
			// columns, so a call shows a cue from a width of five columns.
			it.each([5, 6, 7, 8, 9, 10, 12])(
				"keeps a failed and a cancelled call identifiable within every row at width %i",
				(narrow) => {
					const shells: (ToolDefinition | undefined)[] = [
						undefined,
						{ ...definition(), renderCall: () => new Text("stock header", 0, 0) } as ToolDefinition,
						{
							...definition(),
							renderShell: "default",
							renderCall: () => new Text("stock header", 0, 0),
							getRenderCallHeaderRow: undefined,
							getRenderCallBodyRow: undefined,
						} as ToolDefinition,
					];
					const cues = shells.flatMap((shell) => {
						const failed = call("call-narrow", shell);
						failed.updateResult({ content: [{ type: "text", text: "no" }], isError: true });
						const cancelled = call("call-narrow", shell);
						cancelled.markCancelled("Operation aborted");
						return [failed, cancelled].map((component) => {
							const rows = component.render(narrow);
							const header = stripAnsi(headerRow(rows));
							return {
								widths: rows.every((row) => visibleWidth(row) <= narrow),
								cue: /Failed|✗|Cancelled|⊘/.test(header),
							};
						});
					});

					expect(cues.every((cue) => cue.widths && cue.cue)).toBe(true);
				},
			);

			// At one column the stock Box itself renders two columns, with or without a cue.
			it.each([2, 3, 4])("keeps every row of a failed call in a padded stock shell within width %i", (narrow) => {
				const component = call("call-tiny", {
					...definition(),
					renderShell: "default",
					renderCall: () => new Text("stock header", 0, 0),
					getRenderCallHeaderRow: undefined,
					getRenderCallBodyRow: undefined,
				} as ToolDefinition);
				component.updateResult({ content: [{ type: "text", text: "no" }], isError: true });

				expect(component.render(narrow).every((row) => visibleWidth(row) <= narrow)).toBe(true);
			});

			it.each([30, 12])("keeps the failed count of a group with a long combined label at width %i", (groupWidth) => {
				const group = new ToolGroupComponent({
					groupId: "tool-group:call-a",
					closed: false,
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					semanticSelectorsV3: [() => () => controls],
				});
				for (const [index, toolName] of ["read", "bash", "edit", "write", "grep", "find"].entries()) {
					const member = call(`call-${index}`);
					member.updateResult({ content: [{ type: "text", text: "x" }], isError: index === 0 });
					group.addTool(member, { toolName, toolCallId: `call-${index}` });
				}
				const header = headerRow(group.render(groupWidth));

				expect([stripAnsi(header).trimEnd().endsWith("1 failed"), visibleWidth(header) <= groupWidth]).toEqual([
					true,
					true,
				]);
			});

			it("counts the failed calls of a group once in its header, without cancelled calls", () => {
				const group = new ToolGroupComponent({
					groupId: "tool-group:call-a",
					closed: false,
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					semanticSelectorsV3: [() => () => controls],
				});
				const failed = call("call-a");
				failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
				const cancelled = call("call-b");
				cancelled.markCancelled("Operation aborted");
				group.addTool(failed, { toolName: "bash", toolCallId: "call-a" });
				group.addTool(cancelled, { toolName: "bash", toolCallId: "call-b" });
				const header = () => stripAnsi(headerRow(group.render(80)));
				const first = header();
				const later = call("call-c");
				later.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
				group.addTool(later, { toolName: "bash", toolCallId: "call-c" });

				expect([first.includes("1 failed"), header().includes("1 failed"), header().includes("2 failed")]).toEqual([
					true,
					true,
					false,
				]);
			});

			it("shows a faint group label and its failed count in the error color without faint", () => {
				const group = new ToolGroupComponent({
					groupId: "tool-group:call-a",
					closed: true,
					producerSessionId: "session-a",
					renderScopeId: "scope-a",
					semanticSelectorsV3: [() => () => controls],
				});
				const failed = call("call-a");
				failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
				const done = call("call-b");
				done.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
				group.addTool(failed, { toolName: "bash", toolCallId: "call-a" });
				group.addTool(done, { toolName: "bash", toolCallId: "call-b" });
				const header = headerRow(group.render(80));
				const cue = header.slice(header.lastIndexOf("\x1b[22m"));

				expect({
					label: header.includes(theme.faint("$ Ran commands")),
					cue: cue.includes(theme.fg("error", " · 1 failed")) && !cue.includes("\x1b[2m"),
				}).toEqual({ label: true, cue: true });
			});

			it("frames the card of an open failed call in the error color and a successful call in the border color", () => {
				const failed = call("call-a");
				failed.updateResult({ content: [{ type: "text", text: "boom" }], isError: true });
				const done = call("call-b");
				done.updateResult({ content: [{ type: "text", text: "ok" }], isError: false });
				const corner = (component: ToolExecutionComponent) =>
					component.render(40).find((row) => stripAnsi(row).startsWith("╭"));

				expect([corner(failed)?.startsWith(theme.fg("error", "╭").slice(0, -5)), corner(done)]).toEqual([
					true,
					expect.stringContaining(theme.fg("border", "╭").slice(0, -5)),
				]);
			});
		});
	}
});

describe("theme faint text", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["a compound normal-intensity reset", "a\x1b[22;39mb", "\x1b[2ma\x1b[22;39m\x1b[2mb\x1b[22m"],
		["a compound full reset", "a\x1b[0;31mb", "\x1b[2ma\x1b[0;31m\x1b[2mb\x1b[22m"],
		["an RGB color whose values contain 0 and 22", "a\x1b[38;2;0;22;0mb", "\x1b[2ma\x1b[38;2;0;22;0mb\x1b[22m"],
	])("keeps text faint after %s", (_name, text, faint) => {
		expect(theme.faint(text)).toBe(faint);
	});

	it("keeps text faint after a reset and after the end of bold text inside it", () => {
		expect(theme.faint("a\x1b[1mb\x1b[22mc\x1b[0md")).toBe("\x1b[2ma\x1b[1mb\x1b[22m\x1b[2mc\x1b[0m\x1b[2md\x1b[22m");
	});
});

describe("Tool Call fold frame", () => {
	beforeAll(() => initTheme("dark"));

	/** The rendered row without the boundary and source point controls. */
	const withoutControls = (row: string) => row.replace(/\x1b\]777;[^\x07]*\x07/g, "");
	const builtIn = (name: string) => withBuiltInRenderers(name, undefined)!;
	const editArgs = { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] };
	const failedEdit = () => {
		const component = foldedBuiltIn("edit", editRenderersFor(), editArgs, "no");
		component.updateResult({ content: [{ type: "text", text: "no" }], isError: true });
		return component;
	};

	it.each([
		["read", () => foldedBuiltIn("read", builtIn("read"), { path: "a.md" }, "line 1\nline 2")],
		["bash", () => foldedBuiltIn("bash", builtIn("bash"), { command: "ls" }, "a.md")],
		["write", () => foldedBuiltIn("write", builtIn("write"), { path: "a.md", content: "note" }, "")],
		["edit", () => foldedBuiltIn("edit", editRenderersFor(), editArgs, "ok")],
		["find", () => foldedBuiltIn("find", builtIn("find"), { pattern: "*.ts" }, "a.ts")],
		["grep", () => foldedBuiltIn("grep", builtIn("grep"), { pattern: "x" }, "a.ts:1: x")],
		["ls", () => foldedBuiltIn("ls", builtIn("ls"), { path: "." }, "a.md")],
		[
			"a self Text call",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => new Text("custom call\ncustom arguments", 0, 0),
					renderResult: () => new Text("custom result", 0, 0),
				}),
		],
		[
			"a quiet self call",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => ({ render: () => [], invalidate() {} }),
					renderResult: () => new Text("hub reply", 0, 0),
				}),
		],
		[
			"an opaque self call",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => ({ render: () => ["opaque call row"], invalidate() {} }),
					renderResult: () => new Text("opaque result", 0, 0),
				}),
		],
		["a tool without a definition", () => savedCall(undefined)],
		["a failed edit", failedEdit],
	] as const)(
		"shows the collapsed row of %s with a one-cell indent, a faint title and no background",
		(_name, create) => {
			const row = withoutControls(create().render(60)[1]!);

			expect({
				background: row.includes("\x1b[48;"),
				faint: row.includes("\x1b[2m"),
				fits: visibleWidth(row) <= 60,
				text: stripAnsi(row),
			}).toEqual({ background: false, faint: true, fits: true, text: expect.stringMatching(/^ \S/) });
		},
	);
});

describe("stable Tool Call fold", () => {
	beforeAll(() => initTheme("dark"));

	const builtIn = (name: string) => withBuiltInRenderers(name, undefined)!;
	const editArgs = { path: `src/${"segment/".repeat(12)}Long.kt`, edits: [{ oldText: "a", newText: "b" }] };
	const blank = (row: string) => row === "" || row === "<shaded blank>";
	const firstWord = (row: string) => row.split(" ", 1)[0];

	const withBody = [
		[
			"an expanded read",
			() => {
				const component = readCall();
				component.setExpanded(true);
				return component;
			},
		],
		["a bash call with output", () => foldedBuiltIn("bash", builtIn("bash"), { command: "ls" }, "a.md\nb.md")],
		[
			"a write call with content",
			() => foldedBuiltIn("write", builtIn("write"), { path: "a.md", content: "note" }, ""),
		],
		["an edit with a wrapped header", () => foldedBuiltIn("edit", editRenderersFor(), editArgs, "ok")],
		[
			"a self Text call",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => new Text("custom call\ncustom arguments", 0, 0),
					renderResult: () => new Text("custom result", 0, 0),
				}),
		],
		[
			"a quiet self call with a result",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => ({ render: () => [], invalidate() {} }),
					renderResult: () => new Text("hub reply", 0, 0),
				}),
		],
		["a tool without a definition", () => savedCall(undefined)],
	] as const;

	it.each(withBody)("opens %s with its header on the collapsed row and its body directly below", (_name, create) => {
		const rows = create().render(60);
		const collapsed = foldedRows(rows, () => true);
		const open = foldedRows(rows, () => false);

		expect({
			collapsed: collapsed.length,
			separator: open[0],
			header: firstWord(open[1]!),
			body: open.length > 2,
			blankBeforeHeader: blank(open[1]!),
			blankAfterBody: blank(open.at(-1)!),
		}).toEqual({
			collapsed: 2,
			separator: "",
			header: firstWord(collapsed[1]!),
			body: true,
			blankBeforeHeader: false,
			blankAfterBody: false,
		});
	});

	it("separates an open call in a group from the next call by the bottom row of its card", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:call-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [summaryAware],
		});
		group.addTool(unknownCall("call-a"), { toolName: "process", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "process", toolCallId: "call-b" });
		const visible = boundaryRows(group.render(80)).visible;
		const second = visible.findIndex((row) => row.startsWith("  ╰")) + 1;

		expect(visible.slice(second - 2, second + 1)).toEqual([
			`  │ call-a output${" ".repeat(62)}│`,
			`  ╰${"─".repeat(76)}╯`,
			"   process",
		]);
	});

	it.each([
		["a read without shown output", () => readCall()],
		["a bash call without output", () => foldedBuiltIn("bash", builtIn("bash"), { command: "true" }, "")],
		[
			"a write call without content",
			() => foldedBuiltIn("write", builtIn("write"), { path: "a.md", content: "" }, ""),
		],
		[
			"an edit without a diff",
			() =>
				foldedBuiltIn("edit", editRenderersFor(), { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] }, "ok"),
		],
		[
			"a self call whose result draws no rows",
			() =>
				savedCall({
					renderShell: "self",
					renderCall: () => new Text("agent call", 0, 0),
					renderResult: () => ({ render: () => [], invalidate() {} }),
				}),
		],
	] as const)("gives %s no foldable body and keeps it as one collapsed row", (_name, create) => {
		const rows = create().render(60);

		expect({ controls: boundaryRows(rows).counts, rows: foldedRows(rows, () => false).length }).toEqual({
			controls: [1, 0, 1],
			rows: 2,
		});
	});
});

describe("Tool Call fold label", () => {
	beforeAll(() => initTheme("dark"));

	const labelControl = "\x1b]777;label-end\x07";
	/** The fold controls with a label control after every label, and each context it gets. */
	const labeling = (contexts: MessageRenderBoundaryContextV1[]): MessageRenderBoundarySelectorV3[] => [
		() => (context) => {
			contexts.push(context);
			return { ...controls, labels: context.labels?.map(() => labelControl) };
		},
	];
	/** The cell column of [control] in [row]: the visible width of the text before it. */
	const columnOf = (row: string, control: string) =>
		visibleWidth(row.slice(0, row.indexOf(control)).replace(/\x1b\]777;[^\x07]*\x07/g, ""));
	const builtIn = (name: string) => withBuiltInRenderers(name, undefined)!;
	const bash = (command: string, output: string, contexts: MessageRenderBoundaryContextV1[]) =>
		foldedBuiltIn("bash", builtIn("bash"), { command }, output, labeling(contexts));

	it("gives an opening summary row a label that ends three free cells before the row end", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const rows = bash(`printf '${"x".repeat(80)}'`, "a.md", contexts).render(60);
		const label = contexts.at(-1)!.labels![0]!;
		const visible = stripAnsi(rows[label.row]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""));

		expect({
			row: label.row,
			start: label.start,
			ellipsis: visible.slice(label.start, label.end).endsWith("…"),
			// The row has no background, so the free cells after the label are cells without text.
			free: visible.slice(label.end).trim() === "" && label.end <= 60 - 3,
		}).toEqual({ row: 1, start: 1, ellipsis: true, free: true });
	});

	it("gives the header of an open summarized call the second label at the body row", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const rows = bash("ls", "a.md\nb.md", contexts).render(60);
		const context = contexts.at(-1)!;
		const header = context.labels![1]!;
		const visible = stripAnsi(rows[header.row]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""));

		expect({
			row: header.row,
			text: visible.slice(header.start, header.end),
			after: visible.slice(header.end).trim(),
		}).toEqual({ row: context.bodyRow, text: "$ ls", after: "" });
	});

	it("places the label control right after the last text cell of the label", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const rows = bash("echo 你好", "a.md\nb.md", contexts).render(60);
		const label = contexts.at(-1)!.labels![0]!;

		expect(columnOf(rows[label.row]!, labelControl)).toBe(label.end);
	});

	it("counts the label end in terminal cells", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		bash("echo 你好", "a.md\nb.md", contexts).render(60);
		const label = contexts.at(-1)!.labels![0]!;

		expect(label.end - label.start).toBe(visibleWidth("$ echo 你好"));
	});

	it("gives no label to a call that cannot open", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		bash("true", "", contexts).render(60);

		expect(contexts.at(-1)!.labels).toBeUndefined();
	});

	it("keeps the failures of a narrow group header before the free cells", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:call-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: labeling([]),
		});
		const failed = unknownCall("call-a");
		failed.updateResult({ content: [{ type: "text", text: "no" }], isError: true });
		group.addTool(failed, { toolName: "process", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "process", toolCallId: "call-b" });

		expect(stripAnsi(group.render(9)[1]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""))).toContain("1 failed");
	});

	it("gives a group header a label that ends three free cells before the row end", () => {
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const group = new ToolGroupComponent({
			groupId: "tool-group:assistant-a:call-a",
			ownerEntryId: "assistant-a",
			closed: true,
			outputPad: 1,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: labeling(contexts),
		});
		group.addTool(unknownCall("call-a"), { toolName: "process", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "process", toolCallId: "call-b" });
		// "$ Used tools" fits 14 cells only without the free cells.
		const rows = group.render(14);
		const label = contexts.find((context) => context.role === "tool-group")!.labels![0]!;
		const visible = stripAnsi(rows[label.row]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""));

		expect({
			row: label.row,
			start: label.start,
			ellipsis: visible.slice(0, label.end).endsWith("…"),
			free: label.end + 3 <= 14,
		}).toEqual({ row: 1, start: 1, ellipsis: true, free: true });
	});
});

describe("Tool Call summary text", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps the title faint across a collapsed row whose text ends with an ellipsis", () => {
		const component = foldedBuiltIn(
			"bash",
			withBuiltInRenderers("bash", undefined)!,
			{ command: `printf '${"TC_FOLD_OUTPUT ".repeat(8)}'` },
			"out",
		);
		const row = component.render(40)[1]!.replace(/\x1b\]777;[^\x07]*\x07/g, "");
		// A reset or a normal-intensity control inside the title, such as the one before the ellipsis, starts faint again.
		const title = row.slice(0, row.lastIndexOf("\x1b[22m"));

		expect({
			ellipsis: stripAnsi(row).trimEnd().endsWith("…"),
			unfaint: /\x1b\[(?:0|22)?m(?!\x1b\[2m)/.test(title),
		}).toEqual({ ellipsis: true, unfaint: false });
	});

	it("summarizes an opaque self call row that pads its text to the call width without an ellipsis", () => {
		const component = savedCall({
			renderShell: "self",
			renderCall: () => ({ render: (width: number) => ["opaque call row".padEnd(width)], invalidate() {} }),
			renderResult: () => new Text("opaque result", 0, 0),
		});

		expect(foldedRows(component.render(80), () => true)).toEqual(["", "opaque call row"]);
	});
});

describe("Tool Call summary path", () => {
	beforeAll(() => initTheme("dark"));

	const longPath = "f0-long-read-root/semantic/presentation/fixtures/very/deep/terminal/F0_LONG.md";

	it.each([
		["a line that fits", "read a/b.md", 20, undefined],
		["a long path", `read ${longPath}`, 40, { width: 40, end: "/F0_LONG.md", start: "read f0-long" }],
		[
			"a styled path",
			`\x1b[1mread\x1b[0m \x1b[36m${longPath}\x1b[0m`,
			40,
			{ width: 40, end: "/F0_LONG.md", start: "read f0-long" },
		],
		["a line without a path", `printf '${"x".repeat(60)}'`, 30, undefined],
		["a file name longer than the room", "cat a/b/very_long_file_name_that_does_not_fit.txt", 20, undefined],
	] as const)("fits %s by removing the middle of its path", (_name, line, room, expected) => {
		const fitted = keepPathFileName(line, room);
		const plain = fitted === undefined ? undefined : stripAnsi(fitted);

		expect(
			plain === undefined
				? undefined
				: { width: visibleWidth(plain), end: plain.slice(-"/F0_LONG.md".length), start: plain.slice(0, 12) },
		).toEqual(expected);
	});

	it("cuts a path with wide characters by terminal cells and keeps its file name", () => {
		const fitted = stripAnsi(keepPathFileName(`read src/${"项目目录/".repeat(8)}Report.md`, 38)!);

		expect({ end: fitted.endsWith("/Report.md"), fits: visibleWidth(fitted) <= 38 }).toEqual({
			end: true,
			fits: true,
		});
	});

	it("keeps the file name of a wide-character path in the collapsed summary of a read", () => {
		const read = foldedBuiltIn(
			"read",
			withBuiltInRenderers("read", undefined)!,
			{ path: `src/${"项目目录/".repeat(8)}Report.md` },
			"file content",
		);
		read.setExpanded(true);

		expect(stripAnsi(read.render(40)[1]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""))).toContain("/Report.md");
	});

	it("keeps the complete header of a call that cannot open when the summary frame would cut it", () => {
		const header = "abcdefghijklmnop.txt";
		const call = savedCall({
			renderShell: "self",
			renderCall: () => new Text(header, 0, 0),
			renderResult: () => ({ render: () => [], invalidate() {} }),
		});
		call.updateResult({ content: [], isError: false });

		expect(call.render(20).map((row) => stripAnsi(row.replace(/\x1b\]777;[^\x07]*\x07/g, "")))).toContain(header);
	});

	it("keeps the styles of a styled path", () => {
		expect(keepPathFileName(`\x1b[1mread\x1b[0m \x1b[36m${longPath}\x1b[0m`, 40)).toContain("\x1b[36m");
	});

	it("keeps the file name in the collapsed summary of a long read", () => {
		const read = foldedBuiltIn(
			"read",
			withBuiltInRenderers("read", createReadToolDefinition(process.cwd()) as unknown as ToolRenderers)!,
			{ path: longPath },
			"line 1\nline 2",
		);
		read.setExpanded(true);
		const summary = stripAnsi(read.render(50)[1]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""));

		expect({ fileName: summary.includes("/F0_LONG.md"), ellipsis: summary.includes("…") }).toEqual({
			fileName: true,
			ellipsis: true,
		});
	});
});

describe("open card and quiet header details", () => {
	beforeAll(() => initTheme("dark"));

	it("keeps the ellipsis of a truncated group label faint", () => {
		const group = new ToolGroupComponent({
			groupId: "tool-group:call-a",
			closed: true,
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [() => () => controls],
		});
		group.addTool(unknownCall("call-a"), { toolName: "read", toolCallId: "call-a" });
		group.addTool(unknownCall("call-b"), { toolName: "bash", toolCallId: "call-b" });
		const header = group.render(20)[1]!.replace(/\x1b\]777;[^\x07]*\x07/g, "");
		const beforeEllipsis = header.slice(0, header.indexOf("…"));

		expect({
			ellipsis: stripAnsi(header).includes("…"),
			faint: beforeEllipsis.lastIndexOf("\x1b[2m") > beforeEllipsis.lastIndexOf("\x1b[0m"),
		}).toEqual({ ellipsis: true, faint: true });
	});

	it("draws the header of an open call faint at rest, without a background", () => {
		const rows = foldedBuiltIn(
			"bash",
			withBuiltInRenderers("bash", undefined)!,
			{ command: "printf out" },
			"out",
		).render(60);
		const header = rows[2]!.replace(/\x1b\]777;[^\x07]*\x07/g, "");

		expect({
			text: stripAnsi(header).trim(),
			faint: header.includes("\x1b[2m"),
			background: header.includes("\x1b[48;"),
		}).toEqual({ text: "$ printf out", faint: true, background: false });
	});

	it("starts a self-rendered header whose first cell is a styled space after one free cell", () => {
		const rows = savedCall({
			renderShell: "self",
			renderCall: () => ({ render: () => ["\x1b[31m title\x1b[39m", "body"], invalidate() {} }),
			renderResult: () => new Text("", 0, 0),
		}).render(40);

		expect(stripAnsi(rows[2]!.replace(/\x1b\]777;[^\x07]*\x07/g, ""))).toBe(" title");
	});

	it("pads the short rows of a self-rendered call to the inner width of its card", () => {
		const rows = savedCall({
			renderShell: "self",
			renderCall: () => ({ render: () => ["title", "body"], invalidate() {} }),
			renderResult: () => new Text("", 0, 0),
		}).render(40);
		const card = rows.filter((row) => /^\s*[│╭╰]/.test(stripAnsi(row)));

		expect(card.length).toBeGreaterThan(2);
		expect(card.every((row) => visibleWidth(row) === 40)).toBe(true);
	});
});
