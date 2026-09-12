import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";

export const SYNTHETIC_TOOL_CALL_COUNT = 1_550;
export const SYNTHETIC_TOOL_RESULT_COUNT = 1_550;
export const SYNTHETIC_ENTRY_COUNT = 3_102;
export const SYNTHETIC_GROUP_COUNT = 774;
export const SYNTHETIC_SINGLETON_COUNT = 2;
export const SYNTHETIC_TURN_COUNT = SYNTHETIC_GROUP_COUNT + SYNTHETIC_SINGLETON_COUNT;

export interface SyntheticTranscriptMessage {
	entryId: string;
	message: UserMessage | AssistantMessage | ToolResultMessage;
}

export interface SyntheticLongTranscript {
	messages: SyntheticTranscriptMessage[];
	orderedMarkers: string[];
	toolCallIds: string[];
	assistantEntryIds: string[];
}

function serial(prefix: string, value: number): string {
	return `${prefix}${value.toString().padStart(4, "0")}`;
}

function assistantMessage(turn: number, toolCallIds: readonly string[]): AssistantMessage {
	const assistantMarker = serial("A", turn);
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text: `${assistantMarker} ${"width-sensitive assistant content ".repeat(5)}`,
			},
			...toolCallIds.map((toolCallId) => ({
				type: "toolCall" as const,
				id: toolCallId,
				name: "read",
				arguments: {
					path: `${toolCallId}/${"wrapped-path-segment-".repeat(6)}notes.ts`,
				},
			})),
		],
		api: "openai-responses",
		provider: "openai",
		model: "synthetic",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2_000 + turn,
	};
}

export function createSyntheticLongTranscript(): SyntheticLongTranscript {
	const messages: SyntheticTranscriptMessage[] = [];
	const orderedMarkers: string[] = [];
	const toolCallIds: string[] = [];
	const assistantEntryIds: string[] = [];
	let toolIndex = 0;

	for (let turn = 0; turn < SYNTHETIC_TURN_COUNT; turn++) {
		const userMarker = serial("U", turn);
		const assistantMarker = serial("A", turn);
		const userEntryId = `user-${turn.toString().padStart(3, "0")}`;
		const assistantEntryId = `assistant-${turn.toString().padStart(3, "0")}`;
		const callsInTurn = turn < SYNTHETIC_GROUP_COUNT ? 2 : 1;
		const turnToolCallIds = Array.from({ length: callsInTurn }, () => serial("TC", toolIndex++));

		const user: UserMessage = {
			role: "user",
			content: `${userMarker} ${"width-sensitive user content ".repeat(5)}`,
			timestamp: 1_000 + turn,
		};
		messages.push({ entryId: userEntryId, message: user });
		messages.push({ entryId: assistantEntryId, message: assistantMessage(turn, turnToolCallIds) });
		assistantEntryIds.push(assistantEntryId);
		orderedMarkers.push(userMarker, assistantMarker);

		for (const toolCallId of turnToolCallIds) {
			const resultMarker = toolCallId.replace("TC", "TR");
			const result: ToolResultMessage = {
				role: "toolResult",
				toolCallId,
				toolName: "read",
				content: [
					{
						type: "text",
						text: `${resultMarker} ${"width-sensitive result content ".repeat(5)}`,
					},
				],
				isError: false,
				timestamp: 3_000 + toolCallIds.length,
			};
			messages.push({ entryId: `result-${toolCallId}`, message: result });
			toolCallIds.push(toolCallId);
			orderedMarkers.push(toolCallId, resultMarker);
		}
	}

	if (messages.length !== SYNTHETIC_ENTRY_COUNT) {
		throw new Error(`Synthetic transcript has ${messages.length} entries, expected ${SYNTHETIC_ENTRY_COUNT}`);
	}
	if (toolCallIds.length !== SYNTHETIC_TOOL_CALL_COUNT) {
		throw new Error(
			`Synthetic transcript has ${toolCallIds.length} Tool Calls, expected ${SYNTHETIC_TOOL_CALL_COUNT}`,
		);
	}

	return { messages, orderedMarkers, toolCallIds, assistantEntryIds };
}
