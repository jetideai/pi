import { describe, expect, it } from "vitest";
import { serializeTarget } from "../benchmark/long-transcript.ts";
import { deriveComponentCounts, deriveTranscriptCounts } from "../benchmark/long-transcript-structure.ts";
import {
	createSyntheticLongTranscript,
	SYNTHETIC_ENTRY_COUNT,
	SYNTHETIC_GROUP_COUNT,
	SYNTHETIC_SINGLETON_COUNT,
	SYNTHETIC_TOOL_CALL_COUNT,
	SYNTHETIC_TOOL_RESULT_COUNT,
} from "./helpers/synthetic-long-transcript.ts";

describe("long-transcript benchmark evidence", () => {
	it("removes filesystem roots from serialized target metadata", () => {
		const serialized = serializeTarget({
			label: "stock",
			root: "/Users/private/source/pi",
			expectedRevision: "expected",
			actualRevision: "actual",
			packageVersions: { codingAgent: "0.85.1", tui: "0.85.1" },
		});

		expect(serialized).toEqual({
			label: "stock",
			expectedRevision: "expected",
			actualRevision: "actual",
			packageVersions: { codingAgent: "0.85.1", tui: "0.85.1" },
		});
		expect(JSON.stringify(serialized)).not.toContain("/Users/private/source/pi");
	});

	it("derives transcript counts from restored entries", () => {
		const fixture = createSyntheticLongTranscript();
		const entries = fixture.messages.map(({ message }, index) => ({
			type: "message",
			id: `observed-${index}`,
			message,
		}));

		expect(deriveTranscriptCounts(entries)).toEqual({
			entries: SYNTHETIC_ENTRY_COUNT,
			toolCalls: SYNTHETIC_TOOL_CALL_COUNT,
			toolResults: SYNTHETIC_TOOL_RESULT_COUNT,
			groups: SYNTHETIC_GROUP_COUNT,
			singletons: SYNTHETIC_SINGLETON_COUNT,
		});
	});

	it("derives group and singleton counts from the component tree", () => {
		const tool = () => ({ kind: "tool" as const });
		const groups = Array.from({ length: SYNTHETIC_GROUP_COUNT }, () => ({
			kind: "group" as const,
			children: [tool(), tool()],
		}));
		const root = { children: [...groups, tool(), tool()] };

		expect(
			deriveComponentCounts(
				root,
				(component) => (component as { kind?: string }).kind === "tool",
				(component) => (component as { kind?: string }).kind === "group",
			),
		).toEqual({
			groups: SYNTHETIC_GROUP_COUNT,
			singletons: SYNTHETIC_SINGLETON_COUNT,
			toolCalls: SYNTHETIC_TOOL_CALL_COUNT,
		});
	});
});
