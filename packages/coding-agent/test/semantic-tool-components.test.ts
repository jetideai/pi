import { Text, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { beforeAll, describe, expect, it } from "vitest";
import type {
	MessageRenderBoundaryCandidateV3,
	MessageRenderBoundaryContextV1,
	MessageRenderBoundarySelectorV3,
	ToolDefinition,
	ToolExecutionPresentationSelectorV1,
} from "../src/core/extensions/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
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

	it("renders one presentation-only group around two existing children", () => {
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

		const rendered = group.render(80).join("\n");
		expect(stripAnsi(rendered)).toContain("$ Read files, Ran commands");
		expect(rendered.indexOf("stock header")).toBeLessThan(rendered.lastIndexOf("stock header"));
		expect(rendered.split(controls.begin)).toHaveLength(2);
		expect(rendered.split(controls.body)).toHaveLength(2);
		expect(rendered.split(controls.end)).toHaveLength(2);
	});

	it("leaves a singleton on its existing Tool Call path", () => {
		const child = tool("tool-only");
		const group = new ToolGroupComponent({ groupId: "tool-group:assistant-a:tool-only", closed: true });
		group.addTool(child, { toolName: "read", toolCallId: "tool-only" });

		expect(group.render(80)).toEqual(child.render(80));
	});
});
