import type { AssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { composeAssistantResponse } from "../src/modes/interactive/components/assistant-response.ts";

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
	it("keeps Tool Groups local to one assistant response", () => {
		const first = composeAssistantResponse("assistant-a", assistant([tool("tool-a1"), tool("tool-a2")]));
		const second = composeAssistantResponse("assistant-b", assistant([tool("tool-b1"), tool("tool-b2")]));

		expect(first.members).toEqual([
			{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
			{
				entryId: "tool-group:assistant-a:tool-a1",
				blockId: "tool-group:assistant-a:tool-a1",
				role: "tool-group",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:assistant-a:tool-a1",
				groupClosed: true,
			},
			{
				entryId: "tool-a1",
				blockId: "tool-a1",
				role: "tool",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:assistant-a:tool-a1",
				groupOrder: 0,
			},
			{
				entryId: "tool-a2",
				blockId: "tool-a2",
				role: "tool",
				ownerEntryId: "assistant-a",
				groupId: "tool-group:assistant-a:tool-a1",
				groupOrder: 1,
			},
		]);
		expect(second.members.filter((member) => member.role === "tool").map((member) => member.groupId)).toEqual([
			"tool-group:assistant-b:tool-b1",
			"tool-group:assistant-b:tool-b1",
		]);
	});

	it("keeps singleton, group, and child identities distinct and stable", () => {
		const singleton = composeAssistantResponse("assistant-a", assistant([tool("tool-1")]), true);
		const grouped = composeAssistantResponse("assistant-a", assistant([tool("tool-1"), tool("tool-2")]), true);

		expect(singleton.members.slice(1)).toEqual([
			{ entryId: "tool-1", blockId: "tool-1", role: "tool", ownerEntryId: "assistant-a" },
		]);
		expect(grouped.members[1]?.entryId).toBe("tool-group:assistant-a:tool-1");
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
