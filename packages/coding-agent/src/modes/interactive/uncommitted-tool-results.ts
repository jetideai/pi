import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";

/** A Tool Call result that the session history does not have yet. */
export interface UncommittedToolResult {
	result: { content: ToolResultMessage["content"]; details?: unknown; isError: boolean };
	/** True from the first update to the end of the execution; false from the end to the commit of the result. */
	partial: boolean;
}

/**
 * The Tool Call results that only the execution events carry. The agent state owns which calls execute, and the session
 * history owns each committed result. A view that a rebuild creates again starts from these results, so an update does
 * not depend on a mounted component.
 */
export class UncommittedToolResults {
	private readonly results = new Map<string, UncommittedToolResult>();

	update(toolCallId: string, partialResult: { content?: ToolResultMessage["content"]; details?: unknown }): void {
		this.results.set(toolCallId, {
			result: { content: partialResult.content ?? [], details: partialResult.details, isError: false },
			partial: true,
		});
	}

	end(
		toolCallId: string,
		result: { content?: ToolResultMessage["content"]; details?: unknown },
		isError: boolean,
	): void {
		this.results.set(toolCallId, {
			result: { content: result.content ?? [], details: result.details, isError },
			partial: false,
		});
	}

	/** The history has the result of the call now. */
	commit(toolCallId: string): void {
		this.results.delete(toolCallId);
	}

	/** A run that ended commits no more results: the history alone gives each call of the run its outcome. */
	endRun(): void {
		this.results.clear();
	}

	get(toolCallId: string): UncommittedToolResult | undefined {
		return this.results.get(toolCallId);
	}
}

/**
 * The outcome of a Tool Call from the session history. A call of a response that was aborted or that failed never ran
 * and has no result; it is cancelled, which is neither a success nor a failure of the call.
 */
export function toolCallOutcome(
	response: AssistantMessage,
	result: ToolResultMessage | undefined,
): "success" | "failed" | "cancelled" | undefined {
	if (result) return result.isError ? "failed" : "success";
	return response.stopReason === "aborted" || response.stopReason === "error" ? "cancelled" : undefined;
}
