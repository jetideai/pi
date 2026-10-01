/**
 * Prototype policy: one section contains four complete turns. This is a fixture size, not a work bound.
 */
export const TRANSCRIPT_WINDOW_SECTION_TURNS = 4;

/**
 * "user" starts a turn, "turn" continues the current turn, and "attached" belongs to the next turn.
 * Attached items after the last turn stay in the last turn.
 */
export interface TranscriptWindowItem {
	readonly kind: "user" | "turn" | "attached";
	readonly entryId?: string;
}

export interface TranscriptWindowTarget {
	readonly entryId: string;
	readonly adjacent?: "previous" | "next";
}

/** The loaded item interval is [start, end). */
export type TranscriptWindowSelection =
	| { readonly status: "selected"; readonly start: number; readonly end: number; readonly liveTail: boolean }
	| { readonly status: "missing" };

export function selectTranscriptWindow(
	items: readonly TranscriptWindowItem[],
	target: TranscriptWindowTarget,
): TranscriptWindowSelection {
	const sectionTurns = TRANSCRIPT_WINDOW_SECTION_TURNS;
	const targetIndex = items.findIndex((item) => item.entryId === target.entryId);
	if (targetIndex < 0) return { status: "missing" };
	const turnStarts = [0];
	for (const [index, item] of items.entries()) {
		if (item.kind !== "user") continue;
		let start = index;
		while (start > 0 && items[start - 1]!.kind === "attached") start -= 1;
		if (start > turnStarts.at(-1)!) turnStarts.push(start);
	}
	const sectionStart = (section: number): number => turnStarts[section * sectionTurns] ?? items.length;
	const sectionCount = Math.ceil(turnStarts.length / sectionTurns);
	let targetTurn = 0;
	while (turnStarts[targetTurn + 1] !== undefined && turnStarts[targetTurn + 1]! <= targetIndex) targetTurn += 1;
	const section = Math.floor(targetTurn / sectionTurns);
	const first = target.adjacent === "previous" ? Math.max(section - 1, 0) : section;
	const last = target.adjacent === "next" ? Math.min(section + 1, sectionCount - 1) : section;
	const end = sectionStart(last + 1);
	return { status: "selected", start: sectionStart(first), end, liveTail: end === items.length };
}
