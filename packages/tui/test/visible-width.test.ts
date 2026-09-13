import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { visibleWidth } from "../src/utils.ts";

describe("visibleWidth", () => {
	const cases: { name: string; text: string; width: number }[] = [
		{ name: "empty text", text: "", width: 0 },
		{ name: "plain ASCII", text: "status ready", width: 12 },
		{ name: "leading styling", text: "\x1b[31mstatus", width: 6 },
		{ name: "trailing styling", text: "status\x1b[0m", width: 6 },
		{ name: "adjacent controls", text: "\x1b[1m\x1b[31mstatus\x1b[0m", width: 6 },
		{ name: "only controls", text: "\x1b[1m\x1b[0m", width: 0 },
		{ name: "cursor and erase controls", text: "a\x1b[3Gb\x1b[2Kc\x1b[1;1Hd\x1b[2J", width: 4 },
		{ name: "OSC hyperlink with BEL", text: "a\x1b]8;;https://example.test\x07link\x1b]8;;\x07z", width: 6 },
		{ name: "OSC hyperlink with ST", text: "a\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\z", width: 6 },
		{ name: "OSC prompt marker", text: "\x1b]133;A\x07prompt", width: 6 },
		{ name: "APC with BEL", text: "a\x1b_payload\x07b", width: 2 },
		{ name: "APC with ST", text: "a\x1b_pi:c\x1b\\b", width: 2 },
		{ name: "tabs around styling", text: "\t\x1b[31ma\t\x1b[0m\t", width: 10 },
		{ name: "tabs inside OSC and APC", text: "\x1b]0;a\tb\x07x\x1b_a\tb\x1b\\\ty", width: 5 },
		{ name: "styled CJK", text: "a\x1b[31m中文\x1b[0mb", width: 6 },
		{ name: "styled Cyrillic", text: "\x1b[31mПривет\x1b[0m", width: 6 },
		{ name: "combining mark across styling", text: "e\x1b[31m\u0301\x1b[0m", width: 1 },
		{ name: "emoji ZWJ across styling", text: "👩\x1b[31m\u200d💻\x1b[0m", width: 2 },
		{ name: "surrogate pair across styling", text: "\ud83d\x1b[31m\ude00\x1b[0m", width: 2 },
		{ name: "lone escape", text: "\x1b", width: 0 },
		{ name: "trailing escape", text: "abc\x1b", width: 3 },
		{ name: "unsupported escape", text: "a\x1bXb", width: 3 },
		{ name: "unterminated CSI", text: "a\x1b[31", width: 4 },
		{ name: "unsupported CSI terminator", text: "a\x1b[?25l", width: 6 },
		{ name: "unterminated OSC", text: "a\x1b]0;title", width: 9 },
		{ name: "unterminated APC", text: "a\x1b_payload", width: 9 },
		{ name: "malformed escape before styling", text: "a\x1bX\x1b[31mb\x1b[0m", width: 3 },
		{ name: "consecutive escapes before styling", text: "a\x1b\x1b[31mb", width: 2 },
		{ name: "unterminated OSC before styling", text: "a\x1b]oops\x1b[31mb", width: 7 },
		// extractAnsiCode accepts CSI content through the next supported terminator.
		{ name: "existing permissive CSI parsing", text: "a\x1b[badmZ", width: 2 },
	];

	for (const { name, text, width } of cases) {
		it(`measures ${name}`, () => {
			assert.equal(visibleWidth(text), width);
			assert.equal(visibleWidth(text), width, "cached width");
		});
	}

	it("measures long ordinary-text spans separated by controls", () => {
		const span = "status output ".repeat(1024);
		assert.equal(visibleWidth(`${span}\x1b[31m${span}\x1b[0m${span}`), span.length * 3);
	});
});
