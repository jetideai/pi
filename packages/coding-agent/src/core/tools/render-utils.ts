import * as os from "node:os";
import { pathToFileURL } from "node:url";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
	getCapabilities,
	getImageDimensions,
	hyperlink,
	imageFallback,
	sliceByColumn,
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

function takeTail(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	const width = visibleWidth(text);
	if (width <= maxWidth) return text;
	return sliceByColumn(text, width - maxWidth, maxWidth, true);
}

function takeBasenameTail(basename: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleWidth(basename) <= maxWidth) return basename;

	const extensionStart = basename.lastIndexOf(".");
	const extension = extensionStart > 0 ? basename.slice(extensionStart) : "";
	const extensionWidth = visibleWidth(extension);
	if (!extension || extensionWidth >= maxWidth) return takeTail(basename, maxWidth);

	return `${takeTail(basename.slice(0, extensionStart), maxWidth - extensionWidth)}${extension}`;
}

/** Shorten a raw path for a one-line tool summary while preserving its useful tail. */
export function shortenPathForWidth(path: string, maxWidth: number): string {
	const shortened = shortenPath(path);
	if (maxWidth <= 0) return "";
	if (visibleWidth(shortened) <= maxWidth) return shortened;

	const separator = Math.max(shortened.lastIndexOf("/"), shortened.lastIndexOf("\\"));
	const basename = separator >= 0 ? shortened.slice(separator + 1) : shortened;
	const marker = ".../";
	const markerWidth = visibleWidth(marker);
	if (markerWidth + visibleWidth(basename) <= maxWidth) return `${marker}${basename}`;
	if (markerWidth < maxWidth) return `${marker}${takeBasenameTail(basename, maxWidth - markerWidth)}`;
	return takeBasenameTail(basename, maxWidth);
}

/** A built-in renderer-owned header that keeps a short V3 row and canonical call rows. */
export class SectionedToolCallHeader extends Text {
	private summaryRenderer?: (width: number) => string;
	private canonicalComponent = new Text("", 0, 0);
	private retainCanonicalFirstRow?: (width: number) => boolean;

	setSectionedContent(
		summaryRenderer: (width: number) => string,
		canonicalText: string,
		options?: { retainCanonicalFirstRow?: (width: number) => boolean },
	): void {
		this.summaryRenderer = summaryRenderer;
		this.retainCanonicalFirstRow = options?.retainCanonicalFirstRow;
		this.canonicalComponent.setText(canonicalText);
		this.setText(canonicalText);
	}

	clearSectionedContent(): void {
		this.summaryRenderer = undefined;
		this.retainCanonicalFirstRow = undefined;
		this.canonicalComponent.setText("");
		this.setText("");
	}

	override invalidate(): void {
		super.invalidate();
		this.canonicalComponent.invalidate();
	}

	override render(width: number): string[] {
		if (!this.summaryRenderer) return super.render(width);
		const summary = truncateToWidth(this.summaryRenderer(width), width, "");
		const canonicalLines = this.canonicalComponent.render(width);
		if (canonicalLines.length === 1 && stripAnsi(canonicalLines[0] ?? "").trim() === stripAnsi(summary).trim()) {
			return [summary];
		}
		const canonicalStart = this.retainCanonicalFirstRow?.(width) ? 0 : 1;
		return [summary, ...canonicalLines.slice(canonicalStart)];
	}
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
