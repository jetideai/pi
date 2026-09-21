import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import type { MessageRenderProjectionMemberV1 } from "../src/core/extensions/types.ts";
import type { ExternalAgentOriginV1 } from "../src/core/messages.ts";
import {
	buildMessageRenderProjection,
	publishMessageRenderProjection,
} from "../src/modes/interactive/components/transcript-projection.ts";

const externalInitiator = {
	namespace: "agent-hub",
	agentId: "agent-a",
	registrationGeneration: 3,
} satisfies ExternalAgentOriginV1;
const user = { role: "user", content: "Question", timestamp: 1, initiator: externalInitiator } as const;
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
			settledTurns: [{ userEntryId: "user-a", assistantEntryId: "assistant-a" }],
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
						initiator: externalInitiator,
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
		expect(
			Object.isFrozen(projection.members[0]?.role === "user" && projection.members[0].completedTurn?.initiator),
		).toBe(true);
	});

	it("emits exactly two ordered turns from two settled roots", () => {
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-a", assistant],
			["user-b", { ...user, content: "Second question" }],
			["assistant-b", { ...assistant, content: [{ type: "text" as const, text: "Second answer" }] }],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
				{ entryId: "user-b", blockId: "user-b", role: "user" },
				{ entryId: "assistant-b", blockId: "assistant-b", role: "assistant" },
			],
			mode: "replace",
			settledTurns: [
				{ userEntryId: "user-a", assistantEntryId: "assistant-a" },
				{ userEntryId: "user-b", assistantEntryId: "assistant-b" },
			],
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(
			projection.members.flatMap((member) =>
				member.role === "user" && member.completedTurn
					? [[member.entryId, member.completedTurn.assistantEntryId]]
					: [],
			),
		).toEqual([
			["user-a", "assistant-a"],
			["user-b", "assistant-b"],
		]);
	});

	it("keeps identical initiating text distinct by exact origin and ignores malformed restored origin", () => {
		const secondOrigin = { ...externalInitiator, agentId: "agent-b", registrationGeneration: 4 };
		const malformedUser = {
			...user,
			initiator: { ...externalInitiator, registrationGeneration: 0 },
		} as unknown as AgentMessage;
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-a", assistant],
			["user-b", { ...user, initiator: secondOrigin }],
			["assistant-b", assistant],
			["user-malformed", malformedUser],
			["assistant-malformed", assistant],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
				{ entryId: "user-b", blockId: "user-b", role: "user" },
				{ entryId: "assistant-b", blockId: "assistant-b", role: "assistant" },
				{ entryId: "user-malformed", blockId: "user-malformed", role: "user" },
				{ entryId: "assistant-malformed", blockId: "assistant-malformed", role: "assistant" },
			],
			mode: "replace",
			settledTurns: [
				{ userEntryId: "user-a", assistantEntryId: "assistant-a" },
				{ userEntryId: "user-b", assistantEntryId: "assistant-b" },
				{ userEntryId: "user-malformed", assistantEntryId: "assistant-malformed" },
			],
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(
			projection.members.flatMap((member) =>
				member.role === "user" && member.completedTurn ? [member.completedTurn.initiator] : [],
			),
		).toEqual([externalInitiator, secondOrigin, undefined]);
	});

	it("infers only unmarked turns and keeps conflicting evidence closed", () => {
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-a", assistant],
			["assistant-b", { ...assistant, content: [{ type: "text" as const, text: "Later" }] }],
		]);
		const build = (
			settledTurns: Array<{ userEntryId: string; assistantEntryId: string }>,
			inferMissingTurns: boolean,
		) =>
			buildMessageRenderProjection({
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				members: [
					{ entryId: "user-a", blockId: "user-a", role: "user" },
					{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
					{ entryId: "assistant-b", blockId: "assistant-b", role: "assistant" },
				],
				mode: "replace",
				settledTurns,
				inferMissingTurns,
				readMessage: (entryId) => messages.get(entryId),
			});

		expect(build([], false).members[0]).not.toHaveProperty("completedTurn");
		expect(build([], true).members[0]).toMatchObject({
			completedTurn: { assistantEntryId: "assistant-b", assistantPreview: "Later" },
		});
		expect(
			build(
				[
					{ userEntryId: "user-a", assistantEntryId: "assistant-a" },
					{ userEntryId: "user-a", assistantEntryId: "assistant-b" },
				],
				true,
			).members[0],
		).not.toHaveProperty("completedTurn");
	});

	it("keeps an exact terminal while inferring a later missing turn", () => {
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-a", assistant],
			["assistant-later", { ...assistant, content: [{ type: "text" as const, text: "Later A" }] }],
			["user-b", { ...user, content: "Second question" }],
			["assistant-b", { ...assistant, content: [{ type: "text" as const, text: "Answer B" }] }],
			["user-c", { ...user, content: "Incomplete question" }],
			["assistant-pending", { ...assistant, stopReason: "pending" }],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-a", blockId: "assistant-a", role: "assistant" },
				{ entryId: "assistant-later", blockId: "assistant-later", role: "assistant" },
				{ entryId: "user-b", blockId: "user-b", role: "user" },
				{ entryId: "assistant-b", blockId: "assistant-b", role: "assistant" },
				{ entryId: "user-c", blockId: "user-c", role: "user" },
				{ entryId: "assistant-pending", blockId: "assistant-pending", role: "assistant" },
			],
			mode: "replace",
			settledTurns: [{ userEntryId: "user-a", assistantEntryId: "assistant-a" }],
			inferMissingTurns: true,
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(
			projection.members.flatMap((member) =>
				member.role === "user" && member.completedTurn
					? [[member.entryId, member.completedTurn.assistantEntryId]]
					: [],
			),
		).toEqual([
			["user-a", "assistant-a"],
			["user-b", "assistant-b"],
		]);
	});

	it.each([
		["stop", "length"],
		["length", "stop"],
	] as const)(
		"selects the last terminal %s assistant when a later %s assistant follows",
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
				settledTurns: [{ userEntryId: "user-a", assistantEntryId: "assistant-async" }],
				readMessage: (entryId) => messages.get(entryId),
			});

			expect(projection.members[0]).toMatchObject({
				completedTurn: {
					assistantEntryId: "assistant-async",
					userPreview: "Question",
					assistantPreview: "Later async answer",
					initiator: externalInitiator,
				},
			});
		},
	);

	it.each([undefined, "unknown"])("does not infer malformed assistant stop reason %s", (stopReason) => {
		const malformedAssistant = { ...assistant, stopReason } as unknown as AgentMessage;
		const messages = new Map<string, AgentMessage>([
			["user-a", user],
			["assistant-malformed", malformedAssistant],
		]);
		const projection = buildMessageRenderProjection({
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			members: [
				{ entryId: "user-a", blockId: "user-a", role: "user" },
				{ entryId: "assistant-malformed", blockId: "assistant-malformed", role: "assistant" },
			],
			mode: "replace",
			inferMissingTurns: true,
			readMessage: (entryId) => messages.get(entryId),
		});

		expect(projection.members[0]).not.toHaveProperty("completedTurn");
	});

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
			settledTurns: [{ userEntryId: "user-a", assistantEntryId: "assistant-success" }],
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
			inferMissingTurns: true,
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
