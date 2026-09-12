export interface ObservedTranscriptCounts {
	entries: number;
	toolCalls: number;
	toolResults: number;
	groupableRuns: number;
	singletonRuns: number;
}

export interface ObservedComponentCounts {
	toolExecutionComponents: number;
	toolGroupComponents: number;
	directToolExecutionComponents: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function deriveTranscriptCounts(entries: readonly unknown[]): ObservedTranscriptCounts {
	let toolCalls = 0;
	let toolResults = 0;
	let groupableRuns = 0;
	let singletonRuns = 0;
	for (const entry of entries) {
		const message = record(record(entry)?.message);
		if (message?.role === "toolResult") toolResults += 1;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
		const callsInMessage = message.content.filter((content) => record(content)?.type === "toolCall").length;
		toolCalls += callsInMessage;
		if (callsInMessage > 1) groupableRuns += 1;
		if (callsInMessage === 1) singletonRuns += 1;
	}
	return { entries: entries.length, toolCalls, toolResults, groupableRuns, singletonRuns };
}

export function deriveComponentCounts(
	root: unknown,
	isTool: (component: unknown) => boolean,
	isGroup: (component: unknown) => boolean,
): ObservedComponentCounts {
	let toolExecutionComponents = 0;
	let toolGroupComponents = 0;
	let groupedToolExecutionComponents = 0;
	const visit = (component: unknown, insideGroup: boolean): void => {
		const group = isGroup(component);
		if (group) toolGroupComponents += 1;
		if (isTool(component)) {
			toolExecutionComponents += 1;
			if (insideGroup) groupedToolExecutionComponents += 1;
		}
		const value = record(component);
		const children = value?.children;
		if (Array.isArray(children)) {
			for (const child of children) visit(child, insideGroup || group);
		}
		if (value?.component !== undefined) visit(value.component, insideGroup || group);
	};
	visit(root, false);
	return {
		toolExecutionComponents,
		toolGroupComponents,
		directToolExecutionComponents: toolExecutionComponents - groupedToolExecutionComponents,
	};
}
