import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type {
	ExtensionFactory,
	MessageEndEvent,
	MessageStartEvent,
	MessageUpdateEvent,
	SessionEntry,
} from "../../src/index.ts";
import { toJsonEvent } from "../../src/modes/json-event.ts";
import { createHarness } from "./harness.ts";

describe("assistant entry identity", () => {
	it("uses the persisted entry ID for the full assistant lifecycle", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("same")]);
			await harness.session.prompt("first");

			const assistantEntry = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "assistant");
			const assistantEvents = harness.events.filter(
				(event) =>
					(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
					event.message.role === "assistant",
			);
			const eventIds = assistantEvents.map((event) => (event as typeof event & { entryId?: string }).entryId);

			expect(assistantEntry?.id).toBeTruthy();
			expect(eventIds.length).toBeGreaterThan(2);
			expect(eventIds).toEqual(eventIds.map(() => assistantEntry?.id));
		} finally {
			harness.cleanup();
		}
	});

	it("retains entry IDs in delta-only JSON updates", async () => {
		const harness = await createHarness();
		try {
			harness.setResponses([fauxAssistantMessage("streamed")]);
			await harness.session.prompt("respond");

			const updates = harness.eventsOfType("message_update");
			const projected = updates.map(toJsonEvent);

			expect(projected.length).toBeGreaterThan(0);
			expect(projected.map((event) => (event as typeof event & { entryId?: string }).entryId)).toEqual(
				updates.map((event) => event.entryId),
			);
		} finally {
			harness.cleanup();
		}
	});

	it("uses one persisted ID for a direct custom-message lifecycle", async () => {
		const harness = await createHarness();
		try {
			await harness.session.sendCustomMessage({ customType: "notice", content: "hello", display: true });

			const entry = harness.sessionManager.getEntries().find((candidate) => candidate.type === "custom_message");
			const events = harness.events.filter(
				(event) =>
					(event.type === "message_start" || event.type === "message_end") && event.message.role === "custom",
			);

			expect(entry?.id).toBeTruthy();
			expect(events.map((event) => (event as typeof event & { entryId?: string }).entryId)).toEqual([
				entry?.id,
				entry?.id,
			]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps duplicate assistants distinct in extension events", async () => {
		const observed = new Map<string, Array<string | undefined>>();
		const extension: ExtensionFactory = (pi) => {
			const record = (event: MessageStartEvent | MessageUpdateEvent | MessageEndEvent): void => {
				if (event.message.role !== "assistant") return;
				const ids = observed.get(event.type) ?? [];
				ids.push(event.entryId);
				observed.set(event.type, ids);
			};
			pi.on("message_start", record);
			pi.on("message_update", record);
			pi.on("message_end", record);
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		try {
			harness.setResponses([fauxAssistantMessage("same"), fauxAssistantMessage("same")]);
			await harness.session.prompt("first");
			await harness.session.prompt("second");

			const assistantEntries = harness.sessionManager
				.getEntries()
				.filter(
					(entry): entry is Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage } =>
						entry.type === "message" && entry.message.role === "assistant",
				);
			const entryIds = assistantEntries.map((entry) => entry.id);

			expect(new Set(entryIds).size).toBe(2);
			expect(observed.get("message_start")).toEqual(entryIds);
			expect(observed.get("message_end")).toEqual(entryIds);
			expect(new Set(observed.get("message_update"))).toEqual(new Set(entryIds));
		} finally {
			harness.cleanup();
		}
	});

	it("keeps one persisted identity when an extension replaces an assistant", async () => {
		const observedIds: Array<string | undefined> = [];
		const extension: ExtensionFactory = (pi) => {
			const record = (event: MessageStartEvent | MessageUpdateEvent | MessageEndEvent): void => {
				if (event.message.role === "assistant") observedIds.push(event.entryId);
			};
			pi.on("message_start", record);
			pi.on("message_update", record);
			pi.on("message_end", (event) => {
				record(event);
				if (event.message.role !== "assistant") return undefined;
				return {
					message: {
						...event.message,
						content: [{ type: "text", text: "replaced" }],
					},
				};
			});
		};
		const harness = await createHarness({ extensionFactories: [extension] });
		try {
			harness.setResponses([fauxAssistantMessage("original")]);
			await harness.session.prompt("replace");

			const assistantEntry = harness.sessionManager
				.getEntries()
				.find(
					(entry): entry is Extract<SessionEntry, { type: "message" }> & { message: AssistantMessage } =>
						entry.type === "message" && entry.message.role === "assistant",
				);

			expect(assistantEntry?.message.content).toEqual([{ type: "text", text: "replaced" }]);
			expect(new Set(observedIds)).toEqual(new Set([assistantEntry?.id]));
		} finally {
			harness.cleanup();
		}
	});
});
