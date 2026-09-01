import { randomUUID } from "node:crypto";
import type {
	ExactUIPromptEndEvent,
	ExactUIPromptStartEvent,
	UIPromptControlResult,
	UIPromptId,
	UIPromptKind,
	UIPromptResponse,
	UIPromptResponseAvailability,
	UIPromptResponseSchema,
} from "./types.ts";

export type ExactUIPromptEvent = ExactUIPromptStartEvent | ExactUIPromptEndEvent;

/** Internal source for a UI owner that emits exact confirmation prompt events. */
export interface ConfirmPromptLifecycleSource {
	connect(sink: (event: ExactUIPromptEvent) => void): () => void;
}

export const UI_PROMPT_MAX_RESPONSE_BYTES = 32 * 1024;
export const UI_PROMPT_MAX_SELECT_OPTIONS = 64;
export const UI_PROMPT_MAX_SELECT_OPTION_BYTES = 1024;
export const UI_PROMPT_MAX_SELECT_OPTIONS_BYTES = 32 * 1024;

const utf8 = new TextEncoder();
const ISO_CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const DISALLOWED_TEXT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

/** Create a provider-owned ID for one UI prompt lifecycle. */
export function createUIPromptId(): UIPromptId {
	return randomUUID() as UIPromptId;
}

/** Describe the safe response surface for a UI prompt. */
export function createUIPromptResponseAvailability(kind: "confirm"): {
	status: "supported";
	schema: Extract<UIPromptResponseSchema, { kind: "confirm" }>;
};
export function createUIPromptResponseAvailability(
	kind: "select",
	options: readonly string[],
):
	| { status: "supported"; schema: Extract<UIPromptResponseSchema, { kind: "select" }> }
	| { status: "unavailable"; reason: "invalidOptions" | "boundsExceeded" };
export function createUIPromptResponseAvailability(kind: "input"): {
	status: "supported";
	schema: Extract<UIPromptResponseSchema, { kind: "input" }>;
};
export function createUIPromptResponseAvailability(kind: "editor"): {
	status: "supported";
	schema: Extract<UIPromptResponseSchema, { kind: "editor" }>;
};
export function createUIPromptResponseAvailability(kind: "custom"): {
	status: "unavailable";
	reason: "unsupportedKind";
};
export function createUIPromptResponseAvailability(
	kind: UIPromptKind,
	options: readonly string[] = [],
): UIPromptResponseAvailability {
	if (kind === "custom") {
		return { status: "unavailable", reason: "unsupportedKind" };
	}
	if (kind === "select") {
		return createSelectResponseAvailability(options);
	}
	return {
		status: "supported",
		schema: kind === "confirm" ? { kind } : { kind, maxResponseBytes: UI_PROMPT_MAX_RESPONSE_BYTES },
	};
}

/** Validate one typed response without retaining or recording its value. */
export function validateUIPromptResponse(
	schema: UIPromptResponseSchema,
	response: UIPromptResponse,
): UIPromptControlResult {
	if (schema.kind !== response.kind) return "kindMismatch";
	if (schema.kind === "confirm" && response.kind === "confirm" && typeof response.value !== "boolean") {
		return "invalidValue";
	}
	if (schema.kind === "select" && response.kind === "select" && !schema.options.includes(response.value)) {
		return "invalidValue";
	}
	if (
		(schema.kind === "input" || schema.kind === "editor") &&
		(response.kind === "input" || response.kind === "editor") &&
		(response.value.trim().length === 0 ||
			DISALLOWED_TEXT_CONTROL_CHARACTER.test(response.value) ||
			utf8.encode(response.value).byteLength > schema.maxResponseBytes)
	) {
		return "invalidValue";
	}
	return "accepted";
}

function createSelectResponseAvailability(options: readonly string[]): UIPromptResponseAvailability {
	if (options.length === 0 || new Set(options).size !== options.length) {
		return { status: "unavailable", reason: "invalidOptions" };
	}

	const optionSizes = options.map((option) => utf8.encode(option).byteLength);
	if (
		options.length > UI_PROMPT_MAX_SELECT_OPTIONS ||
		optionSizes.some((size) => size > UI_PROMPT_MAX_SELECT_OPTION_BYTES) ||
		optionSizes.reduce((total, size) => total + size, 0) > UI_PROMPT_MAX_SELECT_OPTIONS_BYTES
	) {
		return { status: "unavailable", reason: "boundsExceeded" };
	}
	if (options.some((option) => option.trim().length === 0 || ISO_CONTROL_CHARACTER.test(option))) {
		return { status: "unavailable", reason: "invalidOptions" };
	}

	const schema: UIPromptResponseSchema = { kind: "select", options: [...options] };
	return { status: "supported", schema };
}
