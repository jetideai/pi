import { Text, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
import { withBuiltInRenderers } from "../src/core/tools/renderers/index.ts";
import type { ToolRenderers } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent, ToolGroupMemberComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const controls = { begin: "\x1b]777;begin\x07", body: "\x1b]777;body\x07", end: "\x1b]777;end\x07" };
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
		expect(rendered.split(controls.begin)).toHaveLength(2);
		expect(rendered.split(controls.body)).toHaveLength(2);
		expect(rendered.split(controls.end)).toHaveLength(2);
	});

	it("keeps expanded stock tool points stable and assigns the containing Tool Group fold", () => {
		const points: MessageRenderSourcePointV1[] = [];
		const sourcePointDecoratorsV1 = [
			(point: Readonly<MessageRenderSourcePointV1>) => {
				points.push({ ...point });
				return "\x1b]777;point\x07";
			},
		];
		const makeBash = (id: string) => {
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
				content: [{ type: "text", text: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n") }],
				isError: false,
			});
			return component;
		};
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
				expect.objectContaining({
					entryId: "tool-a",
					blockId: "tool-group:assistant-a:tool-a",
					foldRole: "tool-group",
				}),
				expect.objectContaining({
					entryId: "tool-b",
					blockId: "tool-group:assistant-a:tool-a",
					foldRole: "tool-group",
				}),
			]),
		);
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

	it("maps group-header and member-separator mouse rows to each child", () => {
		const makeChild = (rows: string[]) => ({
			render: vi.fn(() => rows),
			invalidate: vi.fn(),
			handleMouse: vi.fn(() => ({ handled: true as const })),
			setSemanticBoundariesEnabled: vi.fn(),
			setSourcePointContainingFold: vi.fn(),
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
		expect(group.handleMouse(event(2))).toMatchObject({ handled: true });
		expect(first.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 2 }));
		expect(group.handleMouse(event(5))).toMatchObject({ handled: true });
		expect(second.handleMouse).toHaveBeenCalledWith(expect.objectContaining({ y: 0, height: 1 }));
	});

	it.each([
		["default shell", ["", "default header", "default body"]],
		["self shell", ["", "self header", "self result"]],
		["error", ["", "error header", "error body"]],
		["image", ["image header", "\x1b_Gi=1,r=1;AAAA\x1b\\"]],
		["image only", ["\x1b_Gi=2,r=1;AAAA\x1b\\"]],
		["I3 partial", ["stock header"]],
		["empty", []],
	] as const)("keeps %s member rows transparent", (_name, childRows) => {
		const component = {
			render: vi.fn(() => [...childRows]),
			invalidate: vi.fn(),
			handleMouse: vi.fn(),
		} as unknown as ToolExecutionComponent;
		const member = new ToolGroupMemberComponent(component, true);

		expect(member.render(80)).toEqual(childRows.length === 0 ? [] : ["", ...childRows]);
		expect(component.render).toHaveBeenCalledOnce();
	});

	it("leaves a singleton on its existing Tool Call path", () => {
		const child = tool("tool-only");
		const group = new ToolGroupComponent({ groupId: "tool-group:assistant-a:tool-only", closed: true });
		group.addTool(child, { toolName: "read", toolCallId: "tool-only" });

		expect(group.render(80)).toEqual(child.render(80));
	});
});
