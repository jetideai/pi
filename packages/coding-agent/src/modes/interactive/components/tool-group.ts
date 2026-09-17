import { type Component, Container, type TuiMouseEvent, truncateToWidth } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
} from "../../../core/extensions/types.ts";
import { theme } from "../theme/theme.ts";
import { decorateMessageRenderV2, selectMessageRenderBoundaryDecoratorsV3 } from "./message-render-boundaries.ts";
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
}

export class ToolGroupMemberComponent implements Component {
	readonly component: ToolExecutionComponent;
	private readonly separator: boolean;
	private renderedHeight = 0;

	constructor(component: ToolExecutionComponent, separator: boolean) {
		this.component = component;
		this.separator = separator;
	}

	render(width: number): string[] {
		const rows = this.component.render(width);
		this.renderedHeight = rows.length;
		if (rows.length === 0 || !this.separator) return rows;
		return ["", ...rows];
	}

	invalidate(): void {
		this.component.invalidate();
	}

	handleMouse(event: TuiMouseEvent): ReturnType<NonNullable<Component["handleMouse"]>> {
		const offset = this.separator && this.renderedHeight > 0 ? 1 : 0;
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

	constructor(options: ToolGroupOptions) {
		super();
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

	addTool(component: ToolExecutionComponent, member: ToolGroupMemberV1): void {
		component.setSemanticBoundariesEnabled(false);
		this.addChild(this.semanticDecoratorsV2.length > 0 ? new ToolGroupMemberComponent(component, true) : component);
		this.members.push(member);
		this.memberComponents.push(component);
		if (this.memberComponents.length >= 2) {
			for (const memberComponent of this.memberComponents) {
				memberComponent.setSourcePointContainingFold(this.groupId, "tool-group");
			}
		}
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	override render(width: number): string[] {
		const body = super.render(width);
		if (!this.closed || this.members.length < 2 || this.semanticDecoratorsV2.length === 0) return body;
		const header = truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `$ ${toolGroupLabel(this.members)}`)}`,
			width,
			"…",
		);
		return decorateMessageRenderV2([header, ...body], 1, width, "tool-group", this.outputPad, {
			entryId: this.groupId,
			...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
			decorators: this.semanticDecoratorsV2,
		});
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (!this.closed || this.members.length < 2 || this.semanticDecoratorsV2.length === 0) {
			return super.handleMouse(event);
		}
		if (event.y === 0) return undefined;
		return super.handleMouse({ ...event, y: event.y - 1, height: event.height - 1 });
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
