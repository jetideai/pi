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

/** One item of a transcript in render order, as the Tool Group run rule sees it. */
export type ToolGroupRunItem = (
	| { type: "response"; entryId: string; message: AssistantMessage }
	/** A visible block that is not an assistant response. */
	| { type: "boundary" }
	/** A tool result, or an entry that renders nothing. */
	| { type: "transparent" }
) & {
	/** The item starts a new compaction section or the loaded window, so no run continues into it. */
	cutBefore?: boolean;
};

/**
 * Compose the assistant responses of one transcript segment. A Tool Group is the maximal nonempty run of Tool Calls
 * with no visible assistant atom, boundary item or cut between them, so each call is in exactly one group. Hidden
 * settled thinking, empty text and transparent items do not stop a run. The group ID comes from the first call, and the
 * group member comes before that call, so a call that joins the run is an append. Each call keeps the response that
 * owns it; the group has no owner. Only a group with two or more calls shows a group header and Fold.
 *
 * A group is closed when visible content, a boundary or a cut ends its run. While [tailOpen], the run at the end of the
 * items can still take calls, so its group stays open; the end of a response does not close it. Returns one
 * composition for each response item and undefined for the other items.
 */
export function composeTranscriptResponses(
	items: readonly ToolGroupRunItem[],
	tailOpen = false,
	hideThinkingBlock = false,
): (AssistantResponseComposition | undefined)[] {
	const atomsByItem = items.map((item) =>
		item.type === "response" ? responseAtoms(item.message, hideThinkingBlock) : undefined,
	);
	const runs: Extract<AssistantResponseAtom, { type: "tools" }>[][] = [];
	let run: Extract<AssistantResponseAtom, { type: "tools" }>[] | undefined;
	for (const [index, item] of items.entries()) {
		if (item.cutBefore) run = undefined;
		if (item.type === "transparent") continue;
		if (item.type === "boundary") {
			run = undefined;
			continue;
		}
		for (const atom of atomsByItem[index]!) {
			if (atom.type === "visual") {
				run = undefined;
				continue;
			}
			if (!run) {
				run = [];
				runs.push(run);
			}
			run.push(atom);
		}
	}
	const openGroupId = tailOpen && run ? `tool-group:${run[0]!.calls[0]!.id}` : undefined;
	for (const toolAtoms of runs) {
		const groupId = `tool-group:${toolAtoms[0]!.calls[0]!.id}`;
		for (const atom of toolAtoms) atom.groupId = groupId;
	}

	const nextOrder = new Map<string, number>();
	return items.map((item, index) => {
		if (item.type !== "response") return undefined;
		const atoms = atomsByItem[index]!;
		const members: MessageRenderProjectionMemberV1[] = [
			{ entryId: item.entryId, blockId: item.entryId, role: "assistant" },
		];
		for (const atom of atoms) {
			if (atom.type !== "tools") continue;
			for (const call of atom.calls) {
				const groupId = atom.groupId!;
				const groupOrder = nextOrder.get(groupId) ?? 0;
				if (groupOrder === 0) {
					members.push({
						entryId: groupId,
						blockId: groupId,
						role: "tool-group",
						groupId,
						groupClosed: groupId !== openGroupId,
					});
				}
				members.push({
					entryId: call.id,
					blockId: call.id,
					role: "tool",
					ownerEntryId: item.entryId,
					groupId,
					groupOrder,
				});
				nextOrder.set(groupId, groupOrder + 1);
			}
		}
		return { atoms, members };
	});
}

/** Compose one response as its own transcript segment: its Tool Groups stay inside the response. */
export function composeAssistantResponse(
	entryId: string,
	message: AssistantMessage,
	tailOpen = false,
	hideThinkingBlock = false,
): AssistantResponseComposition {
	return composeTranscriptResponses([{ type: "response", entryId, message }], tailOpen, hideThinkingBlock)[0]!;
}

/** Hidden thinking gives no atom, also while it streams: it is never visible content between calls. */
function responseAtoms(message: AssistantMessage, hideThinkingBlock: boolean): AssistantResponseAtom[] {
	const atoms: AssistantResponseAtom[] = [];
	for (const content of message.content) {
		if (content.type === "text" && !content.text.trim()) continue;
		if (content.type === "thinking" && (!content.thinking.trim() || hideThinkingBlock)) continue;
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
	return atoms;
}
