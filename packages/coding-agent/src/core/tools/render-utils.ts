import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	type Component,
	getCapabilities,
	getImageDimensions,
	hyperlink,
	imageFallback,
	Text,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../utils/ansi.ts";
import { resolvePath } from "../../utils/paths.ts";
import { sanitizeBinaryOutput } from "../../utils/shell.ts";

export function shortenPath(path: unknown): string {
	if (typeof path !== "string") return "";
	const home = os.homedir();
	if (path.startsWith(home)) {
		return `~${path.slice(home.length)}`;
	}
	return path;
}

/** A renderer-owned call component that exposes one compact header before canonical call rows. */
export class SectionedToolCallHeader extends Text {
	private canonicalText = "";
	private sectioned = false;
	private outcomeCue = "";
	/** True when the last render gave a one-row summary of the first line before all canonical rows. */
	summarized = false;

	setSectionedText(canonicalText: string, sectioned: boolean): void {
		this.canonicalText = canonicalText;
		this.sectioned = sectioned;
		this.setText(canonicalText);
	}

	/** The outcome cue of the call: the summary row keeps room for it, and the canonical rows of a summary show it. */
	setOutcomeCue(cue: string): void {
		this.outcomeCue = cue;
	}

	/**
	 * A sectioned header is one summary row of its first line, with an ellipsis when that line does not fit the width.
	 * The canonical rows follow it: all of them when the first line wraps or does not fit with the outcome cue, so no
	 * text is lost. An open Fold hides the summary row, so the canonical first line then ends with the outcome cue.
	 */
	override render(width: number): string[] {
		// The canonical first line fills its first row, so the tool label and the start of a long path share it.
		this.setFillFirstLine(this.sectioned);
		const firstLogicalLine = this.canonicalText.split("\n", 1)[0] ?? "";
		const room = Math.max(0, width - visibleWidth(this.outcomeCue));
		this.summarized = this.sectioned && visibleWidth(firstLogicalLine) > room;
		this.setFirstLineSuffix(this.summarized ? this.outcomeCue : "");
		const canonicalLines = super.render(width);
		if (!this.sectioned) return canonicalLines;
		if (!this.summarized) return [truncateToWidth(firstLogicalLine, width, ""), ...canonicalLines.slice(1)];
		return [truncateToWidth(firstLogicalLine, room, "…"), ...canonicalLines];
	}
}

/** The sectioned header that is [component], or the first child of a container. */
export function sectionedHeaderOf(component: Component): SectionedToolCallHeader | undefined {
	const children = (component as { children?: unknown }).children;
	const header = Array.isArray(children) ? children[0] : component;
	return header instanceof SectionedToolCallHeader ? header : undefined;
}

/** True when [component], or the first child of a container, is a sectioned header that gave a summary row. */
export function sectionedHeaderSummarized(component: Component): boolean {
	return sectionedHeaderOf(component)?.summarized ?? false;
}

export function linkPath(styledText: string, rawPath: string, cwd: string): string {
	if (!getCapabilities().hyperlinks) return styledText;
	const absolutePath = resolvePath(rawPath, cwd);
	return hyperlink(styledText, pathToFileURL(absolutePath).href);
}

export function str(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (value == null) return "";
	return null;
}

export function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

export function normalizeDisplayText(text: string): string {
	return text.replace(/\r/g, "");
}

export function getTextOutput(
	result: { content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> } | undefined,
	showImages: boolean,
): string {
	if (!result) return "";

	const textBlocks = result.content.filter((c) => c.type === "text");
	const imageBlocks = result.content.filter((c) => c.type === "image");

	let output = textBlocks.map((c) => sanitizeBinaryOutput(stripAnsi(c.text || "")).replace(/\r/g, "")).join("\n");

	const caps = getCapabilities();
	if (imageBlocks.length > 0 && (!caps.images || !showImages)) {
		const imageIndicators = imageBlocks
			.map((img) => {
				const mimeType = img.mimeType ?? "image/unknown";
				const dims =
					img.data && img.mimeType ? (getImageDimensions(img.data, img.mimeType) ?? undefined) : undefined;
				return imageFallback(mimeType, dims);
			})
			.join("\n");
		output = output ? `${output}\n${imageIndicators}` : imageIndicators;
	}

	return output;
}

export type ToolRenderResultLike<TDetails> = {
	content: (TextContent | ImageContent)[];
	details: TDetails;
};

export function invalidArgText(theme: Theme): string {
	return theme.fg("error", "[invalid arg]");
}

export function renderToolPath(
	rawPath: string | null,
	theme: Theme,
	cwd: string,
	options?: { emptyFallback?: string },
): string {
	if (rawPath === null) return invalidArgText(theme);
	const value = rawPath || options?.emptyFallback;
	if (!value) return theme.fg("toolOutput", "...");
	return linkPath(theme.fg("accent", shortenPath(value)), value, cwd);
}
