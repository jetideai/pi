export interface ObservedTranscriptCounts {
	entries: number;
	toolCalls: number;
	toolResults: number;
	groups: number;
	singletons: number;
}

export interface ObservedComponentCounts {
	groups: number;
	singletons: number;
	toolCalls: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function deriveTranscriptCounts(entries: readonly unknown[]): ObservedTranscriptCounts {
	let toolCalls = 0;
	let toolResults = 0;
	let groups = 0;
	let singletons = 0;
	for (const entry of entries) {
		const message = record(record(entry)?.message);
		if (message?.role === "toolResult") toolResults += 1;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const callsInMessage = message.content.filter((content) => record(content)?.type === "toolCall").length;
		toolCalls += callsInMessage;
		if (callsInMessage > 1) groups += 1;
		if (callsInMessage === 1) singletons += 1;
	}
	return { entries: entries.length, toolCalls, toolResults, groups, singletons };
}

export function deriveComponentCounts(
	root: unknown,
	isTool: (component: unknown) => boolean,
	isGroup: (component: unknown) => boolean,
): ObservedComponentCounts {
	let groups = 0;
	let toolCalls = 0;
	let groupedToolCalls = 0;
	const visit = (component: unknown, insideGroup: boolean): void => {
		const group = isGroup(component);
		if (group) groups += 1;
		if (isTool(component)) {
			toolCalls += 1;
			if (insideGroup) groupedToolCalls += 1;
		}
		const children = record(component)?.children;
		if (!Array.isArray(children)) return;
		for (const child of children) visit(child, insideGroup || group);
	};
	visit(root, false);
	return { groups, singletons: toolCalls - groupedToolCalls, toolCalls };
}
