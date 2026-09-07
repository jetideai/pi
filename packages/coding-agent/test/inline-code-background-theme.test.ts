import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import {
	getMarkdownTheme,
	loadThemeFromPath,
	setThemeInstance,
	type Theme,
} from "../src/modes/interactive/theme/theme.ts";

const CODE_FG = "\x1b[38;2;0;255;255m";
const CODE_BG = "\x1b[48;2;46;49;54m";
const USER_BG = "\x1b[48;2;17;34;51m";
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
	json.colors.userMessageBg = "#112233";
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

	it("restores the enclosing user-message background after an inline code chip", () => {
		setThemeInstance(loadTheme(themeJson("md-code-user-message", true)));
		const component = new UserMessageComponent("before `greeting` after", getMarkdownTheme(), 0);

		const contentRow = component.render(80).find((line) => line.includes("greeting"));
		const codeEnd = contentRow?.indexOf(BG_RESET, contentRow.indexOf("greeting"));

		expect(codeEnd).toBeGreaterThanOrEqual(0);
		expect(contentRow?.slice(codeEnd! + BG_RESET.length).startsWith(USER_BG)).toBe(true);
	});

	it("keeps foreground-only inline code when mdCodeBg is absent", () => {
		setThemeInstance(loadTheme(themeJson("md-code-fg-only", false)));

		const styled = getMarkdownTheme().code("greeting");

		expect(styled).toBe(`${CODE_FG}greeting${FG_RESET}`);
		expect(styled).not.toContain("\x1b[48;");
	});
});
