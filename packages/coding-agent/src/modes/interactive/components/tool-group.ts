import { Container, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV1,
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV2,
	MessageRenderBoundarySelectorV3,
	ToolGroupMemberV1,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import {
	decorateMessageRender,
	decorateMessageRenderV2,
	selectMessageRenderBoundaryDecoratorsV2,
	selectMessageRenderBoundaryDecoratorsV3,
} from "./message-render-boundaries.ts";
import { ToolExecutionComponent } from "./tool-execution.ts";

export interface ToolGroupOptions {
	groupId: string;
	closed?: boolean;
	outputPad?: number;
	semanticDecorators?: readonly MessageRenderBoundaryDecoratorV1[];
	semanticSelectorsV2?: readonly MessageRenderBoundarySelectorV2[];
	semanticSelectorsV3?: readonly MessageRenderBoundarySelectorV3[];
	producerSessionId?: string;
	renderScopeId?: string;
}

export class ToolGroupComponent extends Container {
	private readonly groupId?: string;
	private readonly closed: boolean;
	private outputPad: number;
	private readonly semanticDecorators: readonly MessageRenderBoundaryDecoratorV1[];
	private readonly semanticSelectorsV2: readonly MessageRenderBoundarySelectorV2[];
	private readonly semanticSelectorsV3: readonly MessageRenderBoundarySelectorV3[];
	private readonly producerSessionId?: string;
	private readonly renderScopeId?: string;
	private semanticDecoratorsV2?: readonly MessageRenderBoundaryDecoratorV2[];
	private usesV3Selection = false;
	private readonly members: ToolGroupMemberV1[] = [];

	constructor(options?: ToolGroupOptions) {
		super();
		this.groupId = options?.groupId;
		this.closed = options?.closed ?? false;
		this.outputPad = options?.outputPad ?? 1;
		this.semanticDecorators = options?.semanticDecorators ?? [];
		this.semanticSelectorsV2 = options?.semanticSelectorsV2 ?? [];
		this.semanticSelectorsV3 = options?.semanticSelectorsV3 ?? [];
		this.producerSessionId = options?.producerSessionId;
		this.renderScopeId = options?.renderScopeId;
	}

	addTool(component: ToolExecutionComponent, member?: ToolGroupMemberV1): void {
		this.addChild(component);
		if (member) this.members.push(member);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	override render(width: number): string[] {
		if (!this.groupId) return this.withExternalSeparator(super.render(width));
		if (this.closed && this.members.length > 1) {
			this.semanticDecoratorsV2 ??=
				this.producerSessionId && this.renderScopeId
					? selectMessageRenderBoundaryDecoratorsV3(
							{
								producerSessionId: this.producerSessionId,
								renderScopeId: this.renderScopeId,
								entryId: this.groupId,
								blockId: this.groupId,
								role: "tool-group",
								state: "expanded",
							},
							this.semanticSelectorsV3,
						)
					: selectMessageRenderBoundaryDecoratorsV2("tool-group", "expanded", {
							entryId: this.groupId,
							selectors: this.semanticSelectorsV2,
						});
			this.usesV3Selection = Boolean(
				this.producerSessionId && this.renderScopeId && this.semanticDecoratorsV2.length > 0,
			);
			if (this.semanticDecoratorsV2.length === 0) return this.withExternalSeparator(super.render(width));
			const header = truncateToWidth(
				`${" ".repeat(this.outputPad)}${theme.fg("muted", `$ ${toolGroupLabel(this.members)}`)}`,
				width,
				"…",
			);
			const body = this.children.flatMap((child) => ["", ...child.render(width)]);
			let lines = decorateMessageRenderV2([header, ...body], 1, width, "tool-group", "expanded", {
				entryId: this.groupId,
				decorators: this.semanticDecoratorsV2,
			});
			lines = decorateMessageRender(lines, width, "tool-group", "expanded", {
				entryId: this.groupId,
				decorators: this.semanticDecorators,
			});
			return this.withExternalSeparator(lines);
		}
		return this.withExternalSeparator(super.render(width));
	}

	private withExternalSeparator(lines: string[]): string[] {
		if (
			lines.length === 0 ||
			(!this.usesV3Selection &&
				!this.children.some(
					(child) => child instanceof ToolExecutionComponent && child.hasSelectedNormalizedSections(),
				))
		) {
			return lines;
		}
		return ["", ...lines];
	}
}

const TOOL_GROUP_ACTIONS: Readonly<Record<string, string>> = {
	bash: "Ran commands",
	edit: "Edited files",
	find: "Read files",
	grep: "Read files",
	ls: "Read files",
	read: "Read files",
	write: "Edited files",
};

function toolGroupLabel(members: readonly ToolGroupMemberV1[]): string {
	const actions = new Set(members.map((member) => TOOL_GROUP_ACTIONS[member.toolName] ?? "Used tools"));
	return [...actions].join(", ");
}
