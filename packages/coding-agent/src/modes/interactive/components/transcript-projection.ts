import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	MessageRenderCompletedTurnV1,
	MessageRenderFinalizedEntryV1,
	MessageRenderProjectionMemberV1,
	MessageRenderProjectionObserverV1,
	MessageRenderProjectionV1,
} from "../../../core/extensions/types.ts";
import {
	copyExternalAgentOriginV1,
	type ExternalAgentOriginV1,
	isTerminalAssistantMessage,
} from "../../../core/messages.ts";
import type { SemanticTurnSettlementV1 } from "../../../core/session-manager.ts";

const MAX_COMPLETED_TURN_PREVIEW_BYTES = 4 * 1024;
const COMPLETED_TURN_PREVIEW_ELLIPSIS = "…";

export interface BuildMessageRenderProjectionOptions {
	producerSessionId: string;
	renderScopeId: string;
	members: readonly MessageRenderProjectionMemberV1[];
	mode: "append" | "replace";
	finalized?: MessageRenderFinalizedEntryV1;
	settledTurns?: readonly Readonly<SemanticTurnSettlementV1>[];
	inferMissingTurns?: boolean;
	readMessage(entryId: string): AgentMessage | undefined;
}

export function buildMessageRenderProjection(
	options: BuildMessageRenderProjectionOptions,
): Readonly<MessageRenderProjectionV1> {
	const members = attachCompletedTurns(
		options.members,
		options.readMessage,
		options.settledTurns ?? [],
		options.inferMissingTurns ?? false,
	).map((member) =>
		Object.freeze({
			...member,
			...(member.role === "user" && member.completedTurn
				? { completedTurn: Object.freeze({ ...member.completedTurn }) }
				: {}),
		}),
	);
	return Object.freeze({
		producerSessionId: options.producerSessionId,
		renderScopeId: options.renderScopeId,
		members: Object.freeze(members),
		mode: options.mode,
		...(options.finalized ? { finalized: Object.freeze({ ...options.finalized }) } : {}),
	});
}

export function publishMessageRenderProjection(
	projection: Readonly<MessageRenderProjectionV1>,
	observers: readonly MessageRenderProjectionObserverV1[],
): void {
	for (const observer of observers) {
		try {
			observer(projection);
		} catch {
			// An observer cannot interrupt stock transcript rendering or later observers.
		}
	}
}

function attachCompletedTurns(
	members: readonly MessageRenderProjectionMemberV1[],
	readMessage: (entryId: string) => AgentMessage | undefined,
	settledTurns: readonly Readonly<SemanticTurnSettlementV1>[],
	inferMissingTurns: boolean,
): MessageRenderProjectionMemberV1[] {
	const completedMembers = [...members];
	const settledAssistantByUser = new Map<string, string>();
	const conflictedUsers = new Set<string>();
	for (const settlement of settledTurns) {
		const existing = settledAssistantByUser.get(settlement.userEntryId);
		if (existing && existing !== settlement.assistantEntryId) {
			conflictedUsers.add(settlement.userEntryId);
		} else if (!existing) {
			settledAssistantByUser.set(settlement.userEntryId, settlement.assistantEntryId);
		}
	}
	for (const userEntryId of conflictedUsers) settledAssistantByUser.delete(userEntryId);
	let userIndex: number | undefined;
	let userEntryId: string | undefined;
	let userPreview: string | undefined;
	let initiator: Readonly<ExternalAgentOriginV1> | undefined;
	let terminalAssistants: Array<{ entryId: string; preview: string | null }> = [];
	const completeTurn = (): void => {
		if (userIndex === undefined || userEntryId === undefined || userPreview === undefined) return;
		const user = completedMembers[userIndex];
		if (user?.role !== "user" || user.completedTurn) return;
		if (conflictedUsers.has(userEntryId)) return;
		const settledAssistantEntryId = settledAssistantByUser.get(userEntryId);
		const terminalAssistant = settledAssistantEntryId
			? terminalAssistants.find((assistant) => assistant.entryId === settledAssistantEntryId)
			: inferMissingTurns
				? terminalAssistants.at(-1)
				: undefined;
		if (!terminalAssistant) return;
		const completedTurn: MessageRenderCompletedTurnV1 = {
			assistantEntryId: terminalAssistant.entryId,
			userPreview,
			assistantPreview: terminalAssistant.preview,
			...(initiator ? { initiator } : {}),
		};
		completedMembers[userIndex] = { ...user, completedTurn };
	};
	for (const [index, member] of members.entries()) {
		if (member.role === "user") {
			completeTurn();
			userIndex = index;
			userEntryId = member.entryId;
			const message = readMessage(member.entryId);
			userPreview = userMessagePreview(message);
			initiator = message?.role === "user" ? copyExternalAgentOriginV1(message.initiator) : undefined;
			terminalAssistants = [];
			continue;
		}
		if (member.role !== "assistant" || userIndex === undefined) continue;
		const message = readMessage(member.entryId);
		const preview = terminalAssistantPreview(message);
		if (preview !== undefined) terminalAssistants.push({ entryId: member.entryId, preview });
	}
	completeTurn();
	return completedMembers;
}

function userMessagePreview(message: AgentMessage | undefined): string | undefined {
	if (message?.role !== "user") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content
					.filter(
						(content): content is Extract<(typeof message.content)[number], { type: "text" }> =>
							content.type === "text",
					)
					.map((content) => content.text)
					.join("");
	return boundedPreview(text);
}

function terminalAssistantPreview(message: AgentMessage | undefined): string | null | undefined {
	if (!isTerminalAssistantMessage(message)) return undefined;
	const text = message.content
		.filter(
			(content): content is Extract<(typeof message.content)[number], { type: "text" }> => content.type === "text",
		)
		.map((content) => content.text)
		.join("\n\n");
	return text.length === 0 && !message.content.some((content) => content.type === "text")
		? null
		: boundedPreview(text);
}

function boundedPreview(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_COMPLETED_TURN_PREVIEW_BYTES) return text;
	const codePoints: string[] = [];
	let bytes = Buffer.byteLength(COMPLETED_TURN_PREVIEW_ELLIPSIS, "utf8");
	for (const codePoint of text) {
		const size = Buffer.byteLength(codePoint, "utf8");
		if (bytes + size > MAX_COMPLETED_TURN_PREVIEW_BYTES) break;
		codePoints.push(codePoint);
		bytes += size;
	}
	return `${codePoints.join("")}${COMPLETED_TURN_PREVIEW_ELLIPSIS}`;
}
