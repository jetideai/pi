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
} satisfies AgentMessage;

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

	it.each([
		["stop", "length"],
		["length", "stop"],
	] as const)(
		"keeps the first successful %s assistant when an unrelated successful %s assistant follows",
		(firstStopReason, laterStopReason) => {
			const messages = new Map<string, AgentMessage>([
				["user-a", user],
				["assistant-owner", { ...assistant, stopReason: firstStopReason }],
				[
					"assistant-async",
					{
						...assistant,
						content: [{ type: "text" as const, text: "Later async answer" }],
						stopReason: laterStopReason,
					},
				],
				["user-next", { ...user, content: "Next question" }],
			]);
			const projection = buildMessageRenderProjection({
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				members: [
					{ entryId: "user-a", blockId: "user-a", role: "user" },
					{ entryId: "assistant-owner", blockId: "assistant-owner", role: "assistant" },
					{ entryId: "assistant-async", blockId: "assistant-async", role: "assistant" },
					{ entryId: "user-next", blockId: "user-next", role: "user" },
				],
				mode: "replace",
				readMessage: (entryId) => messages.get(entryId),
			});

			expect(projection.members[0]).toMatchObject({
				completedTurn: {
					assistantEntryId: "assistant-owner",
					userPreview: "Question",
					assistantPreview: "Answer",
				},
			});
		},
	);

	it("selects the successful assistant after a failed retry attempt", () => {
		const failedAssistant = {
			...assistant,
			content: [{ type: "text" as const, text: "Temporary failure" }],
			stopReason: "error" as const,
			errorMessage: "529 overloaded",
		};
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-error", failedAssistant],
			["assistant-success", assistant],
			["user-next", { ...user, content: "Next question" }],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-error", blockId: "assistant-error", role: "assistant" },
				{ entryId: "assistant-success", blockId: "assistant-success", role: "assistant" },
				{ entryId: "user-next", blockId: "user-next", role: "user" },
			],
			mode: "replace",
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(projection.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: "assistant-success",
				assistantPreview: "Answer",
			},
		});
	});

	it("skips nonterminal assistants before the terminal answer", () => {
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			...(["pending", "toolUse", "deferred"] as const).map(
				(stopReason, index) => [`assistant-${index}`, { ...assistant, stopReason }] as const,
			),
			["assistant-terminal", assistant],
			["user-next", { ...user, content: "Next question" }],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-0", blockId: "assistant-0", role: "assistant" },
				{ entryId: "assistant-1", blockId: "assistant-1", role: "assistant" },
				{ entryId: "assistant-2", blockId: "assistant-2", role: "assistant" },
				{ entryId: "assistant-terminal", blockId: "assistant-terminal", role: "assistant" },
				{ entryId: "user-next", blockId: "user-next", role: "user" },
			],
			mode: "replace",
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(projection.members[0]).toMatchObject({
			completedTurn: {
				assistantEntryId: "assistant-terminal",
				assistantPreview: "Answer",
			},
		});
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
