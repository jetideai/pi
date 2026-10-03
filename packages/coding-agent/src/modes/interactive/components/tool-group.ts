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
	private readonly options: ToolGroupOptions;
	private closed = false;
	private outputPad: number;
	private semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[] = [];
	private readonly members: ToolGroupMemberV1[] = [];
	private readonly memberComponents: ToolExecutionComponent[] = [];
	private readonly sourcePointRevisions?: SourcePointRevisions;

	constructor(options: ToolGroupOptions) {
		super();
		this.sourcePointRevisions = options.sourcePointRevisions;
		this.groupId = options.groupId;
		this.ownerEntryId = options.ownerEntryId;
		this.options = options;
		this.outputPad = options.outputPad ?? 1;
		if (options.closed) this.close();
	}

	/** The run of the group ended: no call joins it any more, so it gets its group boundaries. */
	close(): void {
		if (this.closed) return;
		this.closed = true;
		const options = this.options;
		this.semanticDecoratorsV2 =
			options.producerSessionId && options.renderScopeId
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
		this.mountMembers();
	}

	/**
	 * Each member keeps its own Tool Call range and source points inside the range of the group. A response that renders
	 * again adds its calls again; a call that is a member already keeps its place.
	 */
	addTool(component: ToolExecutionComponent, member: ToolGroupMemberV1): void {
		const index = this.members.findIndex((existing) => existing.toolCallId === member.toolCallId);
		if (index >= 0) {
			if (this.memberComponents[index] === component) return;
			this.memberComponents[index] = component;
		} else {
			this.members.push(member);
			this.memberComponents.push(component);
		}
		this.mountMembers();
	}

	private mountMembers(): void {
		this.clear();
		for (const memberComponent of this.memberComponents) {
			this.addChild(this.framed ? new ToolGroupMemberComponent(memberComponent) : memberComponent);
		}
	}

	/** A closed group of two or more calls shows its header and its range; a group of one call shows only its call. */
	private get framed(): boolean {
		return this.closed && this.members.length >= 2 && this.semanticDecoratorsV2.length > 0;
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
		if (!this.framed) return body;
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
		if (!this.framed) return super.handleMouse(event);
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
