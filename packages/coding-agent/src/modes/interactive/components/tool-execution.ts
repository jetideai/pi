import { Box, type Component, Container, getCapabilities, Image, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV1,
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV2,
	MessageRenderBoundarySelectorV3,
	ToolDefinition,
	ToolExecutionPresentationSelectorV1,
	ToolPresentationOverrideV1,
	ToolPresentationV1,
	ToolRenderContext,
} from "../../../core/extensions/types.ts";
import { createAllToolDefinitions, type ToolName } from "../../../core/tools/index.ts";
import { getTextOutput as getRenderedTextOutput } from "../../../core/tools/render-utils.ts";
import { stripAnsi } from "../../../utils/ansi.ts";
import { convertToPng } from "../../../utils/image-convert.ts";
import { theme } from "../theme/theme.ts";
import { keyHint } from "./keybinding-hints.ts";
import {
	decorateMessageRender,
	decorateMessageRenderV2,
	selectMessageRenderBoundaryDecoratorsV2,
	selectMessageRenderBoundaryDecoratorsV3,
} from "./message-render-boundaries.ts";

const FALLBACK_PREVIEW_LINES = 10;

export interface ToolExecutionOptions {
	showImages?: boolean;
	imageWidthCells?: number;
	ownerEntryId?: string;
	semanticDecorators?: readonly MessageRenderBoundaryDecoratorV1[];
	semanticSelectorsV2?: readonly MessageRenderBoundarySelectorV2[];
	semanticSelectorsV3?: readonly MessageRenderBoundarySelectorV3[];
	producerSessionId?: string;
	renderScopeId?: string;
	presentationOverrides?: readonly ToolPresentationOverrideV1[];
	toolExecutionPresentationSelectorsV1?: readonly ToolExecutionPresentationSelectorV1[];
}

class RetainedToolSection extends Container {
	private renderedRows = 0;

	override render(width: number): string[] {
		const lines = super.render(width);
		this.renderedRows = lines.length;
		return lines;
	}

	get rowCount(): number {
		return this.renderedRows;
	}
}

export class ToolExecutionComponent extends Container {
	private contentBox: Box;
	private contentText: Text;
	private selfRenderContainer: Container;
	private headerSection = new RetainedToolSection();
	private bodySection = new RetainedToolSection();
	private callRendererComponent?: Component;
	private resultRendererComponent?: Component;
	private rendererState: any = {};
	private imageComponents: Image[] = [];
	private imageSpacers: Spacer[] = [];
	private normalizedBodyRow?: number;
	private normalizedHeaderRow?: number;
	private normalizedSectionsAccepted = false;
	private toolName: string;
	private toolCallId: string;
	private ownerEntryId?: string;
	private semanticDecorators: readonly MessageRenderBoundaryDecoratorV1[];
	private semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[];
	private usesV3Sections = false;
	private presentationOverrides: readonly ToolPresentationOverrideV1[];
	private presentation?: ToolPresentationV1;
	private compactLiveToolCall = false;
	private args: any;
	private expanded = false;
	private showImages: boolean;
	private imageWidthCells: number;
	private isPartial = true;
	private toolDefinition?: ToolDefinition<any, any>;
	private builtInToolDefinition?: ToolDefinition<any, any>;
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

	constructor(
		toolName: string,
		toolCallId: string,
		args: any,
		options: ToolExecutionOptions = {},
		toolDefinition: ToolDefinition<any, any> | undefined,
		ui: TUI,
		cwd: string,
	) {
		super();
		this.toolName = toolName;
		this.toolCallId = toolCallId;
		this.ownerEntryId = options.ownerEntryId;
		this.semanticDecorators = options.semanticDecorators ?? [];
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
				: selectMessageRenderBoundaryDecoratorsV2("tool", "expanded", {
						entryId: toolCallId,
						...(options.ownerEntryId ? { ownerEntryId: options.ownerEntryId } : {}),
						selectors: options.semanticSelectorsV2 ?? [],
					});
		this.usesV3Sections = Boolean(
			options.producerSessionId && options.renderScopeId && this.semanticDecoratorsV2.length > 0,
		);
		this.presentationOverrides = options.presentationOverrides ?? [];
		this.args = args;
		this.toolDefinition = toolDefinition;
		this.builtInToolDefinition = createAllToolDefinitions(cwd)[toolName as ToolName];
		this.compactLiveToolCall = this.selectCompactLiveToolCall(options.toolExecutionPresentationSelectorsV1 ?? []);
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
		this.selfRenderContainer = new Container();
		if (this.isSectioned()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			renderContainer.addChild(this.headerSection);
			renderContainer.addChild(this.bodySection);
		}

		if (this.hasRendererDefinition() || this.isSectioned()) {
			this.addChild(this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox);
		} else {
			this.addChild(this.contentText);
		}

		this.updateDisplay();
	}

	getToolCallId(): string {
		return this.toolCallId;
	}

	private getCallRenderer(): ToolDefinition<any, any>["renderCall"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderCall;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderCall;
		}
		return this.toolDefinition.renderCall ?? this.builtInToolDefinition.renderCall;
	}

	private getCallBodyRowLocator(): ToolDefinition<any, any>["getRenderCallBodyRow"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.getRenderCallBodyRow;
		if (!this.toolDefinition) return this.builtInToolDefinition.getRenderCallBodyRow;
		return this.toolDefinition.renderCall
			? this.toolDefinition.getRenderCallBodyRow
			: this.builtInToolDefinition.getRenderCallBodyRow;
	}

	private getCallHeaderRowLocator(): ToolDefinition<any, any>["getRenderCallHeaderRow"] | undefined {
		if (!this.builtInToolDefinition) return this.toolDefinition?.getRenderCallHeaderRow;
		if (!this.toolDefinition) return this.builtInToolDefinition.getRenderCallHeaderRow;
		return this.toolDefinition.renderCall
			? this.toolDefinition.getRenderCallHeaderRow
			: this.builtInToolDefinition.getRenderCallHeaderRow;
	}

	private getResultRenderer(): ToolDefinition<any, any>["renderResult"] | undefined {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderResult;
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderResult;
		}
		return this.toolDefinition.renderResult ?? this.builtInToolDefinition.renderResult;
	}

	private hasRendererDefinition(): boolean {
		return this.builtInToolDefinition !== undefined || this.toolDefinition !== undefined;
	}

	private getRenderShell(): "default" | "self" {
		if (!this.builtInToolDefinition) {
			return this.toolDefinition?.renderShell ?? "default";
		}
		if (!this.toolDefinition) {
			return this.builtInToolDefinition.renderShell ?? "default";
		}
		return this.toolDefinition.renderShell ?? this.builtInToolDefinition.renderShell ?? "default";
	}

	private isExpanded(): boolean {
		return this.presentation?.state === "expanded" || this.expanded;
	}

	private isSectioned(): boolean {
		return this.semanticDecoratorsV2.length > 0;
	}

	private isNormalizedSectioned(): boolean {
		return this.usesV3Sections;
	}

	hasSelectedNormalizedSections(): boolean {
		return this.isNormalizedSectioned() && this.normalizedSectionsAccepted;
	}

	private getRenderContext(lastComponent: Component | undefined, expanded = this.isExpanded()): ToolRenderContext {
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
			expanded,
			showImages: this.showImages,
			isError: this.result?.isError ?? false,
			sectioned: this.isNormalizedSectioned(),
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
		if (this.hideComponent) {
			return [];
		}
		this.normalizedSectionsAccepted = false;

		let lines: string[];
		if (this.presentation?.state === "collapsed") {
			lines = this.presentation.component.render(width);
		} else if (this.isNormalizedSectioned()) {
			this.normalizedBodyRow = undefined;
			this.normalizedHeaderRow = undefined;
			this.normalizedSectionsAccepted = false;
			lines = this.renderNormalizedSections(width);
		} else if (this.hasRendererDefinition() && this.getRenderShell() === "self") {
			lines = this.renderSelfShell(width);
		} else {
			lines = super.render(width);
		}

		if (this.isCompactLiveToolCall()) {
			if (this.normalizedSectionsAccepted && lines.length === 1) return lines;
			this.compactLiveToolCall = false;
			this.updateDisplay();
			return this.render(width);
		}
		if (!this.ownerEntryId) return lines;
		if (this.isSectioned()) {
			lines = decorateMessageRenderV2(lines, this.getBodyRow(), width, "tool", "expanded", 0, {
				entryId: this.toolCallId,
				ownerEntryId: this.ownerEntryId,
				beginRow: this.getHeaderRow(),
				decorators: this.semanticDecoratorsV2,
			});
		}
		return decorateMessageRender(
			lines,
			width,
			"tool",
			this.presentation?.state ?? (this.expanded ? "expanded" : "collapsed"),
			0,
			{
				entryId: this.toolCallId,
				ownerEntryId: this.ownerEntryId,
				decorators: this.semanticDecorators,
			},
		);
	}

	private renderNormalizedSections(width: number): string[] {
		const shellLines =
			this.getRenderShell() === "self" ? this.selfRenderContainer.render(width) : this.contentBox.render(width);
		const shellPaddingRows = this.getRenderShell() === "self" ? 0 : 1;
		const headerStart = shellPaddingRows;
		const headerEnd = headerStart + this.headerSection.rowCount;
		const headerRows = shellLines.slice(headerStart, headerEnd);
		const shellContentEnd = Math.max(headerEnd, shellLines.length - shellPaddingRows);
		const bodyRows = shellLines.slice(headerEnd, shellContentEnd);
		const trailingShellRows = shellLines.slice(shellContentEnd);
		const callHeaderRow = this.callRendererComponent
			? this.getCallHeaderRowLocator()?.(this.callRendererComponent)
			: undefined;
		const callBodyLocator = this.callRendererComponent ? this.getCallBodyRowLocator() : undefined;
		const callBodyRow = this.callRendererComponent ? callBodyLocator?.(this.callRendererComponent) : undefined;
		const hasExactCallHeader = callHeaderRow !== undefined && callHeaderRow >= 0 && callHeaderRow < headerRows.length;
		const hasReportedExactCallSeam =
			hasExactCallHeader &&
			callBodyRow !== undefined &&
			callBodyRow > callHeaderRow &&
			callBodyRow <= headerRows.length;
		if (this.isCompactLiveToolCall() && hasReportedExactCallSeam) {
			this.normalizedSectionsAccepted = true;
			this.normalizedHeaderRow = 0;
			return [headerRows[callHeaderRow]!];
		}
		const hasExactCallSeam = this.getRenderShell() === "self" && hasReportedExactCallSeam;

		if (this.getRenderShell() === "self" && hasExactCallHeader && callBodyLocator && !hasExactCallSeam) {
			const hasOtherNonBlankCallRows = headerRows.some(
				(row, index) => index !== callHeaderRow && stripAnsi(row).trim() !== "",
			);
			if (hasOtherNonBlankCallRows) {
				const lines = this.renderSelfShell(width);
				this.normalizedHeaderRow = this.headerSection.rowCount > 0 ? 1 : 0;
				const bodyStart = this.bodySection.rowCount > 0 ? 1 + this.headerSection.rowCount : undefined;
				this.normalizedBodyRow = bodyStart !== undefined && bodyStart < lines.length ? bodyStart : undefined;
				return lines;
			}

			const resultBodyRows = bodyRows;
			const hasBody = resultBodyRows.length > 0 || this.imageComponents.length > 0;
			this.normalizedSectionsAccepted = true;
			this.normalizedHeaderRow = 0;
			if (!hasBody) {
				return [headerRows[callHeaderRow]!];
			}
			this.normalizedBodyRow = 1;
			const lines = [headerRows[callHeaderRow]!, ...resultBodyRows];
			this.appendImages(lines, width);
			return lines;
		}

		if (this.getRenderShell() === "self" && !hasExactCallSeam) {
			const lines = this.renderSelfShell(width);
			this.normalizedHeaderRow = this.headerSection.rowCount > 0 ? 1 : 0;
			const bodyStart = this.bodySection.rowCount > 0 ? 1 + this.headerSection.rowCount : undefined;
			this.normalizedBodyRow = bodyStart !== undefined && bodyStart < lines.length ? bodyStart : undefined;
			return lines;
		}

		const defaultBodyRows = this.getRenderShell() === "self" ? [] : bodyRows;
		const selfHeaderRows = hasExactCallSeam ? headerRows.slice(callHeaderRow! + 1, callBodyRow!) : [];
		const selfBodyRows = hasExactCallSeam
			? this.removeLocatorOwnedLeadingSeparator(headerRows.slice(callBodyRow!))
			: [];
		const selfResultBodyRows = hasExactCallSeam ? bodyRows : [];
		const bodyContentRows = [...selfBodyRows, ...selfResultBodyRows, ...defaultBodyRows];
		const hasBody = bodyContentRows.length > 0 || this.imageComponents.length > 0;
		this.normalizedSectionsAccepted = true;

		let lines: string[];
		if (!hasBody) {
			if (hasExactCallSeam) {
				this.normalizedHeaderRow = 0;
				lines = headerRows.slice(callHeaderRow!, callBodyRow!);
			} else {
				this.normalizedHeaderRow = 0;
				lines = headerRows;
			}
		} else if (headerRows.length === 0) {
			this.normalizedHeaderRow = 0;
			this.normalizedBodyRow = 0;
			lines = [...bodyContentRows, ...trailingShellRows];
		} else {
			const compactHeaderRow = this.getRenderShell() === "self" ? callHeaderRow! : 0;
			const retainedHeaderRows = hasExactCallSeam
				? selfHeaderRows
				: headerRows.filter((_, index) => index !== compactHeaderRow);
			this.normalizedHeaderRow = 0;
			this.normalizedBodyRow = 1;
			// Keep only the selected header row before BODY. Other rendered rows stay
			// searchable and selectable after BODY.
			lines = [headerRows[compactHeaderRow]!, ...retainedHeaderRows, ...bodyContentRows, ...trailingShellRows];
		}
		this.appendImages(lines, width);
		return lines;
	}

	private removeLocatorOwnedLeadingSeparator(rows: string[]): string[] {
		const firstRow = rows[0];
		if (firstRow === undefined || stripAnsi(firstRow).trim() !== "") return rows;
		return rows.slice(1);
	}

	private renderSelfShell(width: number): string[] {
		const contentLines = this.selfRenderContainer.render(width);
		if (contentLines.length === 0 && this.imageComponents.length === 0) {
			return [];
		}

		const lines: string[] = [];
		if (contentLines.length > 0) {
			lines.push("");
			lines.push(...contentLines);
		}
		this.appendImages(lines, width);
		return lines;
	}

	private appendImages(lines: string[], width: number): void {
		for (let i = 0; i < this.imageComponents.length; i++) {
			const spacer = this.imageSpacers[i];
			if (spacer) lines.push(...spacer.render(width));
			const imageComponent = this.imageComponents[i];
			if (imageComponent) lines.push(...imageComponent.render(width));
		}
	}

	private getBodyRow(): number | undefined {
		if (this.isNormalizedSectioned()) {
			return this.normalizedBodyRow;
		}
		const callBodyRow = this.callRendererComponent
			? this.getCallBodyRowLocator()?.(this.callRendererComponent)
			: undefined;
		if (callBodyRow !== undefined) return this.getHeaderRow() + callBodyRow;
		if (!this.isSectioned() || (this.bodySection.children.length === 0 && this.imageComponents.length === 0))
			return undefined;
		return this.getHeaderRow() + this.headerSection.rowCount;
	}

	private getHeaderRow(): number {
		if (this.isNormalizedSectioned()) return this.normalizedHeaderRow ?? 0;
		return this.getRenderShell() === "self" ? 1 : 2;
	}

	private updateDisplay(): void {
		this.presentation = this.isSectioned() ? undefined : this.resolvePresentation();
		if (this.presentation?.state === "collapsed") {
			this.hideComponent = false;
			return;
		}
		const bgFn = this.isPartial
			? (text: string) => theme.bg("toolPendingBg", text)
			: this.result?.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text);

		let hasContent = false;
		this.hideComponent = false;
		if (this.hasRendererDefinition() || this.isSectioned()) {
			const renderContainer = this.getRenderShell() === "self" ? this.selfRenderContainer : this.contentBox;
			if (renderContainer instanceof Box) {
				renderContainer.setBgFn(bgFn);
			}
			const sectioned = this.isSectioned();
			if (sectioned) {
				this.headerSection.clear();
				this.bodySection.clear();
			} else {
				renderContainer.clear();
			}
			const callSection = sectioned ? this.headerSection : renderContainer;
			const bodySection = sectioned ? this.bodySection : renderContainer;

			const callRenderer = this.getCallRenderer();
			if (!callRenderer) {
				callSection.addChild(this.createCallFallback());
				hasContent = true;
			} else {
				try {
					const component = callRenderer(this.args, theme, this.getRenderContext(this.callRendererComponent));
					this.callRendererComponent = component;
					callSection.addChild(component);
					hasContent = true;
				} catch {
					this.callRendererComponent = undefined;
					callSection.addChild(this.createCallFallback());
					hasContent = true;
				}
			}
			if (sectioned && !this.hasRendererDefinition()) {
				const args = JSON.stringify(this.args, null, 2);
				if (args) {
					bodySection.addChild(new Text(args, 0, 0));
					hasContent = true;
				}
			}

			if (this.result && !this.isCompactLiveToolCall()) {
				const resultRenderer = this.getResultRenderer();
				if (!resultRenderer) {
					const component = this.createResultFallback();
					if (component) {
						bodySection.addChild(component);
						hasContent = true;
					}
				} else {
					try {
						const component = resultRenderer(
							{ content: this.result.content as any, details: this.result.details },
							{ expanded: sectioned || this.isExpanded(), isPartial: this.isPartial },
							theme,
							this.getRenderContext(this.resultRendererComponent, sectioned || this.isExpanded()),
						);
						this.resultRendererComponent = component;
						bodySection.addChild(component);
						hasContent = true;
					} catch {
						this.resultRendererComponent = undefined;
						const component = this.createResultFallback();
						if (component) {
							bodySection.addChild(component);
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
	}

	private resolvePresentation(): ToolPresentationV1 | undefined {
		for (const override of this.presentationOverrides) {
			try {
				const presentation = override({
					toolName: this.toolName,
					toolCallId: this.toolCallId,
					...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
					args: this.args,
					isPartial: this.isPartial,
					...(this.result ? { result: this.result } : {}),
					theme,
					cwd: this.cwd,
					invalidate: () => {
						this.invalidate();
						this.ui.requestRender();
					},
				});
				if (presentation) return presentation;
			} catch {}
		}
		return undefined;
	}

	private selectCompactLiveToolCall(selectors: readonly ToolExecutionPresentationSelectorV1[]): boolean {
		const candidate = {
			role: "tool" as const,
			hasExactHeaderSeam: Boolean(this.getCallHeaderRowLocator() && this.getCallBodyRowLocator()),
			hasCanonicalResultRenderer: Boolean(this.getResultRenderer()),
			hasInitialCollapsedBoundaries: this.usesV3Sections,
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
