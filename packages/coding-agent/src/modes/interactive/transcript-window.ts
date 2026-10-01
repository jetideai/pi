/**
 * Prototype policy: a section is the interval of the selected branch between two compaction entries.
 * The window is the section of the target, plus the adjacent section in the requested direction.
 * An empty section has no items, so the adjacent section is the nearest one that has items.
 */
export interface TranscriptWindowItem {
	/** The number of compaction entries before the item on the selected branch. */
	readonly section: number;
	readonly entryId?: string;
}

/** A member of the transcript, or the logical tail: the latest section that has items. */
export type TranscriptWindowTarget =
	| { readonly entryId: string; readonly adjacent?: "previous" | "next" }
	| { readonly tail: true };

/** The loaded item interval is [start, end). */
export type TranscriptWindowSelection =
	| { readonly status: "selected"; readonly start: number; readonly end: number; readonly liveTail: boolean }
	| { readonly status: "missing" };

export function selectTranscriptWindow(
	items: readonly TranscriptWindowItem[],
	target: TranscriptWindowTarget,
): TranscriptWindowSelection {
	const targetIndex = "tail" in target ? items.length - 1 : items.findIndex((item) => item.entryId === target.entryId);
	if (targetIndex < 0) return { status: "missing" };
	const adjacent = "tail" in target ? undefined : target.adjacent;
	const sectionStart = (index: number): number => {
		let start = index;
		while (start > 0 && items[start - 1]!.section === items[index]!.section) start -= 1;
		return start;
	};
	const sectionEnd = (index: number): number => {
		let end = index + 1;
		while (end < items.length && items[end]!.section === items[index]!.section) end += 1;
		return end;
	};
	let start = sectionStart(targetIndex);
	let end = sectionEnd(targetIndex);
	if (adjacent === "previous" && start > 0) start = sectionStart(start - 1);
	if (adjacent === "next" && end < items.length) end = sectionEnd(end);
	return { status: "selected", start, end, liveTail: end === items.length };
}
