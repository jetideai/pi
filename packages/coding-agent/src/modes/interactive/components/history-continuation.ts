import type { Component } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { decorateMessageRenderV2, selectMessageRenderBoundaryDecoratorsV3 } from "./message-render-boundaries.ts";

/** The side of a transcript window that continues with sections that are not loaded. */
export type HistoryContinuationSide = "earlier" | "later";

export interface HistoryContinuationOptions {
	producerSessionId?: string;
	renderScopeId?: string;
	semanticSelectorsV3?: readonly MessageRenderBoundarySelectorV3[];
}

/**
 * One quiet row that says the transcript continues past the loaded window: a dim rule over the full width, with an
 * arrow in the middle toward the messages that are not loaded. Its boundary range, role "continuation", marks the row
 * for the host as presentation geometry; it is never history.
 */
export class HistoryContinuationRow implements Component {
	private readonly side: HistoryContinuationSide;
	private readonly decorators: readonly MessageRenderBoundaryDecoratorV2[];

	constructor(side: HistoryContinuationSide, options: HistoryContinuationOptions = {}) {
		this.side = side;
		this.decorators =
			options.producerSessionId && options.renderScopeId
				? selectMessageRenderBoundaryDecoratorsV3(
						{
							producerSessionId: options.producerSessionId,
							renderScopeId: options.renderScopeId,
							entryId: historyContinuationEntryId(side),
							blockId: side,
							role: "continuation",
							state: "expanded",
						},
						options.semanticSelectorsV3 ?? [],
					)
				: [];
	}

	render(width: number): string[] {
		return decorateMessageRenderV2(
			[theme.fg("dim", continuationRule(this.side, width))],
			undefined,
			width,
			"continuation",
			0,
			{
				entryId: historyContinuationEntryId(this.side),
				decorators: this.decorators,
			},
		);
	}

	invalidate(): void {}
}

export function historyContinuationEntryId(side: HistoryContinuationSide): string {
	return `history-continuation:${side}`;
}

/** A rule of [width] columns with the arrow of [side] in the middle: `──── ↑ ────`. */
export function continuationRule(side: HistoryContinuationSide, width: number): string {
	const arrow = side === "earlier" ? "↑" : "↓";
	if (width < 3) return width > 0 ? arrow : "";
	const left = Math.floor((width - 3) / 2);
	return `${"─".repeat(left)} ${arrow} ${"─".repeat(width - 3 - left)}`;
}
