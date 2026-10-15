import {
	type Component,
	Container,
	dispatchMouseEvent,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import {
	decorateMessageRenderV2,
	LABEL_AFFORDANCE_COLUMNS,
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

export class ToolGroupComponent extends Container {
	private readonly groupId: string;
	private readonly ownerEntryId?: string;
	private closed = false;
	private outputPad: number;
	private semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[] = [];
	private readonly members: ToolGroupMemberV1[] = [];
	private readonly memberComponents: ToolExecutionComponent[] = [];
	private readonly sourcePointRevisions?: SourcePointRevisions;
	/** The member rows of the last framed render, each without its separator row, for the mouse. */
	private memberLayout?: { width: number; members: Array<{ component: Component; height: number }> };

	constructor(options: ToolGroupOptions) {
		super();
		this.sourcePointRevisions = options.sourcePointRevisions;
		this.groupId = options.groupId;
		this.ownerEntryId = options.ownerEntryId;
		this.outputPad = options.outputPad ?? 1;
		this.closed = options.closed ?? false;
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
	}

	/** The run of the group ended: no call joins it any more. Its boundaries do not depend on it. */
	close(): void {
		this.closed = true;
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
			this.addChild(memberComponent);
		}
	}

	/** A group of two or more committed calls shows its header and its range; a group of one call shows only its call. */
	private get framed(): boolean {
		return this.members.length >= 2 && this.semanticDecoratorsV2.length > 0;
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
		if (!this.framed) return super.render(width);
		const header = this.headerRow(width);
		// The group owns one separator row before its header. Its call headers have no leading separator rows.
		const body = this.renderMembers(width);
		return decorateMessageRenderV2(["", header, ...body], 2, width, "tool-group", this.outputPad, {
			beginRow: 1,
			entryId: this.groupId,
			...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
			decorators: this.semanticDecoratorsV2,
			sourcePointRevision: revision,
		});
	}

	/** The rows of the members at the member indent, each without its leading separator row. */
	private renderMembers(width: number): string[] {
		const memberWidth = Math.max(0, width - MEMBER_INDENT);
		const indent = " ".repeat(Math.min(MEMBER_INDENT, width));
		const rows: string[] = [];
		const members: Array<{ component: Component; height: number }> = [];
		for (const [index, component] of this.memberComponents.entries()) {
			const rendered = component.render(memberWidth, index < this.memberComponents.length - 1);
			// A member renders one separator row before its call; a hidden member renders no rows.
			const own = rendered.length > 0 ? rendered.slice(1) : rendered;
			members.push({ component, height: own.length });
			for (const row of own) rows.push(row.length > 0 ? `${indent}${row}` : row);
		}
		this.memberLayout = { width, members };
		return rows;
	}

	/**
	 * The header row: the action label, then the failed calls of the group, from the outcome of each call. A cancelled
	 * call is no failure. The label gives way first, so a collapsed group shows its failures at every width. The row keeps
	 * free cells after its text for the host control while its failures still fit after one label cell.
	 */
	private headerRow(fullWidth: number): string {
		const pad = " ".repeat(this.outputPad);
		const label = `$ ${toolGroupLabel(this.members)}`;
		const failed = this.memberComponents.filter((member) => member.outcome === "failed").length;
		const cue = ` · ${failed} failed`;
		const free = failed === 0 || fullWidth - LABEL_AFFORDANCE_COLUMNS - visibleWidth(pad) - visibleWidth(cue) >= 1;
		const width = Math.max(0, fullWidth - (free ? LABEL_AFFORDANCE_COLUMNS : 0));
		// The label is faint at rest: the host draws the header that the pointer is on at full contrast.
		// Faint after truncation: the reset before an ellipsis would end faint inside the label.
		if (failed === 0)
			return `${pad}${theme.faint(truncateToWidth(label, Math.max(0, width - visibleWidth(pad)), "…"))}`;
		const room = width - visibleWidth(pad) - visibleWidth(cue);
		if (room < 1) return truncateToWidth(theme.fg("error", `${failed} failed`), width, "…");
		return `${pad}${theme.faint(truncateToWidth(label, room, "…"))}${theme.fg("error", cue)}`;
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.framed) return super.handleMouse(event);
		if (event.y < 2 || event.x < MEMBER_INDENT) return undefined;
		if (this.memberLayout?.width !== event.width) this.renderMembers(event.width);
		const layout = this.memberLayout?.members ?? [];
		let y = event.y - 2;
		for (const { component, height } of layout) {
			if (y < height) {
				// The member sees its own rows: its separator row first, then its call, without the indent.
				return dispatchMouseEvent(component, {
					...event,
					x: event.x - MEMBER_INDENT,
					y: y + 1,
					width: Math.max(0, event.width - MEMBER_INDENT),
					height: height + 1,
				});
			}
			y -= height;
		}
		return undefined;
	}
}

/** The columns between the group header and the rows of its calls. */
const MEMBER_INDENT = 2;

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
