import { createHash } from "node:crypto";
import type { PreWrapTextDecorator } from "@earendil-works/pi-tui";
import type {
	MessageRenderBoundariesV1,
	MessageRenderBoundariesV2,
	MessageRenderBoundaryCandidateV3,
	MessageRenderBoundaryDecoratorV1,
	MessageRenderBoundaryDecoratorV2,
	MessageRenderBoundarySelectorV3,
	MessageRenderRoleV1,
	MessageRenderSourcePointDecoratorV1,
	MessageRenderSourcePointV1,
} from "../../../core/extensions/types.ts";
import { stripAnsi } from "../../../utils/ansi.ts";

export interface MessageRenderBoundaryOptionsV1 {
	entryId: string;
	ownerEntryId?: string;
	decorators: readonly MessageRenderBoundaryDecoratorV1[];
	sourcePointDecorators?: readonly MessageRenderSourcePointDecoratorV1[];
	sourcePointRevisions?: SourcePointRevisions;
	revisionKey?: string;
}

export class SourcePointRevisions {
	private readonly entries = new Map<string, { revision: number; presentation: string; settled: boolean }>();

	resolve(key: string, presentation: string, settled: boolean): number {
		const entry = this.entries.get(key);
		if (!entry) {
			this.entries.set(key, { revision: 1, presentation, settled });
			return 1;
		}
		if (entry.settled && entry.presentation !== presentation) entry.revision += 1;
		entry.presentation = presentation;
		entry.settled = settled;
		return entry.revision;
	}
}

export function sourcePointPresentation(...parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(`${Buffer.byteLength(part, "utf8")}:${part}`);
	return hash.digest("hex");
}

export type MessageRenderSourceOwnerV1 = Omit<
	MessageRenderSourcePointV1,
	"contentIndex" | "pointKind" | "sourceOffset" | "contentDigest"
>;

const SOURCE_POINT_LINE_STEP = 8;
const SOURCE_POINT_BYTE_STEP = 512;
const SOURCE_POINT_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function createMessageRenderSourcePointDecorator(
	owner: MessageRenderSourceOwnerV1,
	contentIndex: number,
	decorators: readonly MessageRenderSourcePointDecoratorV1[],
	includeStart = false,
): PreWrapTextDecorator | undefined {
	if (decorators.length === 0) return undefined;
	return (lines) => {
		const source = lines.join("\n");
		const contentDigest = createHash("sha256").update(source, "utf8").digest("hex");
		const result: Array<{ line: number; utf8Offset: number; control: string }> = [];
		let sourceOffset = 0;
		for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
			const line = lines[lineIndex] ?? "";
			if (includeStart && lineIndex === 0) appendPoint("line", 0, 0, 0);
			if (lineIndex > 0 && lineIndex % SOURCE_POINT_LINE_STEP === 0) {
				appendPoint("line", lineIndex, 0, sourceOffset);
			}
			let lineOffset = 0;
			let nextBytePoint = SOURCE_POINT_BYTE_STEP;
			for (const { segment } of SOURCE_POINT_GRAPHEMES.segment(line)) {
				const segmentEnd = lineOffset + Buffer.byteLength(segment, "utf8");
				if (segmentEnd >= nextBytePoint) {
					appendPoint("offset", lineIndex, lineOffset, sourceOffset + lineOffset);
					while (segmentEnd >= nextBytePoint) nextBytePoint += SOURCE_POINT_BYTE_STEP;
				}
				lineOffset = segmentEnd;
			}
			sourceOffset += Buffer.byteLength(line, "utf8") + (lineIndex + 1 < lines.length ? 1 : 0);
		}
		return result;

		function appendPoint(
			pointKind: "line" | "offset",
			line: number,
			utf8Offset: number,
			absoluteOffset: number,
		): void {
			const point = Object.freeze({
				...owner,
				contentIndex,
				pointKind,
				sourceOffset: absoluteOffset,
				contentDigest,
			});
			for (const decorate of decorators) {
				try {
					const control = decorate(point);
					if (typeof control === "string") result.push({ line, utf8Offset, control });
				} catch {}
			}
		}
	};
}

export function createMessageRenderSourceBlockPointDecorator(
	owner: MessageRenderSourceOwnerV1,
	contentIndex: number,
	source: string,
	decorators: readonly MessageRenderSourcePointDecoratorV1[],
): ((sourceUtf8Offset: number) => string | undefined) | undefined {
	if (decorators.length === 0) return undefined;
	const contentDigest = createHash("sha256").update(source.replace(/\t/g, "   "), "utf8").digest("hex");
	return (sourceOffset) => {
		const point = Object.freeze({
			...owner,
			contentIndex,
			pointKind: "block" as const,
			sourceOffset,
			contentDigest,
		});
		const controls: string[] = [];
		for (const decorate of decorators) {
			try {
				const control = decorate(point);
				if (typeof control === "string") controls.push(control);
			} catch {}
		}
		return controls.length > 0 ? controls.join("") : undefined;
	};
}

export function selectMessageRenderBoundaryDecoratorsV3(
	candidate: MessageRenderBoundaryCandidateV3,
	selectors: readonly MessageRenderBoundarySelectorV3[],
): MessageRenderBoundaryDecoratorV2[] {
	const frozen = Object.freeze({ ...candidate });
	return selectors.flatMap((selector) => {
		try {
			const decorator = selector(frozen);
			return typeof decorator === "function" ? [decorator] : [];
		} catch {
			return [];
		}
	});
}

export function decorateMessageRenderV2(
	lines: string[],
	bodyRow: number | undefined,
	width: number,
	role: MessageRenderRoleV1,
	outputPad: number,
	options?: {
		entryId: string;
		ownerEntryId?: string;
		beginRow?: number;
		/** The begin row when it is a one-row summary of the header that starts at the body row. */
		summaryRow?: number;
		decorators: readonly MessageRenderBoundaryDecoratorV2[];
		sourcePointRevision?: number;
	},
): string[] {
	if (!options || options.decorators.length === 0 || lines.length === 0) return lines;
	const beginRow = options.beginRow ?? 0;
	// A body starts after the begin row and inside the lines; otherwise the block has no foldable body.
	const foldableBodyRow =
		bodyRow !== undefined && Number.isSafeInteger(bodyRow) && bodyRow > beginRow && bodyRow < lines.length
			? bodyRow
			: undefined;
	const context = Object.freeze({
		entryId: options.entryId,
		...(options.ownerEntryId ? { ownerEntryId: options.ownerEntryId } : {}),
		role,
		state: "expanded" as const,
		outputPad,
		sourcePointRevision: options.sourcePointRevision ?? 1,
		allocatedColumns: Object.freeze({ start: 0 as const, end: width }),
		stockRows: Object.freeze({ start: 0 as const, end: lines.length }),
		...(foldableBodyRow !== undefined ? { bodyRow: foldableBodyRow } : {}),
		...(options.summaryRow === beginRow && foldableBodyRow === beginRow + 1 ? { summaryRow: beginRow } : {}),
	});
	const begins: string[] = [];
	const bodies: string[] = [];
	const ends: string[] = [];
	for (const decorate of options.decorators) {
		try {
			const boundaries = decorate(context);
			if (!hasValidBoundariesV2(boundaries)) continue;
			if (boundaries.begin) begins.push(boundaries.begin);
			if (boundaries.body) bodies.push(boundaries.body);
			if (boundaries.end) ends.unshift(boundaries.end);
		} catch {}
	}
	if (beginRow >= 0 && beginRow < lines.length) lines[beginRow] = begins.join("") + lines[beginRow];
	if (foldableBodyRow !== undefined) lines[foldableBodyRow] = bodies.join("") + lines[foldableBodyRow];
	lines[lines.length - 1] += ends.join("");
	return lines;
}

export function decorateMessageRender(
	lines: string[],
	width: number,
	role: MessageRenderRoleV1,
	state: "streaming" | "final",
	outputPad: number,
	options?: MessageRenderBoundaryOptionsV1,
	sourcePointRevision = 1,
): string[] {
	if (!options || options.decorators.length === 0 || lines.length === 0) return lines;

	const context = Object.freeze({
		entryId: options.entryId,
		...(options.ownerEntryId ? { ownerEntryId: options.ownerEntryId } : {}),
		role,
		state,
		outputPad,
		sourcePointRevision,
		allocatedColumns: Object.freeze({ start: 0 as const, end: width }),
		stockRows: Object.freeze({ start: 0 as const, end: lines.length }),
	});
	const prefixes: string[] = [];
	const suffixes: string[] = [];
	let reservedRows = 0;
	for (const decorate of options.decorators) {
		try {
			const boundaries = decorate(context);
			if (!hasValidBoundaries(boundaries)) continue;
			if (boundaries.prefix) prefixes.push(boundaries.prefix);
			if (boundaries.suffix) suffixes.unshift(boundaries.suffix);
			reservedRows = Math.max(reservedRows, boundaries.reservedRows ?? 0);
		} catch {
			// A decorator cannot change or block a built-in message render.
		}
	}

	lines[0] = prefixes.join("") + lines[0];
	for (let index = 0; index < reservedRows; index++) lines.push("");
	lines[lines.length - 1] += suffixes.join("");
	// Keep one blank row after final assistant footer rows and outside the semantic boundary.
	if (reservedRows > 0 && role === "assistant" && state === "final") lines.push("");
	return lines;
}

function hasValidControl(control: unknown): control is string | undefined {
	return control === undefined || (typeof control === "string" && stripAnsi(control).length === 0);
}

function hasValidBoundariesV2(boundaries: unknown): boundaries is MessageRenderBoundariesV2 {
	if (boundaries === undefined || typeof boundaries !== "object" || boundaries === null) return false;
	const candidate = boundaries as MessageRenderBoundariesV2;
	return hasValidControl(candidate.begin) && hasValidControl(candidate.body) && hasValidControl(candidate.end);
}

function hasValidBoundaries(boundaries: unknown): boundaries is MessageRenderBoundariesV1 {
	if (boundaries === undefined || typeof boundaries !== "object" || boundaries === null) return false;
	const candidate = boundaries as MessageRenderBoundariesV1;
	return (
		hasValidControl(candidate.prefix) &&
		hasValidControl(candidate.suffix) &&
		(candidate.reservedRows === undefined ||
			(typeof candidate.reservedRows === "number" &&
				Number.isSafeInteger(candidate.reservedRows) &&
				candidate.reservedRows >= 0))
	);
}
