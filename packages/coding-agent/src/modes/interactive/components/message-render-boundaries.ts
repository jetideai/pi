import type {
	MessageRenderBoundariesV1,
	MessageRenderBoundaryDecoratorV1,
	MessageRenderRoleV1,
} from "../../../core/extensions/types.ts";
import { stripAnsi } from "../../../utils/ansi.ts";

export interface MessageRenderBoundaryOptionsV1 {
	entryId: string;
	decorators: readonly MessageRenderBoundaryDecoratorV1[];
}

export function decorateMessageRender(
	lines: string[],
	width: number,
	role: MessageRenderRoleV1,
	state: "streaming" | "final",
	outputPad: number,
	options?: MessageRenderBoundaryOptionsV1,
): string[] {
	if (!options || options.decorators.length === 0 || lines.length === 0) return lines;

	const context = Object.freeze({
		entryId: options.entryId,
		role,
		state,
		outputPad,
		allocatedColumns: Object.freeze({ start: 0 as const, end: width }),
		stockRows: Object.freeze({ start: 0 as const, end: lines.length }),
	});
	const prefixes: string[] = [];
	const suffixes: string[] = [];
	for (const decorate of options.decorators) {
		try {
			const boundaries = decorate(context);
			if (!hasValidBoundaries(boundaries)) continue;
			if (boundaries.prefix) prefixes.push(boundaries.prefix);
			if (boundaries.suffix) suffixes.unshift(boundaries.suffix);
		} catch {
			// A decorator cannot change or block a built-in message render.
		}
	}

	lines[0] = prefixes.join("") + lines[0];
	lines[lines.length - 1] += suffixes.join("");
	return lines;
}

function hasValidControl(control: unknown): control is string | undefined {
	return control === undefined || (typeof control === "string" && stripAnsi(control).length === 0);
}

function hasValidBoundaries(boundaries: unknown): boundaries is MessageRenderBoundariesV1 {
	if (boundaries === undefined || typeof boundaries !== "object" || boundaries === null) return false;
	const candidate = boundaries as MessageRenderBoundariesV1;
	return hasValidControl(candidate.prefix) && hasValidControl(candidate.suffix);
}
