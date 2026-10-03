import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { toolCallOutcome, UncommittedToolResults } from "../src/modes/interactive/uncommitted-tool-results.ts";

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

describe("uncommitted Tool Call results", () => {
	it("keeps the latest partial result of repeated updates", () => {
		const results = new UncommittedToolResults();
		results.update("call-a", text("one"));
		results.update("call-a", text("two"));

		expect(results.get("call-a")).toEqual({
			result: { ...text("two"), details: undefined, isError: false },
			partial: true,
		});
	});

	it("replaces the partial result with the final result at the end of the execution", () => {
		const results = new UncommittedToolResults();
		results.update("call-a", text("one"));
		results.end("call-a", text("failed"), true);

		expect(results.get("call-a")).toEqual({
			result: { ...text("failed"), details: undefined, isError: true },
			partial: false,
		});
	});

	it("drops a result that the history committed, so a later read does not bring it back", () => {
		const results = new UncommittedToolResults();
		results.end("call-a", text("done"), false);
		results.commit("call-a");
		results.update("call-b", text("other"));

		expect([results.get("call-a"), results.get("call-b")?.partial]).toEqual([undefined, true]);
	});

	it("drops every result at the end of the run", () => {
		const results = new UncommittedToolResults();
		results.update("call-a", text("one"));
		results.end("call-b", text("done"), false);
		results.endRun();

		expect([results.get("call-a"), results.get("call-b")]).toEqual([undefined, undefined]);
	});
});

describe("Tool Call outcome from history", () => {
	const response = (stopReason: AssistantMessage["stopReason"]) => ({ stopReason }) as AssistantMessage;
	const result = (isError: boolean) => ({ isError }) as ToolResultMessage;

	it.each([
		["a successful result", response("toolUse"), result(false), "success"],
		["a failed result", response("toolUse"), result(true), "failed"],
		["an aborted response without a result", response("aborted"), undefined, "cancelled"],
		["a failed response without a result", response("error"), undefined, "cancelled"],
		["a call that has no result yet", response("toolUse"), undefined, undefined],
	] as const)("gives %s its outcome", (_name, message, toolResult, outcome) => {
		expect(toolCallOutcome(message, toolResult)).toBe(outcome);
	});
});
