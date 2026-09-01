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
	it("creates provider UUID prompt IDs for exact start and end events", () => {
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

	it("describes supported response schemas without prompt text", () => {
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

	it("makes oversized selection schemas unavailable", () => {
		const tooMany = Array.from({ length: 65 }, (_, index) => `Option ${index}`);
		const oversizedOption = [`A${"x".repeat(1024)}`];
		const oversizedTotal = Array.from({ length: 33 }, (_, index) => `${index}`.padEnd(1024, "x"));

		expect(createUIPromptResponseAvailability("select", tooMany)).toEqual({
			status: "unavailable",
			reason: "boundsExceeded",
		});
		expect(createUIPromptResponseAvailability("select", oversizedOption)).toEqual({
			status: "unavailable",
			reason: "boundsExceeded",
		});
		expect(createUIPromptResponseAvailability("select", oversizedTotal)).toEqual({
			status: "unavailable",
			reason: "boundsExceeded",
		});
	});

	it("makes ambiguous or unsafe selection schemas unavailable", () => {
		expect(createUIPromptResponseAvailability("select", ["Same", "Same"])).toEqual({
			status: "unavailable",
			reason: "invalidOptions",
		});
		expect(createUIPromptResponseAvailability("select", [" "])).toEqual({
			status: "unavailable",
			reason: "invalidOptions",
		});
		expect(createUIPromptResponseAvailability("select", ["Unsafe\noption"])).toEqual({
			status: "unavailable",
			reason: "invalidOptions",
		});
	});

	it("keeps response and control results typed", () => {
		expectTypeOf<UIPromptResponse>().toEqualTypeOf<
			| { kind: "confirm"; value: boolean }
			| { kind: "select"; value: string }
			| { kind: "input"; value: string }
			| { kind: "editor"; value: string }
		>();
		expectTypeOf<UIPromptControlResult>().toEqualTypeOf<
			"accepted" | "notFound" | "kindMismatch" | "invalidValue" | "unsupported"
		>();
	});

	it("keeps exact end resolution and source discriminated", () => {
		type RespondedSource = Extract<ExactUIPromptEndEvent, { resolution: "responded" }>["source"];
		type DismissedSource = Extract<ExactUIPromptEndEvent, { resolution: "dismissed" }>["source"];

		expectTypeOf<RespondedSource>().toEqualTypeOf<"local" | "external">();
		expectTypeOf<DismissedSource>().toEqualTypeOf<
			"local" | "external" | "timeout" | "signal" | "sessionInvalidated"
		>();
	});

	it("keeps exact start kinds and schemas discriminated", () => {
		const assertSchemaKind = (event: ExactUIPromptStartEvent): void => {
			if (event.response.status !== "supported") return;
			if (event.kind === "confirm") expectTypeOf(event.response.schema.kind).toEqualTypeOf<"confirm">();
			if (event.kind === "select") expectTypeOf(event.response.schema.kind).toEqualTypeOf<"select">();
			if (event.kind === "input") expectTypeOf(event.response.schema.kind).toEqualTypeOf<"input">();
			if (event.kind === "editor") expectTypeOf(event.response.schema.kind).toEqualTypeOf<"editor">();
		};

		assertSchemaKind({
			type: "ui_prompt_start",
			reason: "ui_prompt",
			promptId: createUIPromptId(),
			kind: "input",
			response: createUIPromptResponseAvailability("input"),
		});
	});

	it("validates typed responses against the exact prompt schema", () => {
		const confirm = createUIPromptResponseAvailability("confirm");
		const select = createUIPromptResponseAvailability("select", ["First", "Second"]);
		const input = createUIPromptResponseAvailability("input");
		if (confirm.status !== "supported" || select.status !== "supported" || input.status !== "supported") {
			throw new Error("Expected supported test schemas");
		}

		expect(validateUIPromptResponse(confirm.schema, { kind: "confirm", value: true })).toBe("accepted");
		expect(validateUIPromptResponse(confirm.schema, { kind: "input", value: "true" })).toBe("kindMismatch");
		expect(validateUIPromptResponse(select.schema, { kind: "select", value: "Second" })).toBe("accepted");
		expect(validateUIPromptResponse(select.schema, { kind: "select", value: "Missing" })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "x".repeat(32768) })).toBe("accepted");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "🙂".repeat(8192) })).toBe("accepted");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "x".repeat(32769) })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "🙂".repeat(8193) })).toBe("invalidValue");
	});

	it("rejects unsafe text responses but allows multiline text and tabs", () => {
		const input = createUIPromptResponseAvailability("input");
		const editor = createUIPromptResponseAvailability("editor");

		expect(validateUIPromptResponse(input.schema, { kind: "input", value: " " })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "Unsafe\0text" })).toBe("invalidValue");
		expect(validateUIPromptResponse(input.schema, { kind: "input", value: "Line one\nLine two\r\n\tvalue" })).toBe(
			"accepted",
		);
		expect(validateUIPromptResponse(editor.schema, { kind: "editor", value: "Line one\n\tLine two" })).toBe(
			"accepted",
		);
	});
});
