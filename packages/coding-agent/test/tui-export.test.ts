import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { getMarkdownTheme } from "../src/index.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { Component, DefaultTextStyle, MarkdownOptions, MarkdownTheme } from "../src/tui.ts";
import * as tui from "../src/tui.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("coding-agent TUI entry point", () => {
	test("exports only the standard components and the required renderer types", () => {
		const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
		expect(manifest.exports["./tui"]).toEqual({
			types: "./dist/tui.d.ts",
			import: "./dist/tui.js",
		});
		expect(Object.keys(tui).sort()).toEqual(["Box", "Markdown", "Spacer", "Text"]);
		initTheme("dark");
		const markdownTheme: MarkdownTheme = getMarkdownTheme();
		const style: DefaultTextStyle = {};
		const options: MarkdownOptions = {};
		const component: Component = new tui.Markdown("# Heading\n\n- **Item**", 0, 0, markdownTheme, style, options);
		const output = component.render(60).map(stripAnsi).join("\n");
		expect(output).toContain("Heading");
		expect(output).toContain("Item");
		expect(output).not.toContain("# Heading");
		expect(output).not.toContain("**Item**");
	});
});
