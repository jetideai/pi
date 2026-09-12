import { Container, truncateToWidth } from "@earendil-works/pi-tui";
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

export class ToolGroupComponent extends Container {
	private readonly groupId: string;
	private readonly ownerEntryId?: string;
	private readonly closed: boolean;
	private outputPad: number;
	private readonly semanticDecoratorsV2: readonly MessageRenderBoundaryDecoratorV2[];
	private readonly members: ToolGroupMemberV1[] = [];

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
		this.addChild(component);
		this.members.push(member);
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
	}

	override render(width: number): string[] {
		const stockRows = super.render(width);
		if (!this.closed || this.members.length < 2 || this.semanticDecoratorsV2.length === 0) return stockRows;
		const header = truncateToWidth(
			`${" ".repeat(this.outputPad)}${theme.fg("muted", `$ ${toolGroupLabel(this.members)}`)}`,
			width,
			"…",
		);
		const body = this.children.flatMap((child) => ["", ...child.render(width)]);
		return decorateMessageRenderV2([header, ...body], 1, width, "tool-group", this.outputPad, {
			entryId: this.groupId,
			...(this.ownerEntryId ? { ownerEntryId: this.ownerEntryId } : {}),
			decorators: this.semanticDecoratorsV2,
		});
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
