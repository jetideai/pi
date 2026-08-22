import * as Diff from "diff";
import { type ThemeBg, type ThemeColor, theme } from "../theme/theme.ts";

/**
 * Parse diff line to extract prefix, line number, and content.
 * Format: "+123 content" or "-123 content" or " 123 content" or "     ..."
 */
function parseDiffLine(line: string): { prefix: string; lineNum: string; content: string } | null {
	const match = line.match(/^([+-\s])(\s*\d*)\s(.*)$/);
	if (!match) return null;
	return { prefix: match[1], lineNum: match[2], content: match[3] };
}

/**
 * Replace tabs with spaces for consistent rendering.
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Marks the changed word ranges of a modified line pair.
 */
interface WordRunStyle {
	removed: (value: string) => string;
	added: (value: string) => string;
}

/** Default style: invert the changed word ranges. */
const INVERSE_WORD_RUNS: WordRunStyle = {
	removed: (value: string) => theme.inverse(value),
	added: (value: string) => theme.inverse(value),
};

/**
 * True when the theme gives diff background tints. The soft washes have a
 * fallback, so the two strong tints decide.
 */
function hasDiffBackgrounds(): boolean {
	return theme.hasBg("toolDiffAddedBg") && theme.hasBg("toolDiffRemovedBg");
}

/**
 * Put a changed word range on the strong tint, then go back to the soft wash of
 * the line. `theme.bg` resets the background to the terminal default, so the
 * soft wash must be set again after each range.
 */
function strongRun(strongBg: ThemeBg, softBg: ThemeBg): (value: string) => string {
	return (value: string) => `${theme.getBgAnsi(strongBg)}${value}${theme.getBgAnsi(softBg)}`;
}

/**
 * Paint one whole diff line, prefix and line number included. The prefix keeps
 * its diff color; the content uses the default foreground so the background
 * tint carries the meaning.
 */
function paintDiffLine(bg: ThemeBg, prefixColor: ThemeColor, prefix: string, content: string): string {
	return theme.bg(bg, `${theme.fg(prefixColor, prefix)}${content}`);
}

/**
 * Compute word-level diff and render with inverse on changed parts.
 * Uses diffWords which groups whitespace with adjacent words for cleaner highlighting.
 * Strips leading whitespace from inverse to avoid highlighting indentation.
 */
function renderIntraLineDiff(
	oldContent: string,
	newContent: string,
	wordRuns: WordRunStyle = INVERSE_WORD_RUNS,
): { removedLine: string; addedLine: string } {
	const wordDiff = Diff.diffWords(oldContent, newContent);

	let removedLine = "";
	let addedLine = "";
	let isFirstRemoved = true;
	let isFirstAdded = true;

	for (const part of wordDiff) {
		if (part.removed) {
			let value = part.value;
			// Strip leading whitespace from the first removed part
			if (isFirstRemoved) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				removedLine += leadingWs;
				isFirstRemoved = false;
			}
			if (value) {
				removedLine += wordRuns.removed(value);
			}
		} else if (part.added) {
			let value = part.value;
			// Strip leading whitespace from the first added part
			if (isFirstAdded) {
				const leadingWs = value.match(/^(\s*)/)?.[1] || "";
				value = value.slice(leadingWs.length);
				addedLine += leadingWs;
				isFirstAdded = false;
			}
			if (value) {
				addedLine += wordRuns.added(value);
			}
		} else {
			removedLine += part.value;
			addedLine += part.value;
		}
	}

	return { removedLine, addedLine };
}

export interface RenderDiffOptions {
	/** File path (unused, kept for API compatibility) */
	filePath?: string;
}

/**
 * Render a diff string with colored lines and intra-line change highlighting.
 *
 * Without diff backgrounds in the theme:
 * - Context lines: dim/gray
 * - Removed lines: red, with inverse on changed tokens
 * - Added lines: green, with inverse on changed tokens
 *
 * With diff backgrounds in the theme, the render follows the JetBrains diff
 * model: a wholly added or removed line gets the strong tint. A modified line
 * gets the soft line wash plus the strong tint on the changed word ranges.
 */
export function renderDiff(diffText: string, _options: RenderDiffOptions = {}): string {
	const lines = diffText.split("\n");
	const result: string[] = [];
	const useBackgrounds = hasDiffBackgrounds();

	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		const parsed = parseDiffLine(line);

		if (!parsed) {
			result.push(theme.fg("toolDiffContext", line));
			i++;
			continue;
		}

		if (parsed.prefix === "-") {
			// Collect consecutive removed lines
			const removedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "-") break;
				removedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Collect consecutive added lines
			const addedLines: { lineNum: string; content: string }[] = [];
			while (i < lines.length) {
				const p = parseDiffLine(lines[i]);
				if (!p || p.prefix !== "+") break;
				addedLines.push({ lineNum: p.lineNum, content: p.content });
				i++;
			}

			// Only do intra-line diffing when there's exactly one removed and one added line
			// (indicating a single line modification). Otherwise, show lines as-is.
			if (removedLines.length === 1 && addedLines.length === 1) {
				const removed = removedLines[0];
				const added = addedLines[0];

				const { removedLine, addedLine } = renderIntraLineDiff(
					replaceTabs(removed.content),
					replaceTabs(added.content),
					useBackgrounds
						? {
								removed: strongRun("toolDiffRemovedBg", "toolDiffRemovedSoftBg"),
								added: strongRun("toolDiffAddedBg", "toolDiffAddedSoftBg"),
							}
						: INVERSE_WORD_RUNS,
				);

				if (useBackgrounds) {
					result.push(
						paintDiffLine("toolDiffRemovedSoftBg", "toolDiffRemoved", `-${removed.lineNum} `, removedLine),
					);
					result.push(paintDiffLine("toolDiffAddedSoftBg", "toolDiffAdded", `+${added.lineNum} `, addedLine));
				} else {
					result.push(theme.fg("toolDiffRemoved", `-${removed.lineNum} ${removedLine}`));
					result.push(theme.fg("toolDiffAdded", `+${added.lineNum} ${addedLine}`));
				}
			} else {
				// Show all removed lines first, then all added lines
				for (const removed of removedLines) {
					const content = replaceTabs(removed.content);
					result.push(
						useBackgrounds
							? paintDiffLine("toolDiffRemovedBg", "toolDiffRemoved", `-${removed.lineNum} `, content)
							: theme.fg("toolDiffRemoved", `-${removed.lineNum} ${content}`),
					);
				}
				for (const added of addedLines) {
					const content = replaceTabs(added.content);
					result.push(
						useBackgrounds
							? paintDiffLine("toolDiffAddedBg", "toolDiffAdded", `+${added.lineNum} `, content)
							: theme.fg("toolDiffAdded", `+${added.lineNum} ${content}`),
					);
				}
			}
		} else if (parsed.prefix === "+") {
			// Standalone added line
			const content = replaceTabs(parsed.content);
			result.push(
				useBackgrounds
					? paintDiffLine("toolDiffAddedBg", "toolDiffAdded", `+${parsed.lineNum} `, content)
					: theme.fg("toolDiffAdded", `+${parsed.lineNum} ${content}`),
			);
			i++;
		} else {
			// Context line
			result.push(theme.fg("toolDiffContext", ` ${parsed.lineNum} ${replaceTabs(parsed.content)}`));
			i++;
		}
	}

	return result.join("\n");
}
