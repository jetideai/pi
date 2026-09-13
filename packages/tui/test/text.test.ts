import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Text } from "../src/components/text.ts";
import { getGraphemeSegmenter } from "../src/utils.ts";

const sources = [
	"",
	" \t\n",
	"one two three four five six\nseven eight nine\n",
	"\x1b[4;44mone two three\r\nfour five\rsix\x1b[0m",
	"before \x1b]8;;https://example.com\x07linked words\nmore words\x1b]8;;\x07 after",
	"\x1b]8;;https://example.com\x1b\\01234567890123456789\x1b]8;;\x1b\\",
	"\x1b]133;A\x07hello world\x1b]133;B\x07",
	"one\ttwo 中文 é 👩‍💻 space ́x 🇨\n\x1b[broken",
];

describe("Text retained layout", () => {
	it("keeps full and tail output equivalent at new and repeated widths, including unusual limits", () => {
		for (const source of sources) {
			for (const padding of [0, 1, 2]) {
				for (const background of [undefined, (line: string) => `\x1b[41m${line}\x1b[49m`]) {
					const text = new Text(source, padding, padding, background);
					for (const width of [19, 7, 13, 1, 19]) {
						const full = new Text(source, padding, padding, background).render(width);
						assert.deepEqual(text.render(width), full);
						for (const limit of [5, 1, 0, -1, 1.5, -1.5, Infinity, -Infinity, NaN]) {
							const tail = text.renderTail(width, limit);
							assert.equal(tail.totalLines, full.length);
							assert.deepEqual(tail.lines, full.length <= limit ? full : full.slice(-limit));
						}
						assert.deepEqual(text.render(width), full);
					}
				}
			}
		}
	});

	it("replaces prepared content on streaming updates and invalidates background output", () => {
		const text = new Text("old output ".repeat(10), 1, 1);
		text.render(11);
		for (const source of ["replacement", "replacement with appended words 中文", "", "final"]) {
			text.setText(source);
			for (const width of [11, 8, 17]) {
				const fresh = new Text(source, 1, 1);
				assert.deepEqual(text.renderTail(width, 2).lines, fresh.render(width).slice(-2));
				assert.deepEqual(text.render(width), fresh.render(width));
			}
		}
		let color = "41";
		const background = (line: string) => `\x1b[${color}m${line}\x1b[0m`;
		text.setCustomBgFn(background);
		assert.deepEqual(text.render(11), new Text("final", 1, 1, background).render(11));
		color = "44";
		text.invalidate();
		assert.deepEqual(text.renderTail(11, 2).lines, new Text("final", 1, 1, background).render(11).slice(-2));
		text.setCustomBgFn(undefined);
		assert.deepEqual(text.render(11), new Text("final", 1, 1).render(11));
	});

	it("does not resegment the current source at new widths, but prepares replaced text", (context) => {
		const source = "café résumé naïve élève ".repeat(30);
		const text = new Text(source, 0, 0);
		text.render(18);
		const segmentation = context.mock.method(getGraphemeSegmenter(), "segment");
		text.render(13);
		text.render(22);
		assert.ok(!segmentation.mock.calls.some((call) => call.arguments[0] === source));
		const replacement = "updated élève output ".repeat(30);
		text.setText(replacement);
		text.render(13);
		assert.ok(segmentation.mock.calls.some((call) => call.arguments[0] === replacement));
	});

	it("applies background only to displayed tail rows", () => {
		const painted: string[] = [];
		const text = new Text("one\ntwo\nthree\nfour\nfive\nsix", 0, 0, (line) => {
			painted.push(line);
			return line;
		});
		assert.deepEqual(text.renderTail(8, 2), { lines: ["five    ", "six     "], totalLines: 6 });
		assert.deepEqual(painted, ["five    ", "six     "]);
	});
});
