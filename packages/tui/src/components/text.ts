import type { Component } from "../tui.ts";
import { applyBackgroundToLine, PreparedTextWithAnsi, visibleWidth } from "../utils.ts";

/**
 * Text component - displays multi-line text with word wrapping
 */
export class Text implements Component {
	private text: string;
	private paddingX: number; // Left/right padding
	private paddingY: number; // Top/bottom padding
	private customBgFn?: (text: string) => string;
	private prepared?: PreparedTextWithAnsi;
	private cached?: { width: number; maxLines: number | undefined; lines: string[]; totalLines: number };

	constructor(text: string = "", paddingX: number = 1, paddingY: number = 1, customBgFn?: (text: string) => string) {
		this.text = text;
		this.paddingX = paddingX;
		this.paddingY = paddingY;
		this.customBgFn = customBgFn;
	}

	setText(text: string): void {
		if (this.text !== text) this.prepared = undefined;
		this.text = text;
		this.cached = undefined;
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.customBgFn = customBgFn;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	render(width: number): string[] {
		return this.renderRows(width).lines;
	}

	/** Like render(width).slice(-maxLines), without padding or painting discarded rows. */
	renderTail(width: number, maxLines: number): { lines: string[]; totalLines: number } {
		const { lines, totalLines } = this.renderRows(width, maxLines);
		return { lines, totalLines };
	}

	private renderRows(width: number, maxLines?: number): { lines: string[]; totalLines: number } {
		if (this.cached && this.cached.width === width && this.cached.maxLines === maxLines) {
			return this.cached;
		}

		if (!this.text || this.text.trim() === "") {
			this.cached = { width, maxLines, lines: [], totalLines: 0 };
			return this.cached;
		}

		this.prepared ??= new PreparedTextWithAnsi(this.text.replace(/\t/g, "   "));

		// Reduce margins when necessary so content and padding fit within the available width.
		const paddingX = Math.min(this.paddingX, Math.max(0, Math.floor((width - 1) / 2)));
		const contentWidth = Math.max(1, width - paddingX * 2);
		const tailOnly = maxLines !== undefined && Number.isInteger(maxLines) && maxLines > 0;
		const wrapped = tailOnly
			? this.prepared.wrapTail(contentWidth, maxLines)
			: { lines: this.prepared.wrap(contentWidth), totalLines: 0 };
		const wrappedTotalLines = tailOnly ? wrapped.totalLines : wrapped.lines.length;
		const paddingLines: null[] = [];
		for (let i = 0; i < this.paddingY; i++) paddingLines.push(null);
		const sourceLines = paddingLines.length ? [...paddingLines, ...wrapped.lines, ...paddingLines] : wrapped.lines;
		const totalLines = wrappedTotalLines + paddingLines.length * 2;
		const selected = maxLines === undefined || totalLines <= maxLines ? sourceLines : sourceLines.slice(-maxLines);
		const margin = " ".repeat(paddingX);
		const emptyLine = " ".repeat(width);
		const lines = selected.map((line) => {
			const withMargins = line === null ? emptyLine : margin + line + margin;
			if (this.customBgFn) return applyBackgroundToLine(withMargins, width, this.customBgFn);
			return withMargins + " ".repeat(Math.max(0, width - visibleWidth(withMargins)));
		});

		this.cached = { width, maxLines, lines, totalLines };
		return this.cached;
	}
}
