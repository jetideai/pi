import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	Image,
	MouseRegion,
	Spacer,
	Text,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
	MessageRenderSourcePointDecoratorV1,
	ToolDefinition,
	ToolExecutionPresentationSelectorV1,
	ToolRenderContext,
	ToolRenderResultOptions,
} from "../../../core/extensions/types.ts";
import type { Theme } from "../theme/theme.ts";

/**
 * What this component needs from a tool: how to draw it. It neither executes tools nor reads their
 * parameter schemas, so a definition and a bare renderer pair are equally acceptable.
 *
 * The renderer parameters are `any` on purpose: a `ToolDefinition` types them from its schema, and
 * narrowing them here would make those definitions unassignable.
 */
export interface ToolRenderers {
	renderShell?: "default" | "self";
	semanticSourceTextRenderer?: ToolDefinition<any, any>["renderResult"];
	renderCall?: (args: any, theme: Theme, context: ToolRenderContext<any, any>) => Component;
	getRenderCallHeaderRow?: (component: Component) => number | undefined;
	getRenderCallBodyRow?: (component: Component) => number | undefined;
	renderResult?: (
		result: AgentToolResult<any>,
		options: ToolRenderResultOptions,
		theme: Theme,
		context: ToolRenderContext<any, any>,
	) => Component;
}

import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import {
	createMessageRenderSourcePointDecorator,
	decorateMessageRenderV2,
	selectMessageRenderBoundaryDecoratorsV3,
} from "./message-render-boundaries.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	hasInitialCollapsedBoundaries?: boolean;
	ownerEntryId?: string;
	producerSessionId?: string;
	renderScopeId?: string;
	semanticSelectorsV3?: readonly MessageRenderBoundarySelectorV3[];
	sourcePointDecoratorsV1?: readonly MessageRenderSourcePointDecoratorV1[];
	toolExecutionPresentationSelectorsV1?: readonly ToolExecutionPresentationSelectorV1[];
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private contentTextRegion: MouseRegion;
	private selfRenderContainer: Container;
	private selfRenderHeight = 0;
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private toolName: string;
	private toolCallId: string;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolRenderers;
	private ui: TUI;
	private cwd: string;
	private executionStarted = false;
	private argsComplete = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};
	private convertedImages: Map<number, { data: string; mimeType: string }> = new Map();
	private hideComponent = false;
	private compactLiveToolCall = false;
	private readonly ownerEntryId?: string;
	private readonly semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[];
	private semanticBoundariesEnabled = true;
	private readonly producerSessionId?: string;
	private readonly renderScopeId?: string;
	private readonly sourcePointDecoratorsV1: readonly MessageRenderSourcePointDecoratorV1[];
	private sourcePointFoldRole: "tool" | "tool-group" = "tool";
	private sourcePointFoldBlockId: string;
	private decoratedResultText?: Text;

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolRenderers | ToolDefinition<any, any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.ownerEntryId = options.ownerEntryId;
		this.producerSessionId = options.producerSessionId;
		this.renderScopeId = options.renderScopeId;
		this.sourcePointDecoratorsV1 = options.sourcePointDecoratorsV1 ?? [];
		this.sourcePointFoldBlockId = toolCallId;
		this.semanticDecoratorsV2 =
			options.producerSessionId && options.renderScopeId
				? selectMessageRenderBoundaryDecoratorsV3(
						{
							producerSessionId: options.producerSessionId,
							renderScopeId: options.renderScopeId,
							entryId: toolCallId,
							blockId: toolCallId,
							role: "tool",
							state: "expanded",
							...(options.ownerEntryId ? { ownerEntryId: options.ownerEntryId } : {}),
						},
						options.semanticSelectorsV3 ?? [],
					)
				: [];
		this.compactLiveToolCall = this.selectCompactLiveToolCall(
			options.toolExecutionPresentationSelectorsV1 ?? [],
			options.hasInitialCollapsedBoundaries ?? this.semanticDecoratorsV2.length > 0,
		);
		this.showImages = options.showImages ?? true;
		this.imageWidthCells = options.imageWidthCells ?? 60;
		this.ui = ui;
		this.cwd = cwd;

		this.addChild(new Spacer(1));

		// Always create all shell variants. contentBox is used for default renderer-based composition.
		// selfRenderContainer is used when the tool renders its own framing.
		// contentText is reserved for generic fallback rendering when no tool definition exists.
		this.contentBox = new Box(1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.contentTextRegion = this.createResultRegion(this.contentText);
		this.selfRenderContainer = new Container();

		if (this.hasRendererDefinition()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentTextRegion);
		}

		this.updateDisplay();
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		return this.toolDefinition?.renderCall;
	}

	private getCallHeaderRowLocator(): ToolDefinition<any, any>["getRenderCallHeaderRow"] | undefined {
		return this.toolDefinition?.getRenderCallHeaderRow;
	}

	private getCallBodyRowLocator(): ToolDefinition<any, any>["getRenderCallBodyRow"] | undefined {
		return this.toolDefinition?.getRenderCallBodyRow;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		return this.toolDefinition?.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		return this.toolDefinition?.renderShell ?? "default";
	}

	private getRenderContext(lastComponent: Component | undefined): ToolRenderContext {
		return {
			args: this.args,
			toolCallId: this.toolCallId,
			invalidate: () => {
				this.invalidate();
				this.ui.requestRender();
			},
			lastComponent,
			state: this.rendererState,
			cwd: this.cwd,
			executionStarted: this.executionStarted,
			argsComplete: this.argsComplete,
			isPartial: this.isPartial,
			expanded: this.expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			sectioned: this.isCompactLiveToolCall(),
		};
	}

	private createCallFallback(): Component {
		return new Text(theme.fg("toolTitle", theme.bold(this.toolName)), 0, 0);
	}

	private createResultFallback(): Component | undefined {
		const output = this.getTextOutput();
		if (!output) {
			return undefined;
		}

		const lines = output.split("\n");
		const displayLines = this.expanded ? lines : lines.slice(0, FALLBACK_PREVIEW_LINES);
		const remaining = lines.length - displayLines.length;
		let text = displayLines.map((line) => theme.fg("toolOutput", line)).join("\n");
		if (remaining > 0) {
			text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		}
		return new Text(text, 0, 0);
	}

	private createResultRegion(component: Component): MouseRegion {
		return new MouseRegion(component, (event) => {
			if (!this.result || event.type !== "click" || event.button !== "left") return undefined;
			this.setExpanded(!this.expanded);
			return { handled: true };
		});
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	markExecutionStarted(): void {
		this.executionStarted = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	setArgsComplete(): void {
		this.argsComplete = true;
		this.updateDisplay();
		this.ui.requestRender();
	}

	updateResult(
		result: {
			content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
			details?: any;
			isError: boolean;
		},
		isPartial = false,
	): void {
		this.result = result;
		this.isPartial = isPartial;
		this.updateDisplay();
		this.maybeConvertImagesForKitty();
	}

	private maybeConvertImagesForKitty(): void {
		const caps = getCapabilities();
		if (caps.images !== "kitty") return;
		if (!this.result) return;

		const imageBlocks = this.result.content.filter((c) => c.type === "image");
		for (let i = 0; i < imageBlocks.length; i++) {
			const img = imageBlocks[i];
			if (!img.data || !img.mimeType) continue;
			if (img.mimeType === "image/png") continue;
			if (this.convertedImages.has(i)) continue;

			const index = i;
			convertToPng(img.data, img.mimeType).then((converted) => {
				if (converted) {
					this.convertedImages.set(index, converted);
					this.updateDisplay();
					this.ui.requestRender();
				}
			});
		}
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setSemanticBoundariesEnabled(enabled: boolean): void {
		this.semanticBoundariesEnabled = enabled;
		this.invalidate();
	}

	setSourcePointContainingFold(blockId: string, role: "tool" | "tool-group"): void {
		this.sourcePointFoldBlockId = blockId;
		this.sourcePointFoldRole = role;
		this.updateResultSourcePoints();
	}

	setShowImages(show: boolean): void {
		this.showImages = show;
		this.updateDisplay();
	}

	setImageWidthCells(width: number): void {
		this.imageWidthCells = Math.max(1, Math.floor(width));
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.hideComponent) return [];
		const lines = this.renderStock(width);
		if (!this.isCompactLiveToolCall()) return this.decorateSemanticSections(lines, width);

		const component = this.callRendererComponent;
		const headerLocator = this.getCallHeaderRowLocator();
		const bodyLocator = this.getCallBodyRowLocator();
		if (component && headerLocator && bodyLocator) {
			try {
				const componentWidth = this.getRenderShell() === "self" ? width : Math.max(0, width - 2);
				const componentRows = component.render(componentWidth);
				const headerRow = headerLocator(component);
				const bodyRow = bodyLocator(component);
				const stockHeaderRow = (this.getRenderShell() === "self" ? 1 : 2) + (headerRow ?? -1);
				if (
					headerRow !== undefined &&
					bodyRow !== undefined &&
					headerRow >= 0 &&
					bodyRow > headerRow &&
					bodyRow <= componentRows.length &&
					lines[stockHeaderRow] !== undefined
				) {
					return [lines[stockHeaderRow]];
				}
			} catch {}
		}

		this.compactLiveToolCall = false;
		this.updateDisplay();
		return this.renderStock(width);
	}

	private decorateSemanticSections(lines: string[], width: number): string[] {
		if (!this.semanticBoundariesEnabled || this.semanticDecoratorsV2.length === 0 || this.isPartial) return lines;
		const component = this.callRendererComponent;
		const headerLocator = this.getCallHeaderRowLocator();
		const bodyLocator = this.getCallBodyRowLocator();
		if (!component || !headerLocator || !bodyLocator) return lines;
		try {
			const componentWidth = this.getRenderShell() === "self" ? width : Math.max(0, width - 2);
			component.render(componentWidth);
			const offset = this.getRenderShell() === "self" ? 1 : 2;
			const headerRow = headerLocator(component);
			const bodyRow = bodyLocator(component);
			if (headerRow === undefined || bodyRow === undefined || headerRow < 0 || bodyRow <= headerRow) return lines;
			return decorateMessageRenderV2(lines, offset + bodyRow, width, "tool", 0, {
				entryId: this.toolCallId,
				...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
				beginRow: offset + headerRow,
				decorators: this.semanticDecoratorsV2,
			});
		} catch {
			return lines;
		}
	}

	private renderStock(width: number): string[] {
		if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			const contentLines = this.selfRenderContainer.render(width);
			this.selfRenderHeight = contentLines.length;
			if (contentLines.length === 0 && this.imageComponents.length === 0) return [];

			const lines: string[] = [];
			if (contentLines.length > 0) {
				lines.push("");
				lines.push(...contentLines);
			}
			for (let i = 0; i < this.imageComponents.length; i++) {
				const spacer = this.imageSpacers[i];
				if (spacer) lines.push(...spacer.render(width));
				const imageComponent = this.imageComponents[i];
				if (imageComponent) lines.push(...imageComponent.render(width));
			}
			return lines;
		}
		return super.render(width);
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.hasRendererDefinition() || this.getRenderShell() !== "self") return super.handleMouse(event);
		if (event.y <= 0 || event.y > this.selfRenderHeight) return undefined;
		return this.selfRenderContainer.handleMouse({
			...event,
			y: event.y - 1,
			height: this.selfRenderHeight,
		});
	}

	private selectCompactLiveToolCall(
		selectors: readonly ToolExecutionPresentationSelectorV1[],
		hasInitialCollapsedBoundaries: boolean,
	): boolean {
		if (selectors.length === 0) return false;
		const candidate = {
			role: "tool" as const,
			hasExactHeaderSeam: Boolean(this.getCallHeaderRowLocator() && this.getCallBodyRowLocator()),
			hasCanonicalResultRenderer: Boolean(this.getResultRenderer()),
			hasInitialCollapsedBoundaries,
		};
		if (
			!candidate.hasExactHeaderSeam ||
			!candidate.hasCanonicalResultRenderer ||
			!candidate.hasInitialCollapsedBoundaries
		) {
			return false;
		}
		for (const selector of selectors) {
			try {
				const selection = selector(candidate);
				if (
					selection?.liveToolCall === "compact-stock-header" &&
					selection.liveToolGroup === "compact-stock-header" &&
					selection.header === "exact-one-row" &&
					selection.settled === "canonical-initial-collapsed"
				) {
					return true;
				}
			} catch {}
		}
		return false;
	}

	private isCompactLiveToolCall(): boolean {
		return this.compactLiveToolCall && this.executionStarted && this.isPartial;
	}

	private updateDisplay(): void {
		this.decoratedResultText?.setPreWrapDecorator(undefined);
		this.decoratedResultText = undefined;
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			renderContainer.clear();

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					renderContainer.addChild(this.createResultRegion(component));
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					renderContainer.addChild(this.createResultRegion(this.createCallFallback()));
					hasContent = true;
				}
			}

			if (this.result && !this.isCompactLiveToolCall()) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: this.expanded, isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent),
						);
						this.resultRendererComponent = component;
						renderContainer.addChild(this.createResultRegion(component));
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							renderContainer.addChild(this.createResultRegion(component));
							hasContent = true;
						}
					}
				}
			}
		} else {
			this.contentText.setCustomBgFn(bgFn);
			this.contentText.setText(this.formatToolExecution());
			hasContent = true;
		}

		for (const img of this.imageComponents) {
			this.removeChild(img);
		}
		this.imageComponents = [];
		for (const spacer of this.imageSpacers) {
			this.removeChild(spacer);
		}
		this.imageSpacers = [];

		if (this.result && !this.isCompactLiveToolCall()) {
			const imageBlocks = this.result.content.filter((c) => c.type === "image");
			const caps = getCapabilities();
			for (let i = 0; i < imageBlocks.length; i++) {
				const img = imageBlocks[i];
				if (caps.images && this.showImages && img.data && img.mimeType) {
					const converted = this.convertedImages.get(i);
					const imageData = converted?.data ?? img.data;
					const imageMimeType = converted?.mimeType ?? img.mimeType;
					if (caps.images === "kitty" && imageMimeType !== "image/png") continue;

					const spacer = new Spacer(1);
					this.addChild(spacer);
					this.imageSpacers.push(spacer);
					const imageComponent = new Image(
						imageData,
						imageMimeType,
						{ fallbackColor: (s: string) => theme.fg("toolOutput", s) },
						{ maxWidthCells: this.imageWidthCells },
					);
					this.imageComponents.push(imageComponent);
					this.addChild(imageComponent);
				}
			}
		}

		if (this.hasRendererDefinition() && !hasContent && this.imageComponents.length === 0) {
			this.hideComponent = true;
		}
		this.updateResultSourcePoints();
	}

	private updateResultSourcePoints(): void {
		if (
			this.isPartial ||
			!this.expanded ||
			this.sourcePointDecoratorsV1.length === 0 ||
			this.toolDefinition?.renderResult !== this.toolDefinition?.semanticSourceTextRenderer ||
			!this.producerSessionId ||
			!this.renderScopeId
		) {
			return;
		}
		const text = findFirstText(this.resultRendererComponent);
		if (!text) return;
		text.setPreWrapDecorator(
			createMessageRenderSourcePointDecorator(
				{
					entryId: this.toolCallId,
					...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
					role: "tool",
					state: "expanded",
					producerSessionId: this.producerSessionId,
					renderScopeId: this.renderScopeId,
					blockId: this.sourcePointFoldBlockId,
					foldRole: this.sourcePointFoldRole,
				},
				0,
				this.sourcePointDecoratorsV1,
				true,
			),
		);
		this.decoratedResultText = text;
	}

	private getTextOutput(): string {
		return getRenderedTextOutput(this.result, this.showImages);
	}

	private formatToolExecution(): string {
		let text = theme.fg("toolTitle", theme.bold(this.toolName));
		const content = JSON.stringify(this.args, null, 2);
		if (content) {
			text += `\n\n${content}`;
		}
		const output = this.getTextOutput();
		if (output) {
			text += `\n${output}`;
		}
		return text;
	}
}

function findFirstText(component: Component | undefined): Text | undefined {
	if (component instanceof Text) return component;
	if (!(component instanceof Container)) return undefined;
	for (const child of component.children) {
		const text = findFirstText(child);
		if (text) return text;
	}
	return undefined;
}
