import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	MessageRenderCompletedTurnV1,
	MessageRenderFinalizedEntryV1,
	MessageRenderProjectionMemberV1,
	MessageRenderProjectionObserverV1,
	MessageRenderProjectionV1,
} from "../../../core/extensions/types.ts";

const MAX_COMPLETED_TURN_PREVIEW_BYTES = 4 * 1024;
const COMPLETED_TURN_PREVIEW_ELLIPSIS = "…";

export interface BuildMessageRenderProjectionOptions {
	producerSessionId: string;
	renderScopeId: string;
	members: readonly MessageRenderProjectionMemberV1[];
	mode: "append" | "replace";
	finalized?: MessageRenderFinalizedEntryV1;
	completeLastTurn?: boolean;
	readMessage(entryId: string): AgentMessage | undefined;
}

export function buildMessageRenderProjection(
	options: BuildMessageRenderProjectionOptions,
): Readonly<MessageRenderProjectionV1> {
	const members = attachCompletedTurns(options.members, options.readMessage, options.completeLastTurn ?? false).map(
		(member) =>
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
	completeLastTurn: boolean,
): MessageRenderProjectionMemberV1[] {
	const completedMembers = [...members];
	let userIndex: number | undefined;
	let userPreview: string | undefined;
	let terminalAssistant: { entryId: string; preview: string | null } | undefined;
	let terminalAssistantSucceeded = false;
	const completeTurn = (): void => {
		if (userIndex === undefined || userPreview === undefined || terminalAssistant === undefined) return;
		const user = completedMembers[userIndex];
		if (user?.role !== "user" || user.completedTurn) return;
		const completedTurn: MessageRenderCompletedTurnV1 = {
			assistantEntryId: terminalAssistant.entryId,
			userPreview,
			assistantPreview: terminalAssistant.preview,
		};
		completedMembers[userIndex] = { ...user, completedTurn };
	};
	for (const [index, member] of members.entries()) {
		if (member.role === "user") {
			completeTurn();
			userIndex = index;
			userPreview = userMessagePreview(readMessage(member.entryId));
			terminalAssistant = undefined;
			terminalAssistantSucceeded = false;
			continue;
		}
		if (member.role !== "assistant" || userIndex === undefined) continue;
		const message = readMessage(member.entryId);
		const preview = terminalAssistantPreview(message);
		if (preview !== undefined && (terminalAssistant === undefined || !terminalAssistantSucceeded)) {
			terminalAssistant = { entryId: member.entryId, preview };
			terminalAssistantSucceeded =
				message?.role === "assistant" && (message.stopReason === "stop" || message.stopReason === "length");
		}
	}
	if (completeLastTurn) completeTurn();
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
	if (
		message?.role !== "assistant" ||
		message.stopReason === "pending" ||
		message.stopReason === "toolUse" ||
		message.stopReason === "deferred"
	) {
		return undefined;
	}
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
