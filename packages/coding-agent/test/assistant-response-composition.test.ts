import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	composeAssistantResponse,
	composeTranscriptResponses,
	type ToolGroupRunItem,
} from "../src/modes/interactive/components/assistant-response.ts";

function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: 1,
	};
}

const tool = (id: string) => ({ type: "toolCall" as const, id, name: "read", arguments: { path: `${id}.txt` } });

describe("assistant response composition", () => {
	it("keeps the Tool Groups of a one-response segment inside that response", () => {
		const first = composeAssistantResponse("assistant-a", assistant([tool("tool-a1"), tool("tool-a2")]));
		const second = composeAssistantResponse("assistant-b", assistant([tool("tool-b1"), tool("tool-b2")]));

		expect(first.members).toEqual([
			{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
			{
				entryId: "tool-group:tool-a1",
				blockId: "tool-group:tool-a1",
				role: "tool-group",
				groupId: "tool-group:tool-a1",
				groupClosed: true,
			},
			{
				entryId: "tool-a1",
				blockId: "tool-a1",
				role: "tool",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:tool-a1",
				groupOrder: 0,
			},
			{
				entryId: "tool-a2",
				blockId: "tool-a2",
				role: "tool",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:tool-a1",
				groupOrder: 1,
			},
		]);
		expect(second.members.filter((member) => member.role === "tool").map((member) => member.groupId)).toEqual([
			"tool-group:tool-b1",
			"tool-group:tool-b1",
		]);
	});

	it("keeps singleton, group, and child identities distinct and stable", () => {
		const singleton = composeAssistantResponse("assistant-a", assistant([tool("tool-1")]), true);
		const grouped = composeAssistantResponse("assistant-a", assistant([tool("tool-1"), tool("tool-2")]), true);

		expect(singleton.members.slice(1)).toEqual([
			{ entryId: "tool-1", blockId: "tool-1", role: "tool", ownerEntryId: "assistant-a" },
		]);
		expect(grouped.members[1]?.entryId).toBe("tool-group:tool-1");
		expect(grouped.members[2]?.entryId).toBe("tool-1");
		expect(grouped.members[2]?.blockId).toBe("tool-1");
		expect(grouped.members[1]?.entryId).not.toBe(grouped.members[2]?.entryId);
	});

	it("preserves visual and Tool Call order for live and restored composition", () => {
		const message = assistant([
			{ type: "text", text: "before" },
			tool("tool-1"),
			tool("tool-2"),
			{ type: "text", text: "after" },
			tool("tool-3"),
		]);
		const live = composeAssistantResponse("assistant-a", message, true);
		const restored = composeAssistantResponse("assistant-a", message, false);

		expect(live.atoms.map((atom) => atom.type)).toEqual(["visual", "tools", "visual", "tools"]);
		expect(live.members.map((member) => member.entryId)).toEqual(restored.members.map((member) => member.entryId));
		expect(live.members.find((member) => member.role === "tool-group")?.groupClosed).toBe(false);
		expect(restored.members.find((member) => member.role === "tool-group")?.groupClosed).toBe(true);
	});
});

const thinking = (text: string) => ({ type: "thinking" as const, thinking: text });
const response = (entryId: string, content: AssistantMessage["content"]): ToolGroupRunItem => ({
	type: "response",
	entryId,
	message: assistant(content, "toolUse"),
});
const transparent: ToolGroupRunItem = { type: "transparent" };

/** The group of each Tool Call member, in transcript order. */
function callGroups(items: readonly ToolGroupRunItem[], hideThinkingBlock = true) {
	return composeTranscriptResponses(items, false, hideThinkingBlock)
		.flatMap((composition) => composition?.members ?? [])
		.filter((member) => member.role === "tool")
		.map((member) => [member.entryId, member.groupId, member.groupOrder]);
}

describe("transcript Tool Group runs", () => {
	it("groups calls of consecutive responses across transparent items and hidden thinking", () => {
		const compositions = composeTranscriptResponses(
			[
				response("assistant-a", [thinking("a"), tool("tool-a")]),
				transparent,
				response("assistant-b", [thinking("b"), tool("tool-b")]),
				transparent,
			],
			false,
			true,
		);

		expect(compositions[0]?.members).toEqual([
			{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
			{
				entryId: "tool-group:tool-a",
				blockId: "tool-group:tool-a",
				role: "tool-group",
				groupId: "tool-group:tool-a",
				groupClosed: true,
			},
			{
				entryId: "tool-a",
				blockId: "tool-a",
				role: "tool",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:tool-a",
				groupOrder: 0,
			},
		]);
		expect(compositions[2]?.members).toEqual([
			{ entryId: "assistant-b", blockId: "assistant-b", role: "assistant" },
			{
				entryId: "tool-b",
				blockId: "tool-b",
				role: "tool",
				ownerEntryId: "assistant-b",
				groupId: "tool-group:tool-a",
				groupOrder: 1,
			},
		]);
	});

	it("keeps the group ID of the first call while the run grows", () => {
		const two = [response("assistant-a", [tool("tool-a")]), response("assistant-b", [tool("tool-b")])];

		expect(callGroups([...two, response("assistant-c", [tool("tool-c")])])).toEqual([
			...callGroups(two),
			["tool-c", "tool-group:tool-a", 2],
		]);
	});

	it.each([
		[
			"a boundary item",
			[response("assistant-a", [tool("tool-a")]), { type: "boundary" }, response("assistant-b", [tool("tool-b")])],
		],
		[
			"a cut",
			[response("assistant-a", [tool("tool-a")]), { ...response("assistant-b", [tool("tool-b")]), cutBefore: true }],
		],
		[
			"visible prose",
			[
				response("assistant-a", [tool("tool-a")]),
				response("assistant-b", [{ type: "text", text: "prose" }, tool("tool-b")]),
			],
		],
	] as const)("stops a run at %s", (_name, items) => {
		expect(callGroups(items as readonly ToolGroupRunItem[])).toEqual([
			["tool-a", undefined, undefined],
			["tool-b", undefined, undefined],
		]);
	});

	it("stops a run at visible thinking and continues it across empty text", () => {
		const items = [
			response("assistant-a", [tool("tool-a")]),
			response("assistant-b", [{ type: "text", text: "  " }, tool("tool-b")]),
			response("assistant-c", [thinking("visible"), tool("tool-c")]),
		];

		expect(callGroups(items, false)).toEqual([
			["tool-a", "tool-group:tool-a", 0],
			["tool-b", "tool-group:tool-a", 1],
			["tool-c", undefined, undefined],
		]);
	});

	it("gives a run of one call no group", () => {
		expect(callGroups([response("assistant-a", [tool("tool-a")]), transparent])).toEqual([
			["tool-a", undefined, undefined],
		]);
	});
});
