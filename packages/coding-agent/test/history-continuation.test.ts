import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { MessageRenderBoundaryContextV1 } from "../src/core/extensions/types.ts";
import { continuationRule, HistoryContinuationRow } from "../src/modes/interactive/components/history-continuation.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const controls = { begin: "\x1b]777;begin\x07", end: "\x1b]777;end\x07" };

describe("history continuation row", () => {
	beforeAll(() => initTheme("dark"));

	it.each([
		["earlier", 9, "─── ↑ ───"],
		["later", 10, "─── ↓ ────"],
		["earlier", 3, " ↑ "],
		["later", 2, "↓"],
		["earlier", 0, ""],
	] as const)("draws the %s rule at width %i with the arrow in the middle", (side, width, rule) => {
		expect(continuationRule(side, width)).toBe(rule);
	});

	it("renders one dim row of the full width without decorators", () => {
		const rows = new HistoryContinuationRow("later").render(40);

		expect([rows.length, visibleWidth(rows[0]!), stripAnsi(rows[0]!)]).toEqual([
			1,
			40,
			continuationRule("later", 40),
		]);
	});

	it("marks its row as a plain continuation range of its side, with no body", () => {
		const candidates: unknown[] = [];
		const contexts: MessageRenderBoundaryContextV1[] = [];
		const row = new HistoryContinuationRow("earlier", {
			producerSessionId: "session-a",
			renderScopeId: "scope-a",
			semanticSelectorsV3: [
				(candidate) => {
					candidates.push(candidate);
					return (context) => {
						contexts.push(context);
						return controls;
					};
				},
			],
		});

		const rows = row.render(30);

		expect({
			candidate: candidates[0],
			role: contexts[0]?.role,
			body: contexts[0]?.bodyRow,
			row: rows[0]?.startsWith(controls.begin) && rows[0]?.endsWith(controls.end),
		}).toEqual({
			candidate: {
				producerSessionId: "session-a",
				renderScopeId: "scope-a",
				entryId: "history-continuation:earlier",
				blockId: "earlier",
				role: "continuation",
				state: "expanded",
			},
			role: "continuation",
			body: undefined,
			row: true,
		});
	});
});
