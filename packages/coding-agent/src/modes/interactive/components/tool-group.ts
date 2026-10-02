import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import {
	decorateMessageRenderV2,
	type SourcePointRevisions,
	selectMessageRenderBoundaryDecoratorsV3,
} from "./message-render-boundaries.ts";
import type { ToolExecutionComponent } from "./tool-execution.ts";

export interface ToolGroupMemberV1 {
	toolName: string;
	toolCallId: string;
}

export interface ToolGroupOptions {
	groupId: string;
	ownerEntryId?: string;
	closed?: boolean;
	outputPad?: number;
	producerSessionId?: string;
	renderScopeId?: string;
	semanticSelectorsV3?: readonly MessageRenderBoundarySelectorV3[];
	sourcePointRevisions?: SourcePointRevisions;
}

/** A member of a closed Tool Group: it adds the one separator row that a compact live header does not render. */
export class ToolGroupMemberComponent implements Component {
	readonly component: ToolExecutionComponent;
	private renderedHeight = 0;
	private separated = false;

	constructor(component: ToolExecutionComponent) {
		this.component = component;
	}

	render(width: number): string[] {
		const rows = this.component.render(width);
		this.renderedHeight = rows.length;
		this.separated = rows.length > 0 && !this.component.rendersLeadingSeparator;
		return this.separated ? ["", ...rows] : rows;
	}

	invalidate(): void {
		this.component.invalidate();
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		const offset = this.separated ? 1 : 0;
		if (event.y < offset) return undefined;
		return this.component.handleMouse({ ...event, y: event.y - offset, height: this.renderedHeight });
	}
}

export class ToolGroupComponent extends Container {
	private readonly groupId: string;
	private readonly ownerEntryId?: string;
	private readonly closed: boolean;
	private outputPad: number;
	private readonly semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[];
	private readonly members: ToolGroupMemberV1[] = [];
	private readonly memberComponents: ToolExecutionComponent[] = [];
	private readonly sourcePointRevisions?: SourcePointRevisions;

	constructor(options: ToolGroupOptions) {
		super();
		this.sourcePointRevisions = options.sourcePointRevisions;
		this.groupId = options.groupId;
		this.ownerEntryId = options.ownerEntryId;
		this.closed = options.closed ?? false;
		this.outputPad = options.outputPad ?? 1;
		this.semanticDecoratorsV2 =
			this.closed && options.producerSessionId && options.renderScopeId
				? selectMessageRenderBoundaryDecoratorsV3(
						{
							producerSessionId: options.producerSessionId,
							renderScopeId: options.renderScopeId,
							entryId: options.groupId,
							blockId: options.groupId,
							role: "tool-group",
							state: "expanded",
							...(options.ownerEntryId ? { ownerEntryId: options.ownerEntryId } : {}),
						},
						options.semanticSelectorsV3 ?? [],
					)
				: [];
	}

	/** Each member keeps its own Tool Call range and source points inside the range of the group. */
	addTool(component: ToolExecutionComponent, member: ToolGroupMemberV1): void {
		this.addChild(this.semanticDecoratorsV2.length > 0 ? new ToolGroupMemberComponent(component) : component);
		this.members.push(member);
		this.memberComponents.push(component);
	}

	/** Expand or collapse the output of every member Tool Call. */
	setExpanded(expanded: boolean): void {
		for (const component of this.memberComponents) component.setExpanded(expanded);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	override render(width: number): string[] {
		const revision =
			this.memberComponents.length >= 2
				? (this.sourcePointRevisions?.resolve(
						`${this.groupId}#0`,
						this.memberComponents.map((member) => member.sourcePointPresentation).join("\n"),
						this.closed,
					) ?? 1)
				: 1;
		const body = super.render(width);
		if (!this.closed || this.members.length < 2 || this.semanticDecoratorsV2.length === 0) return body;
		const header = truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `$ ${toolGroupLabel(this.members)}`)}`,
			width,
			"…",
		);
		// The group owns one separator row before its header; each member renders its own before its call.
		return decorateMessageRenderV2(["", header, ...body], 2, width, "tool-group", this.outputPad, {
			beginRow: 1,
			entryId: this.groupId,
			...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
			decorators: this.semanticDecoratorsV2,
			sourcePointRevision: revision,
		});
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.closed || this.members.length < 2 || this.semanticDecoratorsV2.length === 0) {
			return super.handleMouse(event);
		}
		if (event.y < 2) return undefined;
		return super.handleMouse({ ...event, y: event.y - 2, height: event.height - 2 });
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
