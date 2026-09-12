import { describe, expect, expectTypeOf, it } from "vitest";
import {
	createUIPromptId,
	createUIPromptResponseAvailability,
	type ExactUIPromptEndEvent,
	type ExactUIPromptStartEvent,
	type UIPromptControlResult,
	type UIPromptResponse,
	validateUIPromptResponse,
} from "../src/core/extensions/index.ts";

describe("UI prompt contract", () => {
	it("creates host UUID prompt IDs for exact start and end events", () => {
		const promptId = createUIPromptId();
		const start = {
			type: "ui_prompt_start",
			reason: "ui_prompt",
			promptId,
			kind: "confirm",
			response: { status: "supported", schema: { kind: "confirm" } },
		} satisfies ExactUIPromptStartEvent;
		const end = {
			type: "ui_prompt_end",
			reason: "ui_prompt",
			promptId,
			kind: "confirm",
			resolution: "responded",
			source: "external",
		} satisfies ExactUIPromptEndEvent;

		expect(promptId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(end.promptId).toBe(start.promptId);
		expect("value" in end).toBe(false);
	});

	it("describes typed response schemas without prompt text", () => {
		expect(createUIPromptResponseAvailability("confirm")).toEqual({
			status: "supported",
			schema: { kind: "confirm" },
		});
		expect(createUIPromptResponseAvailability("input")).toEqual({
			status: "supported",
			schema: { kind: "input", maxResponseBytes: 32768 },
		});
		expect(createUIPromptResponseAvailability("editor")).toEqual({
			status: "supported",
			schema: { kind: "editor", maxResponseBytes: 32768 },
		});
		expect(createUIPromptResponseAvailability("custom")).toEqual({
			status: "unavailable",
			reason: "unsupportedKind",
		});
	});

	it("allows an exact bounded single-selection schema", () => {
		const options = Array.from({ length: 32 }, (_, index) => `${index}`.padEnd(1024, "x"));
		expect(createUIPromptResponseAvailability("select", options)).toEqual({
			status: "supported",
			schema: { kind: "select", options },
		});
	});

	it("rejects oversized, ambiguous, and unsafe selection schemas", () => {
		expect(
			createUIPromptResponseAvailability(
				"select",
				Array.from({ length: 65 }, (_, index) => `Option ${index}`),
			),
		).toEqual({
			status: "unavailable",
			reason: "boundsExceeded",
		});
		expect(createUIPromptResponseAvailability("select", [`A${"x".repeat(1024)}`])).toEqual({
			status: "unavailable",
			reason: "boundsExceeded",
		});
		expect(createUIPromptResponseAvailability("select", ["Same", "Same"])).toEqual({
			status: "unavailable",
			reason: "invalidOptions",
		});
		expect(createUIPromptResponseAvailability("select", ["Unsafe\noption"])).toEqual({
			status: "unavailable",
			reason: "invalidOptions",
		});
	});

	it("keeps responses, control results, resolutions, and sources discriminated", () => {
		expectTypeOf<UIPromptResponse>().toEqualTypeOf<
			| { kind: "confirm"; value: boolean }
			| { kind: "select"; value: string }
			| { kind: "input"; value: string }
			| { kind: "editor"; value: string }
		>();
		expectTypeOf<UIPromptControlResult>().toEqualTypeOf<
			"accepted" | "notFound" | "kindMismatch" | "invalidValue" | "unsupported"
		>();
		type RespondedSource = Extract<ExactUIPromptEndEvent, { resolution: "responded" }>["source"];
		type DismissedSource = Extract<ExactUIPromptEndEvent, { resolution: "dismissed" }>["source"];
		expectTypeOf<RespondedSource>().toEqualTypeOf<"local" | "external">();
		expectTypeOf<DismissedSource>().toEqualTypeOf<
			"local" | "external" | "timeout" | "signal" | "sessionInvalidated"
		>();
	});

	it("validates typed responses against the exact prompt schema", () => {
		const confirm = createUIPromptResponseAvailability("confirm");
		const select = createUIPromptResponseAvailability("select", ["First", "Second"]);
		const input = createUIPromptResponseAvailability("input");
		if (confirm.status !== "supported" || select.status !== "supported") throw new Error("Expected schemas");

		expect(validateUIPromptResponse(confirm.schema, { kind: "confirm", value: true })).toBe("accepted");
		expect(validateUIPromptResponse(confirm.schema, { kind: "input", value: "true" })).toBe("kindMismatch");
		expect(validateUIPromptResponse(select.schema, { kind: "select", value: "Missing" })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "🙂".repeat(8192) })).toBe("accepted");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "🙂".repeat(8193) })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "Unsafe\0text" })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "Line one\n\tLine two" })).toBe("accepted");
	});
});
