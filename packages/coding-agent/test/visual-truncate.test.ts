import { Text } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { truncateToVisualLines } from "../src/modes/interactive/components/visual-truncate.ts";

describe("truncateToVisualLines", () => {
	it("preserves slice semantics and skipped counts for unusual limits", () => {
		for (const source of ["", " \n", "one two three four\nfive six\nseven\n"]) {
			for (const width of [7, 19]) {
				const full = new Text(source, 1, 0).render(width);
				for (const limit of [5, 1, 0, -1, 1.5, -1.5, Infinity, -Infinity, NaN]) {
					const expected =
						!source || full.length <= limit
							? { visualLines: full, skippedCount: 0 }
							: { visualLines: full.slice(-limit), skippedCount: full.length - limit };
					expect(truncateToVisualLines(source, limit, width, 1)).toEqual(expected);
				}
			}
		}
	});
});
