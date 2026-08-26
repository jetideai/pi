import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	getMarkdownTheme,
	loadThemeFromPath,
	setThemeInstance,
	type Theme,
} from "../src/modes/interactive/theme/theme.ts";

const CODE_FG = "\x1b[38;2;0;255;255m";
const CODE_BG = "\x1b[48;2;46;49;54m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

const tempDirs: string[] = [];

type ThemeJsonFile = { name: string; colors: Record<string, string | number> };

function themeJson(name: string, withCodeBg: boolean): ThemeJsonFile {
	const json = JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	) as ThemeJsonFile;
	json.name = name;
	json.colors.mdCode = "#00ffff";
	if (withCodeBg) {
		json.colors.mdCodeBg = "#2e3136";
	}
	return json;
}

function loadTheme(json: ThemeJsonFile): Theme {
	const testDir = mkdtempSync(join(tmpdir(), "pi-md-code-bg-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${json.name}.json`);
	writeFileSync(themePath, JSON.stringify(json));
	return loadThemeFromPath(themePath, "truecolor");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("optional inline code background token", () => {
	it("paints inline code on the chip background when mdCodeBg is set", () => {
		setThemeInstance(loadTheme(themeJson("md-code-bg", true)));

		const styled = getMarkdownTheme().code("greeting");

		expect(styled).toBe(`${CODE_BG}${CODE_FG}greeting${FG_RESET}${BG_RESET}`);
	});

	it("keeps foreground-only inline code when mdCodeBg is absent", () => {
		setThemeInstance(loadTheme(themeJson("md-code-fg-only", false)));

		const styled = getMarkdownTheme().code("greeting");

		expect(styled).toBe(`${CODE_FG}greeting${FG_RESET}`);
		expect(styled).not.toContain("\x1b[48;");
	});
});

describe("optional code block background token", () => {
	const BLOCK_BG = "\x1b[48;2;33;35;38m";

	function blockThemeJson(name: string, withBlockBg: boolean): ThemeJsonFile {
		const json = themeJson(name, false);
		json.colors.mdCodeBlock = "#00ffff";
		if (withBlockBg) {
			json.colors.mdCodeBlockBg = "#212326";
		}
		return json;
	}

	it("paints code block lines and fences on the block background", () => {
		setThemeInstance(loadTheme(blockThemeJson("md-code-block-bg", true)));
		const markdownTheme = getMarkdownTheme();

		const fence = markdownTheme.codeBlockBorder("```ts");
		const lines = markdownTheme.highlightCode?.("const x = 1\nconst y = 2") ?? [];

		expect(fence.startsWith(BLOCK_BG)).toBe(true);
		expect(fence.endsWith("\x1b[49m")).toBe(true);
		expect(lines).toHaveLength(2);
		for (const line of lines) {
			expect(line.startsWith(BLOCK_BG)).toBe(true);
			expect(line.endsWith("\x1b[49m")).toBe(true);
		}
	});

	it("keeps foreground-only code blocks when mdCodeBlockBg is absent", () => {
		setThemeInstance(loadTheme(blockThemeJson("md-code-block-fg-only", false)));
		const markdownTheme = getMarkdownTheme();

		const fence = markdownTheme.codeBlockBorder("```ts");
		const lines = markdownTheme.highlightCode?.("const x = 1") ?? [];

		expect(fence).not.toContain("\x1b[48;");
		expect(lines[0]).not.toContain("\x1b[48;");
	});
});
