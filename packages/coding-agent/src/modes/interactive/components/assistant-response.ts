import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { MessageRenderProjectionMemberV1 } from "../../../core/extensions/types.ts";

export type AssistantContent = AssistantMessage["content"][number];
export type AssistantToolCall = Extract<AssistantContent, { type: "toolCall" }>;
export type AssistantResponseAtom =
	| { type: "visual"; content: Exclude<AssistantContent, { type: "toolCall" }>[] }
	| { type: "tools"; calls: AssistantToolCall[]; groupId?: string };

export interface AssistantResponseComposition {
	atoms: AssistantResponseAtom[];
	members: MessageRenderProjectionMemberV1[];
}

export function composeAssistantResponse(
	entryId: string,
	message: AssistantMessage,
	streaming = false,
	hideThinkingBlock = false,
): AssistantResponseComposition {
	const atoms: AssistantResponseAtom[] = [];
	for (const content of message.content) {
		if (content.type === "text" && !content.text.trim()) continue;
		if (content.type === "thinking" && (!content.thinking.trim() || (hideThinkingBlock && !streaming))) continue;
		if (content.type === "toolCall") {
			const previous = atoms.at(-1);
			if (previous?.type === "tools") previous.calls.push(content);
			else atoms.push({ type: "tools", calls: [content] });
			continue;
		}
		const previous = atoms.at(-1);
		if (previous?.type === "visual") previous.content.push(content);
		else atoms.push({ type: "visual", content: [content] });
	}

	const members: MessageRenderProjectionMemberV1[] = [{ entryId, blockId: entryId, role: "assistant" }];
	for (const atom of atoms) {
		if (atom.type !== "tools") continue;
		if (atom.calls.length === 1) {
			const call = atom.calls[0]!;
			members.push({ entryId: call.id, blockId: call.id, role: "tool", ownerEntryId: entryId });
			continue;
		}
		const groupId = `tool-group:${entryId}:${atom.calls[0]!.id}`;
		atom.groupId = groupId;
		members.push({
			entryId: groupId,
			blockId: groupId,
			role: "tool-group",
			ownerEntryId: entryId,
			groupId,
			groupClosed: !streaming,
		});
		for (const [groupOrder, call] of atom.calls.entries()) {
			members.push({
				entryId: call.id,
				blockId: call.id,
				role: "tool",
				ownerEntryId: entryId,
				groupId,
				groupOrder,
			});
		}
	}
	return { atoms, members };
}
