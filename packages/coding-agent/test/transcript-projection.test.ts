import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MessageRenderProjectionMemberV1 } from "../src/core/extensions/types.ts";
import {
	buildMessageRenderProjection,
	publishMessageRenderProjection,
} from "../src/modes/interactive/components/transcript-projection.ts";

const user = { role: "user", content: "Question", timestamp: 1 } as const;
const assistant = {
	role: "assistant",
	content: [{ type: "text" as const, text: "Answer" }],
	api: "openai-responses" as const,
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
	stopReason: "stop" as const,
	timestamp: 1,
} as AgentMessage;

const members: MessageRenderProjectionMemberV1[] = [
	{ entryId: "user-a", blockId: "user-a", role: "user" },
	{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
	{
		entryId: "tool-a",
		blockId: "tool-a",
		role: "tool",
		ownerEntryId: "assistant-a",
	},
];

describe("completed transcript projection", () => {
	it("freezes exact producer, scope, entry, block, role, owner, and completed-turn facts", () => {
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-a", assistant],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members,
			mode: "append",
			completeLastTurn: true,
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(projection).toEqual({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{
					entryId: "user-a",
					blockId: "user-a",
					role: "user",
					completedTurn: {
						assistantEntryId: "assistant-a",
						userPreview: "Question",
						assistantPreview: "Answer",
					},
				},
				{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
				{ entryId: "tool-a", blockId: "tool-a", role: "tool", ownerEntryId: "assistant-a" },
			],
			mode: "append",
		});
		expect(Object.isFrozen(projection)).toBe(true);
		expect(Object.isFrozen(projection.members)).toBe(true);
		expect(Object.isFrozen(projection.members[0])).toBe(true);
		expect(Object.isFrozen(projection.members[0]?.role === "user" && projection.members[0].completedTurn)).toBe(true);
	});

	it("isolates observers without changing publication order", () => {
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members,
			mode: "replace",
			readMessage: () => undefined,
		});
		const observed: string[] = [];
		const failure = vi.fn(() => {
			throw new Error("observer failed");
		});

		publishMessageRenderProjection(projection, [failure, () => observed.push("later")]);

		expect(failure).toHaveBeenCalledOnce();
		expect(observed).toEqual(["later"]);
	});
});
