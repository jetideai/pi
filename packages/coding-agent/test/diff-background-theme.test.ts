import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { renderDiff } from "../src/modes/interactive/components/diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { loadThemeFromPath, setThemeInstance, type Theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ADDED_BG = "\x1b[48;2;10;58;10m";
const REMOVED_BG = "\x1b[48;2;58;10;10m";
const ADDED_SOFT_BG = "\x1b[48;2;5;29;5m";
const REMOVED_SOFT_BG = "\x1b[48;2;29;5;5m";
const ADDED_FG = "\x1b[38;2;0;255;0m";
const REMOVED_FG = "\x1b[38;2;255;0;0m";
const CONTEXT_FG = "\x1b[38;2;136;136;136m";
const FG_RESET = "\x1b[39m";
const BG_RESET = "\x1b[49m";

/**
 * Covers a context line, a modified pair, a standalone added line and a
 * removed-only group.
 */
const DIFF = [
	" 1 const keep = true;",
	"-2 const value = 1;",
	"+2 const value = 2;",
	" 3 const tail = true;",
	"+4 const added = true;",
	"-5 const goneOne = 1;",
	"-6 const goneTwo = 2;",
	"     ...",
].join("\n");

/**
 * Output of renderDiff for DIFF before the diff background tokens existed.
 * Captured from the previous implementation, so it pins legacy rendering.
 */
const LEGACY_OUTPUT =
	"\x1b[38;2;136;136;136m 1 const keep = true;\x1b[39m\n" +
	"\x1b[38;2;255;0;0m-2 const value = \x1b[7m1\x1b[27m;\x1b[39m\n" +
	"\x1b[38;2;0;255;0m+2 const value = \x1b[7m2\x1b[27m;\x1b[39m\n" +
	"\x1b[38;2;136;136;136m 3 const tail = true;\x1b[39m\n" +
	"\x1b[38;2;0;255;0m+4 const added = true;\x1b[39m\n" +
	"\x1b[38;2;255;0;0m-5 const goneOne = 1;\x1b[39m\n" +
	"\x1b[38;2;255;0;0m-6 const goneTwo = 2;\x1b[39m\n" +
	"\x1b[38;2;136;136;136m     ...\x1b[39m";

const tempDirs: string[] = [];
let previousChalkLevel: typeof chalk.level;

type ThemeJsonFile = { name: string; colors: Record<string, string | number> };

function loadDarkThemeJson(): ThemeJsonFile {
	return JSON.parse(
		readFileSync(new URL("../src/modes/interactive/theme/dark.json", import.meta.url), "utf8"),
	) as ThemeJsonFile;
}

/** Dark theme with fixed diff foregrounds and no diff backgrounds. */
function legacyThemeJson(name: string): ThemeJsonFile {
	const themeJson = loadDarkThemeJson();
	themeJson.name = name;
	themeJson.colors.toolDiffAdded = "#00ff00";
	themeJson.colors.toolDiffRemoved = "#ff0000";
	themeJson.colors.toolDiffContext = "#888888";
	return themeJson;
}

/** Legacy theme plus the four diff background tokens. */
function backgroundThemeJson(name: string): ThemeJsonFile {
	const themeJson = legacyThemeJson(name);
	themeJson.colors.toolDiffAddedBg = "#0a3a0a";
	themeJson.colors.toolDiffRemovedBg = "#3a0a0a";
	themeJson.colors.toolDiffAddedSoftBg = "#051d05";
	themeJson.colors.toolDiffRemovedSoftBg = "#1d0505";
	return themeJson;
}

function loadTheme(themeJson: ThemeJsonFile): Theme {
	const testDir = mkdtempSync(join(tmpdir(), "pi-diff-bg-theme-"));
	tempDirs.push(testDir);
	const themePath = join(testDir, `${themeJson.name}.json`);
	writeFileSync(themePath, JSON.stringify(themeJson));
	return loadThemeFromPath(themePath, "truecolor");
}

beforeAll(() => {
	// theme.inverse() goes through chalk, which stays silent without color support.
	previousChalkLevel = chalk.level;
	chalk.level = 3;
});

afterAll(() => {
	chalk.level = previousChalkLevel;
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("optional diff background tokens", () => {
	it("loads all four diff background tokens", () => {
		const loadedTheme = loadTheme(backgroundThemeJson("diff-bg-theme"));

		expect(loadedTheme.hasBg("toolDiffAddedBg")).toBe(true);
		expect(loadedTheme.hasBg("toolDiffRemovedBg")).toBe(true);
		expect(loadedTheme.getBgAnsi("toolDiffAddedBg")).toBe(ADDED_BG);
		expect(loadedTheme.getBgAnsi("toolDiffRemovedBg")).toBe(REMOVED_BG);
		expect(loadedTheme.getBgAnsi("toolDiffAddedSoftBg")).toBe(ADDED_SOFT_BG);
		expect(loadedTheme.getBgAnsi("toolDiffRemovedSoftBg")).toBe(REMOVED_SOFT_BG);
	});

	it("falls back to the strong tint when the soft wash is omitted", () => {
		const themeJson = backgroundThemeJson("diff-bg-no-soft-theme");
		delete themeJson.colors.toolDiffAddedSoftBg;
		delete themeJson.colors.toolDiffRemovedSoftBg;

		const loadedTheme = loadTheme(themeJson);

		expect(loadedTheme.hasBg("toolDiffAddedSoftBg")).toBe(true);
		expect(loadedTheme.hasBg("toolDiffRemovedSoftBg")).toBe(true);
		expect(loadedTheme.getBgAnsi("toolDiffAddedSoftBg")).toBe(loadedTheme.getBgAnsi("toolDiffAddedBg"));
		expect(loadedTheme.getBgAnsi("toolDiffRemovedSoftBg")).toBe(loadedTheme.getBgAnsi("toolDiffRemovedBg"));
	});

	it("reports no diff backgrounds for a theme without the strong tints", () => {
		const loadedTheme = loadTheme(legacyThemeJson("legacy-diff-theme"));

		expect(loadedTheme.hasBg("toolDiffAddedBg")).toBe(false);
		expect(loadedTheme.hasBg("toolDiffRemovedBg")).toBe(false);
		expect(loadedTheme.hasBg("toolDiffAddedSoftBg")).toBe(false);
		expect(loadedTheme.hasBg("toolDiffRemovedSoftBg")).toBe(false);
		expect(loadedTheme.hasBg("selectedBg")).toBe(true);
		expect(() => loadedTheme.getBgAnsi("toolDiffAddedBg")).toThrow(/Unknown theme background color/);
	});

	it("keeps the soft wash absent when only one strong tint is set", () => {
		const themeJson = backgroundThemeJson("diff-bg-added-only-theme");
		delete themeJson.colors.toolDiffRemovedBg;
		delete themeJson.colors.toolDiffRemovedSoftBg;

		const loadedTheme = loadTheme(themeJson);

		expect(loadedTheme.hasBg("toolDiffAddedBg")).toBe(true);
		expect(loadedTheme.hasBg("toolDiffRemovedBg")).toBe(false);
		expect(loadedTheme.hasBg("toolDiffRemovedSoftBg")).toBe(false);
	});
});

describe("renderDiff with diff background tokens", () => {
	it("paints whole lines and changed word ranges with the diff backgrounds", () => {
		setThemeInstance(loadTheme(backgroundThemeJson("diff-bg-render-theme")));

		const lines = renderDiff(DIFF).split("\n");

		// Context lines keep the old rendering: foreground only, no background.
		expect(lines[0]).toBe(`${CONTEXT_FG} 1 const keep = true;${FG_RESET}`);
		expect(lines[3]).toBe(`${CONTEXT_FG} 3 const tail = true;${FG_RESET}`);
		expect(lines[7]).toBe(`${CONTEXT_FG}     ...${FG_RESET}`);

		// Modified pair: soft wash on the line, strong tint on the changed range.
		expect(lines[1]).toBe(
			`${REMOVED_SOFT_BG}${REMOVED_FG}-2 ${FG_RESET}const value = ${REMOVED_BG}1${REMOVED_SOFT_BG};${BG_RESET}`,
		);
		expect(lines[2]).toBe(
			`${ADDED_SOFT_BG}${ADDED_FG}+2 ${FG_RESET}const value = ${ADDED_BG}2${ADDED_SOFT_BG};${BG_RESET}`,
		);

		// Standalone added line: strong tint over the whole line.
		expect(lines[4]).toBe(`${ADDED_BG}${ADDED_FG}+4 ${FG_RESET}const added = true;${BG_RESET}`);

		// Removed-only group: strong tint over the whole line.
		expect(lines[5]).toBe(`${REMOVED_BG}${REMOVED_FG}-5 ${FG_RESET}const goneOne = 1;${BG_RESET}`);
		expect(lines[6]).toBe(`${REMOVED_BG}${REMOVED_FG}-6 ${FG_RESET}const goneTwo = 2;${BG_RESET}`);

		// The theme replaces inverse with the strong background tint.
		expect(renderDiff(DIFF)).not.toContain("\x1b[7m");
	});

	it("gives added and removed content the default foreground", () => {
		setThemeInstance(loadTheme(backgroundThemeJson("diff-bg-default-fg-theme")));

		const lines = renderDiff(DIFF).split("\n");

		for (const index of [1, 2, 4, 5, 6]) {
			const line = lines[index];
			const content = line.slice(line.indexOf(FG_RESET) + FG_RESET.length);
			expect(content).not.toContain("\x1b[38;");
			expect(content).not.toContain("\x1b[39m");
		}
	});
});

describe("diff backgrounds inside a Tool Call", () => {
	it("restores the enclosing success background after each nested diff tint", () => {
		const loadedTheme = loadTheme(backgroundThemeJson("diff-bg-tool-component"));
		setThemeInstance(loadedTheme);
		const component = new ToolExecutionComponent(
			"edit",
			"tool-edit-background",
			{ path: "notes.txt", edits: [{ oldText: "before", newText: "after" }] },
			{},
			createEditToolDefinition(process.cwd()),
			{ requestRender: () => {} } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult(
			{
				content: [{ type: "text", text: "edited" }],
				details: { diff: "-1 before\n+1 after", patch: "", firstChangedLine: 1 },
				isError: false,
			},
			false,
		);

		const diffRows = component.render(80).filter((line) => stripAnsi(line).includes("after"));
		const successBg = loadedTheme.getBgAnsi("toolSuccessBg");

		expect(diffRows).toHaveLength(1);
		expect(diffRows[0]).toContain(`${BG_RESET}${successBg}`);
	});
});

describe("renderDiff without diff background tokens", () => {
	it("renders exactly like the legacy implementation", () => {
		setThemeInstance(loadTheme(legacyThemeJson("legacy-diff-render-theme")));

		const rendered = renderDiff(DIFF);

		expect(rendered).toBe(LEGACY_OUTPUT);
		expect(rendered).toContain("\x1b[7m");
		expect(rendered).not.toContain("\x1b[48;");
	});
});
